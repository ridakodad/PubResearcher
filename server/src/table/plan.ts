import { createHash } from 'node:crypto';
import { coerce } from '../engine/coerce.js';
import type { FieldValue, ImportEvidence, TemplateField, TemplateWithFields, ValueSource } from '../domain/types.js';
import { normalizePatientCode } from '../lib/patient-code.js';
import { listPatients } from '../repo/patients.js';
import { listRecordsForTemplate } from '../repo/records.js';
import type { ColumnMapping, ImportOptions } from '../repo/imports.js';
import { cellText, parseHeader } from './mapping.js';
import { cellRef, columnLetter, type TableCell, type TableSheet, type TableWorkbook } from './types.js';

/**
 * Simulation d'un import de tableau : ce qui serait écrit, refusé ou laissé en place, cellule par cellule.
 *
 * La même fonction prépare la simulation et l'écriture, sur l'état de la base au moment où elle s'exécute : ce que
 * l'écran a montré est ce qui s'écrit. Une empreinte du plan permet à l'écriture de vérifier que rien n'a changé
 * entre-temps (une passe d'extraction, une relecture).
 *
 * Chaque cellule passe par la même conversion que l'extraction (`engine/coerce.ts`) : décimales à la française, dates
 * jj/mm/aaaa, oui/non, options de la variable, unités et bornes de plausibilité. Le facteur de conversion d'une
 * variable (`scale`), écrit pour les comptes rendus, ne s'applique pas : une colonne de tableau doit être dans l'unité
 * de la variable, et l'unité annoncée par son en-tête est contrôlée.
 */

/** Nombre maximal de lignes détaillées par catégorie dans le rapport (les compteurs, eux, sont complets). */
const DETAIL_LIMIT = 1000;

export class ImportInputError extends Error {}

export interface PlanInput {
  workbook: TableWorkbook;
  sheet: string | null;
  /** Ligne d'en-tête, 1 = première ligne. */
  headerRow: number;
  codeColumn: number;
  mapping: ColumnMapping[];
  options: ImportOptions;
  template: TemplateWithFields;
  file: { importId: number; fileName: string; sha256: string };
}

export type WriteKind = 'new' | 'replace-extracted' | 'replace-manual';

export interface PlannedWrite {
  code: string;
  /** `null` : dossier à créer. */
  patientId: number | null;
  fieldId: number;
  value: FieldValue;
  kind: WriteKind;
  evidence: ImportEvidence;
}

interface CellIssueBase {
  /** Ligne du tableau (1 = première). */
  row: number;
  cell: string;
  code: string;
  fieldId: number;
  fieldLabel: string;
  header: string;
  raw: string;
}

export interface RejectedCell extends CellIssueBase {
  reason: string;
}

export interface ConflictCell extends CellIssueBase {
  incoming: FieldValue;
  current: FieldValue;
  currentSource: ValueSource;
  /** La valeur en place sera remplacée (option d'écrasement cochée) ou gardée. */
  resolution: 'kept' | 'replaced';
}

export interface RowIssue {
  row: number;
  code: string | null;
  reason: string;
}

export interface FieldSummary {
  fieldId: number;
  fieldLabel: string;
  column: number;
  letter: string;
  header: string;
  write: number;
  unchanged: number;
  empty: number;
  rejected: number;
  conflicts: number;
}

export interface ImportReport {
  templateId: number;
  sheet: string | null;
  headerRow: number;
  codeColumn: number;
  options: ImportOptions;
  /** Lignes sous l'en-tête, vides comprises. */
  dataRows: number;
  rows: {
    /** Lignes retenues : un code valide, un dossier existant ou à créer. */
    used: number;
    empty: number;
    /** Lignes écartées (sans code, code invalide, code en double, dossier inconnu) : détail dans `rowIssues`. */
    skipped: number;
  };
  patients: { created: number; existing: number; createdCodes: string[] };
  values: {
    write: number;
    /** Dont valeurs en place remplacées (extraites ou importées auparavant, puis décisions de relecteurs). */
    replaceExtracted: number;
    replaceManual: number;
    unchanged: number;
    empty: number;
    rejected: number;
    /** Valeurs en place, différentes, gardées faute d'écrasement demandé. */
    conflicts: number;
  };
  fields: FieldSummary[];
  rowIssues: RowIssue[];
  rejected: RejectedCell[];
  conflicts: ConflictCell[];
  /** Les listes détaillées sont tronquées à mille entrées ; les compteurs restent exacts. */
  truncated: boolean;
  /** Empreinte de ce qui serait écrit : l'écriture la compare avant d'agir. */
  planHash: string;
}

export interface ImportPlan {
  report: ImportReport;
  writes: PlannedWrite[];
  /** Codes des dossiers à créer, dans l'ordre du tableau. */
  create: string[];
}

function sameValue(a: FieldValue, b: FieldValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Clé de doublon des codes : celle de la base (`COLLATE NOCASE`, qui ne replie que les lettres ASCII). */
const codeKey = (code: string): string => code.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Le code d'une ligne, lu comme le serait un nom de dossier ; ou la raison de l'écarter. */
function readCode(cell: TableCell | null | undefined): { code: string } | { reason: string } | null {
  if (!cell) return null;
  if (cell.k === 'formula-no-value') return { reason: 'code calculé par une formule sans valeur enregistrée' };
  if (cell.k === 'error') return { reason: `code en erreur dans le tableur (${cell.raw})` };
  if (cell.k === 'boolean') return { reason: 'le code est un booléen (VRAI/FAUX)' };
  const text = typeof cell.v === 'number' ? (Number.isInteger(cell.v) ? String(cell.v) : cell.raw) : String(cell.v ?? '');
  const code = normalizePatientCode(text);
  if (code === '') return null;
  if (code.length > 80) return { reason: 'code de plus de 80 caractères' };
  return { code };
}

/** Contenu brut cité en justification : ce que montre le tableur, et ce que le fichier enregistre quand c'est autre chose. */
function rawForEvidence(cell: TableCell): string {
  const shown = cellText(cell);
  let raw = cell.k === 'date' && cell.raw !== shown ? `${shown} (date Excel n° ${cell.raw})` : cell.k === 'text' ? cell.raw : shown || cell.raw;
  if (cell.f) raw += ' (valeur calculée par une formule)';
  return raw.length > 500 ? `${raw.slice(0, 499)}…` : raw;
}

const BARE_NUMBER = /^[\s(]*[-−]?\d[\d\s  .,]*\)?\s*$/;

/** Convertit une cellule vers le type de la variable, ou dit pourquoi elle ne peut pas l'être. */
export function convertCell(
  cell: TableCell,
  field: TemplateField,
  headerUnit: string | null,
): { ok: true; value: FieldValue } | { ok: false; reason: string } {
  if (cell.k === 'formula-no-value') {
    return {
      ok: false,
      reason: 'formule sans valeur enregistrée : ouvrez le classeur dans le tableur, enregistrez-le, puis réimportez-le (l’outil ne recalcule pas les formules)',
    };
  }
  if (cell.k === 'error') return { ok: false, reason: `erreur du tableur (${cell.raw})` };

  let raw: FieldValue;
  if (typeof cell.v === 'boolean') raw = cell.v;
  else if (typeof cell.v === 'number') {
    if (field.type === 'date') {
      return {
        ok: false,
        reason: 'nombre sans format de date : mettez la colonne au format Date dans le tableur, ou écrivez la date jj/mm/aaaa',
      };
    }
    raw = field.type === 'number' || field.type === 'integer' ? cell.v : cell.raw;
  } else raw = String(cell.v ?? '');

  // L'unité d'un en-tête (« CRP (mg/L) ») vaut pour chaque cellule nue de la colonne : on la leur rattache, pour que
  // le contrôle d'unité de la conversion s'applique comme à un compte rendu.
  if ((field.type === 'number' || field.type === 'integer') && headerUnit) {
    const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : null;
    if (text !== null && BARE_NUMBER.test(text)) raw = `${text} ${headerUnit}`;
  }

  const post = field.extraction.postProcess;
  return coerce(raw, field.type, field.options, post ? { valueMap: post.valueMap, min: post.min, max: post.max } : undefined, field.unit);
}

export function validatePlanInput(input: PlanInput): { sheet: TableSheet; fields: Map<number, TemplateField> } {
  const { workbook } = input;
  const sheet = input.sheet === null ? workbook.sheets[0] : workbook.sheets.find((s) => s.name === input.sheet);
  if (!sheet) throw new ImportInputError(`Feuille « ${input.sheet ?? ''} » introuvable dans ce fichier.`);
  if (sheet.error) throw new ImportInputError(`Feuille « ${sheet.name} » illisible : ${sheet.error}`);
  if (input.headerRow < 1 || input.headerRow > sheet.rows.length) {
    throw new ImportInputError(`Ligne d’en-tête ${input.headerRow} hors du tableau (${sheet.rows.length} ligne(s)).`);
  }
  if (input.codeColumn < 0 || input.codeColumn >= sheet.columns) {
    throw new ImportInputError(`Colonne des codes ${columnLetter(Math.max(0, input.codeColumn))} hors du tableau.`);
  }
  const fields = new Map(input.template.fields.map((f) => [f.id, f]));
  const seenFields = new Set<number>();
  const seenColumns = new Set<number>();
  for (const m of input.mapping) {
    if (m.column < 0 || m.column >= sheet.columns) throw new ImportInputError(`Colonne ${columnLetter(Math.max(0, m.column))} hors du tableau.`);
    const field = fields.get(m.fieldId);
    if (!field) throw new ImportInputError(`Variable ${m.fieldId} absente de la fiche « ${input.template.name} ».`);
    if (seenFields.has(m.fieldId)) throw new ImportInputError(`La variable « ${field.label} » est associée à deux colonnes : gardez-en une.`);
    if (seenColumns.has(m.column)) throw new ImportInputError(`La colonne ${columnLetter(m.column)} est associée à deux variables.`);
    seenFields.add(m.fieldId);
    seenColumns.add(m.column);
  }
  if (input.mapping.length === 0) throw new ImportInputError('Associez au moins une colonne à une variable de la fiche.');
  return { sheet, fields };
}

export function planImport(input: PlanInput): ImportPlan {
  const { sheet, fields } = validatePlanInput(input);
  const { options, template } = input;
  const headerCells = sheet.rows[input.headerRow - 1] ?? [];
  const columns = input.mapping.map((m) => {
    const text = cellText(headerCells[m.column]).trim() || `Colonne ${columnLetter(m.column)}`;
    const header = parseHeader(text);
    return { ...m, field: fields.get(m.fieldId)!, header: text, headerUnit: header.knownUnit ? header.unit : null };
  });

  // Dossiers existants (même clé que la base) et valeurs en place pour la fiche.
  const patientsByKey = new Map(listPatients().map((p) => [codeKey(p.code), p]));
  const records = new Map(listRecordsForTemplate(template.id, { withEvidence: false }).map((r) => [r.patientId, r]));

  const dataRows = sheet.rows.slice(input.headerRow);
  const report: ImportReport = {
    templateId: template.id,
    sheet: input.workbook.format === 'xlsx' ? sheet.name : null,
    headerRow: input.headerRow,
    codeColumn: input.codeColumn,
    options,
    dataRows: dataRows.length,
    rows: { used: 0, empty: 0, skipped: 0 },
    patients: { created: 0, existing: 0, createdCodes: [] },
    values: { write: 0, replaceExtracted: 0, replaceManual: 0, unchanged: 0, empty: 0, rejected: 0, conflicts: 0 },
    fields: columns.map((c) => ({
      fieldId: c.fieldId,
      fieldLabel: c.field.label,
      column: c.column,
      letter: columnLetter(c.column),
      header: c.header,
      write: 0,
      unchanged: 0,
      empty: 0,
      rejected: 0,
      conflicts: 0,
    })),
    rowIssues: [],
    rejected: [],
    conflicts: [],
    truncated: false,
    planHash: '',
  };
  const summaryByField = new Map(report.fields.map((f) => [f.fieldId, f]));
  const pushDetail = <T>(list: T[], item: T) => {
    if (list.length < DETAIL_LIMIT) list.push(item);
    else report.truncated = true;
  };

  // Premier passage : les codes. Un code présent sur plusieurs lignes rend ces lignes ambiguës : aucune n'est importée.
  const codes: ({ code: string } | { reason: string } | null)[] = dataRows.map((r) => readCode(r[input.codeColumn]));
  const linesByKey = new Map<string, number[]>();
  codes.forEach((c, i) => {
    if (c && 'code' in c) {
      const k = codeKey(c.code);
      linesByKey.set(k, [...(linesByKey.get(k) ?? []), i]);
    }
  });

  const writes: PlannedWrite[] = [];
  const create: string[] = [];
  const createdKeys = new Set<string>();
  const existingIds = new Set<number>();

  dataRows.forEach((cells, i) => {
    const rowNumber = input.headerRow + i + 1;
    const mappedEmpty = columns.every((c) => !cells[c.column]);
    const code = codes[i];
    if (!code) {
      if (cells.every((c) => !c)) {
        report.rows.empty++;
        return;
      }
      if (mappedEmpty) {
        report.rows.empty++;
        return;
      }
      report.rows.skipped++;
      pushDetail(report.rowIssues, { row: rowNumber, code: null, reason: 'pas de code dossier : ligne ignorée' });
      return;
    }
    if ('reason' in code) {
      report.rows.skipped++;
      pushDetail(report.rowIssues, { row: rowNumber, code: null, reason: `${code.reason} : ligne ignorée` });
      return;
    }
    const lines = linesByKey.get(codeKey(code.code))!;
    if (lines.length > 1) {
      report.rows.skipped++;
      pushDetail(report.rowIssues, {
        row: rowNumber,
        code: code.code,
        reason: `code présent sur plusieurs lignes (${lines.map((l) => input.headerRow + l + 1).join(', ')}) : aucune n’est importée, dédoublonnez le tableau`,
      });
      return;
    }
    const patient = patientsByKey.get(codeKey(code.code)) ?? null;
    if (!patient && !options.createPatients) {
      report.rows.skipped++;
      pushDetail(report.rowIssues, { row: rowNumber, code: code.code, reason: 'aucun dossier de ce code (création de dossiers désactivée) : ligne ignorée' });
      return;
    }
    report.rows.used++;
    if (patient) existingIds.add(patient.id);
    else if (!createdKeys.has(codeKey(code.code))) {
      createdKeys.add(codeKey(code.code));
      create.push(code.code);
    }
    const stored = patient ? new Map((records.get(patient.id)?.values ?? []).map((v) => [v.fieldId, v])) : new Map();

    for (const c of columns) {
      const summary = summaryByField.get(c.fieldId)!;
      const cell = cells[c.column];
      if (!cell) {
        summary.empty++;
        report.values.empty++;
        continue;
      }
      const base: CellIssueBase = {
        row: rowNumber,
        cell: cellRef(c.column, input.headerRow + i),
        code: code.code,
        fieldId: c.fieldId,
        fieldLabel: c.field.label,
        header: c.header,
        raw: rawForEvidence(cell),
      };
      const converted = convertCell(cell, c.field, c.headerUnit);
      if (!converted.ok) {
        summary.rejected++;
        report.values.rejected++;
        pushDetail(report.rejected, { ...base, reason: converted.reason });
        continue;
      }

      const current = stored.get(c.fieldId);
      let kind: WriteKind = 'new';
      if (current && current.source !== 'empty') {
        if (current.value !== null && sameValue(current.value, converted.value)) {
          summary.unchanged++;
          report.values.unchanged++;
          continue;
        }
        const isManual = current.source === 'manual';
        const allowed = isManual ? options.overwriteManual : options.overwriteExtracted;
        if (!allowed) {
          summary.conflicts++;
          report.values.conflicts++;
        }
        pushDetail(report.conflicts, {
          ...base,
          incoming: converted.value,
          current: current.value,
          currentSource: current.source,
          resolution: allowed ? 'replaced' : 'kept',
        });
        if (!allowed) continue;
        kind = isManual ? 'replace-manual' : 'replace-extracted';
      }

      summary.write++;
      report.values.write++;
      if (kind === 'replace-manual') report.values.replaceManual++;
      if (kind === 'replace-extracted') report.values.replaceExtracted++;
      writes.push({
        code: code.code,
        patientId: patient?.id ?? null,
        fieldId: c.fieldId,
        value: converted.value,
        kind,
        evidence: {
          kind: 'import',
          importId: input.file.importId,
          fileName: input.file.fileName,
          sha256: input.file.sha256,
          sheet: report.sheet,
          cell: base.cell,
          header: c.header,
          raw: base.raw,
        },
      });
    }
  });

  report.patients = { created: create.length, existing: existingIds.size, createdCodes: create.slice(0, 200) };
  report.planHash = createHash('sha256')
    .update(
      JSON.stringify({
        template: template.id,
        options,
        create,
        writes: writes.map((w) => [w.code, w.fieldId, w.value, w.kind, w.evidence.cell]),
      }),
    )
    .digest('hex')
    .slice(0, 32);
  return { report, writes, create };
}
