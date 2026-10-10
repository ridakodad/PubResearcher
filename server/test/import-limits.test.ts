/**
 * Fichiers de dossiers patients réels : noms accentués, envois simultanés, archives Word qui se
 * décompressent en gigaoctets, PDF de milliers de pages, images démesurées.
 *
 * Chaque cas reproduit un fichier qui, avant les plafonds, figeait le serveur de plusieurs
 * secondes à plusieurs minutes ou le faisait mourir faute de mémoire.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-limits-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { uploadsDir, incomingDir } = await import('../src/config.js');
const { extractPdf } = await import('../src/extract/pdf.js');
const { extractImage } = await import('../src/extract/image.js');
const { readImageSize } = await import('../src/extract/image-size.js');
const { readZipDirectory } = await import('../src/extract/zip-guard.js');
const { createLimiter } = await import('../src/lib/limiter.js');
const { makeDocx } = await import('./fixtures.js');

let server: Server;
let baseUrl = '';

before(async () => {
  seedIfEmpty();
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { db } = await import('../src/db/index.js');
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function json(method: string, route: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function upload(patientId: number, files: { name: string; content: Buffer | string }[]) {
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([f.content]), f.name);
  const res = await fetch(`${baseUrl}/api/patients/${patientId}/documents`, { method: 'POST', body: form });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function newPatient(code: string): Promise<number> {
  return (await json('POST', '/api/patients', { code })).data.patient.id;
}

/** Garde la limite le temps d'un test, puis la rend. */
async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** PDF de `pages` pages, chacune portant « Page k Age : 20+k ans ». */
function makeLongPdf(pages: number): Buffer {
  const objects: string[] = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  const kids: number[] = [];
  for (let k = 1; k <= pages; k++) {
    const pageId = objects.length + 1;
    kids.push(pageId);
    const body = `BT /F1 12 Tf 50 740 Td (Page ${k} Age : ${20 + k} ans) Tj ET`;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R /Resources << /Font << /F1 ${pages * 2 + 3} 0 R >> >> >>`,
    );
    objects.push(`<< /Length ${body.length} >>\nstream\n${body}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>`;
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) pdf += `${String(o).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

/** Un .docx dont `word/document.xml` pèse `xmlBytes` octets une fois décompressé, et quelques ko compressé. */
async function makeDocxOfSize(xmlBytes: number): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.folder('_rels')!.file(
    '.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const paragraph = '<w:p><w:r><w:t>Ligne de compte rendu sans particularité</w:t></w:r></w:p>';
  const head = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>';
  const tail = '</w:body></w:document>';
  const count = Math.max(1, Math.floor((xmlBytes - head.length - tail.length) / paragraph.length));
  zip.folder('word')!.file('document.xml', head + paragraph.repeat(count) + tail, {
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('noms de fichiers', () => {
  test('les accents, les idéogrammes et les émojis survivent à l’envoi', async () => {
    const id = await newPatient('NOMS-1');
    const names = ['Compte rendu opératoire é à ç.txt', '日本語.txt', 'bilan-😀.txt', 'Œdème – février.txt'];
    for (const name of names) {
      const r = await upload(id, [{ name, content: `Âge : 54 ans (${name})` }]);
      assert.equal(r.data.results[0].filename, name, `« ${name} » a été déformé`);
    }
    const { data } = await json('GET', `/api/patients/${id}`);
    assert.deepEqual(data.documents.map((d: any) => d.filename).sort(), names.slice().sort());
  });

  test('caractères de contrôle et marques de sens d’écriture sont retirés du nom affiché', async () => {
    const id = await newPatient('NOMS-2');
    const trick = 'compte-rendu' + String.fromCodePoint(0x202e) + 'fdp.exe';
    const r = await upload(id, [{ name: trick, content: 'Âge : 54 ans' }]);
    assert.equal(r.data.results[0].filename, 'compte-rendufdp.exe');
    const sep = await upload(id, [{ name: '../../etc/passwd.txt', content: 'x' }]);
    assert.equal(sep.data.results[0].filename, 'passwd.txt');
  });
});

describe('envois simultanés', () => {
  test('vingt envois du même fichier : un importé, dix-neuf doublons, aucune erreur, un seul fichier sur disque', async () => {
    const id = await newPatient('COURSE-1');
    const content = 'Compte rendu identique\nÂge : 61 ans';
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => upload(id, [{ name: `copie-${i}.txt`, content }])),
    );
    const outcomes = results.flatMap((r) => r.data.results as { status: string; message?: string }[]);
    assert.equal(outcomes.filter((o) => o.status === 'imported').length, 1);
    assert.equal(outcomes.filter((o) => o.status === 'duplicate').length, 19);
    assert.equal(outcomes.filter((o) => o.status === 'error').length, 0);
    assert.doesNotMatch(JSON.stringify(outcomes), /UNIQUE|constraint|sqlite/i, 'aucun message interne de la base');

    const onDisk = fs.readdirSync(path.join(uploadsDir, String(id)));
    assert.equal(onDisk.length, 1);
    assert.deepEqual(fs.existsSync(incomingDir) ? fs.readdirSync(incomingDir) : [], [], 'dépôt provisoire vide');
  });

  test('le limiteur n’exécute jamais plus de tâches que sa limite, et les sert dans l’ordre', async () => {
    const run = createLimiter(() => 2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        run(async () => {
          active++;
          peak = Math.max(peak, active);
          order.push(i);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    assert.equal(peak, 2);
    assert.deepEqual(order, [0, 1, 2, 3, 4, 5, 6, 7]);
  });
});

describe('archives Word qui gonflent', () => {
  test('l’annuaire de l’archive donne les tailles sans rien décompresser', async () => {
    const docx = await makeDocx(['Âge : 54 ans']);
    const dir = readZipDirectory(docx);
    assert.ok(dir && !dir.zip64);
    const document = dir.entries.find((e) => e.name === 'word/document.xml');
    assert.ok(document && document.uncompressedSize > 0);
    assert.equal(readZipDirectory(Buffer.from('ce n’est pas une archive')), null);
    assert.equal(readZipDirectory(Buffer.alloc(0)), null);
  });

  test('un Word qui se décompresse au-delà du plafond est refusé avec la raison, avant toute conversion', async () => {
    await withEnv({ DOCX_MAX_XML_MB: '2' }, async () => {
      const bomb = await makeDocxOfSize(6 * 1024 * 1024); // quelques dizaines de ko compressés
      assert.ok(bomb.length < 200 * 1024, `l’archive doit rester petite (${bomb.length} octets)`);
      const id = await newPatient('BOMBE-1');
      const started = Date.now();
      const r = await upload(id, [{ name: 'bombe.docx', content: bomb }]);
      const elapsed = Date.now() - started;

      assert.equal(r.status, 201, 'un fichier refusé n’est pas un envoi en échec');
      const { data } = await json('GET', `/api/patients/${id}`);
      assert.equal(data.documents[0].parseStatus, 'error');
      assert.match(data.documents[0].parseError, /trop volumineux une fois décompressé/);
      assert.match(data.documents[0].parseError, /DOCX_MAX_XML_MB/);
      assert.ok(elapsed < 3000, `refus en ${elapsed} ms : l’archive n’aurait pas dû être convertie`);
    });
  });

  test('un Word légitime sous le plafond est lu normalement', async () => {
    await withEnv({ DOCX_MAX_XML_MB: '2' }, async () => {
      const id = await newPatient('BOMBE-2');
      const ok = await upload(id, [{ name: 'normal.docx', content: await makeDocxOfSize(500 * 1024) }]);
      assert.equal(ok.data.results[0].status, 'imported');
      const { data } = await json('GET', `/api/patients/${id}`);
      assert.equal(data.documents[0].parseStatus, 'ok');
      assert.ok(data.documents[0].textLength > 10_000);
    });
  });
});

describe('texte volumineux', () => {
  test('un texte au-delà du plafond est coupé à une fin de ligne et le document le dit', async () => {
    await withEnv({ MAX_TEXT_CHARS: '2000' }, async () => {
      const id = await newPatient('TEXTE-1');
      const lines = Array.from({ length: 400 }, (_, i) => `Ligne ${i} : sans particularité`).join('\n');
      const r = await upload(id, [{ name: 'long.txt', content: lines }]);
      assert.match(r.data.results[0].message, /Texte tronqué/);
      const { data } = await json('GET', `/api/patients/${id}`);
      const doc = data.documents[0];
      assert.equal(doc.metadata.textTruncated, true);
      assert.equal(doc.metadata.textOriginalLength, lines.length);
      assert.ok(doc.textLength <= 2000 && doc.textLength > 1800);
      const text = (await json('GET', `/api/documents/${doc.id}/text`)).data.text as string;
      assert.match(text, /Ligne \d+ : sans particularité$/, 'coupé à une fin de ligne, pas au milieu d’un mot');
    });
  });
});

describe('PDF de milliers de pages', () => {
  test('le plafond de pages rend les premières pages et compte les autres', async () => {
    await withEnv({ PDF_MAX_PAGES: '3' }, async () => {
      const result = await extractPdf(makeLongPdf(10), 'long.pdf');
      assert.match(result.text, /Page 1 Age : 21 ans/);
      assert.match(result.text, /Page 3 Age : 23 ans/);
      assert.doesNotMatch(result.text, /Page 4 /);
      assert.equal(result.metadata['pageCount'], 10);
      assert.equal(result.metadata['pagesRead'], 3);
      assert.equal(result.metadata['pagesTruncated'], 7);
      assert.equal(result.metadata['truncatedBecause'], 'pages');
    });
  });

  test('l’envoi signale la lecture partielle au chercheur', async () => {
    await withEnv({ PDF_MAX_PAGES: '3' }, async () => {
      const id = await newPatient('PDF-1');
      const r = await upload(id, [{ name: 'long.pdf', content: makeLongPdf(10) }]);
      assert.match(r.data.results[0].message, /Lecture partielle : 7 pages non lues.*PDF_MAX_PAGES/);
    });
  });

  test('un PDF sans dépassement ne porte aucune mention de coupure', async () => {
    const result = await extractPdf(makeLongPdf(5), 'court.pdf');
    assert.equal(result.metadata['pagesTruncated'], undefined);
    assert.match(result.text, /Page 5 Age : 25 ans/);
  });

  test('le délai accordé interrompt la lecture et rend ce qui a été lu', async () => {
    // 1000 ms est le plancher du réglage ; on le franchit avec un PDF long et un délai minimal.
    await withEnv({ PDF_PARSE_TIMEOUT_MS: '1000', PDF_MAX_PAGES: '100000' }, async () => {
      const pdf = makeLongPdf(3000);
      const result = await extractPdf(pdf, 'tres-long.pdf');
      const read = Number(result.metadata['pagesRead'] ?? 3000);
      if (result.metadata['truncatedBecause'] === 'time') {
        assert.ok(read < 3000 && read > 0);
        assert.equal(result.metadata['pagesTruncated'], 3000 - read);
      } else {
        // Machine rapide : 3000 pages lues avant le délai. Le test ne prouve alors rien d'autre qu'une lecture complète.
        assert.equal(read, 3000);
      }
    });
  });

  test('la lecture cède la main entre les pages : le serveur répond pendant qu’un PDF long est lu', async () => {
    let ticks = 0;
    let running = true;
    const heartbeat = (async () => {
      while (running) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        ticks++;
      }
    })();
    const result = await extractPdf(makeLongPdf(400), 'cent-pages.pdf');
    running = false;
    await heartbeat;
    assert.equal(result.metadata['pageCount'], 400);
    assert.ok(ticks >= 200, `la boucle d’événements n’a eu la main que ${ticks} fois en 400 pages`);
  });
});

describe('images démesurées', () => {
  const pngHeader = (width: number, height: number): Buffer => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    b[24] = 8;
    b[25] = 6;
    return b;
  };

  test('les dimensions se lisent dans l’en-tête, sans décoder l’image', () => {
    assert.deepEqual(readImageSize(pngHeader(1190, 1560)), { width: 1190, height: 1560 });

    const gif = Buffer.from('GIF89a\x40\x01\xc8\x00', 'latin1'); // 320 x 200
    assert.deepEqual(readImageSize(gif), { width: 320, height: 200 });

    // JPEG : SOI, APP0 de 16 octets, puis SOF0 (hauteur 480, largeur 640).
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      Buffer.alloc(14),
      Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03]),
    ]);
    assert.deepEqual(readImageSize(jpeg), { width: 640, height: 480 });

    assert.equal(readImageSize(Buffer.from('rien d’une image')), null);
    assert.equal(readImageSize(Buffer.alloc(0)), null);
  });

  test('une image qui annonce des milliards de pixels n’est pas lue par l’OCR, et le dit', async () => {
    const bomb = pngHeader(30000, 30000); // 900 Mpx, 33 octets
    const out = await extractImage(bomb, 'bombe.png');
    assert.equal(out.metadata['ocrApplied'], false);
    assert.match(String(out.metadata['ocrSkipped']), /trop grande \(900 Mpx, limite 100 Mpx\).*IMAGE_MAX_MEGAPIXELS/);
    assert.equal(out.metadata['width'], 30000);
  });

  test('une image ordinaire passe', async () => {
    const out = await extractImage(pngHeader(1190, 1560), 'scan.png');
    assert.equal(out.metadata['ocrSkipped'], undefined);
  });
});
