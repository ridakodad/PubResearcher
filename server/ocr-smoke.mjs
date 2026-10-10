// Vérifie que l'OCR (tesseract.js) fonctionne dans cet environnement.
import zlib from 'node:zlib';

// --- police bitmap 5x7 minimale, suffisante pour un test OCR ---
const FONT = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  G: ['01110','10001','10000','10111','10001','10001','01110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  N: ['10001','11001','10101','10011','10001','10001','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  '5': ['11111','10000','11110','00001','00001','10001','01110'],
  '4': ['00010','00110','01010','10010','11111','00010','00010'],
  ':': ['00000','00100','00100','00000','00100','00100','00000'],
  ' ': ['00000','00000','00000','00000','00000','00000','00000'],
};

function renderText(text, scale = 10, pad = 30) {
  const w = pad * 2 + text.length * 6 * scale;
  const h = pad * 2 + 7 * scale;
  const px = Buffer.alloc(w * h, 255); // fond blanc, niveaux de gris
  text.split('').forEach((ch, ci) => {
    const glyph = FONT[ch] ?? FONT[' '];
    for (let gy = 0; gy < 7; gy++) {
      for (let gx = 0; gx < 5; gx++) {
        if (glyph[gy][gx] !== '1') continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const x = pad + ci * 6 * scale + gx * scale + sx;
            const y = pad + gy * scale + sy;
            px[y * w + x] = 0;
          }
        }
      }
    }
  });
  return { px, w, h };
}

function encodePng({ px, w, h }) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    px.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w);
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const png = encodePng(renderText('AGE 54ANS'));
console.log('PNG généré:', png.length, 'octets');

const t0 = Date.now();
try {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const path = await import('node:path');
  const langDir = path.dirname(require.resolve('@tesseract.js-data/fra/package.json'));
  const langPath = path.join(langDir, '4.0.0_best_int');
  console.log('langPath =', langPath);

  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('fra', 1, {
    langPath,
    cacheMethod: 'none',
    logger: () => {},
  });
  const { data } = await worker.recognize(png);
  console.log('OCR OK en', Date.now() - t0, 'ms ->', JSON.stringify(data.text.trim()));
  console.log('confiance:', data.confidence);
  await worker.terminate();
} catch (e) {
  console.log('OCR FAIL', e.message);
}
