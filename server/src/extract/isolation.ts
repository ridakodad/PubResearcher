import { Worker, type WorkerOptions } from 'node:worker_threads';
import { limits } from './limits.js';
import { ocrStatus, runOcr, type OcrBackend } from './ocr.js';
import { parseDocument, type ParseResult } from './index.js';
import { PARSE_ENV_KEYS, type FromWorker, type ParseRequest, type TableOutcome, type TableRequest, type ToWorker } from './protocol.js';
import { detectKind, looksLikeDicom } from './types.js';
import { readTable } from '../table/read.js';
import { TableReadError, type TableWorkbook } from '../table/types.js';

/**
 * Analyse des fichiers dans des fils séparés.
 *
 * Les plafonds de `limits.ts` protègent des fichiers volumineux ; ils ne protègent pas d'un fichier qui
 * piège sa bibliothèque de lecture. Un PDF dont l'arbre de pages se mord la queue, un flux compressé qui se
 * gonfle de mille fois sa taille, une archive Word qui se dégonfle en mémoire : la lecture n'en finit pas,
 * ou dévore la mémoire, et pendant ce temps le serveur — donc tous ceux qui l'utilisent — ne répond plus.
 * Un signal d'arrêt n'y change rien : le fil principal, occupé, ne le lit même pas.
 *
 * Ici, chaque fichier est lu dans un fil dédié. Il y dispose d'une mémoire bornée et d'un délai ferme. S'il
 * les dépasse, ou plante, le serveur arrête ce fil, en lance un neuf, et le document est enregistré en
 * erreur — avec le motif, pour que le chercheur saisisse ses valeurs ou réimporte une version saine.
 * Les autres fichiers, eux, ne s'aperçoivent de rien.
 *
 * Un nombre limité de fils vivent en permanence (`PARSE_CONCURRENCY`, 2 par défaut) : démarrer une
 * bibliothèque de lecture de PDF coûte plus que lire un compte rendu. Le moteur de reconnaissance optique,
 * lui, reste dans le fil principal, où les fils d'analyse viennent le solliciter : il n'en existe qu'un.
 */

export type IsolationFailure = 'timeout' | 'memory' | 'crash' | 'unavailable';

export class ParseIsolationError extends Error {
  constructor(
    readonly reason: IsolationFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ParseIsolationError';
  }
}

export interface ParseHostOptions {
  /** Script exécuté par chaque fil d'analyse. */
  workerFile: URL;
  /** Nombre de fils d'analyse, relu à chaque tâche. */
  workers: () => number;
  /** Délai ferme d'une tâche, relu à chaque tâche. */
  hardTimeoutMs: () => number;
  /** Mémoire du tas d'un fil, en Mo. */
  heapMb: () => number;
  /**
   * Croissance de la mémoire du processus, en Mo, qu'une analyse peut causer avant d'être arrêtée. Le tas d'un fil
   * est borné par `heapMb`, mais pas la mémoire hors tas (un flux compressé qui se gonfle de mille fois sa taille),
   * ni le tas si le processus a reçu `--max-old-space-size`, qui l'emporte sur le réglage du fil.
   */
  maxGrowthMb: () => number;
  /** Période de surveillance de cette croissance. */
  watchIntervalMs?: number;
  /** Un fil est remplacé après ce nombre de tâches : les fuites lentes des bibliothèques de lecture ne s'y accumulent pas. */
  maxJobsPerWorker: number;
  /** Ce qui répond aux demandes de reconnaissance optique des fils. */
  ocr: OcrBackend;
  /** Options de Node des fils ; par défaut, celles du processus (le chargeur TypeScript des tests, notamment). */
  execArgv?: string[];
  /** Fabrique de fils, pour les tests qui rejouent un ordre d'évènements précis ; par défaut, `new Worker`. */
  createWorker?: (file: URL, options: WorkerOptions) => Worker;
}

export interface HostStats {
  workers: number;
  busy: number;
  queued: number;
  served: number;
  timeouts: number;
  outOfMemory: number;
  crashes: number;
  recycled: number;
}

export interface ParseHost {
  /**
   * `transfer: true` cède le contenu du tampon au fil d'analyse sans le recopier (utile pour un fichier de
   * 200 Mo) : le tampon est alors vide pour l'appelant. Sans effet si le tampon partage son espace avec
   * d'autres données — il est alors recopié, et reste intact.
   */
  parse(buffer: Buffer, filename: string, mime: string, options?: { transfer?: boolean }): Promise<ParseResult>;
  /** Lecture d'un tableau de cohorte (classeur, CSV), sous les mêmes protections. */
  readTable(buffer: Buffer, filename: string, options?: { transfer?: boolean }): Promise<TableOutcome>;
  shutdown(): Promise<void>;
  stats(): HostStats;
}

interface Job {
  id: number;
  request: ParseRequest | TableRequest;
  transfer: ArrayBuffer[];
  resolve(result: ParseResult | TableOutcome): void;
  reject(error: Error): void;
}

interface Slot {
  worker: Worker;
  active: { job: Job; timer: NodeJS.Timeout; startedAt: number; rssAtStart: number } | null;
  served: number;
  retired: boolean;
  /** Le fil a annoncé qu'il écoute. */
  ready: boolean;
  /** Erreur reçue avant l'annonce « ready » : on tranche à la sortie du fil (voir `spawn`). */
  pendingError: (Error & { code?: string }) | null;
}

export function createParseHost(options: ParseHostOptions): ParseHost {
  const slots = new Set<Slot>();
  const queue: Job[] = [];
  const counters = { served: 0, timeouts: 0, outOfMemory: 0, crashes: 0, recycled: 0 };
  let nextId = 1;
  let closed = false;
  /** Au moins un fil de cet hôte a déjà annoncé qu'il écoutait : les fils se lancent donc sur cette plateforme. */
  let everReady = false;

  const seconds = (ms: number): string => (ms >= 10_000 ? `${Math.round(ms / 1000)} s` : `${(ms / 1000).toFixed(1).replace('.', ',')} s`);

  function spawn(): Slot {
    let worker: Worker;
    try {
      const workerOptions: WorkerOptions = {
        resourceLimits: { maxOldGenerationSizeMb: options.heapMb() },
        ...(options.execArgv ? { execArgv: options.execArgv } : {}),
      };
      worker = options.createWorker ? options.createWorker(options.workerFile, workerOptions) : new Worker(options.workerFile, workerOptions);
    } catch (error) {
      throw new ParseIsolationError(
        'unavailable',
        `Fil d'analyse impossible à démarrer : ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const slot: Slot = { worker, active: null, served: 0, retired: false, ready: false, pendingError: null };
    worker.on('message', (message: FromWorker) => onMessage(slot, message));

    // « ready » et l'erreur d'un fil qui plante aussitôt après arrivent par deux canaux distincts, dans un ordre que
    // Node ne garantit pas (observé : l'erreur d'abord, sur Node 22.13, 24 et 26, quand le fil principal est occupé).
    // Prise pour un fil qui n'a jamais démarré, cette erreur désactiverait l'isolation pour toute la vie du processus
    // et ferait relire le fichier fautif dans le fil principal. Node vide le canal des messages AVANT d'émettre
    // « exit » : on tranche donc à la sortie du fil, quand « ready » est fiable.
    worker.on('error', (error: Error & { code?: string }) => {
      if (!slot.ready) {
        slot.pendingError = error;
        return;
      }
      fail(slot, error);
    });
    worker.on('exit', (code) => {
      if (slot.retired) return;
      const error = slot.pendingError;
      if (!slot.ready && !everReady) {
        // Mort avant d'écouter, et aucun fil n'a jamais écouté : script introuvable, bibliothèque absente… Le fichier
        // n'y est pour rien, et le fil suivant mourrait de la même façon. L'appelant lit alors sans isolation, en le disant.
        retire(
          slot,
          new ParseIsolationError(
            'unavailable',
            error ? `Fil d'analyse impossible à démarrer : ${error.message.slice(0, 200)}` : `Fil d'analyse impossible à démarrer (arrêt de code ${code}).`,
          ),
        );
        return;
      }
      if (error) {
        fail(slot, error);
        return;
      }
      counters.crashes++;
      retire(slot, new ParseIsolationError('crash', `Le fil d'analyse s'est arrêté pendant la lecture du fichier (code ${code}).`));
    });
    // Un fil au repos ne doit pas empêcher le processus de s'arrêter. À poser APRÈS les écouteurs : ajouter un
    // écouteur « message » à un fil déjà détaché rattache à nouveau son port, et le processus ne se termine plus.
    worker.unref();
    slots.add(slot);
    return slot;
  }

  /** Un fil qui écoutait s'est arrêté sur une erreur : mémoire épuisée, ou plantage. */
  function fail(slot: Slot, error: Error & { code?: string }): void {
    if (error.code === 'ERR_WORKER_OUT_OF_MEMORY') {
      counters.outOfMemory++;
      retire(
        slot,
        new ParseIsolationError(
          'memory',
          `L'analyse de ce fichier a épuisé la mémoire qui lui est accordée (${options.heapMb()} Mo, PARSE_WORKER_MB) et a été interrompue. ` +
            `Le fichier est peut-être piégé. Le document est conservé : saisissez ses valeurs à la main, ou réimportez une version saine.`,
        ),
      );
    } else {
      counters.crashes++;
      retire(
        slot,
        new ParseIsolationError(
          'crash',
          `L'analyse de ce fichier a échoué de façon inattendue (${error.message.slice(0, 200)}). Le document est conservé : saisissez ses valeurs à la main, ou réimportez une version saine.`,
        ),
      );
    }
  }

  /** Arrête un fil, rejette sa tâche en cours s'il y en a une, et reprend la file avec un fil neuf si besoin. */
  function retire(slot: Slot, error: Error | null): void {
    if (slot.retired) return;
    slot.retired = true;
    slots.delete(slot);
    void slot.worker.terminate().catch(() => undefined);
    const active = slot.active;
    slot.active = null;
    if (active) {
      clearTimeout(active.timer);
      active.job.reject(error ?? new ParseIsolationError('crash', "Le fil d'analyse a été arrêté."));
    }
    watch();
    pump();
  }

  let watchdog: NodeJS.Timeout | null = null;

  /** Surveille la mémoire du processus tant qu'une analyse est en cours ; s'éteint quand il n'y en a plus. */
  function watch(): void {
    const busy = [...slots].some((s) => s.active);
    if (!busy) {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
      return;
    }
    if (watchdog) return;
    watchdog = setInterval(() => {
      const rss = process.memoryUsage.rss();
      const limit = options.maxGrowthMb() * 1024 * 1024;
      const victim = [...slots]
        .filter((s) => s.active && rss - s.active.rssAtStart > limit)
        .sort((a, b) => a.active!.startedAt - b.active!.startedAt)[0];
      if (victim) {
        counters.outOfMemory++;
        // Les autres tâches repartent de la mémoire actuelle : si c'est la coupable qui continue d'enfler, elle les dépassera encore.
        for (const s of slots) if (s.active && s !== victim) s.active.rssAtStart = rss;
        retire(
          victim,
          new ParseIsolationError(
            'memory',
            `L'analyse de ce fichier a fait grossir la mémoire du serveur de plus de ${options.maxGrowthMb()} Mo (PARSE_MAX_GROWTH_MB) et a été interrompue. ` +
              `Le fichier est peut-être piégé (flux compressé démesuré). Le document est conservé : saisissez ses valeurs à la main, ou réimportez une version saine.`,
          ),
        );
      }
      watch();
    }, options.watchIntervalMs ?? 500);
    watchdog.unref();
  }

  function dispatch(slot: Slot, job: Job): void {
    const limit = options.hardTimeoutMs();
    const timer = setTimeout(() => {
      counters.timeouts++;
      retire(
        slot,
        new ParseIsolationError(
          'timeout',
          `L'analyse de ce fichier a dépassé ${seconds(limit)} et a été interrompue (PARSE_HARD_TIMEOUT_MS). ` +
            `Le fichier est peut-être corrompu ou piégé. Le document est conservé : saisissez ses valeurs à la main, ou réimportez une version saine.`,
        ),
      );
    }, limit);
    slot.active = { job, timer, startedAt: Date.now(), rssAtStart: process.memoryUsage.rss() };
    try {
      slot.worker.postMessage(job.request satisfies ToWorker, job.transfer);
    } catch (error) {
      clearTimeout(timer);
      slot.active = null;
      job.reject(error instanceof Error ? error : new Error(String(error)));
    }
    watch();
  }

  function pump(): void {
    while (queue.length > 0 && !closed) {
      let slot = [...slots].find((s) => !s.active);
      if (!slot) {
        if (slots.size >= Math.max(1, options.workers())) return;
        try {
          slot = spawn();
        } catch (error) {
          queue.shift()?.reject(error as Error);
          continue;
        }
      }
      dispatch(slot, queue.shift()!);
    }
  }

  function reply(slot: Slot, id: number, value: unknown): void {
    if (slot.retired) return;
    try {
      slot.worker.postMessage({ type: 'ocr-reply', id, value } satisfies ToWorker);
    } catch {
      /* fil déjà arrêté */
    }
  }

  function onMessage(slot: Slot, message: FromWorker): void {
    switch (message.type) {
      case 'ready':
        slot.ready = true;
        everReady = true;
        return;
      case 'result':
      case 'failure': {
        const active = slot.active;
        // Réponse tardive d'une tâche déjà abandonnée : ignorée.
        if (!active || active.job.id !== message.id) return;
        clearTimeout(active.timer);
        slot.active = null;
        slot.served++;
        if (message.type === 'result') {
          counters.served++;
          active.job.resolve(message.result);
        } else {
          active.job.reject(new Error(message.message));
        }
        if (slot.served >= options.maxJobsPerWorker) {
          counters.recycled++;
          retire(slot, null);
        } else {
          watch();
          pump();
        }
        return;
      }
      case 'ocr-status':
        options.ocr.status().then(
          (value) => reply(slot, message.id, value),
          (error: unknown) =>
            reply(slot, message.id, { available: false, lang: '', reason: error instanceof Error ? error.message : String(error) }),
        );
        return;
      case 'ocr-run': {
        const image = Buffer.from(message.image.buffer, message.image.byteOffset, message.image.byteLength);
        options.ocr.run(image).then(
          (value) => reply(slot, message.id, value),
          () => reply(slot, message.id, null),
        );
        return;
      }
    }
  }

  function enqueue(
    buffer: Buffer,
    transfer: boolean,
    build: (id: number, view: Uint8Array, env: ParseRequest['env']) => ParseRequest | TableRequest,
  ): Promise<ParseResult | TableOutcome> {
    if (closed) return Promise.reject(new Error("Le service d'analyse est arrêté."));
    const ownsItsMemory =
      buffer.buffer instanceof ArrayBuffer && buffer.byteOffset === 0 && buffer.byteLength === buffer.buffer.byteLength;
    const moved = transfer && ownsItsMemory;
    const view = moved ? new Uint8Array(buffer.buffer as ArrayBuffer, 0, buffer.byteLength) : new Uint8Array(buffer);
    const env: ParseRequest['env'] = {};
    for (const key of PARSE_ENV_KEYS) env[key] = process.env[key];

    return new Promise<ParseResult | TableOutcome>((resolve, reject) => {
      const id = nextId++;
      queue.push({
        id,
        request: build(id, view, env),
        transfer: moved ? [view.buffer as ArrayBuffer] : [],
        resolve,
        reject,
      });
      pump();
    });
  }

  return {
    parse(buffer, filename, mime, { transfer = false } = {}) {
      return enqueue(buffer, transfer, (id, view, env) => ({ type: 'parse', id, buffer: view, filename, mime, env })) as Promise<ParseResult>;
    },

    readTable(buffer, filename, { transfer = false } = {}) {
      return enqueue(buffer, transfer, (id, view, env) => ({ type: 'table', id, buffer: view, filename, env })) as Promise<TableOutcome>;
    },

    async shutdown() {
      closed = true;
      for (const job of queue.splice(0)) job.reject(new Error("Le service d'analyse est arrêté."));
      const workers = [...slots].map((s) => s.worker);
      for (const slot of [...slots]) retire(slot, new ParseIsolationError('crash', "Le serveur s'arrête : l'analyse est interrompue."));
      await Promise.all(workers.map((w) => w.terminate().catch(() => undefined)));
    },

    stats() {
      return {
        workers: slots.size,
        busy: [...slots].filter((s) => s.active).length,
        queued: queue.length,
        ...counters,
      };
    },
  };
}

/* ───────────────────────── Service partagé du serveur ───────────────────── */

/** Les tests s'exécutent depuis les sources TypeScript (entrée `worker-dev.mjs`), le serveur installé depuis le JavaScript compilé. */
const workerFile = new URL(import.meta.url.endsWith('.ts') ? './worker-dev.mjs' : './worker.js', import.meta.url);

let shared: ParseHost | null = null;
let unavailable = false;

function sharedHost(): ParseHost {
  shared ??= createParseHost({
    workerFile,
    workers: limits.parseConcurrency,
    hardTimeoutMs: limits.parseHardTimeoutMs,
    heapMb: limits.parseWorkerMb,
    maxGrowthMb: limits.parseMaxGrowthMb,
    maxJobsPerWorker: 200,
    ocr: { status: ocrStatus, run: runOcr },
  });
  return shared;
}

/**
 * Analyse un fichier dans un fil dédié (voir plus haut). Même résultat que `parseDocument`, à une
 * différence près : un fichier qui plante ou fige son fil donne un document en erreur, avec le motif.
 * `PARSE_ISOLATION=0` ramène à l'analyse dans le fil principal.
 */
export async function parseIsolated(
  buffer: Buffer,
  filename: string,
  mime: string,
  options: { transfer?: boolean } = {},
): Promise<ParseResult> {
  if (unavailable || !limits.parseIsolation()) return parseDocument(buffer, filename, mime);

  // La nature et la taille se relèvent avant l'envoi : si le fil échoue, le document garde sa nature, et un tampon cédé est vide.
  const size = buffer.byteLength;
  let kind = detectKind(filename, mime);
  if ((kind === 'unknown' || kind === 'text') && looksLikeDicom(buffer)) kind = 'dicom';

  try {
    return await sharedHost().parse(buffer, filename, mime, options);
  } catch (error) {
    if (error instanceof ParseIsolationError) {
      if (error.reason === 'unavailable') {
        // Plateforme sans fils d'analyse : on le dit une fois, et on lit dans le fil principal.
        unavailable = true;
        console.warn(`[analyse] ${error.message} — les fichiers seront lus sans isolation.`);
        return parseDocument(buffer, filename, mime);
      }
      console.warn(`[analyse] fichier de ${size} octets interrompu : ${error.reason}`);
      return { kind, text: '', metadata: { textLayer: false, isolation: error.reason }, status: 'error', error: error.message };
    }
    return {
      kind,
      text: '',
      metadata: { textLayer: false },
      status: 'error',
      error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
  }
}

/**
 * Lit un tableau de cohorte dans un fil d'analyse : un classeur piégé (archive qui se gonfle, XML démesuré) arrête ce
 * fil, pas le serveur. Rend le classeur, ou lève `TableReadError` avec le motif à montrer au chercheur.
 */
export async function readTableIsolated(buffer: Buffer, filename: string): Promise<TableWorkbook> {
  let outcome: TableOutcome;
  if (unavailable || !limits.parseIsolation()) {
    outcome = readTableInline(buffer, filename);
  } else {
    try {
      outcome = await sharedHost().readTable(buffer, filename);
    } catch (error) {
      if (error instanceof ParseIsolationError && error.reason === 'unavailable') {
        unavailable = true;
        console.warn(`[analyse] ${error.message} — les fichiers seront lus sans isolation.`);
        outcome = readTableInline(buffer, filename);
      } else if (error instanceof ParseIsolationError) {
        console.warn(`[analyse] tableau de ${buffer.byteLength} octets interrompu : ${error.reason}`);
        throw new TableReadError(error.message.replace(/ Le document est conservé : saisissez ses valeurs à la main, ou réimportez une version saine\.$/, ' Vérifiez le fichier, ou enregistrez-le à nouveau depuis le tableur.'));
      } else {
        throw error;
      }
    }
  }
  if (!outcome.ok) throw new TableReadError(outcome.message);
  return outcome.workbook;
}

function readTableInline(buffer: Buffer, filename: string): TableOutcome {
  try {
    return { ok: true, workbook: readTable(buffer, filename) };
  } catch (error) {
    if (error instanceof TableReadError) return { ok: false, message: error.message };
    throw error;
  }
}

export function parserStats(): HostStats | null {
  return shared?.stats() ?? null;
}

/** À l'arrêt du serveur : les fils d'analyse en cours sont interrompus. */
export async function shutdownParsers(): Promise<void> {
  const host = shared;
  shared = null;
  await host?.shutdown();
}
