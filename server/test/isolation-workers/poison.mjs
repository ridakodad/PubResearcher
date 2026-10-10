/**
 * Faux fil d'analyse pour les tests de l'hôte (`src/extract/isolation.ts`) : il parle le même protocole que
 * `worker.ts`, mais son comportement dépend du nom du fichier reçu — un fil qui se fige, qui plante, qui
 * s'arrête, qui épuise sa mémoire, qui sollicite la reconnaissance optique…
 */
import { parentPort, threadId } from 'node:worker_threads';

// Échec au démarrage sur demande : le test pose cette variable avant de faire naître le fil (il en reçoit une copie).
if (process.env.POISON_FAIL_AT_START === '1') throw new Error('échec au démarrage');

const waiting = new Map();
let asked = 0;

parentPort.on('message', (message) => {
  if (message.type === 'ocr-reply') {
    waiting.get(message.id)?.(message.value);
    waiting.delete(message.id);
    return;
  }

  const { id, filename, buffer } = message;
  const answer = (text, metadata = {}) =>
    parentPort.postMessage({
      type: 'result',
      id,
      result: { kind: 'text', status: 'ok', error: null, text, metadata: { thread: threadId, ...metadata } },
    });

  switch (filename) {
    case 'hang.bin':
      for (;;) {
        /* fil figé : rien ne le sortira de là que son arrêt */
      }
    case 'crash.bin':
      setImmediate(() => {
        throw new Error('boom');
      });
      return;
    case 'exit.bin':
      process.exit(3);
      return;
    case 'oom.bin': {
      const hog = [];
      for (;;) hog.push(new Array(100_000).fill(Math.random()));
    }
    case 'bloat.bin': {
      // Mémoire hors tas : aucune limite de tas ne l'arrête.
      const held = [];
      setInterval(() => held.push(Buffer.alloc(50 * 1024 * 1024, 1)), 20);
      return;
    }
    case 'failure.bin':
      parentPort.postMessage({ type: 'failure', id, message: 'refusé par la bibliothèque' });
      return;
    case 'slow.bin':
      setTimeout(() => answer('lent'), 300);
      return;
    case 'env.bin':
      answer(JSON.stringify(message.env));
      return;
    case 'ocr.bin': {
      const request = ++asked;
      waiting.set(request, (value) => answer(JSON.stringify(value)));
      parentPort.postMessage({ type: 'ocr-run', id: request, image: new Uint8Array([1, 2, 3]) });
      return;
    }
    case 'ocr-status.bin': {
      const request = ++asked;
      waiting.set(request, (value) => answer(JSON.stringify(value)));
      parentPort.postMessage({ type: 'ocr-status', id: request });
      return;
    }
    case 'bytes.bin':
      answer(`${buffer.byteLength}:${buffer[0]}:${buffer[buffer.byteLength - 1]}`);
      return;
    default:
      answer(`${filename}:${buffer.byteLength}`);
  }
});

parentPort.postMessage({ type: 'ready' });
