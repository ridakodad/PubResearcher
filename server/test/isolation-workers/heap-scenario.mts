/**
 * Scénario lancé par `extract-isolation.test.ts` dans un processus à part, SANS `--max-old-space-size` :
 * quand le processus reçoit ce réglage global (c'est le cas de NODE_OPTIONS ici), Node l'applique aussi
 * aux fils et ignore la limite de tas qu'on leur donne. Le scénario mesure ce que fait cette limite
 * quand elle est effective : le fil gourmand meurt en quelques centaines de millisecondes.
 */
import { createParseHost, ParseIsolationError } from '../../src/extract/isolation.js';

const host = createParseHost({
  workerFile: new URL('./poison.mjs', import.meta.url),
  workers: () => 1,
  hardTimeoutMs: () => 30_000,
  heapMb: () => 64,
  maxGrowthMb: () => 1_000_000,
  maxJobsPerWorker: 100,
  ocr: { status: async () => ({ available: false, lang: '', reason: null }), run: async () => null },
});

const rssBefore = process.memoryUsage.rss();
const started = Date.now();
let reason: string | null = null;
let message = '';
try {
  await host.parse(Buffer.from('x'), 'oom.bin', '');
} catch (error) {
  reason = error instanceof ParseIsolationError ? error.reason : String(error);
  message = error instanceof Error ? error.message : '';
}
const elapsedMs = Date.now() - started;
const rssGrowthMb = Math.round((process.memoryUsage.rss() - rssBefore) / 1048576);
const next = (await host.parse(Buffer.from('abc'), 'a.txt', '')).text;
console.log(JSON.stringify({ reason, message, elapsedMs, rssGrowthMb, next, stats: host.stats() }));
await host.shutdown();
process.exit(0);
