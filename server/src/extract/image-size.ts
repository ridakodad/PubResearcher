/**
 * Dimensions d'une image lues dans son en-tête, sans la décoder.
 *
 * Une image PNG de 100 Ko peut annoncer 30 000 x 30 000 pixels : décodée, elle réclame 3,6 Go.
 * La reconnaissance optique doit donc connaître la taille avant d'ouvrir l'image, pas après.
 */
export interface ImageSize {
  width: number;
  height: number;
}

export function readImageSize(buffer: Buffer): ImageSize | null {
  try {
    return png(buffer) ?? jpeg(buffer) ?? gif(buffer) ?? bmp(buffer) ?? webp(buffer) ?? tiff(buffer);
  } catch {
    return null;
  }
}

function png(b: Buffer): ImageSize | null {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function jpeg(b: Buffer): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let p = 2;
  while (p + 9 < b.length) {
    if (b[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = b[p + 1]!;
    if (marker === 0xff) {
      p++;
      continue;
    }
    // SOF0..SOF15 hors DHT (C4), JPG (C8) et DAC (CC) : l'en-tête de trame porte les dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(p + 5), width: b.readUInt16BE(p + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    p += 2 + b.readUInt16BE(p + 2);
  }
  return null;
}

function gif(b: Buffer): ImageSize | null {
  if (b.length < 10 || !b.toString('latin1', 0, 3).startsWith('GIF')) return null;
  return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function bmp(b: Buffer): ImageSize | null {
  if (b.length < 26 || b.toString('latin1', 0, 2) !== 'BM') return null;
  return { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)) };
}

function webp(b: Buffer): ImageSize | null {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const kind = b.toString('latin1', 12, 16);
  if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (kind === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  return null;
}

function tiff(b: Buffer): ImageSize | null {
  if (b.length < 8) return null;
  const little = b.toString('latin1', 0, 2) === 'II';
  if (!little && b.toString('latin1', 0, 2) !== 'MM') return null;
  const u16 = (o: number) => (little ? b.readUInt16LE(o) : b.readUInt16BE(o));
  const u32 = (o: number) => (little ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u16(2) !== 42) return null;
  const ifd = u32(4);
  if (ifd + 2 > b.length) return null;
  const count = u16(ifd);
  let width: number | null = null;
  let height: number | null = null;
  for (let i = 0; i < Math.min(count, 64); i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > b.length) break;
    const tag = u16(entry);
    const type = u16(entry + 2);
    const value = type === 3 ? u16(entry + 8) : u32(entry + 8);
    if (tag === 256) width = value;
    if (tag === 257) height = value;
  }
  return width !== null && height !== null ? { width, height } : null;
}
