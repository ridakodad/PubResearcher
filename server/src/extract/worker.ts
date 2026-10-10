/**
 * Fil d'analyse : lit un fichier à la place du fil principal.
 *
 * Un fichier hostile ou simplement corrompu — PDF dont la lecture ne finit jamais, archive qui se gonfle en
 * mémoire — ne doit pas figer le serveur, ni l'emporter avec lui. Il fige ce fil-ci, que le serveur arrête
 * sans autre dommage (voir `isolation.ts`).
 */
import { parentPort } from 'node:worker_threads';
import { parseDocument } from './index.js';
import { useRemoteOcr } from './ocr.js';
import { PARSE_ENV_KEYS, type FromWorker, type ParseRequest, type ToWorker } from './protocol.js';

const port = parentPort;
if (!port) throw new Error('Ce fichier s’exécute dans un fil d’analyse, pas seul.');

const send = (message: FromWorker): void => port.postMessage(message);

let counter = 0;
const waiting = new Map<number, (value: unknown) => void>();

function ask<T>(build: (id: number) => FromWorker): Promise<T> {
  const id = ++counter;
  return new Promise<T>((resolve) => {
    waiting.set(id, resolve as (value: unknown) => void);
    send(build(id));
  });
}

useRemoteOcr({
  status: () => ask((id) => ({ type: 'ocr-status', id })),
  run: (image) => ask((id) => ({ type: 'ocr-run', id, image: new Uint8Array(image) })),
});

async function handle(job: ParseRequest): Promise<void> {
  try {
    for (const key of PARSE_ENV_KEYS) {
      const value = job.env[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const buffer = Buffer.from(job.buffer.buffer, job.buffer.byteOffset, job.buffer.byteLength);
    send({ type: 'result', id: job.id, result: await parseDocument(buffer, job.filename, job.mime) });
  } catch (error) {
    send({ type: 'failure', id: job.id, message: error instanceof Error ? error.message : String(error) });
  }
}

port.on('message', (message: ToWorker) => {
  if (message.type === 'ocr-reply') {
    const done = waiting.get(message.id);
    waiting.delete(message.id);
    done?.(message.value);
    return;
  }
  void handle(message);
});

send({ type: 'ready' });
