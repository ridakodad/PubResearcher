import type { FieldValue } from '../domain/types.js';

/**
 * Échappe une cellule CSV (RFC 4180).
 *
 * Un texte commençant par `=`, `+`, `-` ou `@` est préfixé d'une apostrophe : sans
 * cela, Excel l'interprète comme une formule à l'ouverture du fichier. Cette
 * protection ne vaut que pour du texte — jamais pour un nombre, sans quoi « -3,2 »
 * (un excès de base, une variation) deviendrait du texte dans R ou SPSS.
 */
function escapeCell(value: string, delimiter: string, guardFormula: boolean): string {
  let v = value;
  if (guardFormula && /^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  if (v.includes(delimiter) || v.includes('"') || v.includes('\n') || v.includes('\r')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

export interface CsvOptions {
  /** `;` pour Excel en configuration française, `,` pour R / Python. */
  delimiter?: string;
  /** `true` pour Oui/Non, `false` pour 1/0 (préférable pour l'analyse statistique). */
  booleanAsText?: boolean;
  /** Séparateur interne des variables à choix multiples. */
  multiSeparator?: string;
  /**
   * Séparateur décimal. `,` pour Excel en français (qui lirait « 36.7 » comme du texte, ou
   * comme une date), `read.csv2` de R, `decimal=','` de pandas ; `.` pour tout le reste.
   */
  decimal?: '.' | ',';
}

export function formatValue(value: FieldValue, options: CsvOptions = {}): string {
  const { booleanAsText = false, multiSeparator = '|', decimal = '.' } = options;
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') {
    if (booleanAsText) return value ? 'Oui' : 'Non';
    return value ? '1' : '0';
  }
  if (Array.isArray(value)) return value.join(multiSeparator);
  if (typeof value === 'number') return decimal === ',' ? String(value).replace('.', ',') : String(value);
  return String(value);
}

export function toCsv(
  headers: string[],
  rows: FieldValue[][],
  options: CsvOptions = {},
): string {
  const delimiter = options.delimiter ?? ';';
  const lines: string[] = [
    headers.map((h) => escapeCell(h, delimiter, true)).join(delimiter),
  ];
  for (const row of rows) {
    lines.push(
      row.map((cell) => escapeCell(formatValue(cell, options), delimiter, typeof cell === 'string')).join(delimiter),
    );
  }
  // CRLF + BOM UTF-8 : sans le BOM, Excel affiche « Ã¢ge » au lieu de « âge ».
  return '﻿' + lines.join('\r\n') + '\r\n';
}
