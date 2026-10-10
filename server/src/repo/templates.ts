import { db, nowIso, parseJson } from '../db/index.js';
import type {
  FieldExtraction,
  FieldType,
  Template,
  TemplateField,
  TemplateWithFields,
} from '../domain/types.js';

interface TemplateRow {
  id: number;
  name: string;
  description: string | null;
  is_active: number;
  created_at: string;
  updated_at: string;
}

interface FieldRow {
  id: number;
  template_id: number;
  key: string;
  label: string;
  type: string;
  section: string;
  unit: string | null;
  description: string | null;
  required: number;
  options: string;
  position: number;
  extraction: string;
}

const EMPTY_EXTRACTION: FieldExtraction = { enabled: true, rules: [] };

function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.is_active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toField(row: FieldRow): TemplateField {
  return {
    id: row.id,
    templateId: row.template_id,
    key: row.key,
    label: row.label,
    type: row.type as FieldType,
    section: row.section,
    unit: row.unit,
    description: row.description,
    required: row.required === 1,
    options: parseJson<string[]>(row.options, []),
    position: row.position,
    extraction: parseJson<FieldExtraction>(row.extraction, EMPTY_EXTRACTION),
  };
}

export function listTemplates(): Template[] {
  const rows = db
    .prepare('SELECT * FROM templates ORDER BY is_active DESC, name COLLATE NOCASE')
    .all() as TemplateRow[];
  return rows.map(toTemplate);
}

export function getTemplate(id: number): TemplateWithFields | null {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
  if (!row) return null;
  return { ...toTemplate(row), fields: listFields(id) };
}

/** Fiche active : celle proposée par défaut à l'extraction et aux résultats. */
export function getActiveTemplate(): TemplateWithFields | null {
  const row = db.prepare('SELECT * FROM templates WHERE is_active = 1 LIMIT 1').get() as
    | TemplateRow
    | undefined;
  if (row) return { ...toTemplate(row), fields: listFields(row.id) };
  const first = db.prepare('SELECT * FROM templates ORDER BY id LIMIT 1').get() as
    | TemplateRow
    | undefined;
  return first ? { ...toTemplate(first), fields: listFields(first.id) } : null;
}

export function listFields(templateId: number): TemplateField[] {
  const rows = db
    .prepare('SELECT * FROM fields WHERE template_id = ? ORDER BY position, id')
    .all(templateId) as FieldRow[];
  return rows.map(toField);
}

export function getField(id: number): TemplateField | null {
  const row = db.prepare('SELECT * FROM fields WHERE id = ?').get(id) as FieldRow | undefined;
  return row ? toField(row) : null;
}

export function createTemplate(input: {
  name: string;
  description?: string | null;
  isActive?: boolean;
}): Template {
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO templates (name, description, is_active, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    )
    .run(input.name, input.description ?? null, ts, ts);
  const id = Number(info.lastInsertRowid);
  if (input.isActive) setActiveTemplate(id);
  return toTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
}

export function updateTemplate(
  id: number,
  input: { name?: string; description?: string | null },
): Template | null {
  const row = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
  if (!row) return null;
  db.prepare('UPDATE templates SET name = ?, description = ?, updated_at = ? WHERE id = ?').run(
    input.name ?? row.name,
    input.description !== undefined ? input.description : row.description,
    nowIso(),
    id,
  );
  return toTemplate(db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow);
}

/** Une seule fiche active à la fois. */
export const setActiveTemplate = db.transaction((id: number): void => {
  db.prepare('UPDATE templates SET is_active = 0').run();
  db.prepare('UPDATE templates SET is_active = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
});

export function deleteTemplate(id: number): boolean {
  return db.prepare('DELETE FROM templates WHERE id = ?').run(id).changes > 0;
}

export interface FieldInput {
  key: string;
  label: string;
  type: FieldType;
  section?: string;
  unit?: string | null;
  description?: string | null;
  required?: boolean;
  options?: string[];
  position?: number;
  extraction?: FieldExtraction;
}

export function createField(templateId: number, input: FieldInput): TemplateField {
  const position =
    input.position ??
    ((db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM fields WHERE template_id = ?').get(
      templateId,
    ) as { m: number }).m +
      1);

  const info = db
    .prepare(
      `INSERT INTO fields
         (template_id, key, label, type, section, unit, description, required, options, position, extraction)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      templateId,
      input.key,
      input.label,
      input.type,
      input.section ?? 'Général',
      input.unit ?? null,
      input.description ?? null,
      input.required ? 1 : 0,
      JSON.stringify(input.options ?? []),
      position,
      JSON.stringify(input.extraction ?? EMPTY_EXTRACTION),
    );
  touchTemplate(templateId);
  return getField(Number(info.lastInsertRowid))!;
}

export function updateField(id: number, input: Partial<FieldInput>): TemplateField | null {
  const current = getField(id);
  if (!current) return null;
  db.prepare(
    `UPDATE fields
        SET key = ?, label = ?, type = ?, section = ?, unit = ?, description = ?,
            required = ?, options = ?, position = ?, extraction = ?
      WHERE id = ?`,
  ).run(
    input.key ?? current.key,
    input.label ?? current.label,
    input.type ?? current.type,
    input.section ?? current.section,
    input.unit !== undefined ? input.unit : current.unit,
    input.description !== undefined ? input.description : current.description,
    (input.required ?? current.required) ? 1 : 0,
    JSON.stringify(input.options ?? current.options),
    input.position ?? current.position,
    JSON.stringify(input.extraction ?? current.extraction),
    id,
  );
  touchTemplate(current.templateId);
  return getField(id);
}

export function deleteField(id: number): boolean {
  const field = getField(id);
  if (!field) return false;
  db.prepare('DELETE FROM fields WHERE id = ?').run(id);
  touchTemplate(field.templateId);
  return true;
}

/** Réordonne les variables selon la séquence d'identifiants fournie. */
export const reorderFields = db.transaction((templateId: number, orderedIds: number[]): void => {
  const stmt = db.prepare('UPDATE fields SET position = ? WHERE id = ? AND template_id = ?');
  orderedIds.forEach((fieldId, index) => stmt.run(index, fieldId, templateId));
  touchTemplate(templateId);
});

function touchTemplate(templateId: number): void {
  db.prepare('UPDATE templates SET updated_at = ? WHERE id = ?').run(nowIso(), templateId);
}

/** Duplique une fiche et ses variables (versionner sans casser les données existantes). */
export const duplicateTemplate = db.transaction((id: number, name: string): TemplateWithFields | null => {
  const source = getTemplate(id);
  if (!source) return null;
  const ts = nowIso();
  const info = db
    .prepare(
      `INSERT INTO templates (name, description, is_active, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)`,
    )
    .run(name, source.description, ts, ts);
  const newId = Number(info.lastInsertRowid);
  for (const field of source.fields) {
    createField(newId, {
      key: field.key,
      label: field.label,
      type: field.type,
      section: field.section,
      unit: field.unit,
      description: field.description,
      required: field.required,
      options: field.options,
      position: field.position,
      extraction: field.extraction,
    });
  }
  return getTemplate(newId);
});
