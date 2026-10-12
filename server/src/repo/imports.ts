import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso, parseJson, currentProject } from '../db/index.js';
import type { TableFormat } from '../table/types.js';
import { appVersion } from '../version.js';

/**
 * Journal des imports de tableaux de cohorte.
 *
 * Le pendant des passes d'extraction (`runs.ts`) pour les valeurs venues d'un tableau : quel fichier (conservé, avec
 * son empreinte), quelle feuille, quelle correspondance colonnes -> variables, quand, et ce qui a été écrit. Chaque
 * valeur importée renvoie à sa ligne par sa justification et par le journal des valeurs (`value_events.import_id`).
 */

export type ImportStatus = 'draft' | 'done';

export interface ColumnMapping {
  /** Index de la colonne (0 = A). */
  column: number;
  fieldId: number;
}

export interface ImportOptions {
  /** Créer les dossiers dont le code n'existe pas encore (sinon, leurs lignes sont ignorées). */
  createPatients: boolean;
  /** Remplacer les valeurs extraites (règles, Claude) ou importées auparavant qui diffèrent. */
  overwriteExtracted: boolean;
  /** Remplacer aussi les décisions des relecteurs (valeurs saisies, confirmées ou vidées). */
  overwriteManual: boolean;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = { createPatients: true, overwriteExtracted: false, overwriteManual: false };

export interface TableImport {
  id: number;
  templateId: number | null;
  templateName: string | null;
  templateFingerprint: string | null;
  filename: string;
  format: TableFormat;
  size: number;
  sha256: string;
  sheet: string | null;
  headerRow: number | null;
  codeColumn: number | null;
  mapping: ColumnMapping[];
  options: ImportOptions;
  status: ImportStatus;
  appVersion: string;
  createdAt: string;
  committedAt: string | null;
  dataRows: number;
  patientsCreated: number;
  patientsExisting: number;
  written: number;
  unchanged: number;
  rejected: number;
  conflicts: number;
}

interface ImportRow {
  id: number;
  template_id: number | null;
  template_name: string | null;
  template_fingerprint: string | null;
  filename: string;
  stored_name: string;
  format: string;
  size: number;
  sha256: string;
  sheet: string | null;
  header_row: number | null;
  code_column: number | null;
  mapping: string;
  options: string;
  status: string;
  app_version: string;
  created_at: string;
  committed_at: string | null;
  data_rows: number;
  patients_created: number;
  patients_existing: number;
  written: number;
  unchanged: number;
  rejected: number;
  conflicts: number;
}

function toImport(row: ImportRow): TableImport {
  return {
    id: row.id,
    templateId: row.template_id,
    templateName: row.template_name,
    templateFingerprint: row.template_fingerprint,
    filename: row.filename,
    format: row.format as TableFormat,
    size: row.size,
    sha256: row.sha256,
    sheet: row.sheet,
    headerRow: row.header_row,
    codeColumn: row.code_column,
    mapping: parseJson<ColumnMapping[]>(row.mapping, []),
    options: { ...DEFAULT_IMPORT_OPTIONS, ...parseJson<Partial<ImportOptions>>(row.options, {}) },
    status: row.status as ImportStatus,
    appVersion: row.app_version,
    createdAt: row.created_at,
    committedAt: row.committed_at,
    dataRows: row.data_rows,
    patientsCreated: row.patients_created,
    patientsExisting: row.patients_existing,
    written: row.written,
    unchanged: row.unchanged,
    rejected: row.rejected,
    conflicts: row.conflicts,
  };
}

export function importFilePath(storedName: string): string {
  return path.join(currentProject().importsDir, storedName);
}

export function createImportDraft(input: {
  filename: string;
  storedName: string;
  format: TableFormat;
  size: number;
  sha256: string;
}): TableImport {
  const info = db
    .prepare(
      `INSERT INTO table_imports (filename, stored_name, format, size, sha256, status, app_version, created_at)
       VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)`,
    )
    .run(input.filename, input.storedName, input.format, input.size, input.sha256, appVersion, nowIso());
  return getImport(Number(info.lastInsertRowid))!;
}

export function getImport(id: number): TableImport | null {
  const row = db.prepare('SELECT * FROM table_imports WHERE id = ?').get(id) as ImportRow | undefined;
  return row ? toImport(row) : null;
}

export function getImportFile(id: number): { path: string; filename: string; format: TableFormat } | null {
  const row = db.prepare('SELECT * FROM table_imports WHERE id = ?').get(id) as ImportRow | undefined;
  return row ? { path: importFilePath(row.stored_name), filename: row.filename, format: row.format as TableFormat } : null;
}

/** Imports confirmés, du plus récent au plus ancien. */
export function listImports(templateId?: number): TableImport[] {
  const rows = (
    templateId
      ? db.prepare(`SELECT * FROM table_imports WHERE status = 'done' AND template_id = ? ORDER BY id DESC`).all(templateId)
      : db.prepare(`SELECT * FROM table_imports WHERE status = 'done' ORDER BY id DESC`).all()
  ) as ImportRow[];
  return rows.map(toImport);
}

/** Imports confirmés d'un fichier identique (même empreinte) : le même tableau importé deux fois se signale. */
export function findImportsBySha(sha256: string): TableImport[] {
  return (db.prepare(`SELECT * FROM table_imports WHERE status = 'done' AND sha256 = ? ORDER BY id`).all(sha256) as ImportRow[]).map(toImport);
}

export interface ImportCompletion {
  template: { id: number; name: string; fingerprint: string };
  sheet: string | null;
  headerRow: number;
  codeColumn: number;
  mapping: ColumnMapping[];
  options: ImportOptions;
  dataRows: number;
  patientsCreated: number;
  patientsExisting: number;
  written: number;
  unchanged: number;
  rejected: number;
  conflicts: number;
}

/** Clôt un brouillon : l'import est confirmé, avec ses réglages et son bilan. À appeler dans la transaction des écritures. */
export function completeImport(id: number, done: ImportCompletion): void {
  db.prepare(
    `UPDATE table_imports
        SET template_id = ?, template_name = ?, template_fingerprint = ?, sheet = ?, header_row = ?, code_column = ?,
            mapping = ?, options = ?, status = 'done', committed_at = ?, data_rows = ?, patients_created = ?,
            patients_existing = ?, written = ?, unchanged = ?, rejected = ?, conflicts = ?
      WHERE id = ? AND status = 'draft'`,
  ).run(
    done.template.id,
    done.template.name,
    done.template.fingerprint,
    done.sheet,
    done.headerRow,
    done.codeColumn,
    JSON.stringify(done.mapping),
    JSON.stringify(done.options),
    nowIso(),
    done.dataRows,
    done.patientsCreated,
    done.patientsExisting,
    done.written,
    done.unchanged,
    done.rejected,
    done.conflicts,
    id,
  );
}

/** Abandon d'un brouillon : la ligne et le fichier disparaissent. Un import confirmé, lui, ne se supprime pas ici. */
export function deleteImportDraft(id: number): boolean {
  const row = db.prepare(`SELECT * FROM table_imports WHERE id = ? AND status = 'draft'`).get(id) as ImportRow | undefined;
  if (!row) return false;
  db.prepare('DELETE FROM table_imports WHERE id = ?').run(id);
  fs.rmSync(importFilePath(row.stored_name), { force: true });
  return true;
}

/**
 * Efface les brouillons d'import abandonnés depuis plus d'un jour, et leurs fichiers : ce sont des données de patients
 * qu'aucune valeur ne justifie. Appelée au démarrage.
 */
export function purgeStaleImportDrafts(maxAgeMs = 24 * 3600 * 1000): number {
  const limit = new Date(Date.now() - maxAgeMs).toISOString();
  const rows = db.prepare(`SELECT * FROM table_imports WHERE status = 'draft' AND created_at < ?`).all(limit) as ImportRow[];
  for (const row of rows) {
    db.prepare('DELETE FROM table_imports WHERE id = ?').run(row.id);
    fs.rmSync(importFilePath(row.stored_name), { force: true });
  }
  return rows.length;
}
