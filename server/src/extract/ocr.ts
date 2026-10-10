import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);

/**
 * Service OCR (tesseract.js), utilisé pour les documents sans couche texte :
 * photos de comptes rendus, PDF scannés.
 *
 * `tesseract.js` et les données de langue sont des dépendances optionnelles.
 * Si elles sont absentes, l'OCR est simplement désactivé et le document est
 * enregistré avec ses seules métadonnées — l'application reste fonctionnelle.
 */

export interface OcrResult {
  text: string;
  confidence: number;
}

/** Langue de reconnaissance, `fra` par défaut (comptes rendus francophones). */
const OCR_LANG = process.env.OCR_LANG ?? 'fra';
const OCR_ENABLED = process.env.OCR_ENABLED !== '0';

/** Ce que l'analyse de fichiers demande à l'OCR. */
export interface OcrBackend {
  status(): Promise<{ available: boolean; lang: string; reason: string | null }>;
  run(image: Buffer): Promise<OcrResult | null>;
}

/**
 * Dans un fil d'analyse (voir `isolation.ts`), l'OCR n'est pas porté par le fil : il est demandé au fil principal,
 * qui n'en garde qu'un exemplaire. Plusieurs fils d'analyse, chacun avec son propre moteur de reconnaissance,
 * multiplieraient par autant les quelques centaines de mégaoctets qu'il occupe.
 */
let remote: OcrBackend | null = null;
export function useRemoteOcr(backend: OcrBackend | null): void {
  remote = backend;
}

type TesseractWorker = {
  recognize(input: Buffer): Promise<{ data: { text: string; confidence: number } }>;
  terminate(): Promise<void>;
};

let workerPromise: Promise<TesseractWorker | null> | null = null;
/** Sérialise les appels : un worker traite une image à la fois. */
let queue: Promise<unknown> = Promise.resolve();
let unavailableReason: string | null = null;

/**
 * Localise les fichiers `.traineddata.gz` fournis par les paquets
 * `@tesseract.js-data/*`, ce qui permet un fonctionnement hors-ligne.
 * `OCR_LANG_PATH` permet de pointer un dossier de données personnel.
 */
function resolveLangPath(lang: string): string | null {
  if (process.env.OCR_LANG_PATH) return process.env.OCR_LANG_PATH;
  try {
    const pkgDir = path.dirname(require.resolve(`@tesseract.js-data/${lang}/package.json`));
    // tesseract.js v7 demande la variante « best_int » ; on retombe sur la
    // variante standard si le paquet ne la contient pas.
    for (const variant of ['4.0.0_best_int', '4.0.0']) {
      const dir = path.join(pkgDir, variant);
      if (fs.existsSync(path.join(dir, `${lang}.traineddata.gz`))) return dir;
    }
  } catch {
    // Paquet de langue absent : tesseract tentera son CDN.
  }
  return null;
}

async function getWorker(): Promise<TesseractWorker | null> {
  if (!OCR_ENABLED) {
    unavailableReason = 'OCR désactivé (OCR_ENABLED=0)';
    return null;
  }
  if (!workerPromise) {
    workerPromise = (async () => {
      try {
        const tesseract = await import('tesseract.js');
        const langPath = resolveLangPath(OCR_LANG);
        const options: Record<string, unknown> = { logger: () => {}, errorHandler: () => {} };
        if (langPath) {
          options['langPath'] = langPath;
          options['cacheMethod'] = 'none';
        }
        const worker = await tesseract.createWorker(OCR_LANG, 1, options);
        return worker as unknown as TesseractWorker;
      } catch (err) {
        unavailableReason = err instanceof Error ? err.message : String(err);
        return null;
      }
    })();
  }
  return workerPromise;
}

/** Indique si l'OCR est utilisable, pour affichage dans l'interface. */
export async function ocrStatus(): Promise<{ available: boolean; lang: string; reason: string | null }> {
  if (remote) return remote.status();
  const worker = await getWorker();
  return { available: worker !== null, lang: OCR_LANG, reason: worker ? null : unavailableReason };
}

/**
 * Reconnaît le texte d'une image encodée (PNG/JPEG).
 * Renvoie `null` si l'OCR n'est pas disponible.
 */
export async function runOcr(image: Buffer): Promise<OcrResult | null> {
  if (remote) return remote.run(image);
  const worker = await getWorker();
  if (!worker) return null;

  const task = queue.then(async () => {
    try {
      const { data } = await worker.recognize(image);
      return { text: data.text.trim(), confidence: data.confidence };
    } catch (err) {
      unavailableReason = err instanceof Error ? err.message : String(err);
      // Un worker qui a échoué (mémoire épuisée sur une image démesurée, arrêt brutal) n'est plus
      // fiable : on le remplace, sans quoi toutes les lectures suivantes échoueraient avec lui.
      await shutdownOcr();
      return null;
    }
  });
  // La file ne doit jamais être rompue par un échec ponctuel.
  queue = task.catch(() => undefined);
  return task;
}

export async function shutdownOcr(): Promise<void> {
  const worker = workerPromise ? await workerPromise : null;
  if (worker) await worker.terminate().catch(() => undefined);
  workerPromise = null;
}
