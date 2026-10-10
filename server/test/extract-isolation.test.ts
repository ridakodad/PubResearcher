/**
 * Analyse des fichiers dans des fils séparés.
 *
 * Un PDF d'une centaine d'octets (20 000 « q » à la suite) occupe pdf.js pendant 21 secondes ; avec 40 000,
 * plus de cent. Lu dans le fil principal, il fige le serveur pour tout le monde, et un signal d'arrêt
 * n'y change rien : le fil, occupé, ne le lit pas. Ici, ce fichier est lu dans un fil que le serveur arrête.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import { makeDicom, makeDocx, makeGraphicsStackBomb, makePdf, makeRawPdf } from './fixtures.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-isolation-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '1';
delete process.env.PARSE_ISOLATION;
delete process.env.PARSE_HARD_TIMEOUT_MS;
delete process.env.PDF_MAX_PAGES;

const { createParseHost, ParseIsolationError, parseIsolated, parserStats, shutdownParsers } = await import('../src/extract/isolation.js');
const { parseDocument } = await import('../src/extract/index.js');
const { ocrStatus, shutdownOcr } = await import('../src/extract/ocr.js');
const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): Buffer => fs.readFileSync(path.join(here, 'pdf-fixtures', name));
const poison = new URL('./isolation-workers/poison.mjs', import.meta.url);
const ocr = await ocrStatus();

/** Retard maximal pris par la boucle d'événements du fil principal entre deux battements de 10 ms. */
function watchLoop(): { stop(): number } {
  let max = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 10);
    last = now;
  }, 10);
  return { stop: () => (clearInterval(timer), max) };
}

after(async () => {
  await shutdownParsers();
  await shutdownOcr();
  try {
    const { db } = await import('../src/db/index.js');
    db.close();
  } catch {
    /* base jamais ouverte par ce fichier */
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ───────────────────────── L'hôte, avec des fils factices ───────────────── */

describe('hôte d’analyse : fils figés, plantés, gourmands', () => {
  const ocrBackend = {
    status: async () => ({ available: true, lang: 'fra', reason: null }),
    run: async (image: Buffer) => ({ text: `lu:${image.length}`, confidence: 91 }),
  };
  const make = (over: Partial<Parameters<typeof createParseHost>[0]> = {}) =>
    createParseHost({
      workerFile: poison,
      workers: () => 2,
      hardTimeoutMs: () => 400,
      heapMb: () => 64,
      maxGrowthMb: () => 1_000_000,
      maxJobsPerWorker: 100,
      ocr: ocrBackend,
      ...over,
    });
  const parse = (host: ReturnType<typeof make>, name: string, content: Buffer | string = 'abc') =>
    host.parse(Buffer.from(content), name, '');
  const threadOf = (result: { metadata: Record<string, unknown> }): number => Number(result.metadata['thread']);

  test('une tâche ordinaire revient avec son résultat, et le fil sert la suivante', async () => {
    const host = make();
    try {
      const first = await parse(host, 'a.txt');
      assert.equal(first.text, 'a.txt:3');
      const second = await parse(host, 'b.txt', 'abcdef');
      assert.equal(second.text, 'b.txt:6');
      assert.equal(threadOf(first), threadOf(second), 'même fil, pas de démarrage à chaque fichier');
      assert.equal(host.stats().served, 2);
    } finally {
      await host.shutdown();
    }
  });

  test('les tâches se répartissent sur deux fils au plus', async () => {
    const host = make({ hardTimeoutMs: () => 10_000 });
    try {
      const started = Date.now();
      const results = await Promise.all(Array.from({ length: 8 }, () => parse(host, 'slow.bin')));
      const elapsed = Date.now() - started;
      const threads = new Set(results.map(threadOf));
      assert.equal(threads.size, 2);
      assert.ok(elapsed < 2000, `${elapsed} ms : huit tâches de 300 ms sur deux fils tiennent en ~1,2 s`);
      assert.ok(host.stats().workers <= 2);
    } finally {
      await host.shutdown();
    }
  });

  test('un fil figé est arrêté à l’échéance, le fil principal ne bronche pas, la tâche suivante réussit sur un fil neuf', async () => {
    const host = make();
    try {
      const healthy = await parse(host, 'a.txt');
      const watch = watchLoop();
      const started = Date.now();
      await assert.rejects(parse(host, 'hang.bin'), (error: unknown) => {
        assert.ok(error instanceof ParseIsolationError);
        assert.equal(error.reason, 'timeout');
        assert.match(error.message, /dépassé 0,4 s.*PARSE_HARD_TIMEOUT_MS.*Le document est conservé/);
        return true;
      });
      const elapsed = Date.now() - started;
      const lag = watch.stop();
      assert.ok(elapsed >= 350 && elapsed < 3000, `arrêté après ${elapsed} ms`);
      assert.ok(lag < 250, `le fil principal a été bloqué ${Math.round(lag)} ms`);
      assert.equal(host.stats().timeouts, 1);

      const after = await parse(host, 'b.txt');
      assert.equal(after.text, 'b.txt:3');
      assert.notEqual(threadOf(after), threadOf(healthy), 'un fil neuf a pris le relais');
    } finally {
      await host.shutdown();
    }
  });

  test('derrière un fil figé, la file n’est pas bloquée : les tâches suivantes passent sur un autre fil', async () => {
    const host = make({ workers: () => 1 });
    try {
      const [stuck, one, two] = await Promise.allSettled([parse(host, 'hang.bin'), parse(host, 'un.txt'), parse(host, 'deux.txt')]);
      assert.equal(stuck.status, 'rejected');
      assert.equal(one.status === 'fulfilled' && one.value.text, 'un.txt:3');
      assert.equal(two.status === 'fulfilled' && two.value.text, 'deux.txt:3');
    } finally {
      await host.shutdown();
    }
  });

  test('un fil qui plante, ou qui s’arrête, rejette sa tâche avec le motif ; le suivant repart', async () => {
    const host = make();
    try {
      await assert.rejects(parse(host, 'crash.bin'), (error: unknown) => {
        assert.ok(error instanceof ParseIsolationError);
        assert.equal(error.reason, 'crash');
        assert.match(error.message, /boom/);
        return true;
      });
      await assert.rejects(parse(host, 'exit.bin'), (error: unknown) => error instanceof ParseIsolationError && /code 3/.test(error.message));
      assert.equal((await parse(host, 'a.txt')).text, 'a.txt:3');
      assert.equal(host.stats().crashes, 2);
    } finally {
      await host.shutdown();
    }
  });

  /** Un fil factice dont le test fixe l'ordre des évènements, que Node ne garantit pas entre « message » et « error ». */
  class FakeWorker extends EventEmitter {
    postMessage(): void {}
    terminate(): Promise<number> {
      return Promise.resolve(0);
    }
    unref(): void {}
  }
  const withFake = (): { host: ReturnType<typeof make>; fake: () => FakeWorker } => {
    let current: FakeWorker | null = null;
    const host = make({ workers: () => 1, createWorker: () => (current = new FakeWorker()) as unknown as Worker });
    return { host, fake: () => current! };
  };
  const reasonOf = async (pending: Promise<unknown>): Promise<{ reason: string; message: string }> =>
    pending.then(
      () => assert.fail('la tâche aurait dû être rejetée'),
      (error: unknown) => {
        assert.ok(error instanceof ParseIsolationError);
        return { reason: error.reason, message: error.message };
      },
    );

  test('l’erreur d’un fil qui plante arrive AVANT son annonce « ready » : c’est un plantage, pas un fil impossible à démarrer', async () => {
    const { host, fake } = withFake();
    try {
      const pending = reasonOf(host.parse(Buffer.from('x'), 'a.txt', 'text/plain'));
      fake().emit('error', new Error('boom'));
      fake().emit('message', { type: 'ready' });
      fake().emit('exit', 1);
      const { reason, message } = await pending;
      assert.equal(reason, 'crash');
      assert.match(message, /boom/);
      assert.equal(host.stats().crashes, 1);
    } finally {
      await host.shutdown();
    }
  });

  test('l’annonce « ready » avant l’erreur (l’ordre usuel) donne le même plantage', async () => {
    const { host, fake } = withFake();
    try {
      const pending = reasonOf(host.parse(Buffer.from('x'), 'a.txt', 'text/plain'));
      fake().emit('message', { type: 'ready' });
      fake().emit('error', new Error('boom'));
      fake().emit('exit', 1);
      assert.equal((await pending).reason, 'crash');
    } finally {
      await host.shutdown();
    }
  });

  test('une erreur sans jamais d’annonce « ready », alors qu’aucun fil n’a servi, reste « impossible à démarrer »', async () => {
    const { host, fake } = withFake();
    try {
      const pending = reasonOf(host.parse(Buffer.from('x'), 'a.txt', 'text/plain'));
      fake().emit('error', new Error('Cannot find module'));
      fake().emit('exit', 1);
      const { reason, message } = await pending;
      assert.equal(reason, 'unavailable');
      assert.match(message, /impossible à démarrer.*Cannot find module/);
    } finally {
      await host.shutdown();
    }
  });

  test('un arrêt de code 3 sans erreur ni « ready » : impossible à démarrer ; après « ready », un plantage avec son code', async () => {
    const first = withFake();
    try {
      const pending = reasonOf(first.host.parse(Buffer.from('x'), 'a.txt', 'text/plain'));
      first.fake().emit('exit', 3);
      const { reason, message } = await pending;
      assert.equal(reason, 'unavailable');
      assert.match(message, /code 3/);
    } finally {
      await first.host.shutdown();
    }
    const second = withFake();
    try {
      const pending = reasonOf(second.host.parse(Buffer.from('x'), 'a.txt', 'text/plain'));
      second.fake().emit('message', { type: 'ready' });
      second.fake().emit('exit', 3);
      const { reason, message } = await pending;
      assert.equal(reason, 'crash');
      assert.match(message, /code 3/);
    } finally {
      await second.host.shutdown();
    }
  });

  test('un fil qui plante aussitôt après avoir annoncé qu’il écoute est un plantage, jamais un « fil impossible à démarrer », quel que soit l’ordre des évènements', async () => {
    // Node ne garantit pas l'ordre entre l'annonce « ready » et l'erreur d'un fil qui plante tout de suite (deux canaux).
    // Pris pour un fil qui n'a jamais démarré, ce plantage coupait l'isolation pour tout le reste de la vie du serveur.
    const host = make({ workers: () => 1 });
    try {
      for (let essai = 1; essai <= 12; essai++) {
        const pending = parse(host, 'crash.bin');
        // Le fil principal reste occupé le temps que le fil plante : l'annonce et l'erreur attendent ensemble.
        const until = Date.now() + 30;
        while (Date.now() < until) {
          /* occupé */
        }
        await assert.rejects(pending, (error: unknown) => {
          assert.ok(error instanceof ParseIsolationError);
          assert.equal(error.reason, 'crash', `essai ${essai}`);
          return true;
        });
      }
      assert.equal(host.stats().crashes, 12);
    } finally {
      await host.shutdown();
    }
  });

  test('un fil qui meurt au démarrage, alors que d’autres ont déjà servi, est une erreur de ce fichier — pas une plateforme sans fils', async () => {
    const host = make({ workers: () => 1, maxJobsPerWorker: 1 });
    try {
      assert.equal((await parse(host, 'a.txt')).text, 'a.txt:3', 'le premier fil sert, puis est remplacé');
      process.env.POISON_FAIL_AT_START = '1';
      try {
        await assert.rejects(parse(host, 'b.txt'), (error: unknown) => {
          assert.ok(error instanceof ParseIsolationError);
          assert.equal(error.reason, 'crash');
          assert.match(error.message, /échec au démarrage/);
          return true;
        });
      } finally {
        delete process.env.POISON_FAIL_AT_START;
      }
      assert.equal((await parse(host, 'c.txt')).text, 'c.txt:3', 'le fil suivant naît sain : l’hôte continue');
      assert.equal(host.stats().crashes, 1);
    } finally {
      await host.shutdown();
    }
  });

  test('un fil qui meurt au démarrage, alors qu’aucun n’a jamais servi, est signalé comme impossible à démarrer', async () => {
    process.env.POISON_FAIL_AT_START = '1';
    const host = make({ workers: () => 1 });
    try {
      await assert.rejects(parse(host, 'a.txt'), (error: unknown) => {
        assert.ok(error instanceof ParseIsolationError);
        assert.equal(error.reason, 'unavailable');
        assert.match(error.message, /impossible à démarrer.*échec au démarrage/);
        return true;
      });
    } finally {
      delete process.env.POISON_FAIL_AT_START;
      await host.shutdown();
    }
  });

  test('une analyse qui fait enfler la mémoire hors tas est arrêtée par la surveillance de croissance, le serveur n’y perd rien', async () => {
    const host = make({ hardTimeoutMs: () => 20_000, maxGrowthMb: () => 200, watchIntervalMs: 50 });
    try {
      const started = Date.now();
      await assert.rejects(parse(host, 'bloat.bin'), (error: unknown) => {
        assert.ok(error instanceof ParseIsolationError);
        assert.equal(error.reason, 'memory');
        assert.match(error.message, /plus de 200 Mo \(PARSE_MAX_GROWTH_MB\)/);
        return true;
      });
      assert.ok(Date.now() - started < 8000, `arrêtée après ${Date.now() - started} ms`);
      assert.equal(host.stats().outOfMemory, 1);
      assert.equal((await parse(host, 'a.txt')).text, 'a.txt:3', 'le fil suivant travaille normalement');
    } finally {
      await host.shutdown();
    }
  });

  test('la limite de tas d’un fil l’arrête en quelques centaines de millisecondes quand elle est effective', () => {
    // Processus à part, et NODE_OPTIONS vidé : un `--max-old-space-size` global l'emporte sur la limite du fil.
    const script = fileURLToPath(new URL('./isolation-workers/heap-scenario.mts', import.meta.url));
    const run = spawnSync(process.execPath, ['--import', 'tsx', script], {
      env: { ...process.env, NODE_OPTIONS: '' },
      encoding: 'utf8',
      timeout: 90_000,
    });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const out = JSON.parse(run.stdout.trim().split('\n').at(-1)!) as {
      reason: string;
      message: string;
      elapsedMs: number;
      rssGrowthMb: number;
      next: string;
      stats: { outOfMemory: number };
    };
    assert.equal(out.reason, 'memory');
    assert.match(out.message, /PARSE_WORKER_MB/);
    assert.ok(out.elapsedMs < 10_000, `${out.elapsedMs} ms`);
    assert.ok(out.rssGrowthMb < 400, `la mémoire du serveur a grossi de ${out.rssGrowthMb} Mo`);
    assert.equal(out.next, 'a.txt:3');
    assert.equal(out.stats.outOfMemory, 1);
  });

  test('un échec rapporté par le fil est une erreur ordinaire : le fil n’est pas jeté', async () => {
    const host = make();
    try {
      const before = await parse(host, 'a.txt');
      await assert.rejects(parse(host, 'failure.bin'), (error: unknown) => {
        assert.ok(!(error instanceof ParseIsolationError));
        assert.equal((error as Error).message, 'refusé par la bibliothèque');
        return true;
      });
      assert.equal(threadOf(await parse(host, 'b.txt')), threadOf(before));
    } finally {
      await host.shutdown();
    }
  });

  test('un fil est remplacé après un nombre fixé de tâches', async () => {
    const host = make({ maxJobsPerWorker: 3, workers: () => 1 });
    try {
      const threads: number[] = [];
      for (let i = 0; i < 7; i++) threads.push(threadOf(await parse(host, `f${i}.txt`)));
      assert.equal(new Set(threads).size, 3, `fils : ${threads.join(',')}`);
      assert.ok(Object.values(Object.groupBy(threads, (t) => t)).every((g) => (g?.length ?? 0) <= 3));
      assert.equal(host.stats().recycled, 2);
    } finally {
      await host.shutdown();
    }
  });

  test('la reconnaissance optique demandée par le fil est servie par le fil principal, qui n’en garde qu’un exemplaire', async () => {
    const calls: number[] = [];
    const host = make({
      ocr: {
        status: async () => ({ available: true, lang: 'fra', reason: null }),
        run: async (image) => {
          calls.push(image.length);
          return { text: `lu:${image.length}`, confidence: 91 };
        },
      },
    });
    try {
      const viaRun = await parse(host, 'ocr.bin');
      assert.deepEqual(JSON.parse(viaRun.text), { text: 'lu:3', confidence: 91 });
      assert.deepEqual(calls, [3]);
      const viaStatus = await parse(host, 'ocr-status.bin');
      assert.deepEqual(JSON.parse(viaStatus.text), { available: true, lang: 'fra', reason: null });
    } finally {
      await host.shutdown();
    }
  });

  test('un moteur de reconnaissance qui échoue ne fige pas le fil : il reçoit « rien reconnu »', async () => {
    const host = make({
      ocr: {
        status: async () => {
          throw new Error('indisponible');
        },
        run: async () => {
          throw new Error('mémoire épuisée');
        },
      },
    });
    try {
      assert.equal((await parse(host, 'ocr.bin')).text, 'null');
      assert.deepEqual(JSON.parse((await parse(host, 'ocr-status.bin')).text), { available: false, lang: '', reason: 'indisponible' });
    } finally {
      await host.shutdown();
    }
  });

  test('les réglages de plafonds accompagnent chaque tâche : ils se règlent sans redémarrage', async () => {
    const host = make();
    try {
      process.env.PDF_MAX_PAGES = '7';
      const withIt = JSON.parse((await parse(host, 'env.bin')).text) as Record<string, string | null>;
      assert.equal(withIt['PDF_MAX_PAGES'], '7');
      delete process.env.PDF_MAX_PAGES;
      const without = JSON.parse((await parse(host, 'env.bin')).text) as Record<string, string | null>;
      assert.equal(without['PDF_MAX_PAGES'] ?? null, null);
    } finally {
      delete process.env.PDF_MAX_PAGES;
      await host.shutdown();
    }
  });

  test('« transfer » cède un tampon qui possède sa mémoire sans le recopier ; un tampon partagé est recopié, intact', async () => {
    const host = make();
    try {
      const big = Buffer.alloc(100_000, 7);
      assert.equal((await host.parse(big, 'bytes.bin', '', { transfer: true })).text, '100000:7:7');
      assert.equal(big.byteLength, 0, 'le tampon a été cédé');

      const small = Buffer.from('abc');
      assert.equal((await host.parse(small, 'bytes.bin', '', { transfer: true })).text, '3:97:99');
      assert.equal(small.toString(), 'abc', 'un tampon issu du réservoir de Node est recopié et reste utilisable');

      const kept = Buffer.alloc(10, 1);
      await host.parse(kept, 'bytes.bin', '');
      assert.equal(kept.byteLength, 10, 'sans « transfer », jamais cédé');
    } finally {
      await host.shutdown();
    }
  });

  test('à l’arrêt, les tâches en attente et en cours sont rejetées, aucun fil ne reste', async () => {
    const host = make({ workers: () => 1, hardTimeoutMs: () => 10_000 });
    const running = parse(host, 'hang.bin');
    const waiting = parse(host, 'a.txt');
    running.catch(() => undefined);
    waiting.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await host.shutdown();
    await assert.rejects(running, ParseIsolationError);
    await assert.rejects(waiting, /arrêté/);
    await assert.rejects(parse(host, 'b.txt'), /arrêté/);
    assert.equal(host.stats().workers, 0);
  });

  test('un fil au repos ne retient pas le processus : après une lecture, il s’arrête seul', () => {
    const script = fileURLToPath(new URL('./isolation-workers/exit-scenario.mts', import.meta.url));
    const started = Date.now();
    const run = spawnSync(process.execPath, ['--import', 'tsx', script], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(run.error, undefined, 'le processus ne s’est pas arrêté dans le délai');
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim().split('\n').at(-1)!), { status: 'ok', workers: 1 });
    assert.ok(Date.now() - started < 20_000);
  });

  test('un fil qu’on ne peut pas démarrer est signalé comme tel, pas comme un fichier défectueux', async () => {
    const host = make({ workerFile: new URL('./isolation-workers/inexistant.mjs', import.meta.url) });
    try {
      await assert.rejects(parse(host, 'a.txt'), (error: unknown) => error instanceof ParseIsolationError && error.reason === 'unavailable');
      assert.equal(host.stats().crashes, 0, 'ce n’est pas une panne de fichier');
    } finally {
      await host.shutdown();
    }
  });
});

/* ───────────────────────── Le vrai fil d'analyse ────────────────────────── */

describe('analyse réelle dans un fil : mêmes résultats que dans le fil principal', () => {
  const same = async (name: string, content: Buffer, mime = ''): Promise<void> => {
    const isolated = await parseIsolated(Buffer.from(content), name, mime);
    const direct = await parseDocument(Buffer.from(content), name, mime);
    assert.deepEqual(isolated, direct, name);
    assert.notEqual(isolated.status, 'error', `${name} : ${isolated.error}`);
  };

  test('texte brut, HTML et RTF', async () => {
    await same('cr.txt', Buffer.from('Âge : 54 ans\nSexe : féminin\n'), 'text/plain');
    await same('cr.html', Buffer.from('<html><body><p>Âge : 54 ans</p><p>Poids : 71 kg</p></body></html>'), 'text/html');
    await same('cr.rtf', Buffer.from("{\\rtf1\\ansi \\'c2ge : 54 ans}", 'latin1'), '');
  });

  test('PDF à couche texte', async () => {
    await same('cr.pdf', makePdf(['Âge : 54 ans', 'Poids : 71 kg']), 'application/pdf');
  });

  test('Word', async () => {
    await same('cr.docx', await makeDocx(['Âge : 54 ans', 'Poids : 71 kg']));
  });

  test('DICOM, avec ses étiquettes', async () => {
    const dicom = makeDicom({ patientAge: '054Y' });
    await same('coupe.dcm', dicom, 'application/dicom');
    const isolated = await parseIsolated(Buffer.from(dicom), 'coupe.dcm', 'application/dicom');
    assert.equal(isolated.kind, 'dicom');
    assert.ok(Object.keys(isolated.dicomTags ?? {}).length > 3);
  });

  test('un fichier de format inconnu rend la même erreur lisible', async () => {
    const isolated = await parseIsolated(Buffer.from('MZ'), 'programme.exe', 'application/octet-stream');
    assert.equal(isolated.status, 'error');
    assert.match(isolated.error ?? '', /Programme exécutable/);
    assert.deepEqual(isolated, await parseDocument(Buffer.from('MZ'), 'programme.exe', 'application/octet-stream'));
  });

  test('les plafonds réglés dans l’environnement s’appliquent dans le fil, sans redémarrage', async () => {
    const pdf = fixture('double.pdf');
    process.env.OCR_MAX_PAGES = '0'; // le sujet est le plafond de pages, pas la reconnaissance
    const normal = await parseIsolated(Buffer.from(pdf), 'double.pdf', 'application/pdf');
    assert.equal(normal.metadata['pagesTruncated'], undefined);
    process.env.PDF_MAX_PAGES = '1';
    try {
      const capped = await parseIsolated(Buffer.from(pdf), 'double.pdf', 'application/pdf');
      assert.equal(capped.metadata['pagesTruncated'], 1);
      assert.equal(capped.metadata['truncatedBecause'], 'pages');
      assert.match(capped.error ?? '', /PDF_MAX_PAGES/);
    } finally {
      delete process.env.PDF_MAX_PAGES;
    }
    assert.equal((await parseIsolated(Buffer.from(pdf), 'double.pdf', 'application/pdf')).metadata['pagesTruncated'], undefined);
    delete process.env.OCR_MAX_PAGES;
  });

  test('un flux compressé qui se gonfle de 1 000 fois sa taille est arrêté avant d’avoir mangé la mémoire du serveur', async () => {
    // 200 Ko sur le disque, 200 Mo une fois décompressés : pdf.js les décompresse d'un bloc (mesuré : +720 Mo de mémoire, 9 s).
    await parseIsolated(Buffer.from(makePdf(['Âge : 54 ans'])), 'chaud.pdf', 'application/pdf'); // fil chaud
    const bomb = makeRawPdf(Buffer.alloc(200 * 1024 * 1024, 0x20));
    assert.ok(bomb.length < 1024 * 1024, `${bomb.length} octets`);
    process.env.PARSE_MAX_GROWTH_MB = '250';
    process.env.PARSE_HARD_TIMEOUT_MS = '60000';
    try {
      const started = Date.now();
      const result = await parseIsolated(bomb, 'bombe.pdf', 'application/pdf');
      assert.equal(result.status, 'error');
      assert.equal(result.metadata['isolation'], 'memory');
      assert.match(result.error ?? '', /PARSE_MAX_GROWTH_MB/);
      assert.ok(Date.now() - started < 30_000, `arrêtée après ${Date.now() - started} ms`);
    } finally {
      delete process.env.PARSE_MAX_GROWTH_MB;
      delete process.env.PARSE_HARD_TIMEOUT_MS;
    }
    const after = await parseIsolated(Buffer.from(makePdf(['Poids : 71 kg'])), 'apres.pdf', 'application/pdf');
    assert.match(after.text, /Poids : 71 kg/);
  });

  test('PARSE_ISOLATION=0 ramène à l’analyse dans le fil principal', async () => {
    process.env.PARSE_ISOLATION = '0';
    try {
      const served = parserStats()?.served ?? 0;
      const result = await parseIsolated(Buffer.from('Âge : 54 ans'), 'cr.txt', 'text/plain');
      assert.equal(result.status, 'ok');
      assert.equal(parserStats()?.served ?? 0, served, 'aucun fil n’a servi');
    } finally {
      delete process.env.PARSE_ISOLATION;
    }
  });

  test('la reconnaissance optique reste dans le fil principal : un scan lu depuis un fil est lu', { skip: ocr.available ? false : `OCR indisponible : ${ocr.reason}` }, async () => {
    const scan = fixture('scan.pdf');
    const isolated = await parseIsolated(Buffer.from(scan), 'scan.pdf', 'application/pdf');
    assert.equal(isolated.status, 'ok', isolated.error ?? '');
    assert.match(isolated.text, /Âge\s*:\s*54 ans/);
    assert.equal(isolated.metadata['ocrApplied'], true);
    assert.deepEqual(isolated.metadata['ocrPages'], [1]);
  });
});

/* ───────────────────────────── De bout en bout ───────────────────────────── */

describe('un PDF piégé importé par l’API ne fige pas le serveur', () => {
  let server: Server;
  let base = '';

  before(async () => {
    seedIfEmpty();
    await new Promise<void>((resolve) => {
      server = createApp().listen(0, '127.0.0.1', () => {
        const address = server.address();
        base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function upload(patientId: number, name: string, content: Buffer, type: string) {
    const body = new FormData();
    body.append('files', new Blob([new Uint8Array(content)], { type }), name);
    const res = await fetch(`${base}/api/patients/${patientId}/documents`, { method: 'POST', body });
    return { status: res.status, json: (await res.json()) as { results: { status: string; message?: string }[]; documents: { id: number; filename: string; parseStatus: string; parseError: string | null }[] } };
  }

  test('lu dans le fil principal, ce fichier occuperait le serveur ; ici il est interrompu et le serveur répond pendant ce temps', async () => {
    const patient = (await (await fetch(`${base}/api/patients`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'PIEGE-001' }) })).json()) as { patient: { id: number } };
    const patientId = patient.patient.id;

    // Fil chaud : le démarrage de pdf.js n'entre pas dans le délai mesuré.
    assert.equal((await upload(patientId, 'sain.pdf', makePdf(['Âge : 54 ans']), 'application/pdf')).status, 201);

    process.env.PARSE_HARD_TIMEOUT_MS = '2500';
    try {
      // 60 000 « q » : plusieurs minutes de lecture pour pdf.js ; moins de 1 Ko sur le disque.
      const bomb = makeGraphicsStackBomb(60_000);
      assert.ok(bomb.length < 1500, `${bomb.length} octets`);

      const watch = watchLoop();
      const probes: number[] = [];
      const poller = setInterval(() => {
        const started = performance.now();
        fetch(`${base}/api/health`).then(() => probes.push(performance.now() - started), () => probes.push(Infinity));
      }, 100);

      const started = Date.now();
      const sent = await upload(patientId, 'piege.pdf', bomb, 'application/pdf');
      const elapsed = Date.now() - started;
      clearInterval(poller);
      const lag = watch.stop();

      assert.equal(sent.status, 201);
      assert.equal(sent.json.results[0]?.status, 'imported', 'le document est conservé, avec son erreur');
      assert.match(sent.json.results[0]?.message ?? '', /dépassé 2,5 s.*PARSE_HARD_TIMEOUT_MS/);
      const doc = sent.json.documents.find((d) => d.filename === 'piege.pdf');
      assert.equal(doc?.parseStatus, 'error');
      assert.match(doc?.parseError ?? '', /interrompue.*corrompu ou piégé/);
      assert.ok(elapsed < 8000, `l’import a pris ${elapsed} ms`);

      assert.ok(probes.length >= 10, `${probes.length} sondes de santé pendant l’import`);
      assert.ok(Math.max(...probes) < 500, `sonde la plus lente : ${Math.round(Math.max(...probes))} ms`);
      assert.ok(lag < 300, `le fil principal a été bloqué ${Math.round(lag)} ms`);
    } finally {
      delete process.env.PARSE_HARD_TIMEOUT_MS;
    }

    // Le fichier suivant s'importe normalement, sur un fil neuf.
    const next = await upload(patientId, 'apres.pdf', makePdf(['Poids : 71 kg']), 'application/pdf');
    assert.equal(next.json.results[0]?.status, 'imported');
    assert.equal(next.json.documents.find((d) => d.filename === 'apres.pdf')?.parseStatus, 'ok');
    assert.ok((parserStats()?.timeouts ?? 0) >= 1);
  });
});
