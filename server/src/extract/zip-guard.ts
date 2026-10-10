/**
 * Lecture de l'annuaire d'une archive ZIP (sans rien décompresser).
 *
 * Un fichier Word est une archive : quelques centaines de kilo-octets peuvent en contenir cent
 * mégaoctets de XML répétitif, que la conversion en HTML gonfle ensuite jusqu'à plusieurs
 * gigaoctets de mémoire. L'annuaire central de l'archive annonce la taille décompressée de
 * chaque partie : la lire coûte quelques microsecondes et permet de refuser avant d'ouvrir.
 */

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
}

export interface ZipDirectory {
  entries: ZipEntry[];
  /** Une taille ne tient pas sur 32 bits : archive ZIP64, trop grosse pour un document de compte rendu. */
  zip64: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

/** `null` si le tampon n'a pas la forme d'une archive ZIP (l'extracteur dira alors lui-même ce qui ne va pas). */
export function readZipDirectory(buffer: Buffer): ZipDirectory | null {
  // L'enregistrement de fin d'annuaire est dans les 64 Ko + 22 octets de la fin (commentaire inclus).
  const from = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= from; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;

  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    return { entries: [], zip64: true };
  }
  if (offset + size > buffer.length) return null;

  const entries: ZipEntry[] = [];
  let zip64 = false;
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== CENTRAL_SIGNATURE) return null;
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff) zip64 = true;
    entries.push({
      name: buffer.toString('utf8', p + 46, p + 46 + nameLength),
      compressedSize,
      uncompressedSize,
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, zip64 };
}
