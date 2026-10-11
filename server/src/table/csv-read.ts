import { limits } from '../extract/limits.js';
import { decodeText } from '../extract/text.js';
import { TableReadError, type TableCell, type TableFormat, type TableWorkbook } from './types.js';

/**
 * Lecture des tableaux CSV et TSV (RFC 4180, avec les écarts qu'on rencontre en pratique).
 *
 * - l'encodage est détecté comme pour les comptes rendus (`extract/text.ts`) : un export Excel français est souvent
 *   en Windows-1252, et « Âge » lu en UTF-8 deviendrait « �ge » sans qu'aucune erreur ne le signale ;
 * - le séparateur est reconnu (point-virgule d'un Excel français, virgule, tabulation, barre verticale), ou lu sur la
 *   ligne « sep=; » qu'Excel sait écrire en tête de fichier ;
 * - les guillemets protègent séparateurs et sauts de ligne, et se doublent pour s'écrire (« "" ») ;
 * - un guillemet jamais refermé est signalé : sans cela, toute la fin du fichier tiendrait dans une seule cellule.
 */

const CANDIDATES = [';', ',', '\t', '|'] as const;

export interface CsvParse {
  rows: string[][];
  /** Ligne physique (1 = première) où commence chaque enregistrement : utile quand une cellule contient des sauts de ligne. */
  lines: number[];
  warnings: string[];
}

/** Découpe le texte en enregistrements. `maxRecords` arrête la lecture tôt (détection du séparateur). */
export function splitCsv(text: string, delimiter: string, maxRecords = Infinity): CsvParse {
  const rows: string[][] = [];
  const lines: number[] = [];
  const warnings: string[] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let fieldStarted = false;
  let line = 1;
  let recordLine = 1;
  let afterQuote = false;
  let strayQuoteLine: number | null = null;
  let quoteOpenedAt = 0;

  const endField = () => {
    row.push(field);
    field = '';
    fieldStarted = false;
    afterQuote = false;
  };
  const endRecord = () => {
    endField();
    rows.push(row);
    lines.push(recordLine);
    row = [];
  };

  let i = 0;
  const n = text.length;
  while (i < n && rows.length < maxRecords) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        afterQuote = true;
        i++;
        continue;
      }
      if (ch === '\n' || (ch === '\r' && text[i + 1] !== '\n')) line++;
      field += ch;
      i++;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i++;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      endRecord();
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      line++;
      recordLine = line;
      continue;
    }
    if (ch === '"' && !fieldStarted && !afterQuote) {
      quoted = true;
      fieldStarted = true;
      quoteOpenedAt = line;
      i++;
      continue;
    }
    if (afterQuote || ch === '"') {
      // Texte collé après un guillemet fermant (« "abc"def »), ou guillemet au milieu d'un champ non protégé :
      // gardés tels quels, et signalés une fois.
      strayQuoteLine ??= line;
    }
    field += ch;
    fieldStarted = true;
    i++;
  }
  if (rows.length < maxRecords) {
    if (quoted) {
      warnings.push(`Guillemet ouvert ligne ${quoteOpenedAt} et jamais refermé : la fin du fichier a été lue dans une seule cellule. Vérifiez le fichier.`);
    }
    // Dernier enregistrement sans saut de ligne final.
    if (field !== '' || row.length > 0 || fieldStarted) endRecord();
  }
  if (strayQuoteLine !== null) warnings.push(`Guillemet mal placé ligne ${strayQuoteLine} : le texte a été gardé tel quel.`);
  return { rows, lines, warnings };
}

/** Séparateur le plus probable : celui qui donne le même nombre de colonnes (plus d'une) au plus grand nombre de lignes. */
export function detectDelimiter(text: string, preferred?: string): string {
  const sample = text.slice(0, 64 * 1024);
  let best: { delimiter: string; score: number } | null = null;
  const order = preferred ? [preferred, ...CANDIDATES.filter((c) => c !== preferred)] : [...CANDIDATES];
  for (const delimiter of order) {
    const { rows } = splitCsv(sample, delimiter, 50);
    const counts = rows.filter((r) => !(r.length === 1 && r[0] === '')).map((r) => r.length);
    if (counts.length === 0) continue;
    const frequency = new Map<number, number>();
    for (const c of counts) frequency.set(c, (frequency.get(c) ?? 0) + 1);
    const [mode, times] = [...frequency.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    if (mode < 2) continue;
    // La régularité d'abord (part des lignes au nombre de colonnes dominant), puis le nombre de colonnes.
    const score = (times / counts.length) * 1000 + Math.min(mode, 999);
    if (!best || score > best.score) best = { delimiter, score };
  }
  return best?.delimiter ?? preferred ?? ';';
}

/** Lit un tableau CSV ou TSV. Lève `TableReadError` avec un message qui dit quoi faire. */
export function readCsv(buffer: Buffer, format: Extract<TableFormat, 'csv' | 'tsv'>): TableWorkbook {
  if (buffer.includes(0) && !/^utf-16/.test(decodeText(buffer.subarray(0, 400)).charset)) {
    throw new TableReadError('Ce fichier n’est pas un tableau texte (octets binaires) : est-ce bien un CSV ?');
  }
  const { text: decoded, charset } = decodeText(buffer);
  // Nomenclature restée en tête (UTF-16, ou double nomenclature d'un export) : elle n'appartient pas au premier en-tête.
  let text = decoded.replace(/^﻿+/, '');
  const warnings: string[] = [];

  let delimiter: string | null = null;
  const sep = /^sep=(.)\r?\n/i.exec(text);
  if (sep) {
    delimiter = sep[1]!;
    text = text.slice(sep[0].length);
  }
  delimiter ??= detectDelimiter(text, format === 'tsv' ? '\t' : undefined);

  const parsed = splitCsv(text, delimiter);
  warnings.push(...parsed.warnings);

  const maxRows = limits.tableMaxRows();
  const maxColumns = limits.tableMaxColumns();
  const maxCells = limits.tableMaxCells();
  if (parsed.rows.length > maxRows) {
    throw new TableReadError(`Plus de ${maxRows.toLocaleString('fr-FR')} lignes (TABLE_MAX_ROWS) : découpez le fichier, ou relevez le plafond.`);
  }

  let cells = 0;
  let columns = 0;
  const rows: (TableCell | null)[][] = parsed.rows.map((record) => {
    if (record.length > maxColumns) {
      throw new TableReadError(`Plus de ${maxColumns.toLocaleString('fr-FR')} colonnes (TABLE_MAX_COLUMNS) : est-ce bien le bon séparateur ?`);
    }
    // Une ligne entièrement vide reste une ligne : la numérotation suit celle du fichier.
    const out = record.map((value): TableCell | null => (value.trim() === '' ? null : { v: value, k: 'text', raw: value }));
    while (out.length > 0 && out[out.length - 1] === null) out.pop();
    cells += out.filter(Boolean).length;
    if (out.length > columns) columns = out.length;
    return out;
  });
  if (cells > maxCells) {
    throw new TableReadError(`Tableau trop volumineux : plus de ${maxCells.toLocaleString('fr-FR')} cellules renseignées (TABLE_MAX_CELLS).`);
  }
  while (rows.length > 0 && rows[rows.length - 1]!.length === 0) rows.pop();
  if (rows.length === 0) throw new TableReadError('Le fichier est vide : aucune ligne à lire.');

  // Les sauts de ligne dans une cellule décalent la numérotation : on le dit, la référence « ligne N » renvoie à l'enregistrement.
  if (parsed.lines.some((l, index) => l !== index + 1)) {
    warnings.push('Certaines cellules contiennent des sauts de ligne : les numéros de ligne cités sont ceux des enregistrements, comme dans un tableur.');
  }

  return {
    format,
    sheets: [{ name: format === 'tsv' ? 'TSV' : 'CSV', hidden: false, rows, columns, merges: [], formulas: 0, formulasWithoutValue: 0, error: null }],
    delimiter,
    charset,
    warnings,
  };
}
