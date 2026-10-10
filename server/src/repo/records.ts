import { db, nowIso, parseJson } from '../db/index.js';
import type {
  Evidence,
  FieldValue,
  PatientRecord,
  RecordValue,
  ValueOrigin,
  ValueSource,
} from '../domain/types.js';

interface RecordRow {
  id: number;
  template_id: number;
  patient_id: number;
  last_extraction_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ValueRow {
  record_id: number;
  field_id: number;
  value: string | null;
  source: string;
  confidence: number | null;
  evidence: string | null;
  updated_at: string;
  origin_source: string | null;
  origin_value: string | null;
  reviewed_at: string | null;
}

function toValue(row: ValueRow): RecordValue {
  const originSource = row.origin_source === 'auto' || row.origin_source === 'llm' ? row.origin_source : null;
  const origin: ValueOrigin | null = originSource
    ? { source: originSource, value: parseJson<FieldValue>(row.origin_value, null) }
    : null;
  return {
    fieldId: row.field_id,
    value: parseJson<FieldValue>(row.value, null),
    source: row.source as ValueSource,
    confidence: row.confidence,
    evidence: row.evidence ? parseJson<Evidence | null>(row.evidence, null) : null,
    updatedAt: row.updated_at,
    origin,
    reviewedAt: row.reviewed_at,
  };
}

function toRecord(row: RecordRow, values: RecordValue[]): PatientRecord {
  return {
    id: row.id,
    templateId: row.template_id,
    patientId: row.patient_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastExtractionAt: row.last_extraction_at,
    values,
  };
}

/** Récupère la fiche remplie d'un patient, en la créant au besoin. */
export function ensureRecord(templateId: number, patientId: number): PatientRecord {
  const existing = db
    .prepare('SELECT * FROM records WHERE template_id = ? AND patient_id = ?')
    .get(templateId, patientId) as RecordRow | undefined;

  if (existing) return toRecord(existing, listValues(existing.id));

  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO records (template_id, patient_id, created_at, updated_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(templateId, patientId, ts, ts);
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(Number(info.lastInsertRowid)) as RecordRow;
  return toRecord(row, []);
}

export function getRecord(templateId: number, patientId: number): PatientRecord | null {
  const row = db
    .prepare('SELECT * FROM records WHERE template_id = ? AND patient_id = ?')
    .get(templateId, patientId) as RecordRow | undefined;
  return row ? toRecord(row, listValues(row.id)) : null;
}

const valuesOfRecordStmt = db.prepare('SELECT * FROM record_values WHERE record_id = ?');

export function listValues(recordId: number): RecordValue[] {
  return (valuesOfRecordStmt.all(recordId) as ValueRow[]).map(toValue);
}

export interface ValueInput {
  fieldId: number;
  value: FieldValue;
  source: ValueSource;
  confidence?: number | null;
  evidence?: Evidence | null;
}

/** Ce que fait un humain d'une valeur : la fixer (ou la vider), la confirmer telle quelle, ou rendre la main à l'extraction. */
export type HumanMode = 'set' | 'confirm' | 'release';

export interface HumanEdit {
  fieldId: number;
  value: FieldValue;
  mode: HumanMode;
}

export type EventAction = 'extract' | 'unset' | 'edit' | 'confirm' | 'clear' | 'release';

const upsertStmt = db.prepare(
  `INSERT INTO record_values
     (record_id, field_id, value, source, confidence, evidence, updated_at, origin_source, origin_value, reviewed_at)
   VALUES (@recordId, @fieldId, @value, @source, @confidence, @evidence, @updatedAt, @originSource, @originValue, @reviewedAt)
   ON CONFLICT(record_id, field_id) DO UPDATE SET
     value = excluded.value,
     source = excluded.source,
     confidence = excluded.confidence,
     evidence = excluded.evidence,
     updated_at = excluded.updated_at,
     origin_source = excluded.origin_source,
     origin_value = excluded.origin_value,
     reviewed_at = excluded.reviewed_at`,
);

const eventStmt = db.prepare(
  `INSERT INTO value_events (record_id, field_id, at, action, old_value, old_source, new_value, new_source, run_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const touchRecordStmt = db.prepare('UPDATE records SET updated_at = ? WHERE id = ?');
const deleteValueStmt = db.prepare('DELETE FROM record_values WHERE record_id = ? AND field_id = ?');
const markExtractedStmt = db.prepare('UPDATE records SET last_extraction_at = ?, updated_at = ? WHERE id = ?');

function loadRows(recordId: number): Map<number, ValueRow> {
  const rows = db.prepare('SELECT * FROM record_values WHERE record_id = ?').all(recordId) as ValueRow[];
  return new Map(rows.map((r) => [r.field_id, r]));
}

const json = (value: FieldValue): string | null => (value === null ? null : JSON.stringify(value));

function logEvent(
  recordId: number,
  fieldId: number,
  at: string,
  action: EventAction,
  before: ValueRow | undefined,
  after: { value: string | null; source: string } | null,
  runId: number | null,
): void {
  eventStmt.run(
    recordId,
    fieldId,
    at,
    action,
    before?.value ?? null,
    before?.source ?? null,
    after?.value ?? null,
    after?.source ?? null,
    runId,
  );
}

export interface AutomaticOptions {
  /** Passe d'extraction à laquelle rattacher les changements. */
  runId?: number | null;
  /** Date la passe sur cette fiche (`last_extraction_at`), dans la même transaction que les valeurs. */
  markExtracted?: boolean;
  /**
   * Sources que cette passe a autorité pour retirer quand elles ne sont plus trouvées. Une passe ne retire que ce
   * qu'elle a pu produire : une passe de règles ne touche pas aux valeurs de Claude (que les règles ne savent pas
   * retrouver), et une passe dont l'appel au modèle a échoué ne les efface pas non plus. Par défaut : les deux.
   */
  withdraw?: readonly ('auto' | 'llm')[];
}

/**
 * Range le résultat d'une passe d'extraction.
 *
 * On compare à l'état précédent plutôt que d'effacer puis réécrire : une valeur
 * retrouvée à l'identique ne produit aucun changement, et une variable qui n'est
 * plus trouvée perd sa valeur automatique au lieu de la conserver en silence.
 * Chaque changement réel est inscrit au journal.
 *
 * Les décisions humaines ne sont jamais retirées ici ; une valeur manuelle n'est
 * remplacée que si l'appelant en donne explicitement une nouvelle (écrasement forcé).
 * Une passe ne retire que les sources qu'elle a pu produire (`options.withdraw`).
 */
export const applyAutomaticValues = db.transaction(
  (recordId: number, values: ValueInput[], options: AutomaticOptions = {}): void => {
    const ts = nowIso();
    const runId = options.runId ?? null;
    const existing = loadRows(recordId);
    const incoming = new Set<number>();

    for (const v of values) {
      incoming.add(v.fieldId);
      const before = existing.get(v.fieldId);
      const newValue = json(v.value);
      const evidence = v.evidence ? JSON.stringify(v.evidence) : null;
      const unchanged = before && before.source === v.source && before.value === newValue;

      upsertStmt.run({
        recordId,
        fieldId: v.fieldId,
        value: newValue,
        source: v.source,
        confidence: v.confidence ?? null,
        evidence,
        updatedAt: unchanged ? before.updated_at : ts,
        originSource: null,
        originValue: null,
        reviewedAt: null,
      });
      if (!unchanged) logEvent(recordId, v.fieldId, ts, 'extract', before, { value: newValue, source: v.source }, runId);
    }

    const withdraw = options.withdraw ?? (['auto', 'llm'] as const);
    for (const [fieldId, row] of existing) {
      if (incoming.has(fieldId) || row.source === 'manual') continue;
      if ((row.source === 'auto' || row.source === 'llm') && !withdraw.includes(row.source)) continue;
      deleteValueStmt.run(recordId, fieldId);
      // Une ligne « vide » ne portait aucune valeur : l'effacer n'est pas un changement de donnée.
      if (row.source === 'auto' || row.source === 'llm') {
        logEvent(recordId, fieldId, ts, 'unset', row, null, runId);
      }
    }
    touchRecordStmt.run(ts, recordId);
    if (options.markExtracted) markExtractedStmt.run(ts, ts, recordId);
  },
);

/**
 * Range des décisions humaines.
 *
 * Une valeur relue garde ce que la machine avait proposé (`origin_*`), ce qui
 * permet ensuite de compter ce qui a été confirmé, corrigé ou vidé. Vider une
 * valeur est une décision au même titre que la corriger : elle survit aux
 * extractions suivantes, sans quoi la valeur écartée reviendrait à la passe d'après.
 * Rendre la main (`release`) est le seul geste qui autorise l'extraction à rejouer.
 */
export const applyHumanEdits = db.transaction((recordId: number, edits: HumanEdit[]): void => {
  const ts = nowIso();
  const rows = loadRows(recordId);

  for (const edit of edits) {
    const before = rows.get(edit.fieldId);
    const machine = before && (before.source === 'auto' || before.source === 'llm') ? before : undefined;

    if (edit.mode === 'release') {
      if (!before || before.source !== 'manual') continue;
      upsertStmt.run({
        recordId,
        fieldId: edit.fieldId,
        value: null,
        source: 'empty',
        confidence: null,
        evidence: null,
        updatedAt: ts,
        originSource: null,
        originValue: null,
        reviewedAt: null,
      });
      logEvent(recordId, edit.fieldId, ts, 'release', before, { value: null, source: 'empty' }, null);
      continue;
    }

    if (edit.mode === 'confirm') {
      // Rien à confirmer sans proposition de la machine ; l'appelant l'a déjà vérifié.
      if (!machine || machine.value === null) continue;
      upsertStmt.run({
        recordId,
        fieldId: edit.fieldId,
        value: machine.value,
        source: 'manual',
        confidence: machine.confidence,
        evidence: machine.evidence,
        updatedAt: ts,
        originSource: machine.source,
        originValue: machine.value,
        reviewedAt: ts,
      });
      logEvent(recordId, edit.fieldId, ts, 'confirm', before, { value: machine.value, source: 'manual' }, null);
      continue;
    }

    // set
    const newValue = json(edit.value);
    if (before?.source === 'manual' && before.value === newValue) continue; // rien ne change

    // La proposition d'origine est celle de la machine, et le reste à travers les corrections successives.
    const originSource = machine ? machine.source : before?.source === 'manual' ? before.origin_source : null;
    const originValue = machine ? machine.value : before?.source === 'manual' ? before.origin_value : null;
    const sameAsMachine = machine !== undefined && machine.value === newValue && newValue !== null;
    const action: EventAction = newValue === null ? 'clear' : sameAsMachine ? 'confirm' : 'edit';

    upsertStmt.run({
      recordId,
      fieldId: edit.fieldId,
      value: newValue,
      source: 'manual',
      // Retrouver la valeur de la machine, c'est la confirmer : sa justification reste attachée.
      confidence: sameAsMachine ? machine.confidence : null,
      evidence: sameAsMachine ? machine.evidence : null,
      updatedAt: ts,
      originSource,
      originValue,
      reviewedAt: ts,
    });
    logEvent(recordId, edit.fieldId, ts, action, before, { value: newValue, source: 'manual' }, null);
  }
  touchRecordStmt.run(ts, recordId);
});

/** Identifiants des variables tranchées par un humain (valeur saisie, corrigée, confirmée ou vidée). */
export function manualFieldIds(recordId: number): Set<number> {
  const rows = db
    .prepare(`SELECT field_id FROM record_values WHERE record_id = ? AND source = 'manual'`)
    .all(recordId) as { field_id: number }[];
  return new Set(rows.map((r) => r.field_id));
}

/**
 * Toutes les fiches remplies d'un modèle, pour les résultats et l'export.
 *
 * Deux requêtes, quel que soit le nombre de dossiers. Les justifications (`evidence`) pèsent plus de la
 * moitié du volume lu : les écrans qui n'en ont pas besoin — tableau, distributions, complétude, exports —
 * les laissent de côté (`withEvidence: false`), ce qui ramène à cinq mille dossiers une lecture de ~1 s à ~0,4 s.
 */
export function listRecordsForTemplate(templateId: number, options: { withEvidence?: boolean } = {}): PatientRecord[] {
  const withEvidence = options.withEvidence ?? true;
  const records = db
    .prepare('SELECT * FROM records WHERE template_id = ? ORDER BY patient_id')
    .all(templateId) as RecordRow[];
  const columns = withEvidence
    ? 'rv.*'
    : 'rv.record_id, rv.field_id, rv.value, rv.source, rv.confidence, NULL AS evidence, rv.updated_at, rv.origin_source, rv.origin_value, rv.reviewed_at';
  const rows = db
    .prepare(
      `SELECT ${columns} FROM record_values rv
         JOIN records r ON r.id = rv.record_id
        WHERE r.template_id = ?`,
    )
    .all(templateId) as ValueRow[];

  const byRecord = new Map<number, RecordValue[]>();
  for (const row of rows) {
    const list = byRecord.get(row.record_id);
    if (list) list.push(toValue(row));
    else byRecord.set(row.record_id, [toValue(row)]);
  }
  return records.map((record) => toRecord(record, byRecord.get(record.id) ?? []));
}
