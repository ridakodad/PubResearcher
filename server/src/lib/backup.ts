import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Sauvegarde et restauration des données d'une étude : la base SQLite et les fichiers des dossiers.
 *
 * Une sauvegarde est un dossier autonome :
 *
 *   research-tool-sauvegarde-AAAAMMJJ-HHMMSS/
 *     research-tool.db      copie cohérente de la base (VACUUM INTO : l'outil peut tourner pendant ce temps)
 *     uploads/              les fichiers des dossiers patients, tels quels
 *     MANIFEST.json         version, nombre de lignes, taille et empreinte SHA-256 de chaque fichier
 *
 * La restauration vérifie d'abord les empreintes : une sauvegarde abîmée (copie interrompue, disque
 * défaillant) est refusée avant qu'elle ne remplace quoi que ce soit.
 *
 * Attention : une sauvegarde contient des données de patients, telles qu'elles sont dans l'outil. Elle
 * se range et se détruit avec les mêmes précautions que les dossiers eux-mêmes.
 */

export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: 1;
  createdAt: string;
  appVersion: string;
  schemaVersion: number;
  counts: { patients: number; documents: number; templates: number; records: number; values: number };
  files: ManifestFile[];
}

const MANIFEST = 'MANIFEST.json';
const DB_NAME = 'research-tool.db';

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full, base);
    return entry.isFile() ? [path.relative(base, full)] : [];
  });
}

const stamp = (d: Date): string =>
  d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

export interface BackupInput {
  dbPath: string;
  uploadsDir: string;
  /** Dossier dans lequel créer la sauvegarde (un sous-dossier daté y est ajouté). */
  destination: string;
  appVersion: string;
  now?: Date;
}

export async function createBackup(input: BackupInput): Promise<{ directory: string; manifest: BackupManifest }> {
  if (!fs.existsSync(input.dbPath)) throw new Error(`Base introuvable : ${input.dbPath}`);

  const directory = path.join(input.destination, `research-tool-sauvegarde-${stamp(input.now ?? new Date())}`);
  if (fs.existsSync(directory)) throw new Error(`Cette sauvegarde existe déjà : ${directory}`);
  fs.mkdirSync(path.join(directory, 'uploads'), { recursive: true });

  // VACUUM INTO écrit un instantané cohérent même si le serveur écrit en même temps (mode WAL).
  const source = new DatabaseSync(input.dbPath);
  let schemaVersion = 0;
  const counts = { patients: 0, documents: 0, templates: 0, records: 0, values: 0 };
  try {
    source.exec('PRAGMA busy_timeout = 10000');
    const target = path.join(directory, DB_NAME).replace(/'/g, "''");
    source.exec(`VACUUM INTO '${target}'`);
    schemaVersion = Number((source.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    const count = (table: string): number => Number((source.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    counts.patients = count('patients');
    counts.documents = count('documents');
    counts.templates = count('templates');
    counts.records = count('records');
    counts.values = count('record_values');
  } finally {
    source.close();
  }

  // Fichiers des dossiers. Le dépôt provisoire (.incoming) n'est pas une donnée : il est ignoré.
  for (const rel of walk(input.uploadsDir)) {
    if (rel.split(path.sep)[0] === '.incoming') continue;
    const to = path.join(directory, 'uploads', rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(input.uploadsDir, rel), to);
  }

  const files: ManifestFile[] = [];
  for (const rel of walk(directory).sort()) {
    if (rel === MANIFEST) continue;
    const full = path.join(directory, rel);
    files.push({ path: rel.split(path.sep).join('/'), bytes: fs.statSync(full).size, sha256: await sha256(full) });
  }

  const manifest: BackupManifest = {
    format: 1,
    createdAt: (input.now ?? new Date()).toISOString(),
    appVersion: input.appVersion,
    schemaVersion,
    counts,
    files,
  };
  fs.writeFileSync(path.join(directory, MANIFEST), JSON.stringify(manifest, null, 2));
  return { directory, manifest };
}

export interface VerifyResult {
  ok: boolean;
  manifest: BackupManifest | null;
  problems: string[];
}

/** Relit la sauvegarde et compare chaque fichier à l'empreinte du manifeste. */
export async function verifyBackup(directory: string): Promise<VerifyResult> {
  const manifestPath = path.join(directory, MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, manifest: null, problems: [`Ce dossier n'est pas une sauvegarde (${MANIFEST} absent).`] };
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as BackupManifest;
  } catch {
    return { ok: false, manifest: null, problems: [`${MANIFEST} illisible.`] };
  }
  if (manifest.format !== 1 || !Array.isArray(manifest.files)) {
    return { ok: false, manifest, problems: ['Format de sauvegarde inconnu.'] };
  }

  const problems: string[] = [];
  const listed = new Set<string>();
  for (const file of manifest.files) {
    listed.add(file.path);
    const full = path.join(directory, ...file.path.split('/'));
    // Un manifeste ne désigne que l'intérieur de la sauvegarde.
    if (path.relative(directory, full).startsWith('..') || path.isAbsolute(file.path)) {
      problems.push(`Chemin suspect dans le manifeste : ${file.path}`);
      continue;
    }
    if (!fs.existsSync(full)) {
      problems.push(`Fichier manquant : ${file.path}`);
    } else if (fs.statSync(full).size !== file.bytes) {
      problems.push(`Taille différente : ${file.path}`);
    } else if ((await sha256(full)) !== file.sha256) {
      problems.push(`Empreinte différente (fichier altéré) : ${file.path}`);
    }
  }
  for (const rel of walk(directory)) {
    const normalized = rel.split(path.sep).join('/');
    if (normalized !== MANIFEST && !listed.has(normalized)) problems.push(`Fichier inattendu : ${normalized}`);
  }
  if (!listed.has(DB_NAME)) problems.push('La base est absente de la sauvegarde.');
  return { ok: problems.length === 0, manifest, problems };
}

export interface RestoreInput {
  backupDir: string;
  dbPath: string;
  uploadsDir: string;
  /** Remplacer des données existantes (elles sont d'abord mises de côté, jamais supprimées). */
  force?: boolean;
  now?: Date;
}

/**
 * Restaure une sauvegarde vérifiée. Si des données existent, `force` est exigé ; elles sont alors déplacées
 * à côté (`.avant-restauration-AAAAMMJJ-HHMMSS`) plutôt que supprimées, pour pouvoir revenir en arrière.
 * L'outil doit être arrêté.
 */
export async function restoreBackup(input: RestoreInput): Promise<{ manifest: BackupManifest; aside: string[] }> {
  const check = await verifyBackup(input.backupDir);
  if (!check.ok || !check.manifest) {
    throw new Error(`Sauvegarde refusée :\n  - ${check.problems.join('\n  - ')}`);
  }

  const existing = [input.dbPath, input.uploadsDir].filter((p) => fs.existsSync(p) && (fs.statSync(p).isFile() || fs.readdirSync(p).length > 0));
  if (existing.length > 0 && !input.force) {
    throw new Error(
      `Des données existent déjà (${existing.join(', ')}). Relancez avec --force pour les remplacer : elles seront mises de côté, pas supprimées.`,
    );
  }

  const suffix = `.avant-restauration-${stamp(input.now ?? new Date())}`;
  const aside: string[] = [];
  for (const p of [input.dbPath, `${input.dbPath}-wal`, `${input.dbPath}-shm`, input.uploadsDir]) {
    if (fs.existsSync(p)) {
      fs.renameSync(p, p + suffix);
      aside.push(p + suffix);
    }
  }

  fs.mkdirSync(path.dirname(input.dbPath), { recursive: true });
  fs.copyFileSync(path.join(input.backupDir, DB_NAME), input.dbPath);
  fs.mkdirSync(input.uploadsDir, { recursive: true });
  for (const rel of walk(path.join(input.backupDir, 'uploads'))) {
    const to = path.join(input.uploadsDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(input.backupDir, 'uploads', rel), to);
  }
  fs.mkdirSync(path.join(input.uploadsDir, '.incoming'), { recursive: true });
  return { manifest: check.manifest, aside };
}
