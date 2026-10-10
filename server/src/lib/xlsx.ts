import { escapeXml, makeZip, type ZipEntry } from './zip.js';

/**
 * Écriture de classeurs `.xlsx`.
 *
 * Le CSV reste le format d'échange, mais il perd le typage : une date y devient
 * du texte, un nombre décimal dépend de la locale, et Excel réinterprète
 * volontiers « 5-10 » en date. Le classeur, lui, porte le type de chaque
 * cellule — un nombre est un nombre, une date est une date — et s'ouvre sans
 * assistant d'importation ni reformatage.
 *
 * Il porte aussi ce qu'un CSV ne peut pas : plusieurs feuilles, un en-tête figé
 * et un filtre automatique, de sorte que le jeu de données est exploitable dès
 * l'ouverture.
 */

export type CellValue = string | number | boolean | null;

export interface SheetColumn {
  header: string;
  /** Largeur en caractères. Une colonne trop étroite affiche « ##### ». */
  width?: number;
  /** Les dates sont écrites en série Excel et mises en forme par le classeur. */
  type?: 'text' | 'number' | 'date';
}

export interface Sheet {
  name: string;
  columns: SheetColumn[];
  rows: CellValue[][];
}

/** Colonne 0 -> « A », 26 -> « AA ». */
function columnName(index: number): string {
  let name = '';
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/**
 * Date ISO vers numéro de série Excel.
 *
 * L'origine est le 30/12/1899 : Excel reproduit un bogue de Lotus 1-2-3 qui
 * tenait 1900 pour bissextile. Renvoie `null` si la valeur n'est pas une date
 * complète, auquel cas elle sera écrite comme texte.
 */
export function toExcelSerial(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  // Excel ne connaît pas les dates d'avant 1900, et son calendrier compte un 29 février 1900 qui n'a jamais existé :
  // avant le 1er mars 1900, l'origine du 30/12/1899 donnerait un jour de trop. Ces dates restent du texte, exactes.
  if (iso.trim() < '1900-03-01') return null;
  // `setUTCFullYear` : `Date.UTC(24, …)` lirait l'an 1924. Et on vérifie que la date existe : `Date` normalise
  // « 2024-02-30 » en 1er mars sans rien dire, ce qui ferait écrire dans le classeur une date que le CSV n'a pas.
  const probe = new Date(0);
  probe.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  if (
    Number.isNaN(probe.getTime()) ||
    probe.getUTCFullYear() !== Number(y) ||
    probe.getUTCMonth() !== Number(m) - 1 ||
    probe.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  return Math.round(probe.getTime() / 86_400_000) + 25_569;
}

/** Excel limite une cellule à 32 767 caractères : au-delà, le fichier est signalé comme corrompu à l'ouverture. */
const EXCEL_CELL_LIMIT = 32_000;

/** Une feuille dont le nom dépasse 31 caractères rend le classeur illisible. */
function sheetName(name: string, index: number): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned || `Feuille ${index + 1}`).slice(0, 31);
}

function cellXml(ref: string, value: CellValue, type: SheetColumn['type']): string {
  if (value === null || value === '') return '';

  if (type === 'date' && typeof value === 'string') {
    const serial = toExcelSerial(value);
    // Une date incomplète — « 2024 » seul — reste du texte plutôt que de
    // devenir une date fausse.
    if (serial !== null) return `<c r="${ref}" s="2"><v>${serial}</v></c>`;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }

  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }

  // `inlineStr` évite la table de chaînes partagées : le fichier est un peu
  // plus gros, le code beaucoup plus simple à vérifier.
  const text = String(value);
  const kept = text.length > EXCEL_CELL_LIMIT ? `${text.slice(0, EXCEL_CELL_LIMIT)}… [tronqué : ${text.length - EXCEL_CELL_LIMIT} caractères de plus dans le CSV]` : text;
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(kept)}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const lastColumn = columnName(Math.max(sheet.columns.length - 1, 0));
  const lastRow = sheet.rows.length + 1;

  const cols = sheet.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 16}" customWidth="1"/>`)
    .join('');

  const header = sheet.columns
    .map((c, i) => cellXml(`${columnName(i)}1`, c.header, 'text').replace('<c ', '<c s="1" '))
    .join('');

  const body = sheet.rows
    .map((row, r) => {
      const cells = sheet.columns
        .map((c, i) => cellXml(`${columnName(i)}${r + 2}`, row[i] ?? null, c.type))
        .join('');
      return `<row r="${r + 2}">${cells}</row>`;
    })
    .join('');

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    // Volet figé sous l'en-tête : les libellés de colonne restent visibles en
    // parcourant une cohorte de plusieurs centaines de lignes.
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<cols>${cols}</cols>` +
    `<sheetData><row r="1">${header}</row>${body}</sheetData>` +
    (sheet.columns.length > 0 ? `<autoFilter ref="A1:${lastColumn}${lastRow}"/>` : '') +
    `</worksheet>`
  );
}

export function makeXlsx(sheets: Sheet[]): Buffer {
  const named = sheets.map((s, i) => ({ ...s, name: sheetName(s.name, i) }));

  const entries: ZipEntry[] = [
    {
      path: '[Content_Types].xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        named
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join('') +
        `</Types>`,
    },
    {
      path: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      path: 'xl/workbook.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        named
          .map(
            (s, i) =>
              `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
          )
          .join('') +
        `</sheets></workbook>`,
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        named
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    },
    {
      // Trois styles : ordinaire, en-tête en gras, et date au format ISO —
      // seule écriture non ambiguë d'une date entre deux pays.
      path: 'xl/styles.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/></numFmts>` +
        `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
        `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
        `<fill><patternFill patternType="gray125"/></fill></fills>` +
        `<borders count="1"><border/></borders>` +
        `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
        `<cellXfs count="3">` +
        `<xf xfId="0"/>` +
        `<xf xfId="0" fontId="1" applyFont="1"/>` +
        `<xf xfId="0" numFmtId="164" applyNumberFormat="1"/>` +
        `</cellXfs></styleSheet>`,
    },
    ...named.map((sheet, i) => ({
      path: `xl/worksheets/sheet${i + 1}.xml`,
      data: sheetXml(sheet),
    })),
  ];

  return makeZip(entries);
}
