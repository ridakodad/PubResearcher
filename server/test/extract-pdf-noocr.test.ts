/**
 * PDF scanné quand l'OCR est coupé (OCR_ENABLED=0) : le fichier est importé, la page reste vide,
 * et rien n'est inventé. Le document porte alors `textLayer: false`, que l'interface signale.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.OCR_ENABLED = '0';

const { extractPdf } = await import('../src/extract/pdf.js');

const fixture = (name: string): Buffer =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'pdf-fixtures', name));

describe('PDF scanné sans OCR', () => {
  test('page vide, aucune couche texte, aucune reconnaissance annoncée', async () => {
    const r = await extractPdf(fixture('scan.pdf'), 'scan.pdf');
    assert.equal(r.text.trim(), '');
    assert.equal(r.metadata['pageCount'], 1);
    assert.equal(r.metadata['textLayer'], false);
    assert.equal(r.metadata['ocrApplied'], false);
    assert.equal(r.metadata['ocrPages'], undefined);
  });

  test('un PDF mixte garde le texte de sa couche texte et laisse la page scannée vide', async () => {
    const r = await extractPdf(fixture('mixte.pdf'), 'mixte.pdf');
    assert.match(r.text, /Poids : 71 kg/);
    assert.doesNotMatch(r.text, /COMPTE RENDU/i);
    assert.equal(r.metadata['textLayer'], true);
    assert.equal(r.metadata['ocrApplied'], false);
  });
});
