/**
 * Tableau de cohorte lu dans un fichier (classeur Excel, CSV) : ce que les lecteurs de `table/` produisent et ce que
 * l'import consomme. Les cellules gardent leur contenu brut, qui sert de justification à chaque valeur importée.
 */

/**
 * Nature d'une cellule lue.
 *
 * - `formula-no-value` : une formule dont le tableur n'a pas enregistré le résultat. L'outil n'évalue jamais une
 *   formule (ce serait refaire le calcul du tableur, avec ses erreurs) : la cellule est signalée, pas devinée.
 * - `error` : une erreur du tableur (#N/A, #DIV/0!…), conservée comme telle.
 */
export type TableCellKind = 'text' | 'number' | 'boolean' | 'date' | 'error' | 'formula-no-value';

export interface TableCell {
  /** Valeur lue : texte, nombre, booléen, date ISO (« 2024-03-15 », « 2024-03-15 08:30 »). `null` pour une erreur ou une formule sans valeur. */
  v: string | number | boolean | null;
  k: TableCellKind;
  /** Contenu tel qu'enregistré dans le fichier : numéro de série d'une date, code d'erreur, texte du CSV. */
  raw: string;
  /** La cellule porte une formule : sa valeur est celle que le tableur a calculée à l'enregistrement. */
  f?: true;
}

export interface TableSheet {
  name: string;
  hidden: boolean;
  /** Lignes de la feuille, la première à l'index 0 ; `null` pour une cellule vide. Les lignes vides de fin sont retirées. */
  rows: (TableCell | null)[][];
  /** Nombre de colonnes de la ligne la plus longue. */
  columns: number;
  /** Plages fusionnées (« A1:C1 ») : seule la cellule en haut à gauche porte la valeur. */
  merges: string[];
  formulas: number;
  formulasWithoutValue: number;
  /** Feuille illisible (plafond dépassé, structure inattendue) : les autres feuilles restent utilisables. */
  error: string | null;
}

export type TableFormat = 'xlsx' | 'csv' | 'tsv';

export interface TableWorkbook {
  format: TableFormat;
  sheets: TableSheet[];
  /** CSV : séparateur retenu et encodage détecté. */
  delimiter?: string;
  charset?: string;
  /** Classeur au calendrier de 1904 (ancien Excel pour Mac). */
  date1904?: boolean;
  warnings: string[];
}

/** Lecture refusée : le message s'adresse au chercheur et dit quoi faire. */
export class TableReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableReadError';
  }
}

/** Colonne 0 -> « A », 26 -> « AA ». */
export function columnLetter(index: number): string {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/** Référence de cellule à la manière du tableur : colonne 4, ligne 11 (index 0) -> « E12 ». */
export function cellRef(column: number, rowIndex: number): string {
  return `${columnLetter(column)}${rowIndex + 1}`;
}
