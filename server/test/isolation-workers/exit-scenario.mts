/**
 * Scénario lancé par `extract-isolation.test.ts` : lire un fichier puis NE RIEN faire d'autre. Le processus doit
 * s'arrêter seul — un fil d'analyse au repos ne doit pas le retenir (régression : `worker.unref()` posé avant les
 * écouteurs « message » laissait le port rattaché, et tout programme qui avait lu un fichier restait en vie).
 */
process.env.OCR_ENABLED = '0';
const { parseIsolated, parserStats } = await import('../../src/extract/isolation.js');
const result = await parseIsolated(Buffer.from('Âge : 54 ans'), 'cr.txt', 'text/plain');
console.log(JSON.stringify({ status: result.status, workers: parserStats()?.workers }));
