import { canonicalUnit } from '../engine/coerce.js';
import { fold } from '../engine/fold.js';
import type { TemplateField } from '../domain/types.js';
import { columnLetter, type TableCell, type TableSheet } from './types.js';

/**
 * Lecture des en-têtes d'un tableau et propositions de correspondance colonne -> variable.
 *
 * Ce ne sont que des propositions : le chercheur les voit toutes, les corrige, et rien n'est écrit sans la simulation
 * qui suit. Une colonne n'est proposée que pour une seule variable, et une variable pour une seule colonne.
 */

export interface HeaderInfo {
  /** En-tête tel qu'écrit dans le tableau. */
  text: string;
  /** En-tête sans son unité : « CRP (mg/L) » -> « CRP ». */
  label: string;
  /** Contenu des parenthèses ou crochets de fin, quand il y en a. */
  unit: string | null;
  /** Unité reconnue (forme canonique), `null` si les parenthèses disent autre chose (« Sexe (M/F) »). */
  knownUnit: string | null;
}

export function parseHeader(text: string): HeaderInfo {
  const clean = text.replace(/\s+/g, ' ').trim();
  const m = /^(.*?)\s*[([]\s*(?:en\s+)?([^()[\]]{1,24}?)\s*[)\]]\s*$/i.exec(clean);
  if (m && m[1]!.trim() !== '') {
    const unit = m[2]!.trim();
    return { text: clean, label: m[1]!.trim(), unit, knownUnit: canonicalUnit(unit) };
  }
  // « CRP en mg/L », « Créatinine, µmol/L » : l'unité n'est retenue que si l'outil la reconnaît.
  const tail = /^(.*?)(?:\s+en|\s*,)\s+(\S{1,12})$/i.exec(clean);
  if (tail && canonicalUnit(tail[2]!)) {
    return { text: clean, label: tail[1]!.trim(), unit: tail[2]!, knownUnit: canonicalUnit(tail[2]!) };
  }
  return { text: clean, label: clean, unit: null, knownUnit: null };
}

/** Forme de comparaison : repliée, sans ponctuation, les tirets bas et apostrophes valant des espaces. */
function key(text: string): string {
  return fold(text)
    .replace(/[_'’‘`´.\-/:;,#°]+/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Mots vides qui ne suffisent pas à rapprocher deux libellés. */
const STOP = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'd', 'l', 'a', 'au', 'en', 'et', 'ou', 'par', 'n', 'no', 'num']);

function containsWords(haystack: string, needle: string): boolean {
  if (needle.length < 3 || STOP.has(needle)) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

export interface ColumnSuggestion {
  column: number;
  fieldId: number;
  /** Pourquoi cette proposition, en clair. */
  reason: string;
  /** Unité de l'en-tête différente de celle de la variable : les valeurs seront refusées à la simulation. */
  unitWarning: string | null;
}

interface Scored extends ColumnSuggestion {
  score: number;
}

function scorePair(header: HeaderInfo, field: TemplateField): Scored | null {
  const h = key(header.label);
  if (h === '') return null;
  const label = key(field.label);
  const fieldKey = key(field.key);
  const ruleLabels = field.extraction.rules.flatMap((r) => (r.kind === 'label' ? r.labels : [])).map(key).filter(Boolean);

  let score = 0;
  let reason = '';
  if (h === label) {
    score = 100;
    reason = 'même libellé';
  } else if (h === fieldKey) {
    score = 95;
    reason = 'même clé';
  } else if (ruleLabels.includes(h)) {
    score = 90;
    reason = 'libellé connu de la variable';
  } else if (containsWords(h, label) || containsWords(label, h)) {
    score = 75;
    reason = 'libellé proche';
  } else if (ruleLabels.some((l) => containsWords(h, l))) {
    score = 70;
    reason = 'libellé proche';
  }
  if (score === 0) return null;

  let unitWarning: string | null = null;
  const fieldUnit = canonicalUnit(field.unit);
  if (header.knownUnit && fieldUnit) {
    if (header.knownUnit === fieldUnit) {
      score += 10;
      reason += ', même unité';
    } else {
      score -= 20;
      unitWarning = `L’en-tête annonce « ${header.unit} », la variable attend « ${field.unit} » : convertissez la colonne avant l’import, sinon ses valeurs seront refusées.`;
    }
  }
  return { column: -1, fieldId: field.id, reason, unitWarning, score };
}

const CODE_HEADERS = new Set([
  'code', 'code patient', 'code dossier', 'code du dossier', 'patient', 'dossier', 'id', 'identifiant', 'id patient',
  'patient id', 'ipp', 'n dossier', 'numero dossier', 'numero de dossier', 'numero', 'n', 'no', 'num', 'sujet', 'subject',
  'subject id', 'record id', 'code sujet', 'inclusion', 'numero d inclusion', 'n inclusion', 'anonymat', 'code anonymat',
]);

/** Texte d'une cellule pour l'affichage et la comparaison (pas pour l'import, qui garde le type). */
export function cellText(cell: TableCell | null | undefined): string {
  if (!cell) return '';
  if (cell.k === 'formula-no-value') return '';
  if (cell.k === 'error') return cell.raw;
  if (typeof cell.v === 'boolean') return cell.v ? 'VRAI' : 'FAUX';
  if (typeof cell.v === 'number') return String(cell.v).replace('.', ',');
  return String(cell.v ?? '');
}

/**
 * Ligne d'en-tête probable (1 = première ligne) : la première, parmi les vingt premières, dont les cellules sont du
 * texte et presque aussi nombreuses que dans la ligne la plus remplie — un titre ou une ligne de notes au-dessus du
 * tableau ne remplit qu'une ou deux cellules.
 */
export function suggestHeaderRow(sheet: TableSheet): number {
  const head = sheet.rows.slice(0, 20);
  const widest = Math.max(0, ...head.map((r) => r.filter(Boolean).length));
  for (let i = 0; i < head.length; i++) {
    const cells = head[i]!.filter((c): c is TableCell => c !== null);
    if (cells.length >= Math.max(2, Math.ceil(widest * 0.6)) && cells.every((c) => c.k === 'text')) return i + 1;
  }
  return 1;
}

export interface ColumnInfo extends HeaderInfo {
  index: number;
  letter: string;
  /** Cellules renseignées sous l'en-tête. */
  filled: number;
  /** Premières valeurs renseignées, pour reconnaître la colonne. */
  sample: string[];
  /** Codes distincts (comparaison sans casse) : une colonne de codes n'a pas de doublon. */
  distinct: number;
}

export function describeColumns(sheet: TableSheet, headerRow: number): ColumnInfo[] {
  const header = sheet.rows[headerRow - 1] ?? [];
  const data = sheet.rows.slice(headerRow);
  const columns: ColumnInfo[] = [];
  for (let c = 0; c < sheet.columns; c++) {
    const text = cellText(header[c]).trim();
    const info = parseHeader(text || `Colonne ${columnLetter(c)}`);
    const values = data.map((r) => cellText(r[c]).trim()).filter((v) => v !== '');
    columns.push({
      ...info,
      text: text,
      index: c,
      letter: columnLetter(c),
      filled: values.length,
      sample: values.slice(0, 4).map((v) => (v.length > 40 ? `${v.slice(0, 39)}…` : v)),
      distinct: new Set(values.map((v) => v.toLowerCase())).size,
    });
  }
  // Colonnes sans en-tête ni valeur (cellules de fin mises en forme) : rien à proposer.
  return columns.filter((c) => c.text !== '' || c.filled > 0);
}

export interface MappingSuggestion {
  codeColumn: number | null;
  mapping: ColumnSuggestion[];
}

export function suggestMapping(columns: ColumnInfo[], fields: TemplateField[]): MappingSuggestion {
  // Colonne des codes : un en-tête qui le dit, sinon la première colonne sans doublon ni case vide.
  const byHeader = columns.find((c) => CODE_HEADERS.has(key(c.label)) && c.filled > 0) ?? columns.find((c) => /\bcode\b/.test(key(c.label)) && c.filled > 0);
  const unique = columns.find((c) => c.filled > 0 && c.distinct === c.filled);
  const codeColumn = byHeader?.index ?? unique?.index ?? null;

  const pairs: Scored[] = [];
  for (const column of columns) {
    if (column.index === codeColumn || column.text === '') continue;
    for (const field of fields) {
      const scored = scorePair(column, field);
      if (scored) pairs.push({ ...scored, column: column.index });
    }
  }
  pairs.sort((a, b) => b.score - a.score || a.column - b.column);
  const takenColumns = new Set<number>();
  const takenFields = new Set<number>();
  const mapping: ColumnSuggestion[] = [];
  for (const p of pairs) {
    if (p.score < 50 || takenColumns.has(p.column) || takenFields.has(p.fieldId)) continue;
    takenColumns.add(p.column);
    takenFields.add(p.fieldId);
    mapping.push({ column: p.column, fieldId: p.fieldId, reason: p.reason, unitWarning: p.unitWarning });
  }
  mapping.sort((a, b) => a.column - b.column);
  return { codeColumn, mapping };
}
