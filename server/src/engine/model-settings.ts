import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config.js';
import { isLoopback } from '../lib/security.js';
import { MODEL_TASKS, defaultLocalModel, type ModelTask } from './model-catalog.js';

/**
 * Quel modèle sert à quelle tâche : Claude (clé Anthropic de l'utilisateur) ou un modèle ouvert qui tourne sur ce
 * poste avec Ollama.
 *
 * Rangé comme la clé d'API (`api-key.ts`) : un petit fichier JSON dans le dossier de données, hors de la base, des
 * sauvegardes et des exports. C'est un réglage du poste, pas une donnée de recherche.
 *
 * L'adresse d'Ollama est **bornée au poste** (boucle locale) : le seul intérêt d'un modèle local est que les dossiers
 * ne quittent pas la machine. Une adresse sur le réseau (serveur de calcul du service, par exemple) n'est acceptée que
 * si l'administrateur l'autorise explicitement (`LOCAL_MODEL_ALLOW_REMOTE=1`), et l'interface le signale alors.
 */

export type ProviderId = 'anthropic' | 'local';

export interface TaskSetting {
  provider: ProviderId;
  /** Étiquette Ollama (`qwen3.5:9b`) pour un modèle local ; `null` : le modèle recommandé (local) ou celui de l'outil (Claude). */
  model: string | null;
}

export interface ModelSettings {
  tasks: Record<ModelTask, TaskSetting>;
  /** Pseudonymiser aussi avant un modèle local. Inutile pour la confidentialité (rien ne sort), désactivé par défaut. */
  pseudonymizeLocal: boolean;
  /** Adresse d'Ollama enregistrée dans l'application ; `null` : défaut ou `OLLAMA_HOST`. */
  ollamaUrl: string | null;
}

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsError';
  }
}

const defaults = (): ModelSettings => ({
  tasks: Object.fromEntries(MODEL_TASKS.map((t) => [t, { provider: 'anthropic', model: null }])) as Record<ModelTask, TaskSetting>,
  pseudonymizeLocal: false,
  ollamaUrl: null,
});

/** Étiquette Ollama plausible (`nom:variante`, espace de noms facultatif). Rien qui ressemble à un chemin ou une URL. */
export function checkModelTag(raw: string): string {
  const tag = raw.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,80}(\/[a-z0-9][a-z0-9._-]{0,80})?(:[a-zA-Z0-9._-]{1,80})?$/.test(tag)) {
    throw new SettingsError(`« ${raw.slice(0, 80)} » n’est pas un nom de modèle Ollama (exemple : qwen3.5:9b).`);
  }
  return tag;
}

/**
 * Normalise une adresse d'Ollama. `OLLAMA_HOST` suit la convention d'Ollama : `127.0.0.1`, `127.0.0.1:11434`,
 * `0.0.0.0` (écoute sur toutes les interfaces : on l'interroge alors par la boucle locale) ou une URL complète.
 */
export function normalizeOllamaUrl(raw: string): URL {
  let text = raw.trim();
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new SettingsError(`Adresse d’Ollama illisible : « ${raw.slice(0, 120)} ».`);
  }
  if (url.hostname === '0.0.0.0' || url.hostname === '[::]') url.hostname = '127.0.0.1';
  if (!url.port && url.protocol === 'http:' && !/:\d+$/.test(raw.trim().replace(/\/+$/, ''))) url.port = '11434';
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url;
}

export interface OllamaEndpoint {
  url: string;
  /** Adresse hors du poste (autorisée par `LOCAL_MODEL_ALLOW_REMOTE=1`). */
  remote: boolean;
  /** Avertissement à afficher : adresse distante, ou adresse refusée et remplacée par le défaut. */
  warning: string | null;
}

export interface ModelSettingsStore {
  get(): ModelSettings;
  task(task: ModelTask): TaskSetting;
  /** Le modèle local d'une tâche (réglé, ou recommandé). */
  localModel(task: ModelTask): string;
  update(patch: {
    tasks?: Partial<Record<ModelTask, Partial<TaskSetting>>>;
    pseudonymizeLocal?: boolean;
    ollamaUrl?: string | null;
  }): ModelSettings;
  endpoint(): OllamaEndpoint;
}

export function createModelSettingsStore(file: string, env: NodeJS.ProcessEnv = process.env): ModelSettingsStore {
  let cached: ModelSettings | undefined;

  function read(): ModelSettings {
    if (cached) return cached;
    const base = defaults();
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ModelSettings>;
      for (const task of MODEL_TASKS) {
        const t = parsed.tasks?.[task];
        if (!t) continue;
        const provider: ProviderId = t.provider === 'local' ? 'local' : 'anthropic';
        let model: string | null = null;
        try {
          model = typeof t.model === 'string' && t.model ? checkModelTag(t.model) : null;
        } catch {
          model = null;
        }
        base.tasks[task] = { provider, model };
      }
      base.pseudonymizeLocal = parsed.pseudonymizeLocal === true;
      base.ollamaUrl = typeof parsed.ollamaUrl === 'string' && parsed.ollamaUrl ? parsed.ollamaUrl : null;
    } catch {
      // absent ou illisible : réglages par défaut (tout par Claude, comme avant)
    }
    cached = base;
    return base;
  }

  function write(next: ModelSettings): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temp, file);
    cached = next;
  }

  const allowRemote = (): boolean => env.LOCAL_MODEL_ALLOW_REMOTE === '1';

  function resolve(raw: string): OllamaEndpoint {
    const url = normalizeOllamaUrl(raw);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const local = isLoopback(host) || host === '::1';
    const href = url.toString().replace(/\/+$/, '');
    if (local) return { url: href, remote: false, warning: null };
    if (!allowRemote()) {
      throw new SettingsError(
        `Ollama doit tourner sur ce poste (127.0.0.1) : « ${url.host} » est une autre machine, et les dossiers patients la traverseraient. Pour l’autoriser malgré tout (serveur de calcul de l’établissement), l’administrateur pose LOCAL_MODEL_ALLOW_REMOTE=1 dans l’environnement du serveur.`,
      );
    }
    return {
      url: href,
      remote: true,
      warning: `Modèle « local » servi par une autre machine (${url.host}) : les textes des dossiers transitent par le réseau jusqu’à elle. Vérifiez que cet usage est couvert par votre déclaration de traitement.`,
    };
  }

  const store: ModelSettingsStore = {
    get: () => structuredClone(read()),
    task: (task) => ({ ...read().tasks[task] }),
    localModel: (task) => read().tasks[task].model ?? defaultLocalModel(task),

    update(patch) {
      const next = structuredClone(read());
      for (const [task, change] of Object.entries(patch.tasks ?? {}) as [ModelTask, Partial<TaskSetting>][]) {
        if (!MODEL_TASKS.includes(task) || !change) continue;
        if (change.provider !== undefined) {
          if (change.provider !== 'anthropic' && change.provider !== 'local') throw new SettingsError('Fournisseur inconnu.');
          next.tasks[task].provider = change.provider;
        }
        if (change.model !== undefined) next.tasks[task].model = change.model === null || change.model === '' ? null : checkModelTag(change.model);
      }
      if (patch.pseudonymizeLocal !== undefined) next.pseudonymizeLocal = patch.pseudonymizeLocal;
      if (patch.ollamaUrl !== undefined) {
        if (patch.ollamaUrl === null || patch.ollamaUrl.trim() === '') next.ollamaUrl = null;
        else next.ollamaUrl = resolve(patch.ollamaUrl).url; // refuse une adresse distante non autorisée
      }
      write(next);
      return structuredClone(next);
    },

    endpoint() {
      const fromEnv = (env.OLLAMA_HOST ?? '').trim();
      const raw = fromEnv || read().ollamaUrl || DEFAULT_OLLAMA_URL;
      try {
        return resolve(raw);
      } catch (error) {
        // Adresse refusée : on retombe sur le poste lui-même, et on le dit.
        const why = error instanceof Error ? error.message : String(error);
        return { url: DEFAULT_OLLAMA_URL, remote: false, warning: `${why} Adresse utilisée : ${DEFAULT_OLLAMA_URL}.` };
      }
    },
  };
  return store;
}

export const modelSettings = createModelSettingsStore(path.join(dataDir, 'model-settings.json'));

// ------------------------------------------------------------------ résultats d'évaluation

/** Précision mesurée d'un modèle sur le corpus de démonstration (`npm run eval:models`). */
export interface ModelEvaluation {
  model: string;
  provider: ProviderId;
  measuredAt: string;
  corpus: string;
  patients: number;
  /** Valeurs retenues (après vérification des citations) qui sont exactes / toutes les valeurs retenues. */
  precision: number | null;
  /** Valeurs exactes / valeurs attendues. */
  recall: number | null;
  correct: number;
  extracted: number;
  expected: number;
  /** Dossiers dont la réponse n'était pas un JSON exploitable. */
  invalidJsonRate: number;
  /** Valeurs proposées puis écartées faute de citation vérifiable. */
  unverifiedRate: number;
  /** Dossiers en échec (hors JSON) : modèle absent, mémoire, délai. */
  errors: number;
  meanLatencyMs: number;
}

export function createEvaluationStore(file: string) {
  const readAll = (): Record<string, ModelEvaluation> => {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, ModelEvaluation>;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };
  return {
    all: readAll,
    get: (model: string): ModelEvaluation | null => readAll()[model] ?? null,
    save(evaluation: ModelEvaluation): void {
      const all = readAll();
      all[evaluation.model] = evaluation;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(all, null, 2));
      fs.renameSync(temp, file);
    },
  };
}

export const evaluationStore = createEvaluationStore(path.join(dataDir, 'model-evaluations.json'));
