import { readCsv } from './csv-read.js';
import { TableReadError, type TableFormat, type TableWorkbook } from './types.js';
import { readXlsx } from './xlsx-read.js';

/**
 * Nature d'un fichier de tableau, d'après son contenu d'abord (une archive ZIP est un classeur, quel que soit son
 * nom), puis son extension. `null` : ce n'est pas un tableau que l'outil sait lire, et `tableFormatProblem` dit pourquoi.
 */
export function tableFormat(buffer: Buffer, filename: string): TableFormat | null {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (buffer.length >= 4 && buffer.readUInt32LE(0) === 0x04034b50) return ext === 'csv' || ext === 'tsv' || ext === 'txt' ? null : 'xlsx';
  if (isOle(buffer)) return null;
  if (ext === 'tsv' || ext === 'tab') return 'tsv';
  if (ext === 'csv' || ext === 'txt') return 'csv';
  return null;
}

/** Conteneur OLE2 : ancien classeur `.xls`, ou classeur `.xlsx` chiffré par mot de passe. */
function isOle(buffer: Buffer): boolean {
  return buffer.length >= 8 && buffer.readUInt32BE(0) === 0xd0cf11e0 && buffer.readUInt32BE(4) === 0xa1b11ae1;
}

export function tableFormatProblem(buffer: Buffer, filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (isOle(buffer)) {
    return ext === 'xls'
      ? 'Ancien format Excel (.xls) : ouvrez-le dans Excel ou LibreOffice et enregistrez-le en .xlsx (ou en CSV), puis réimportez-le.'
      : 'Classeur protégé par mot de passe, ou ancien format Excel (.xls) : retirez la protection et enregistrez-le en .xlsx (ou en CSV), puis réimportez-le.';
  }
  if (ext === 'ods') return 'Classeur OpenDocument (.ods) : enregistrez-le en .xlsx ou en CSV depuis LibreOffice, puis réimportez-le.';
  if (ext === 'numbers') return 'Classeur Numbers : exportez-le en .xlsx ou en CSV, puis réimportez-le.';
  return `Format non reconnu (${filename}) : l’import de tableau lit les classeurs Excel (.xlsx) et les fichiers CSV ou TSV.`;
}

/** Lit un tableau de cohorte : classeur `.xlsx`, CSV ou TSV. Lève `TableReadError` avec un message qui dit quoi faire. */
export function readTable(buffer: Buffer, filename: string): TableWorkbook {
  if (buffer.length === 0) throw new TableReadError(`Fichier vide (0 octet) : ${filename}.`);
  const format = tableFormat(buffer, filename);
  if (!format) throw new TableReadError(tableFormatProblem(buffer, filename));
  return format === 'xlsx' ? readXlsx(buffer) : readCsv(buffer, format);
}
