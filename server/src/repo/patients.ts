import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso, currentProject } from '../db/index.js';
import type { Patient } from '../domain/types.js';

interface PatientRow {
  id: number;
  code: string;
  label: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

function toPatient(row: PatientRow): Patient {
  return {
    id: row.id,
    code: row.code,
    label: row.label,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Patient enrichi des compteurs utiles à la liste des dossiers. */
export interface PatientSummary extends Patient {
  documentCount: number;
  /** Documents dont l'analyse a échoué ou n'a produit aucun texte. */
  unreadableCount: number;
}

const CODE_ORDER = new Intl.Collator('fr', { numeric: true, sensitivity: 'base' });

export function listPatients(): PatientSummary[] {
  const rows = db
    .prepare(
      `SELECT p.*,
              COUNT(d.id) AS document_count,
              COALESCE(SUM(CASE WHEN d.parse_status IN ('error','empty') THEN 1 ELSE 0 END), 0) AS unreadable_count
         FROM patients p
         LEFT JOIN documents d ON d.patient_id = p.id
        GROUP BY p.id`,
    )
    .all() as (PatientRow & { document_count: number; unreadable_count: number })[];

  // Ordre naturel : P-2 avant P-10 (le tri alphabétique de SQLite donnerait P-1, P-10, P-2), accents et
  // casse sans effet. C'est l'ordre des lignes de la liste, du tableau de résultats et des exports.
  return rows
    .map((r) => ({
      ...toPatient(r),
      documentCount: r.document_count,
      unreadableCount: r.unreadable_count,
    }))
    .sort((a, b) => CODE_ORDER.compare(a.code, b.code) || a.id - b.id);
}

export function getPatient(id: number): Patient | null {
  const row = db.prepare('SELECT * FROM patients WHERE id = ?').get(id) as PatientRow | undefined;
  return row ? toPatient(row) : null;
}

export function getPatientByCode(code: string): Patient | null {
  const row = db
    .prepare('SELECT * FROM patients WHERE code = ? COLLATE NOCASE')
    .get(code) as PatientRow | undefined;
  return row ? toPatient(row) : null;
}

export function createPatient(input: {
  code: string;
  label?: string | null;
  notes?: string | null;
}): Patient {
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO patients (code, label, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(input.code, input.label ?? null, input.notes ?? null, ts, ts);
  return getPatient(Number(info.lastInsertRowid))!;
}

/** Récupère le dossier ou le crée s'il n'existe pas (import par lot). */
export function ensurePatient(code: string): Patient {
  return getPatientByCode(code) ?? createPatient({ code });
}

export function updatePatient(
  id: number,
  input: { code?: string; label?: string | null; notes?: string | null },
): Patient | null {
  const current = getPatient(id);
  if (!current) return null;
  db.prepare(
    `UPDATE patients SET code = ?, label = ?, notes = ?, updated_at = ? WHERE id = ?`,
  ).run(
    input.code ?? current.code,
    input.label !== undefined ? input.label : current.label,
    input.notes !== undefined ? input.notes : current.notes,
    nowIso(),
    id,
  );
  return getPatient(id);
}

/**
 * Supprime un dossier patient — ses lignes ET ses fichiers.
 *
 * La suppression en cascade de la base ne touche pas au disque : sans le
 * `rmSync` ci-dessous, les comptes rendus d'un dossier « supprimé » resteraient
 * lisibles sous `uploads/<id>/`, ce qui est exactement ce que la personne qui
 * supprime ne veut pas.
 */
export function deletePatient(id: number): boolean {
  const removed = db.prepare('DELETE FROM patients WHERE id = ?').run(id).changes > 0;
  if (removed) {
    fs.rmSync(path.join(currentProject().uploadsDir, String(id)), { recursive: true, force: true });
  }
  return removed;
}
