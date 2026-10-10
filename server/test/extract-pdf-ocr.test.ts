/**
 * PDF scannés : une page sans couche texte est rendue en image puis lue par l'OCR.
 *
 * Les trois PDF de `pdf-fixtures/` sont fabriqués (texte inventé, voir `make-fixtures.mjs`) :
 *   - scan.pdf   : une page, image seule — ce que produit un scanner ;
 *   - mixte.pdf  : page 1 scannée, page 2 avec couche texte ;
 *   - double.pdf : deux pages scannées.
 *
 * Sans OCR installé (données de langue absentes), la suite est ignorée plutôt qu'en échec :
 * le module est une dépendance optionnelle. Le comportement « OCR coupé » a son propre
 * fichier, `extract-pdf-noocr.test.ts`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-ocr-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '1';
delete process.env.OCR_MAX_PAGES;

const { extractPdf } = await import('../src/extract/pdf.js');
const { ocrStatus, shutdownOcr } = await import('../src/extract/ocr.js');
const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');

const fixture = (name: string): Buffer =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'pdf-fixtures', name));

const ocr = await ocrStatus();

describe('PDF scannés : reconnaissance optique', { skip: ocr.available ? false : `OCR indisponible : ${ocr.reason}` }, () => {
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
    await shutdownOcr();
    const { db } = await import('../src/db/index.js');
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('une page image seule devient du texte, avec la page et la confiance dans les métadonnées', async () => {
    const r = await extractPdf(fixture('scan.pdf'), 'scan.pdf');
    assert.match(r.text, /COMPTE RENDU/i);
    assert.match(r.text, /Âge\s*:\s*54 ans/);
    assert.match(r.text, /Sexe\s*:\s*Féminin/);
    assert.equal(r.metadata['textLayer'], true);
    assert.equal(r.metadata['ocrApplied'], true);
    assert.deepEqual(r.metadata['ocrPages'], [1]);
    assert.ok(Number(r.metadata['ocrConfidence']) >= 70, `confiance trop basse : ${String(r.metadata['ocrConfidence'])}`);
    assert.equal(r.metadata['ocrSkippedPages'], undefined);
  });

  test('un PDF mixte ne fait lire par l’OCR que la page sans texte', async () => {
    const r = await extractPdf(fixture('mixte.pdf'), 'mixte.pdf');
    assert.deepEqual(r.metadata['ocrPages'], [1], 'la page 2 a une couche texte : elle ne doit pas être reconnue');
    assert.match(r.text, /Âge\s*:\s*54 ans/, 'page 1 : lue par OCR');
    assert.match(r.text, /Poids : 71 kg/, 'page 2 : lue dans la couche texte, intacte');
  });

  test('OCR_MAX_PAGES plafonne le travail et le dit : les pages laissées sont comptées', async () => {
    process.env.OCR_MAX_PAGES = '1';
    try {
      const r = await extractPdf(fixture('double.pdf'), 'double.pdf');
      assert.deepEqual(r.metadata['ocrPages'], [1]);
      assert.equal(r.metadata['ocrSkippedPages'], 1);
      assert.match(r.text, /Âge\s*:\s*54 ans/);
    } finally {
      delete process.env.OCR_MAX_PAGES;
    }
  });

  test('OCR_MAX_PAGES=0 interdit l’OCR des PDF : page vide, rien de reconnu, rien d’inventé', async () => {
    process.env.OCR_MAX_PAGES = '0';
    try {
      const r = await extractPdf(fixture('scan.pdf'), 'scan.pdf');
      assert.equal(r.text.trim(), '');
      assert.equal(r.metadata['textLayer'], false);
      assert.equal(r.metadata['ocrApplied'], false);
    } finally {
      delete process.env.OCR_MAX_PAGES;
    }
  });

  test('de bout en bout : un scan importé alimente l’extraction, avec l’extrait qui la justifie', async () => {
    const created = await fetch(`${baseUrl}/api/patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'SCAN-001' }),
    });
    const patientId = ((await created.json()) as { patient: { id: number } }).patient.id;

    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(fixture('scan.pdf'))]), 'compte-rendu-scanne.pdf');
    const imported = await fetch(`${baseUrl}/api/patients/${patientId}/documents`, { method: 'POST', body: form });
    assert.equal(imported.status, 201);

    const detail = (await (await fetch(`${baseUrl}/api/patients/${patientId}`)).json()) as {
      documents: { parseStatus: string; metadata: Record<string, unknown> }[];
    };
    assert.equal(detail.documents.length, 1);
    assert.equal(detail.documents[0]?.parseStatus, 'ok');
    assert.equal(detail.documents[0]?.metadata['ocrApplied'], true);

    const run = await fetch(`${baseUrl}/api/records/extraction/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ patientIds: [patientId] }),
    });
    assert.equal(run.status, 200);

    const rec = (await (await fetch(`${baseUrl}/api/records?patientId=${patientId}`)).json()) as {
      template: { fields: { id: number; key: string }[] };
      record: { values: { fieldId: number; value: unknown; source: string; evidence?: { snippet?: string } | null }[] };
    };
    const byKey = new Map(
      rec.record.values.map((v) => [rec.template.fields.find((f) => f.id === v.fieldId)?.key, v] as const),
    );
    const age = byKey.get('age');
    assert.equal(age?.value, 54, 'l’âge lu dans l’image doit être extrait');
    assert.equal(age?.source, 'auto');
    assert.match(String(age?.evidence?.snippet ?? ''), /54/);
    assert.equal(byKey.get('sexe')?.value, 'Féminin');
  });
});
