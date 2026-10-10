import { createHash } from 'node:crypto';
import { db, nowIso } from '../db/index.js';
import type { TemplateWithFields } from '../domain/types.js';
import { appVersion } from '../version.js';

/**
 * Journal des passes d'extraction.
 *
 * Une valeur extraite n'a de sens que rapportée à ce qui l'a produite : quelle
 * fiche, quelles règles, quel moteur, quand. Chaque passe en garde la trace, avec
 * l'empreinte de la fiche — deux passes d'empreinte identique ont appliqué
 * exactement les mêmes règles, ce qui est la définition d'une analyse reproductible.
 */

export type RunStatus = 'running' | 'done' | 'failed';

export interface ExtractionRun {
  id: number;
  templateId: number | null;
  templateName: string;
  templateFingerprint: string;
  mode: string;
  model: string | null;
  overwriteManual: boolean;
  appVersion: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  patients: number;
  documents: number;
  extracted: number;
  notFound: number;
  keptManual: number;
  rejected: number;
}

interface RunRow {
  id: number;
  template_id: number | null;
  template_name: string;
  template_fingerprint: string;
  mode: string;
  model: string | null;
  overwrite_manual: number;
  app_version: string;
  started_at: string;
  finished_at: string | null;
  status: string;
  patients: number;
  documents: number;
  extracted: number;
  not_found: number;
  kept_manual: number;
  rejected: number;
}

function toRun(row: RunRow): ExtractionRun {
  return {
    id: row.id,
    templateId: row.template_id,
    templateName: row.template_name,
    templateFingerprint: row.template_fingerprint,
    mode: row.mode,
    model: row.model,
    overwriteManual: row.overwrite_manual === 1,
    appVersion: row.app_version,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status as RunStatus,
    patients: row.patients,
    documents: row.documents,
    extracted: row.extracted,
    notFound: row.not_found,
    keptManual: row.kept_manual,
    rejected: row.rejected,
  };
}

/** Ordonne récursivement les clés d'un objet : deux fiches égales donnent la même chaîne. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

/**
 * Empreinte d'une fiche : ce qui change le résultat d'une extraction (variables,
 * types, options, règles, post-traitements), à l'exclusion de ce qui n'y change rien
 * (identifiants internes, dates, description libre, position d'affichage).
 */
export function templateFingerprint(template: TemplateWithFields): string {
  const material = template.fields
    .slice()
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((f) => ({
      key: f.key,
      label: f.label,
      type: f.type,
      unit: f.unit,
      required: f.required,
      options: f.options,
      extraction: f.extraction,
    }));
  return createHash('sha256').update(JSON.stringify(canonical(material))).digest('hex');
}

export interface RunStart {
  template: TemplateWithFields;
  mode: string;
  model?: string | null;
  overwriteManual: boolean;
}

export function startRun(input: RunStart): number {
  const info = db
    .prepare(
      `INSERT INTO extraction_runs
         (template_id, template_name, template_fingerprint, mode, model, overwrite_manual, app_version, started_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
    )
    .run(
      input.template.id,
      input.template.name,
      templateFingerprint(input.template),
      input.mode,
      input.model ?? null,
      input.overwriteManual ? 1 : 0,
      appVersion,
      nowIso(),
    );
  return Number(info.lastInsertRowid);
}

export interface RunTotals {
  patients: number;
  documents: number;
  extracted: number;
  notFound: number;
  keptManual: number;
  rejected: number;
}

export function finishRun(id: number, status: RunStatus, totals: RunTotals): void {
  db.prepare(
    `UPDATE extraction_runs
        SET finished_at = ?, status = ?, patients = ?, documents = ?, extracted = ?, not_found = ?,
            kept_manual = ?, rejected = ?
      WHERE id = ?`,
  ).run(
    nowIso(),
    status,
    totals.patients,
    totals.documents,
    totals.extracted,
    totals.notFound,
    totals.keptManual,
    totals.rejected,
    id,
  );
}

/** Passes restées « en cours » parce que le serveur s'est arrêté pendant leur exécution. */
export function recoverInterruptedRuns(): number {
  return db
    .prepare(`UPDATE extraction_runs SET status = 'failed', finished_at = ? WHERE status = 'running'`)
    .run(nowIso()).changes;
}

export function listRuns(limit = 50): ExtractionRun[] {
  const rows = db
    .prepare('SELECT * FROM extraction_runs ORDER BY id DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 500)) as RunRow[];
  return rows.map(toRun);
}

export function getRun(id: number): ExtractionRun | null {
  const row = db.prepare('SELECT * FROM extraction_runs WHERE id = ?').get(id) as RunRow | undefined;
  return row ? toRun(row) : null;
}
