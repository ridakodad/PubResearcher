import zlib from 'node:zlib';

/**
 * Écriture (et, plus bas, lecture) d'archives ZIP.
 *
 * Les formats bureautiques modernes — `.xlsx`, `.pptx`, `.docx` — sont des
 * archives ZIP de fichiers XML. Les produire ne demande donc qu'un écrivain
 * ZIP, que `node:zlib` permet d'écrire en une centaine de lignes.
 *
 * Le choix d'écrire plutôt que d'installer suit celui déjà fait pour SQLite :
 * l'application doit s'installer sans chaîne de compilation ni dépendance
 * lourde, sur un poste d'établissement où l'on n'ajoute pas ce qu'on veut.
 */

export interface ZipEntry {
  path: string;
  data: Buffer | string;
}

/** Somme de contrôle exigée par le format, en en-tête de chaque fichier. */
function crc32(buffer: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) {
    crc ^= buffer[i]!;
    for (let bit = 0; bit < 8; bit++) {
      // Polynôme inversé standard du CRC-32 (IEEE 802.3).
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ -1) >>> 0;
}

/**
 * Horodatage MS-DOS.
 *
 * Fixé à une date constante plutôt qu'à l'heure courante : deux exports du
 * même jeu de données produisent ainsi des fichiers identiques octet pour
 * octet, ce qui rend un export vérifiable et comparable.
 */
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;
const DOS_TIME = 0;

export function makeZip(entries: ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // Un contenu déjà dense peut gonfler à la compression : on garde alors le
    // brut, ce que le format autorise (méthode 0).
    const stored = deflated.length >= raw.length;
    const body = stored ? raw : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version minimale
    local.writeUInt16LE(0x0800, 6); // noms de fichiers en UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/**
 * Échappement XML.
 *
 * Un compte rendu contient des « < », des « & » et des guillemets ; un texte
 * mal échappé produirait un classeur que le tableur refuse d'ouvrir. Les
 * caractères de contrôle sont retirés : XML 1.0 les interdit, et l'OCR en
 * produit sur des scans médiocres.
 */
// Tout le plan de contrôle sauf tabulation, saut de ligne et retour chariot,
// que XML 1.0 accepte, plus les non-caractères de fin de plan.
const FORBIDDEN_IN_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

export function escapeXml(value: string): string {
  return value
    .replace(FORBIDDEN_IN_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ───────────────────────────────── Lecture ─────────────────────────────── */

/**
 * Lecture d'archives ZIP, pour les classeurs `.xlsx` reçus.
 *
 * Le pendant de l'écrivain ci-dessus, et pas davantage : l'annuaire central, puis la décompression d'une partie à la
 * demande. Une archive reçue est une donnée hostile jusqu'à preuve du contraire — quelques kilo-octets peuvent se
 * gonfler en gigaoctets. L'annuaire annonce la taille décompressée de chaque partie : on la plafonne avant d'ouvrir,
 * et la décompression elle-même s'arrête à la taille annoncée (`maxOutputLength`), de sorte qu'une archive qui ment
 * sur ses tailles ne peut pas en produire davantage.
 */

export interface ZipReadEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

export class ZipReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipReadError';
  }
}

export interface ZipReader {
  entries: Map<string, ZipReadEntry>;
  /** Somme des tailles décompressées annoncées. */
  totalUncompressed: number;
  /** Contenu décompressé d'une partie, `null` si elle n'existe pas. */
  read(name: string): Buffer | null;
}

export function openZip(buffer: Buffer): ZipReader {
  const from = Math.max(0, buffer.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= from; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipReadError('Ce fichier n’est pas une archive ZIP (classeur .xlsx tronqué ou d’un autre format).');

  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
    throw new ZipReadError('Archive au format ZIP64 : trop volumineuse pour un tableau de cohorte.');
  }
  if (offset + size > buffer.length) throw new ZipReadError('Archive ZIP tronquée : l’annuaire dépasse la fin du fichier.');

  const entries = new Map<string, ZipReadEntry>();
  let total = 0;
  let p = offset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) {
      throw new ZipReadError('Archive ZIP corrompue : annuaire illisible.');
    }
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const uncompressedSize = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localHeaderOffset = buffer.readUInt32LE(p + 42);
    if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new ZipReadError('Archive au format ZIP64 : trop volumineuse pour un tableau de cohorte.');
    }
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLength).replace(/\\/g, '/');
    entries.set(name, { name, method, flags, compressedSize, uncompressedSize, localHeaderOffset });
    total += uncompressedSize;
    p += 46 + nameLength + extraLength + commentLength;
  }

  return {
    entries,
    totalUncompressed: total,
    read(name) {
      const entry = entries.get(name);
      if (!entry) return null;
      if (entry.flags & 0x1) throw new ZipReadError('Classeur chiffré (protégé par mot de passe) : retirez la protection, puis réimportez-le.');
      const at = entry.localHeaderOffset;
      if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) {
        throw new ZipReadError(`Archive ZIP corrompue : partie « ${name} » introuvable.`);
      }
      const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
      const end = start + entry.compressedSize;
      if (end > buffer.length) throw new ZipReadError(`Archive ZIP tronquée : partie « ${name} » incomplète.`);
      const body = buffer.subarray(start, end);
      if (entry.method === 0) {
        if (entry.compressedSize !== entry.uncompressedSize) throw new ZipReadError(`Archive ZIP corrompue : partie « ${name} ».`);
        return Buffer.from(body);
      }
      if (entry.method !== 8) throw new ZipReadError(`Méthode de compression non prise en charge (${entry.method}) pour « ${name} ».`);
      try {
        // La sortie est bornée à la taille annoncée : une partie qui se gonfle au-delà est refusée, pas décompressée.
        return zlib.inflateRawSync(body, { maxOutputLength: Math.max(entry.uncompressedSize, 1) });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) {
          throw new ZipReadError(`Archive piégée : la partie « ${name} » se décompresse au-delà de la taille qu’elle annonce.`);
        }
        throw new ZipReadError(`Archive ZIP corrompue : partie « ${name} » illisible.`);
      }
    },
  };
}
