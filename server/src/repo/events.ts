import { db, parseJson } from '../db/index.js';
import type { FieldValue } from '../domain/types.js';
import type { EventAction } from './records.js';

/**
 * Lecture du journal des changements de valeur.
 *
 * Le journal ne s'écrit qu'à la suite (voir `records.ts`) ; ce module ne fait que le relire,
 * pour l'historique d'une variable et pour l'export d'audit.
 */

export interface ValueEvent {
  id: number;
  recordId: number;
  patientId: number;
  patientCode: string;
  fieldId: number;
  fieldKey: string;
  fieldLabel: string;
  at: string;
  action: EventAction;
  oldValue: FieldValue;
  oldSource: string | null;
  newValue: FieldValue;
  newSource: string | null;
  runId: number | null;
}

interface EventRow {
  id: number;
  record_id: number;
  patient_id: number;
  patient_code: string;
  field_id: number;
  field_key: string;
  field_label: string;
  at: string;
  action: string;
  old_value: string | null;
  old_source: string | null;
  new_value: string | null;
  new_source: string | null;
  run_id: number | null;
}

const SELECT = `
  SELECT e.id, e.record_id, r.patient_id, p.code AS patient_code, e.field_id, f.key AS field_key,
         f.label AS field_label, e.at, e.action, e.old_value, e.old_source, e.new_value, e.new_source, e.run_id
    FROM value_events e
    JOIN records r  ON r.id = e.record_id
    JOIN patients p ON p.id = r.patient_id
    JOIN fields f   ON f.id = e.field_id`;

function toEvent(row: EventRow): ValueEvent {
  return {
    id: row.id,
    recordId: row.record_id,
    patientId: row.patient_id,
    patientCode: row.patient_code,
    fieldId: row.field_id,
    fieldKey: row.field_key,
    fieldLabel: row.field_label,
    at: row.at,
    action: row.action as EventAction,
    oldValue: parseJson<FieldValue>(row.old_value, null),
    oldSource: row.old_source,
    newValue: parseJson<FieldValue>(row.new_value, null),
    newSource: row.new_source,
    runId: row.run_id,
  };
}

/** Historique d'une fiche, éventuellement restreint à une variable. Du plus récent au plus ancien. */
export function listEventsForRecord(recordId: number, fieldId: number | null, limit = 200): ValueEvent[] {
  const rows = (
    fieldId
      ? db.prepare(`${SELECT} WHERE e.record_id = ? AND e.field_id = ? ORDER BY e.id DESC LIMIT ?`).all(recordId, fieldId, limit)
      : db.prepare(`${SELECT} WHERE e.record_id = ? ORDER BY e.id DESC LIMIT ?`).all(recordId, limit)
  ) as EventRow[];
  return rows.map(toEvent);
}

/** Tout le journal d'une fiche d'exploitation, du plus ancien au plus récent : l'ordre d'un audit. */
export function listEventsForTemplate(templateId: number): ValueEvent[] {
  const rows = db
    .prepare(`${SELECT} WHERE r.template_id = ? ORDER BY e.id ASC`)
    .all(templateId) as EventRow[];
  return rows.map(toEvent);
}
