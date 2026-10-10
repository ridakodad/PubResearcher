/**
 * Images : une photo ou un scan de compte rendu est lu par l'OCR, et sa date de prise de vue vient de l'EXIF.
 *
 * Une seule image est versionnée (`image-fixtures/scan-texte.png`, texte inventé, voir `make-fixtures.mjs`) : le JPEG
 * (avec une date et un appareil EXIF) et le TIFF sont fabriqués ici à partir d'elle, pour que chaque format annoncé
 * (JPEG, PNG, TIFF) passe par la vraie chaîne — détection du type, lecture de l'en-tête, OCR, EXIF.
 *
 * Sans OCR installé (données de langue absentes), la suite est ignorée plutôt qu'en échec.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-images-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '1';

const { parseDocument } = await import('../src/extract/index.js');
const { ocrStatus, shutdownOcr } = await import('../src/extract/ocr.js');
const { createCanvas, loadImage } = await import('@napi-rs/canvas');

const here = path.dirname(fileURLToPath(import.meta.url));
const png = fs.readFileSync(path.join(here, 'image-fixtures', 'scan-texte.png'));
const ocr = await ocrStatus();

after(async () => {
  await shutdownOcr();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Segment APP1 « Exif » (TIFF grand boutiste) portant un fabricant et une date de prise de vue. */
function exifSegment(make: string, dateTimeOriginal: string): Buffer {
  const makeBytes = Buffer.from(`${make}\0`, 'latin1');
  const dateBytes = Buffer.from(`${dateTimeOriginal}\0`, 'latin1');
  const ifd0 = 8;
  const makeAt = ifd0 + 2 + 2 * 12 + 4;
  const exifIfd = makeAt + makeBytes.length;
  const dateAt = exifIfd + 2 + 12 + 4;
  const tiff = Buffer.alloc(dateAt + dateBytes.length);
  tiff.write('MM', 0, 'latin1');
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0, 4);
  tiff.writeUInt16BE(2, ifd0); // deux entrées : fabricant, pointeur vers l'IFD Exif
  let at = ifd0 + 2;
  tiff.writeUInt16BE(0x010f, at); tiff.writeUInt16BE(2, at + 2); tiff.writeUInt32BE(makeBytes.length, at + 4); tiff.writeUInt32BE(makeAt, at + 8);
  at += 12;
  tiff.writeUInt16BE(0x8769, at); tiff.writeUInt16BE(4, at + 2); tiff.writeUInt32BE(1, at + 4); tiff.writeUInt32BE(exifIfd, at + 8);
  makeBytes.copy(tiff, makeAt);
  tiff.writeUInt16BE(1, exifIfd); // une entrée : DateTimeOriginal
  tiff.writeUInt16BE(0x9003, exifIfd + 2); tiff.writeUInt16BE(2, exifIfd + 4); tiff.writeUInt32BE(dateBytes.length, exifIfd + 6); tiff.writeUInt32BE(dateAt, exifIfd + 10);
  dateBytes.copy(tiff, dateAt);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
  const header = Buffer.from([0xff, 0xe1, 0, 0]);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

async function pixels(): Promise<{ width: number; height: number; gray: Buffer; jpeg: Buffer }> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  const rgba = context.getImageData(0, 0, image.width, image.height).data;
  const gray = Buffer.alloc(image.width * image.height);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!);
  return { width: image.width, height: image.height, gray, jpeg: canvas.toBuffer('image/jpeg', 92) };
}

/** TIFF de base : niveaux de gris, 8 bits, sans compression, une seule bande. */
function tiff(width: number, height: number, gray: Buffer): Buffer {
  const entries: [number, number, number, number][] = [
    [256, 4, 1, width], [257, 4, 1, height], [258, 3, 1, 8], [259, 3, 1, 1], [262, 3, 1, 1],
    [273, 4, 1, 0], [277, 3, 1, 1], [278, 4, 1, height], [279, 4, 1, gray.length],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const dataAt = 8 + ifdSize;
  const out = Buffer.alloc(dataAt + gray.length);
  out.write('II', 0, 'latin1');
  out.writeUInt16LE(42, 2);
  out.writeUInt32LE(8, 4);
  out.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, count, value], i) => {
    const at = 10 + i * 12;
    out.writeUInt16LE(tag, at); out.writeUInt16LE(type, at + 2); out.writeUInt32LE(count, at + 4);
    if (type === 3) out.writeUInt16LE(value, at + 8);
    else out.writeUInt32LE(tag === 273 ? dataAt : value, at + 8);
  });
  gray.copy(out, dataAt);
  return out;
}

describe('images : reconnaissance optique et EXIF', { skip: ocr.available ? false : `OCR indisponible : ${ocr.reason}` }, () => {
  test('PNG : le texte est lu, l’image garde son nom, ses dimensions et la confiance de l’OCR', async () => {
    const r = await parseDocument(png, 'scan-texte.png', 'image/png');
    assert.equal(r.kind, 'image');
    assert.equal(r.status, 'ok', String(r.error));
    assert.match(r.text, /^Image: scan-texte\.png/);
    assert.match(r.text, /Âge\s*:\s*54 ans/);
    assert.match(r.text, /Sexe\s*:\s*Féminin/);
    assert.match(r.text, /CRP\s*:\s*142 mg\/L/);
    assert.equal(r.metadata['ocrApplied'], true);
    assert.equal(r.metadata['width'], 820);
    assert.equal(r.metadata['height'], 380);
    assert.ok(Number(r.metadata['ocrConfidence']) >= 70, `confiance : ${String(r.metadata['ocrConfidence'])}`);
  });

  test('JPEG : la date de prise de vue et l’appareil viennent de l’EXIF, le texte de l’OCR', async () => {
    const { jpeg } = await pixels();
    assert.equal(jpeg[0], 0xff);
    assert.equal(jpeg[1], 0xd8);
    // L'EXIF s'insère juste après le marqueur de début d'image.
    const withExif = Buffer.concat([jpeg.subarray(0, 2), exifSegment('AppareilEssai', '2024:03:12 08:30:00'), jpeg.subarray(2)]);
    const r = await parseDocument(withExif, 'photo-cr.jpg', 'image/jpeg');
    assert.equal(r.kind, 'image');
    assert.equal(r.status, 'ok', String(r.error));
    assert.match(r.text, /Date du cliché: 2024-03-12/);
    assert.match(r.text, /Appareil: AppareilEssai/);
    assert.match(r.text, /Âge\s*:\s*54 ans/);
    assert.equal(r.metadata['make'], 'AppareilEssai');
  });

  test('JPEG sans EXIF : pas de date inventée', async () => {
    const { jpeg } = await pixels();
    const r = await parseDocument(jpeg, 'photo-sans-exif.jpg', 'image/jpeg');
    assert.equal(r.status, 'ok', String(r.error));
    assert.doesNotMatch(r.text, /Date du cliché/);
    assert.match(r.text, /Âge\s*:\s*54 ans/);
  });

  test('TIFF : lu comme les autres, y compris sans extension reconnue par le navigateur', async () => {
    const { width, height, gray } = await pixels();
    const file = tiff(width, height, gray);
    for (const [name, mime] of [['scan.tif', 'image/tiff'], ['scan.tiff', 'application/octet-stream']] as const) {
      const r = await parseDocument(file, name, mime);
      assert.equal(r.kind, 'image', name);
      assert.equal(r.status, 'ok', `${name} : ${String(r.error)}`);
      assert.match(r.text, /Âge\s*:\s*54 ans/, name);
      assert.equal(r.metadata['width'], 820, name);
    }
  });
});
