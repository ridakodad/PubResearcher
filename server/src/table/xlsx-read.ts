import path from 'node:path/posix';
import { limits } from '../extract/limits.js';
import { formatSize } from '../lib/size.js';
import { ZipReadError, openZip, type ZipReader } from '../lib/zip.js';
import { TableReadError, type TableCell, type TableSheet, type TableWorkbook } from './types.js';
import { attr, decodeOfficeEscapes, decodeXml, walkXml } from './xml.js';

/**
 * Lecture seule des classeurs `.xlsx` (et `.xlsm`, dont les macros sont ignorées).
 *
 * Écrite ici plutôt qu'empruntée : les bibliothèques qui lisent tous les formats de tableur sont lourdes, et la plus
 * répandue n'est plus publiée sur npm qu'en version vulnérable. Un tableau de cohorte n'a besoin que de peu de chose :
 * la liste des feuilles, la table des chaînes partagées, les styles (pour reconnaître une date), et les cellules.
 *
 * Ce que le lecteur ne fait jamais :
 * - évaluer une formule. La valeur d'une cellule calculée est celle que le tableur a enregistrée ; une formule sans
 *   valeur enregistrée est signalée comme telle, jamais recalculée ni devinée ;
 * - suivre un lien externe, une entité XML ou une macro ;
 * - décompresser au-delà des plafonds (`TABLE_MAX_XML_MB`, `TABLE_MAX_TOTAL_MB`), vérifiés sur l'annuaire de l'archive
 *   avant d'ouvrir quoi que ce soit.
 */

/** Plafond atteint dans une feuille : cette feuille est écartée, les autres restent lisibles. */
class SheetLimit extends Error {}

/** Formats de nombre intégrés d'Excel qui affichent une date, une date et une heure, ou une heure seule. */
const BUILTIN_DATE = new Set([14, 15, 16, 17, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58]);
const BUILTIN_DATETIME = new Set([22]);
const BUILTIN_TIME = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56]);

type DateStyle = 'date' | 'datetime' | 'time' | null;

/** Ce que montre un format personnalisé (« dd/mm/yyyy », « [$-40C]d mmmm yyyy », « hh:mm »…). */
export function classifyNumberFormat(code: string): DateStyle {
  const stripped = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?:h+|m+|s+)\]/gi, 'h')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/AM\/PM|A\/P/gi, '')
    // Une section de format conditionnel suffit : la première.
    .split(';')[0]!;
  if (/^(?:general|@)?$/i.test(stripped.trim())) return null;
  const hasDate = /[yd]/i.test(stripped) || (/m/i.test(stripped) && !/[hs]/i.test(stripped));
  const hasTime = /[hs]/i.test(stripped);
  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return null;
}

const DAY_MS = 86_400_000;
const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Numéro de série d'une date Excel vers une date ISO.
 *
 * Calendrier de 1900 : le jour 1 est le 1er janvier 1900, et Excel compte un 29 février 1900 qui n'a jamais existé
 * (héritage de Lotus 1-2-3) : le jour 60 est cette date fictive, rendue telle quelle pour qu'elle soit refusée plutôt
 * que décalée d'un jour. Calendrier de 1904 : le jour 0 est le 1er janvier 1904.
 */
export function excelSerialToIso(serial: number, date1904: boolean, style: Exclude<DateStyle, null>): string | null {
  if (!Number.isFinite(serial) || serial < 0 || serial >= 2_958_466) return null;
  let days = Math.floor(serial);
  let seconds = Math.round((serial - days) * 86_400);
  if (seconds >= 86_400) {
    days += 1;
    seconds -= 86_400;
  }
  const time = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}${seconds % 60 ? `:${pad(seconds % 60)}` : ''}`;
  if (style === 'time') return time;

  let date: string;
  if (!date1904 && days === 60) date = '1900-02-29';
  else {
    const base = date1904 ? Date.UTC(1904, 0, 1) : days < 60 ? Date.UTC(1899, 11, 31) : Date.UTC(1899, 11, 30);
    const d = new Date(base + days * DAY_MS);
    date = `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  return style === 'datetime' && seconds > 0 ? `${date} ${time}` : date;
}

/** Lettres de colonne et numéro de ligne d'une référence « AB12 » (index 0), `null` si elle est mal formée. */
function parseRef(ref: string): { column: number; row: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(ref);
  if (!m) return null;
  let column = 0;
  for (const ch of m[1]!.toUpperCase()) column = column * 26 + (ch.charCodeAt(0) - 64);
  return { column: column - 1, row: Number(m[2]) - 1 };
}

function readPart(zip: ZipReader, name: string, required: boolean): string | null {
  const entry = zip.entries.get(name);
  if (!entry) {
    if (required) throw new TableReadError(`Classeur incomplet : la partie « ${name} » manque. Réenregistrez-le depuis le tableur.`);
    return null;
  }
  if (entry.uncompressedSize > limits.tableMaxXmlBytes()) {
    throw new TableReadError(
      `Classeur trop volumineux une fois décompressé (« ${name} » : ${formatSize(entry.uncompressedSize)}, limite ${formatSize(limits.tableMaxXmlBytes())}). ` +
        `Enregistrez la feuille utile seule, ou en CSV, ou relevez TABLE_MAX_XML_MB si ce classeur est légitime.`,
    );
  }
  const data = zip.read(name);
  return data ? data.toString('utf8') : null;
}

/** Résout la cible d'une relation, relative au dossier de la partie qui la déclare. */
function resolveTarget(fromPart: string, target: string): string {
  if (target.startsWith('/')) return path.normalize(target.slice(1));
  return path.normalize(path.join(path.dirname(fromPart), target));
}

function relationships(zip: ZipReader, part: string): Map<string, { type: string; target: string; external: boolean }> {
  const relsPath = path.join(path.dirname(part), '_rels', `${path.basename(part)}.rels`);
  const xml = readPart(zip, relsPath, false);
  const out = new Map<string, { type: string; target: string; external: boolean }>();
  if (!xml) return out;
  walkXml(xml, {
    open(name, attrs) {
      if (name !== 'Relationship') return;
      const id = attr(attrs, 'Id');
      const target = attr(attrs, 'Target');
      if (!id || !target) return;
      const external = attr(attrs, 'TargetMode') === 'External';
      out.set(id, { type: attr(attrs, 'Type') ?? '', target: external ? target : resolveTarget(part, target), external });
    },
  });
  return out;
}

function sharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const out: string[] = [];
  let current: string[] | null = null;
  let inText = false;
  let phonetic = 0;
  const maxCells = limits.tableMaxCells();
  walkXml(xml, {
    open(name, _attrs, selfClosing) {
      if (name === 'si') current = [];
      else if (name === 'rPh') phonetic++;
      else if (name === 't' && !selfClosing) inText = true;
    },
    close(name) {
      if (name === 'si') {
        out.push(decodeOfficeEscapes((current ?? []).join('')));
        current = null;
        if (out.length > maxCells) {
          throw new TableReadError(`Classeur trop volumineux : plus de ${maxCells.toLocaleString('fr-FR')} textes distincts (TABLE_MAX_CELLS).`);
        }
      } else if (name === 'rPh') phonetic--;
      else if (name === 't') inText = false;
    },
    text(raw, cdata) {
      // Les indications phonétiques (`rPh`, japonais) ne font pas partie du texte affiché.
      if (inText && phonetic === 0 && current) current.push(cdata ? raw : decodeXml(raw));
    },
  });
  return out;
}

function dateStyles(xml: string | null): DateStyle[] {
  if (!xml) return [];
  const custom = new Map<number, string>();
  const styles: DateStyle[] = [];
  let inCellXfs = false;
  walkXml(xml, {
    open(name, attrs) {
      if (name === 'numFmt') {
        const id = Number(attr(attrs, 'numFmtId'));
        const code = attr(attrs, 'formatCode');
        if (Number.isInteger(id) && code !== null) custom.set(id, code);
      } else if (name === 'cellXfs') inCellXfs = true;
      else if (name === 'xf' && inCellXfs) {
        const id = Number(attr(attrs, 'numFmtId') ?? 0);
        const code = custom.get(id);
        styles.push(
          code !== undefined
            ? classifyNumberFormat(code)
            : BUILTIN_DATE.has(id)
              ? 'date'
              : BUILTIN_DATETIME.has(id)
                ? 'datetime'
                : BUILTIN_TIME.has(id)
                  ? 'time'
                  : null,
        );
      }
    },
    close(name) {
      if (name === 'cellXfs') inCellXfs = false;
    },
  });
  return styles;
}

interface SheetContext {
  strings: string[];
  styles: DateStyle[];
  date1904: boolean;
  /** Cellules non vides lues jusqu'ici dans tout le classeur (plafond `TABLE_MAX_CELLS`). */
  cells: { count: number };
}

function readSheet(xml: string, name: string, hidden: boolean, ctx: SheetContext): TableSheet {
  const maxRows = limits.tableMaxRows();
  const maxColumns = limits.tableMaxColumns();
  const maxCells = limits.tableMaxCells();
  const rows: (TableCell | null)[][] = [];
  const merges: string[] = [];
  let formulas = 0;
  let formulasWithoutValue = 0;
  let columns = 0;

  let rowIndex = -1;
  let columnIndex = -1;
  // Cellule en cours de lecture.
  let cell: { ref: string | null; type: string; style: number; value: string | null; inline: string[] | null; formula: boolean } | null = null;
  let capture: 'v' | 't' | null = null;
  let phonetic = 0;
  let buffer: string[] = [];

  const sheetError = (message: string): TableSheet => ({
    name,
    hidden,
    rows: [],
    columns: 0,
    merges: [],
    formulas: 0,
    formulasWithoutValue: 0,
    error: message,
  });

  function finishCell(): void {
    const c = cell!;
    cell = null;
    let column = columnIndex + 1;
    let row = rowIndex;
    if (c.ref) {
      const parsed = parseRef(c.ref);
      if (parsed) {
        column = parsed.column;
        row = parsed.row;
      }
    }
    columnIndex = column;
    const built = buildCell(c, ctx);
    if (!built) return;
    if (built.f) {
      formulas++;
      if (built.k === 'formula-no-value') formulasWithoutValue++;
    }
    if (row + 1 > maxRows) {
      throw new SheetLimit(`Plus de ${maxRows.toLocaleString('fr-FR')} lignes (TABLE_MAX_ROWS) : enregistrez la cohorte seule, ou relevez le plafond.`);
    }
    if (column + 1 > maxColumns) {
      throw new SheetLimit(`Plus de ${maxColumns.toLocaleString('fr-FR')} colonnes (TABLE_MAX_COLUMNS).`);
    }
    if (++ctx.cells.count > maxCells) {
      throw new TableReadError(`Classeur trop volumineux : plus de ${maxCells.toLocaleString('fr-FR')} cellules renseignées (TABLE_MAX_CELLS).`);
    }
    while (rows.length <= row) rows.push([]);
    const target = rows[row]!;
    while (target.length < column) target.push(null);
    target[column] = built;
    if (column + 1 > columns) columns = column + 1;
  }

  try {
    walkXml(xml, {
      open(tag, attrs, selfClosing) {
        switch (tag) {
          case 'row': {
            const r = Number(attr(attrs, 'r'));
            rowIndex = Number.isInteger(r) && r >= 1 ? r - 1 : rowIndex + 1;
            columnIndex = -1;
            return;
          }
          case 'c':
            cell = {
              ref: attr(attrs, 'r'),
              type: attr(attrs, 't') ?? 'n',
              style: Number(attr(attrs, 's') ?? 0) || 0,
              value: null,
              inline: null,
              formula: false,
            };
            if (selfClosing) {
              // Cellule mise en forme mais vide : elle compte pour la position de la suivante, pas comme valeur.
              const parsed = cell.ref ? parseRef(cell.ref) : null;
              columnIndex = parsed ? parsed.column : columnIndex + 1;
              cell = null;
            }
            return;
          case 'f':
            if (cell) cell.formula = true;
            return;
          case 'v':
            if (cell && !selfClosing) {
              capture = 'v';
              buffer = [];
            }
            return;
          case 'is':
            if (cell) cell.inline = [];
            return;
          case 'rPh':
            phonetic++;
            return;
          case 't':
            if (cell?.inline && !selfClosing) {
              capture = 't';
              buffer = [];
            }
            return;
          case 'mergeCell': {
            const ref = attr(attrs, 'ref');
            if (ref && merges.length < 10_000) merges.push(ref);
            return;
          }
        }
      },
      close(tag) {
        switch (tag) {
          case 'v':
            if (cell && capture === 'v') cell.value = buffer.join('');
            capture = null;
            return;
          case 't':
            if (cell?.inline && capture === 't' && phonetic === 0) cell.inline.push(buffer.join(''));
            capture = null;
            return;
          case 'rPh':
            phonetic--;
            return;
          case 'c':
            if (cell) finishCell();
            return;
        }
      },
      text(raw, cdata) {
        if (capture) buffer.push(cdata ? raw : decodeXml(raw));
      },
    });
  } catch (error) {
    if (error instanceof SheetLimit) return sheetError(error.message);
    throw error;
  }

  // Lignes vides de fin (mises en forme mais sans contenu) : retirées.
  while (rows.length > 0 && rows[rows.length - 1]!.every((c) => c === null)) rows.pop();
  return { name, hidden, rows, columns, merges, formulas, formulasWithoutValue, error: null };
}

function buildCell(
  c: { type: string; style: number; value: string | null; inline: string[] | null; formula: boolean },
  ctx: SheetContext,
): TableCell | null {
  const formula = c.formula ? ({ f: true } as const) : {};
  if (c.type === 'inlineStr') {
    const text = decodeOfficeEscapes((c.inline ?? []).join(''));
    return text === '' ? null : { v: text, k: 'text', raw: text, ...formula };
  }
  if (c.value === null) {
    // Une formule dont le tableur n'a pas enregistré le résultat (fichier produit par un programme, calcul
    // manuel désactivé) : la signaler, ne jamais l'évaluer.
    return c.formula ? { v: null, k: 'formula-no-value', raw: '', f: true } : null;
  }
  const raw = c.value;
  switch (c.type) {
    case 's': {
      const text = ctx.strings[Number(raw)];
      if (text === undefined) return { v: null, k: 'error', raw: `#REF (chaîne partagée ${raw} absente)`, ...formula };
      return text === '' ? null : { v: text, k: 'text', raw: text, ...formula };
    }
    case 'str': {
      const text = decodeOfficeEscapes(raw);
      return text === '' ? null : { v: text, k: 'text', raw: text, ...formula };
    }
    case 'b':
      return { v: raw.trim() === '1' || raw.trim().toLowerCase() === 'true', k: 'boolean', raw, ...formula };
    case 'e':
      return { v: null, k: 'error', raw, ...formula };
    case 'd': {
      // Date ISO 8601 écrite telle quelle (format « strict »).
      const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2})(?::(\d{2}))?)?/.exec(raw.trim());
      if (!m) return { v: raw, k: 'text', raw, ...formula };
      const time = m[2] && (m[2] !== '00:00' || (m[3] && m[3] !== '00')) ? ` ${m[2]}${m[3] && m[3] !== '00' ? `:${m[3]}` : ''}` : '';
      return { v: `${m[1]}${time}`, k: 'date', raw, ...formula };
    }
    default: {
      const n = Number(raw);
      if (raw.trim() === '' || !Number.isFinite(n)) return { v: raw, k: 'text', raw, ...formula };
      const style = ctx.styles[c.style] ?? null;
      if (style) {
        const iso = excelSerialToIso(n, ctx.date1904, style);
        if (iso !== null) return { v: iso, k: style === 'time' ? 'text' : 'date', raw, ...formula };
      }
      return { v: n, k: 'number', raw, ...formula };
    }
  }
}

/** Lit un classeur `.xlsx`. Lève `TableReadError` avec un message qui dit quoi faire. */
export function readXlsx(buffer: Buffer): TableWorkbook {
  let zip: ZipReader;
  try {
    zip = openZip(buffer);
  } catch (error) {
    if (error instanceof ZipReadError) throw new TableReadError(error.message);
    throw error;
  }
  if (zip.totalUncompressed > limits.tableMaxTotalBytes()) {
    throw new TableReadError(
      `Classeur trop volumineux une fois décompressé (${formatSize(zip.totalUncompressed)}, limite ${formatSize(limits.tableMaxTotalBytes())}). ` +
        `Enregistrez la feuille utile seule, ou en CSV, ou relevez TABLE_MAX_TOTAL_MB si ce classeur est légitime.`,
    );
  }
  const mimetype = zip.entries.has('mimetype') ? zip.read('mimetype')?.toString('utf8') ?? '' : '';
  if (mimetype.includes('opendocument.spreadsheet')) {
    throw new TableReadError('Classeur OpenDocument (.ods) : enregistrez-le en .xlsx ou en CSV depuis LibreOffice, puis réimportez-le.');
  }
  if (zip.entries.has('word/document.xml')) {
    throw new TableReadError('Ce fichier est un document Word, pas un classeur : importez-le avec « Importer des dossiers ».');
  }

  try {
    // Partie principale : annoncée par la relation « officeDocument » du paquet, `xl/workbook.xml` d'ordinaire.
    const packageRels = (() => {
      const xml = readPart(zip, '_rels/.rels', false);
      let target: string | null = null;
      if (xml) {
        walkXml(xml, {
          open(name, attrs) {
            if (name === 'Relationship' && /officeDocument$/.test(attr(attrs, 'Type') ?? '') && !target) {
              target = resolveTarget('', attr(attrs, 'Target') ?? '');
            }
          },
        });
      }
      return target as string | null;
    })();
    const workbookPart = packageRels && zip.entries.has(packageRels) ? packageRels : 'xl/workbook.xml';
    const workbookXml = readPart(zip, workbookPart, true)!;

    let date1904 = false;
    const declared: { name: string; rid: string; hidden: boolean }[] = [];
    walkXml(workbookXml, {
      open(name, attrs) {
        if (name === 'workbookPr') {
          const v = (attr(attrs, 'date1904') ?? '').toLowerCase();
          date1904 = v === '1' || v === 'true';
        } else if (name === 'sheet') {
          const state = attr(attrs, 'state');
          declared.push({ name: attr(attrs, 'name') ?? `Feuille ${declared.length + 1}`, rid: attr(attrs, 'id') ?? '', hidden: state === 'hidden' || state === 'veryHidden' });
        }
      },
    });

    const rels = relationships(zip, workbookPart);
    const relOfType = (suffix: string): string | null => {
      for (const rel of rels.values()) if (!rel.external && rel.type.endsWith(suffix)) return rel.target;
      return null;
    };
    const ctx: SheetContext = {
      strings: sharedStrings(readPart(zip, relOfType('/sharedStrings') ?? 'xl/sharedStrings.xml', false)),
      styles: dateStyles(readPart(zip, relOfType('/styles') ?? 'xl/styles.xml', false)),
      date1904,
      cells: { count: 0 },
    };

    const warnings: string[] = [];
    if (zip.entries.has('xl/vbaProject.bin')) warnings.push('Le classeur contient des macros : elles sont ignorées, rien n’est exécuté.');
    if ([...rels.values()].some((r) => r.external) || [...zip.entries.keys()].some((n) => n.startsWith('xl/externalLinks/'))) {
      warnings.push('Le classeur fait référence à d’autres fichiers (liaisons externes) : seules les valeurs enregistrées dans ce fichier sont lues.');
    }

    const sheets: TableSheet[] = [];
    for (const sheet of declared) {
      const rel = rels.get(sheet.rid);
      // Feuilles de graphique ou de boîte de dialogue : pas de cellules.
      if (!rel || rel.external || !/\/worksheet$/.test(rel.type)) continue;
      const xml = readPart(zip, rel.target, false);
      if (xml === null) {
        sheets.push({ name: sheet.name, hidden: sheet.hidden, rows: [], columns: 0, merges: [], formulas: 0, formulasWithoutValue: 0, error: 'Feuille absente de l’archive.' });
        continue;
      }
      sheets.push(readSheet(xml, sheet.name, sheet.hidden, ctx));
    }
    if (sheets.length === 0) throw new TableReadError('Ce classeur ne contient aucune feuille de données.');
    return { format: 'xlsx', sheets, date1904, warnings };
  } catch (error) {
    if (error instanceof ZipReadError) throw new TableReadError(error.message);
    throw error;
  }
}
