/**
 * Sauvegarde et restauration : un instantané cohérent, vérifiable, qui ne remplace rien sans le dire.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from '../src/db/schema.js';
import { migrate } from '../src/db/migrations.js';
import { createBackup, restoreBackup, verifyBackup } from '../src/lib/backup.js';

let root: string;
let dbPath: string;
let uploadsDir: string;

const write = (file: string, content: string | Buffer): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

function seedDatabase(file: string, patients: number): void {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  const insert = db.prepare("INSERT INTO patients (code, created_at, updated_at) VALUES (?, 't', 't')");
  for (let i = 1; i <= patients; i++) insert.run(`P-${i}`);
  db.close();
}

const patientCodes = (file: string): string[] => {
  const db = new DatabaseSync(file);
  try {
    return (db.prepare('SELECT code FROM patients ORDER BY id').all() as { code: string }[]).map((r) => r.code);
  } finally {
    db.close();
  }
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-backup-'));
  dbPath = path.join(root, 'data', 'research-tool.db');
  uploadsDir = path.join(root, 'data', 'uploads');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  seedDatabase(dbPath, 3);
  write(path.join(uploadsDir, '1', 'a.pdf'), 'contenu pdf');
  write(path.join(uploadsDir, '1', 'b.txt'), 'Âge : 54 ans');
  write(path.join(uploadsDir, '2', 'c.docx'), Buffer.from([0, 1, 2, 3, 255]));
  write(path.join(uploadsDir, '.incoming', 'en-cours'), 'à ne pas sauvegarder');
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('sauvegarde', () => {
  test('contient la base, les fichiers et un manifeste vérifiable', async () => {
    const { directory, manifest } = await createBackup({
      dbPath,
      uploadsDir,
      destination: path.join(root, 'sauvegardes'),
      appVersion: '1.2.3',
      now: new Date('2026-10-08T23:15:00Z'),
    });
    assert.match(path.basename(directory), /^research-tool-sauvegarde-20261008-231500$/);
    assert.equal(manifest.appVersion, '1.2.3');
    assert.equal(manifest.counts.patients, 3);
    assert.deepEqual(
      manifest.files.map((f) => f.path),
      ['research-tool.db', 'uploads/1/a.pdf', 'uploads/1/b.txt', 'uploads/2/c.docx'],
      'le dépôt provisoire n’est pas une donnée',
    );
    assert.ok(manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
    assert.deepEqual(patientCodes(path.join(directory, 'research-tool.db')), ['P-1', 'P-2', 'P-3']);
    assert.deepEqual(await verifyBackup(directory), { ok: true, manifest, problems: [] });
  });

  test('copie une base ouverte en écriture sans la corrompre', async () => {
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode = WAL');
    writer.exec("INSERT INTO patients (code, created_at, updated_at) VALUES ('P-EN-COURS', 't', 't')"); // dans le WAL, pas encore dans le fichier
    try {
      const { directory } = await createBackup({ dbPath, uploadsDir, destination: path.join(root, 'sauv'), appVersion: '1' });
      assert.ok(patientCodes(path.join(directory, 'research-tool.db')).includes('P-EN-COURS'), 'l’écriture récente doit figurer');
    } finally {
      writer.close();
    }
  });

  test('refuse d’écraser une sauvegarde de la même seconde, et une base absente', async () => {
    const input = { dbPath, uploadsDir, destination: path.join(root, 's'), appVersion: '1', now: new Date('2026-01-01T00:00:00Z') };
    await createBackup(input);
    await assert.rejects(createBackup(input), /existe déjà/);
    await assert.rejects(createBackup({ ...input, dbPath: path.join(root, 'absente.db') }), /Base introuvable/);
  });
});

describe('vérification', () => {
  async function backup() {
    return (await createBackup({ dbPath, uploadsDir, destination: path.join(root, 'sauv'), appVersion: '1' })).directory;
  }

  test('détecte un fichier altéré, manquant, ajouté ou tronqué', async () => {
    const dir = await backup();
    fs.writeFileSync(path.join(dir, 'uploads', '1', 'b.txt'), 'Âge : 55 ans'); // même taille, contenu changé
    assert.match((await verifyBackup(dir)).problems.join('\n'), /Empreinte différente.*uploads\/1\/b\.txt/);

    fs.rmSync(path.join(dir, 'uploads', '2', 'c.docx'));
    assert.match((await verifyBackup(dir)).problems.join('\n'), /Fichier manquant.*c\.docx/);

    write(path.join(dir, 'uploads', 'intrus.txt'), 'x');
    assert.match((await verifyBackup(dir)).problems.join('\n'), /Fichier inattendu.*intrus/);

    fs.writeFileSync(path.join(dir, 'uploads', '1', 'a.pdf'), 'court');
    assert.match((await verifyBackup(dir)).problems.join('\n'), /Taille différente.*a\.pdf/);
  });

  test('refuse un dossier qui n’est pas une sauvegarde et un manifeste qui sort du dossier', async () => {
    assert.equal((await verifyBackup(root)).ok, false);
    const dir = await backup();
    const manifestPath = path.join(dir, 'MANIFEST.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files.push({ path: '../../etc/passwd', bytes: 1, sha256: 'x' });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.match((await verifyBackup(dir)).problems.join('\n'), /Chemin suspect/);
    fs.writeFileSync(manifestPath, '{ pas du json');
    assert.match((await verifyBackup(dir)).problems.join('\n'), /illisible/);
  });
});

describe('restauration', () => {
  async function backup() {
    return (await createBackup({ dbPath, uploadsDir, destination: path.join(root, 'sauv'), appVersion: '1' })).directory;
  }

  test('rend exactement ce qui avait été sauvegardé, sur un poste vide', async () => {
    const dir = await backup();
    const fresh = path.join(root, 'neuf');
    const result = await restoreBackup({ backupDir: dir, dbPath: path.join(fresh, 'x.db'), uploadsDir: path.join(fresh, 'uploads') });
    assert.deepEqual(result.aside, []);
    assert.deepEqual(patientCodes(path.join(fresh, 'x.db')), ['P-1', 'P-2', 'P-3']);
    assert.equal(fs.readFileSync(path.join(fresh, 'uploads', '1', 'b.txt'), 'utf8'), 'Âge : 54 ans');
    assert.deepEqual(fs.readFileSync(path.join(fresh, 'uploads', '2', 'c.docx')), Buffer.from([0, 1, 2, 3, 255]));
    assert.ok(fs.existsSync(path.join(fresh, 'uploads', '.incoming')), 'le dépôt provisoire est recréé');
  });

  test('ne remplace pas des données existantes sans --force, et les met de côté avec', async () => {
    const dir = await backup();
    // l'étude a avancé depuis la sauvegarde
    const db = new DatabaseSync(dbPath);
    db.exec("INSERT INTO patients (code, created_at, updated_at) VALUES ('P-4', 't', 't')");
    db.close();
    write(path.join(uploadsDir, '4', 'nouveau.txt'), 'récent');

    await assert.rejects(restoreBackup({ backupDir: dir, dbPath, uploadsDir }), /--force/);
    assert.deepEqual(patientCodes(dbPath), ['P-1', 'P-2', 'P-3', 'P-4'], 'rien n’a bougé');

    const { aside } = await restoreBackup({ backupDir: dir, dbPath, uploadsDir, force: true, now: new Date('2026-10-09T08:00:00Z') });
    assert.deepEqual(patientCodes(dbPath), ['P-1', 'P-2', 'P-3']);
    assert.equal(fs.existsSync(path.join(uploadsDir, '4')), false);
    assert.equal(aside.length, 2);
    for (const p of aside) assert.match(p, /\.avant-restauration-20261009-080000$/);
    assert.deepEqual(patientCodes(aside.find((p) => p.includes('.db'))!), ['P-1', 'P-2', 'P-3', 'P-4'], 'les données remplacées sont récupérables');
    assert.equal(fs.readFileSync(path.join(aside.find((p) => p.includes('uploads'))!, '4', 'nouveau.txt'), 'utf8'), 'récent');
  });

  test('une sauvegarde abîmée est refusée avant de toucher quoi que ce soit', async () => {
    const dir = await backup();
    fs.writeFileSync(path.join(dir, 'uploads', '1', 'a.pdf'), 'corrompu!!');
    await assert.rejects(restoreBackup({ backupDir: dir, dbPath, uploadsDir, force: true }), /Sauvegarde refusée/);
    assert.deepEqual(patientCodes(dbPath), ['P-1', 'P-2', 'P-3']);
    assert.equal(fs.readFileSync(path.join(uploadsDir, '1', 'a.pdf'), 'utf8'), 'contenu pdf');
  });

  test('la base restaurée s’ouvre avec le schéma attendu', async () => {
    const dir = await backup();
    const fresh = path.join(root, 'neuf');
    await restoreBackup({ backupDir: dir, dbPath: path.join(fresh, 'x.db'), uploadsDir: path.join(fresh, 'uploads') });
    const db = new DatabaseSync(path.join(fresh, 'x.db'));
    const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
    db.close();
    assert.ok(version >= 1);
  });
});
