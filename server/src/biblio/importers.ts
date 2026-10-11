/**
 * Import de références exportées d'autres bases : RIS (Embase, Cochrane
 * CENTRAL, Scopus, Web of Science, LiSSa, Zotero…), MEDLINE/.nbib (PubMed),
 * BibTeX (.bib) et CSV avec en-tête.
 *
 * Les lecteurs sont tolérants, parce que les exports le sont : fins de ligne
 * Windows, marque d'ordre des octets, fichiers en Latin-1 (Windows-1252) ou en
 * UTF-16, lignes de continuation, balises inconnues. Une notice illisible (sans
 * titre) est comptée et écartée ; elle ne fait pas échouer le fichier.
 *
 * Chaque lecteur rend des `BiblioRefInput`, comme une recherche : le
 * dédoublonnage et le diagramme de flux ne font pas la différence.
 */

import { clean, doiFromUrl, normDoi, pmcFromUrl, safeUrl } from './normalize.js';
import { refTypeFromPublicationTypes } from './eutils.js';
import type { BiblioRefInput, BiblioSource, RefType } from './types.js';

export const IMPORT_FORMATS = ['ris', 'nbib', 'bibtex', 'csv'] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const FORMAT_LABELS: Record<ImportFormat, string> = {
  ris: 'RIS',
  nbib: 'MEDLINE (.nbib)',
  bibtex: 'BibTeX',
  csv: 'CSV',
};

/** Au-delà, un fichier se découpe : une revue ne trie pas 50 000 notices d'un même export. */
export const MAX_IMPORT_RECORDS = 50_000;

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface ParsedImport {
  format: ImportFormat;
  encoding: string;
  refs: BiblioRefInput[];
  /** Notices lues mais inexploitables (sans titre). */
  skipped: number;
  warnings: string[];
}

/* ─────────────────────────────── Encodage ──────────────────────────────── */

/**
 * Texte d'un fichier : UTF-8 (avec ou sans marque d'ordre des octets), UTF-16
 * annoncé par sa marque, sinon Windows-1252 — l'encodage des vieux exports
 * EndNote et de certains postes Windows.
 */
export function decodeText(buffer: Uint8Array): { text: string; encoding: string } {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(buffer.subarray(2)), encoding: 'UTF-16' };
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(buffer.subarray(2)), encoding: 'UTF-16' };
  const bom = buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const body = bom ? buffer.subarray(3) : buffer;
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(body), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(body), encoding: 'Windows-1252' };
  }
}

/* ─────────────────────────────── Outils ─────────────────────────────────── */

/** Bornes d'un champ importé : un fichier hostile ou abîmé ne remplit pas la base. */
const LIMITS = { title: 2_000, abstract: 30_000, field: 1_000, authors: 1_000, keywords: 300 };
const cut = (value: string | null, max: number): string | null => {
  const text = clean(value);
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

export function blankRef(source: BiblioSource, title: string): BiblioRefInput {
  return {
    source,
    title,
    authors: [],
    year: null,
    journal: null,
    volume: null,
    issue: null,
    pages: null,
    doi: null,
    pmid: null,
    pmcid: null,
    url: null,
    pdfUrl: null,
    abstract: null,
    snippet: null,
    keywords: [],
    meshTerms: [],
    publicationTypes: [],
    citedBy: null,
    citedByUrl: null,
    refType: null,
  };
}

/** Applique les bornes et rend `null` pour une notice sans titre. */
function finalize(ref: BiblioRefInput): BiblioRefInput | null {
  // Un titre se termine souvent par un point dans les exports (PubMed, Embase) : on le retire, comme pour une recherche.
  const title = cut(ref.title, LIMITS.title)?.replace(/(?<!\.)\.$/, '') ?? '';
  if (!title) return null;
  const list = (values: string[], maxItems: number) =>
    [...new Set(values.map((v) => cut(v, LIMITS.field)).filter((v): v is string => v !== null))].slice(0, maxItems);
  return {
    ...ref,
    title,
    authors: list(ref.authors, LIMITS.authors),
    journal: cut(ref.journal, LIMITS.field),
    volume: cut(ref.volume, 50),
    issue: cut(ref.issue, 50),
    pages: cut(ref.pages, 50),
    doi: normDoi(ref.doi),
    pmid: ref.pmid && /^\d{1,9}$/.test(ref.pmid.trim()) ? ref.pmid.trim() : null,
    pmcid: ref.pmcid && /^PMC\d+$/i.test(ref.pmcid.trim()) ? ref.pmcid.trim().toUpperCase() : null,
    url: safeUrl(ref.url),
    pdfUrl: safeUrl(ref.pdfUrl),
    abstract: cut(ref.abstract, LIMITS.abstract),
    keywords: list(ref.keywords, LIMITS.keywords),
    meshTerms: list(ref.meshTerms, LIMITS.keywords),
    publicationTypes: list(ref.publicationTypes, 50),
  };
}

const yearOf = (text: string | null | undefined): number | null => {
  const m = /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/.exec(text ?? '');
  return m ? Number(m[1]) : null;
};

/**
 * « Dupont, Jean-Pierre » → « Dupont JP » ; « Smith, J. A. » → « Smith JA ».
 * Le format « Nom Initiales » est celui de PubMed : les auteurs importés
 * s'affichent et s'exportent comme ceux d'une recherche. Sans virgule, le nom
 * est gardé tel quel.
 */
export function normalizeAuthor(raw: string): string {
  const name = clean(raw).replace(/\.$/, '');
  const comma = name.indexOf(',');
  if (comma <= 0) return name;
  const last = name.slice(0, comma).trim();
  const rest = name.slice(comma + 1).trim();
  if (!rest) return last;
  // « JA » est déjà une suite d'initiales ; « Jean-Pierre » ou « J. A. » en donnent une.
  const initials = rest
    .split(/[\s.\-\u2010]+/)
    .filter(Boolean)
    .map((part) => (/^[A-Z]{2,4}$/.test(part) ? part : (part[0] ?? '').toUpperCase()))
    .join('');
  return initials ? `${last} ${initials}` : last;
}

/** « 266-74 », « 266 » + « 274 », « e15223 ». */
function pagesOf(start: string | null | undefined, end: string | null | undefined): string | null {
  const s = clean(start);
  const e = clean(end);
  if (!s) return e || null;
  if (!e || s.includes('-') || s.includes('–')) return s;
  return `${s}-${e}`;
}

const PMID_IN_TEXT = /\bPMID\s*:?\s*(\d{1,9})\b/i;
const PMC_IN_TEXT = /\b(PMC\d{3,})\b/i;

/* ─────────────────────────────────── RIS ────────────────────────────────── */

const RIS_TYPES: Record<string, RefType> = {
  JOUR: 'JOUR', JFULL: 'JOUR', EJOUR: 'JOUR', MGZN: 'JOUR', ABST: 'JOUR', INPR: 'JOUR', NEWS: 'JOUR',
  CONF: 'CONF', CPAPER: 'CONF',
  BOOK: 'BOOK', EBOOK: 'BOOK', EDBOOK: 'BOOK',
  CHAP: 'CHAP', ECHAP: 'CHAP',
  THES: 'THES',
  RPRT: 'RPRT', GOVDOC: 'RPRT', STAND: 'RPRT',
  UNPB: 'UNPB', MANSCPT: 'UNPB',
  ELEC: 'ELEC', WEB: 'ELEC', BLOG: 'ELEC',
  DATA: 'DATA', DBASE: 'DATA',
};

const RIS_LINE = /^([A-Z][A-Z0-9])\s{1,3}-(?:\s+(.*?))?\s*$/;

export function parseRis(text: string, source: BiblioSource): { refs: BiblioRefInput[]; skipped: number } {
  const refs: BiblioRefInput[] = [];
  let skipped = 0;
  let fields: [string, string][] | null = null;

  const close = () => {
    if (!fields) return;
    const ref = risRecord(fields, source);
    if (ref) refs.push(ref);
    else skipped += 1;
    fields = null;
    if (refs.length + skipped > MAX_IMPORT_RECORDS) throw tooMany();
  };

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/^\ufeff/, '');
    const m = RIS_LINE.exec(line);
    if (m) {
      const tag = m[1] as string;
      const value = m[2] ?? '';
      if (tag === 'TY') {
        close();
        fields = [['TY', value]];
      } else if (tag === 'ER') {
        close();
      } else {
        if (!fields) fields = [];
        fields.push([tag, value]);
      }
      continue;
    }
    // Ligne de continuation (résumé coupé en plusieurs lignes par certains exports).
    const extra = line.trim();
    const current = fields as [string, string][] | null;
    if (extra && current && current.length > 0) {
      const last = current[current.length - 1] as [string, string];
      last[1] = `${last[1]} ${extra}`;
    }
  }
  close();
  return { refs, skipped };
}

function risRecord(fields: [string, string][], source: BiblioSource): BiblioRefInput | null {
  const all = (...tags: string[]) => fields.filter(([t]) => tags.includes(t)).map(([, v]) => clean(v)).filter(Boolean);
  const first = (...tags: string[]) => {
    for (const tag of tags) {
      const found = fields.find(([t, v]) => t === tag && clean(v));
      if (found) return clean(found[1]);
    }
    return null;
  };

  const ty = (first('TY') ?? '').toUpperCase();
  let refType: RefType = RIS_TYPES[ty] ?? 'GEN';
  const m3 = all('M3');
  if (refType === 'JOUR' && m3.some((v) => /conference/i.test(v))) refType = 'CONF';

  const chapterLike = refType === 'CHAP' || refType === 'CONF';
  const title = first('TI', 'T1', 'CT') ?? (refType === 'BOOK' ? first('BT', 'T2') : null) ?? '';
  const ref = blankRef(source, title);
  ref.refType = refType;
  ref.authors = all('AU', 'A1').map(normalizeAuthor);
  ref.year = yearOf(first('PY', 'Y1', 'DA', 'Y2'));
  ref.journal = chapterLike ? first('T2', 'BT', 'JF', 'JO', 'T3') : first('T2', 'JF', 'JO', 'JA', 'J2', 'J1', 'BT');
  ref.volume = first('VL');
  ref.issue = first('IS', 'CP');
  ref.pages = pagesOf(first('SP'), first('EP'));
  ref.abstract = first('AB', 'N2');

  const urls = all('UR', 'L2', 'L3', 'LK');
  ref.doi = normDoi(first('DO', 'DI')) ?? urls.map(doiFromUrl).find(Boolean) ?? null;
  ref.url = urls.map(safeUrl).find(Boolean) ?? null;
  ref.pdfUrl = all('L1').map(safeUrl).find(Boolean) ?? null;

  // Mots-clés : une ligne chacun, ou plusieurs séparés par « ; » sur une seule ligne.
  ref.keywords = all('KW').flatMap((k) => k.split(/\s*;\s*/)).filter(Boolean);
  ref.publicationTypes = m3;

  // PMID : « AN » ne l'est que si l'export vient de PubMed/MEDLINE (ailleurs c'est le numéro de la base).
  const fromMedline = source === 'pubmed' || all('DB', 'DP').some((v) => /pubmed|medline/i.test(v));
  const an = first('AN');
  const values = fields.map(([, v]) => v);
  ref.pmid =
    (fromMedline && an && /^\d{1,9}$/.test(an) ? an : null) ??
    values.map((v) => PMID_IN_TEXT.exec(v)?.[1]).find(Boolean) ??
    null;
  ref.pmcid =
    all('C2', 'C6', 'M2').map((v) => PMC_IN_TEXT.exec(v)?.[1]).find(Boolean) ??
    urls.map(pmcFromUrl).find(Boolean) ??
    null;
  return finalize(ref);
}

/* ───────────────────────────── MEDLINE (.nbib) ──────────────────────────── */

const NBIB_LINE = /^([A-Z][A-Z0-9]{1,3})\s*-\s?(.*)$/;

export function parseNbib(text: string, source: BiblioSource): { refs: BiblioRefInput[]; skipped: number } {
  const refs: BiblioRefInput[] = [];
  let skipped = 0;
  let fields: [string, string][] = [];

  const close = () => {
    if (fields.length === 0) return;
    const ref = nbibRecord(fields, source);
    if (ref) refs.push(ref);
    else skipped += 1;
    fields = [];
    if (refs.length + skipped > MAX_IMPORT_RECORDS) throw tooMany();
  };

  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/^\ufeff/, '');
    if (line.trim() === '') {
      close();
      continue;
    }
    // Continuation : six espaces en tête (format MEDLINE), ou toute ligne sans balise.
    const m = /^\s/.test(line) ? null : NBIB_LINE.exec(line);
    if (m) {
      const tag = m[1] as string;
      if (tag === 'PMID') close();
      fields.push([tag, m[2] ?? '']);
    } else if (fields.length > 0) {
      const last = fields[fields.length - 1] as [string, string];
      last[1] = `${last[1]} ${line.trim()}`;
    }
  }
  close();
  return { refs, skipped };
}

function nbibRecord(fields: [string, string][], source: BiblioSource): BiblioRefInput | null {
  const all = (tag: string) => fields.filter(([t]) => t === tag).map(([, v]) => clean(v)).filter(Boolean);
  const first = (...tags: string[]) => {
    for (const tag of tags) {
      const v = all(tag)[0];
      if (v) return v;
    }
    return null;
  };

  const bookTitle = first('BTI');
  const chapter = first('TI');
  const title = chapter ?? bookTitle ?? '';
  const ref = blankRef(source, title.replace(/^\[(.*)\]\.?$/, '$1'));
  ref.pmid = first('PMID');
  const short = all('AU');
  ref.authors = [...(short.length > 0 ? short : all('FAU').map(normalizeAuthor)), ...all('CN')];
  ref.year = yearOf(first('DP', 'DEP', 'CRDT'));
  ref.journal = bookTitle && chapter ? bookTitle : first('JT', 'TA');
  ref.volume = first('VI');
  ref.issue = first('IP');
  ref.pages = first('PG');
  ref.abstract = first('AB');
  const ids = [...all('LID'), ...all('AID')];
  ref.doi = ids.filter((v) => /\[doi\]/i.test(v)).map((v) => normDoi(v)).find(Boolean) ?? null;
  ref.pmcid = first('PMC') ?? ids.map((v) => (/\[pmc\]/i.test(v) ? PMC_IN_TEXT.exec(v)?.[1] : undefined)).find(Boolean) ?? null;
  ref.url = ref.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/` : null;
  // « Appendicitis/*surgery » → « Appendicitis » : le descripteur, sans qualificatif ni astérisque de sujet majeur.
  ref.meshTerms = all('MH').map((h) => (h.split('/')[0] ?? '').replace(/^\*/, '').trim());
  ref.keywords = all('OT');
  ref.publicationTypes = all('PT');
  ref.refType = bookTitle ? (chapter ? 'CHAP' : 'BOOK') : refTypeFromPublicationTypes(ref.publicationTypes);
  return finalize(ref);
}

/* ───────────────────────────────── BibTeX ───────────────────────────────── */

const BIBTEX_TYPES: Record<string, RefType> = {
  article: 'JOUR',
  inproceedings: 'CONF', conference: 'CONF', proceedings: 'CONF',
  book: 'BOOK', mvbook: 'BOOK', booklet: 'BOOK',
  incollection: 'CHAP', inbook: 'CHAP', inreference: 'CHAP',
  phdthesis: 'THES', mastersthesis: 'THES', thesis: 'THES',
  techreport: 'RPRT', report: 'RPRT', manual: 'RPRT',
  unpublished: 'UNPB',
  online: 'ELEC', electronic: 'ELEC', www: 'ELEC',
  dataset: 'DATA',
};

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const ACCENTS: Record<string, string> = {
  "'": '\u0301', '`': '\u0300', '^': '\u0302', '"': '\u0308', '~': '\u0303', '=': '\u0304', '.': '\u0307',
  u: '\u0306', v: '\u030c', H: '\u030b', c: '\u0327', k: '\u0328', r: '\u030a',
};
const LETTERS: Record<string, string> = {
  ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'i', j: 'j',
};

/** LaTeX → Unicode, pour ce que les gestionnaires de références écrivent : accents, ligatures, caractères échappés. */
export function latexToText(value: string): string {
  let text = value;
  text = text.replace(/\\(ss|ae|AE|oe|OE|aa|AA|o|O|l|L|i|j)(?![A-Za-z])\s?/g, (_m, name: string) => LETTERS[name] ?? name);
  text = text.replace(/\\(['`^"~=.])\s*(?:\{\s*([A-Za-z])\s*\}|([A-Za-z]))/g, (_m, accent: string, a?: string, b?: string) => `${a ?? b}${ACCENTS[accent]}`);
  text = text.replace(/\\([uvHckr])\s*(?:\{\s*([A-Za-z])\s*\}|\s+([A-Za-z]))/g, (_m, accent: string, a?: string, b?: string) => `${a ?? b}${ACCENTS[accent]}`);
  text = text.replace(/\\([&%$#_{}])/g, '$1').replace(/\\[,;:! ]/g, ' ');
  text = text.replace(/\\textendash\b\s?|--/g, '–').replace(/\\textemdash\b\s?|---/g, '—');
  // Commande de mise en forme (\emph{x}, \textit{x}) : on garde le contenu.
  text = text.replace(/\\[A-Za-z]+\s*(?=\{)/g, '');
  text = text.replace(/[{}]/g, '').replace(/~/g, '\u00a0');
  return text.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/** Coupe « A and B and {C and D} » au niveau zéro des accolades. */
function splitAnd(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  const tokens = value.split(/(\{|\}|\s+and\s+)/i);
  for (const token of tokens) {
    if (token === '{') depth++;
    else if (token === '}') depth--;
    if (depth === 0 && /^\s+and\s+$/i.test(token)) {
      parts.push(current);
      current = '';
    } else current += token;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** « Dupont, Jean » ou « Jean Dupont » → « Dupont J » ; un nom entre accolades (collectif) reste entier. */
function bibtexAuthor(raw: string): string {
  const trimmed = raw.trim();
  if (/^\{.*\}$/.test(trimmed)) return latexToText(trimmed);
  const text = latexToText(trimmed);
  if (text.includes(',')) return normalizeAuthor(text);
  const words = text.split(/\s+/);
  if (words.length < 2) return text;
  const last = words.pop() as string;
  return normalizeAuthor(`${last}, ${words.join(' ')}`);
}

interface BibEntry {
  type: string;
  fields: Record<string, string>;
}

/** Lit les entrées d'un fichier BibTeX ; une entrée mal formée est sautée jusqu'au « @ » suivant. */
export function readBibtexEntries(text: string): { entries: BibEntry[]; broken: number } {
  const entries: BibEntry[] = [];
  const macros: Record<string, string> = Object.fromEntries(MONTHS.map((m, i) => [m, String(i + 1)]));
  let broken = 0;
  let i = 0;
  const n = text.length;

  const skipSpace = () => {
    while (i < n && /\s/.test(text[i] as string)) i++;
  };
  const readBraced = (): string => {
    // text[i] === '{'
    let depth = 0;
    const start = i + 1;
    for (; i < n; i++) {
      const c = text[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) {
          i++;
          return text.slice(start, i - 1);
        }
      }
    }
    throw new Error('accolade non fermée');
  };
  const readQuoted = (): string => {
    let depth = 0;
    const start = ++i;
    for (; i < n; i++) {
      const c = text[i];
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '"' && depth === 0) {
        i++;
        return text.slice(start, i - 1);
      }
    }
    throw new Error('guillemet non fermé');
  };
  const readValue = (): string => {
    const parts: string[] = [];
    for (;;) {
      skipSpace();
      const c = text[i];
      if (c === '{') parts.push(readBraced());
      else if (c === '"') parts.push(readQuoted());
      else {
        const m = /^[^\s,#}\)]+/.exec(text.slice(i, i + 200));
        if (!m) throw new Error('valeur attendue');
        i += m[0].length;
        parts.push(macros[m[0].toLowerCase()] ?? m[0]);
      }
      skipSpace();
      if (text[i] === '#') {
        i++;
        continue;
      }
      return parts.join('');
    }
  };

  while (i < n) {
    const at = text.indexOf('@', i);
    if (at === -1) break;
    i = at + 1;
    const typeMatch = /^([A-Za-z]+)\s*([{(])/.exec(text.slice(i, i + 60));
    if (!typeMatch) continue;
    const type = (typeMatch[1] as string).toLowerCase();
    i += typeMatch[0].length;
    const closer = typeMatch[2] === '{' ? '}' : ')';
    try {
      if (type === 'comment' || type === 'preamble') {
        i -= 1;
        if (typeMatch[2] === '{') readBraced();
        else i = Math.max(text.indexOf(')', i), i + 1);
        continue;
      }
      if (type === 'string') {
        skipSpace();
        const name = /^[^\s=]+/.exec(text.slice(i, i + 100))?.[0] ?? '';
        i += name.length;
        skipSpace();
        if (text[i] !== '=') throw new Error('« = » attendu');
        i++;
        macros[name.toLowerCase()] = readValue();
        skipSpace();
        if (text[i] === closer) i++;
        continue;
      }
      // Clé de citation, jusqu'à la première virgule.
      const comma = text.indexOf(',', i);
      const end = text.indexOf(closer, i);
      if (comma === -1 || (end !== -1 && end < comma)) {
        i = end === -1 ? n : end + 1;
        broken++;
        continue;
      }
      i = comma + 1;
      const fields: Record<string, string> = {};
      for (;;) {
        skipSpace();
        if (text[i] === closer) {
          i++;
          break;
        }
        if (text[i] === ',') {
          i++;
          continue;
        }
        const name = /^[A-Za-z][\w:.-]*/.exec(text.slice(i, i + 100))?.[0];
        if (!name) throw new Error('nom de champ attendu');
        i += name.length;
        skipSpace();
        if (text[i] !== '=') throw new Error('« = » attendu');
        i++;
        const value = readValue();
        if (!(name.toLowerCase() in fields)) fields[name.toLowerCase()] = value;
      }
      entries.push({ type, fields });
      if (entries.length > MAX_IMPORT_RECORDS) throw tooMany();
    } catch (error) {
      if (error instanceof ImportError) throw error;
      broken++;
      // On reprend au prochain « @ » en début de ligne après le début de l'entrée fautive : une accolade jamais
      // fermée a pu entraîner la lecture jusqu'à la fin du fichier.
      const next = text.slice(at + 1).search(/\n\s*@/);
      i = next === -1 ? n : at + 1 + next + 1;
    }
  }
  return { entries, broken };
}

export function parseBibtex(text: string, source: BiblioSource): { refs: BiblioRefInput[]; skipped: number } {
  const { entries, broken } = readBibtexEntries(text);
  const refs: BiblioRefInput[] = [];
  let skipped = broken;
  for (const { type, fields } of entries) {
    const f = (...names: string[]) => {
      for (const name of names) {
        const v = fields[name];
        if (v !== undefined && latexToText(v)) return latexToText(v);
      }
      return null;
    };
    const refType = BIBTEX_TYPES[type] ?? 'GEN';
    const chapterLike = refType === 'CHAP' || refType === 'CONF';
    const ref = blankRef(source, f('title') ?? (refType === 'BOOK' ? f('booktitle') : null) ?? '');
    ref.refType = refType;
    ref.authors = fields.author ? splitAnd(fields.author).map(bibtexAuthor) : [];
    ref.year = yearOf(f('year', 'date'));
    ref.journal = chapterLike ? f('booktitle', 'journal', 'journaltitle') : f('journal', 'journaltitle', 'booktitle');
    ref.volume = f('volume');
    ref.issue = f('number', 'issue');
    ref.pages = f('pages')?.replace(/\s*[–—]\s*/g, '-') ?? null;
    ref.doi = normDoi(f('doi'));
    const eprintType = (f('eprinttype', 'archiveprefix') ?? '').toLowerCase();
    ref.pmid = f('pmid') ?? (eprintType === 'pubmed' ? f('eprint') : null);
    ref.pmcid = f('pmcid') ?? (eprintType === 'pmc' ? f('eprint') : null);
    ref.url = f('url');
    ref.abstract = f('abstract');
    ref.keywords = (f('keywords', 'mesh') ?? '').split(/\s*[;,]\s*/).filter(Boolean);
    const done = finalize(ref);
    if (done) refs.push(done);
    else skipped++;
  }
  return { refs, skipped };
}

/* ─────────────────────────────────── CSV ────────────────────────────────── */

/** Lit un CSV (RFC 4180 : guillemets doublés, retours à la ligne dans une cellule). */
export function readCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell.trim() === '') {
      quoted = true;
      cell = '';
    } else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((v) => v.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      if (rows.length > MAX_IMPORT_RECORDS + 1) throw tooMany();
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== '')) rows.push(row);
  return rows;
}

/** Séparateur le plus fréquent de la ligne d'en-tête, hors guillemets. */
export function sniffDelimiter(text: string): string {
  const header = text.split(/\r\n|\r|\n/, 1)[0] ?? '';
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const c of header) {
    if (c === '"') quoted = !quoted;
    else if (!quoted && c in counts) counts[c] = (counts[c] ?? 0) + 1;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [',', 0];
  return count > 0 ? best : ',';
}

const foldHeader = (h: string) =>
  h.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** En-têtes reconnus, en anglais et en français : PubMed, Scopus, Web of Science, Zotero, et l'export de cette application. */
const CSV_COLUMNS = {
  title: ['title', 'titre', 'articletitle', 'documenttitle', 'ti'],
  authors: ['authors', 'author', 'auteurs', 'auteur', 'au', 'authorfullnames', 'authornames'],
  year: ['year', 'annee', 'publicationyear', 'py', 'pubyear', 'date', 'publicationdate', 'datepublished'],
  journal: ['journal', 'revue', 'sourcetitle', 'publicationtitle', 'journaltitle', 'journalbook', 'source', 'so', 'jt', 'journalname'],
  doi: ['doi', 'di'],
  pmid: ['pmid', 'pubmedid', 'pm'],
  pmcid: ['pmcid', 'pmc'],
  abstract: ['abstract', 'resume', 'resumeouextrait', 'ab', 'abstractnote'],
  volume: ['volume', 'vl', 'vol'],
  issue: ['issue', 'numero', 'is', 'number'],
  pages: ['pages', 'pagination', 'pg'],
  pageStart: ['pagestart', 'startpage', 'bp'],
  pageEnd: ['pageend', 'endpage', 'ep'],
  url: ['url', 'lien', 'link'],
  keywords: ['keywords', 'motscles', 'authorkeywords', 'manualtags', 'de', 'kw'],
  type: ['itemtype', 'documenttype', 'pt', 'publicationtype', 'type'],
} as const;

/** « Smith J; Doe A », « Smith J, Doe A » (PubMed), « Smith, J.; Doe, A. » (Scopus). */
export function splitCsvAuthors(raw: string): string[] {
  const text = clean(raw);
  if (!text) return [];
  if (text.includes(';')) return text.split(/\s*;\s*/).filter(Boolean).map(normalizeAuthor);
  const parts = text.split(/\s*,\s*/);
  // Liste « Nom Initiales, Nom Initiales » : chaque morceau finit par des initiales.
  if (parts.length > 1 && parts.every((p) => /^[\p{L}'’ -]+\s(?:[A-Z]\.?){1,4}$/u.test(p.trim()))) {
    return parts.map((p) => p.replace(/\./g, '').trim());
  }
  return [normalizeAuthor(text)];
}

const CSV_TYPES: [RegExp, RefType][] = [
  [/conference|proceeding|congr/i, 'CONF'],
  [/book ?chapter|booksection|chapitre|^chapter/i, 'CHAP'],
  [/^book$|^livre$/i, 'BOOK'],
  [/thesis|these|dissertation/i, 'THES'],
  [/report|rapport/i, 'RPRT'],
  [/article|review|journal|letter|editorial/i, 'JOUR'],
];

export function parseCsv(text: string, source: BiblioSource): { refs: BiblioRefInput[]; skipped: number } {
  const rows = readCsv(text, sniffDelimiter(text));
  const header = (rows[0] ?? []).map(foldHeader);
  const col = (key: keyof typeof CSV_COLUMNS): number => {
    for (const name of CSV_COLUMNS[key]) {
      const index = header.indexOf(name);
      if (index !== -1) return index;
    }
    return -1;
  };
  const titleCol = col('title');
  if (titleCol === -1) {
    throw new ImportError(
      'Le CSV n’a pas de colonne de titre reconnue. La première ligne doit être un en-tête avec au moins « title » (ou « titre »), et de préférence « authors », « year », « doi », « pmid ».',
    );
  }
  const columns = Object.fromEntries((Object.keys(CSV_COLUMNS) as (keyof typeof CSV_COLUMNS)[]).map((k) => [k, col(k)])) as Record<
    keyof typeof CSV_COLUMNS,
    number
  >;

  const refs: BiblioRefInput[] = [];
  let skipped = 0;
  for (const row of rows.slice(1)) {
    const get = (key: keyof typeof CSV_COLUMNS) => (columns[key] === -1 ? null : clean(row[columns[key]] ?? '') || null);
    const ref = blankRef(source, get('title') ?? '');
    ref.authors = splitCsvAuthors(get('authors') ?? '');
    ref.year = yearOf(get('year'));
    ref.journal = get('journal');
    ref.volume = get('volume');
    ref.issue = get('issue');
    ref.pages = get('pages') ?? pagesOf(get('pageStart'), get('pageEnd'));
    ref.doi = normDoi(get('doi'));
    ref.pmid = get('pmid');
    ref.pmcid = get('pmcid');
    ref.url = get('url');
    ref.abstract = get('abstract');
    ref.keywords = (get('keywords') ?? '').split(/\s*;\s*/).filter(Boolean);
    const type = get('type');
    ref.refType = type ? (CSV_TYPES.find(([re]) => re.test(type))?.[1] ?? 'GEN') : null;
    if (type) ref.publicationTypes = [type];
    const done = finalize(ref);
    if (done) refs.push(done);
    else skipped++;
  }
  return { refs, skipped };
}

/* ────────────────────────────── Détection ───────────────────────────────── */

function tooMany(): ImportError {
  return new ImportError(
    `Fichier trop long : au plus ${MAX_IMPORT_RECORDS.toLocaleString('fr-FR')} notices par import. Découpez l’export en plusieurs fichiers.`,
  );
}

/** Format d'un fichier, d'après son contenu d'abord, son extension ensuite. */
export function detectFormat(text: string, fileName: string): ImportFormat | null {
  const head = text.slice(0, 20_000);
  if (/^\s*PMID-\s*\d/m.test(head)) return 'nbib';
  if (/^TY {1,3}- /m.test(head)) return 'ris';
  if (/^\s*@[A-Za-z]+\s*[{(]/m.test(head)) return 'bibtex';
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase();
  if (ext === 'ris') return 'ris';
  if (ext === 'nbib' || ext === 'medline') return 'nbib';
  if (ext === 'bib' || ext === 'bibtex') return 'bibtex';
  if (ext === 'csv' || ext === 'tsv' || ext === 'txt') {
    const firstLine = head.split(/\r\n|\r|\n/, 1)[0] ?? '';
    if (/[,;\t]/.test(firstLine)) return 'csv';
  }
  return null;
}

/** Lit un fichier importé, quel que soit son format. */
export function parseImport(
  buffer: Uint8Array,
  fileName: string,
  source: BiblioSource,
  format: ImportFormat | 'auto' = 'auto',
): ParsedImport {
  const { text, encoding } = decodeText(buffer);
  if (/\u0000/.test(text.slice(0, 4096))) {
    throw new ImportError('Ce fichier n’est pas un fichier texte (PDF, document Word, archive ?). Exportez les références au format RIS, MEDLINE (.nbib), BibTeX ou CSV.');
  }
  const detected = format === 'auto' ? detectFormat(text, fileName) : format;
  if (!detected) {
    throw new ImportError(
      'Format non reconnu. Importez un export RIS (.ris), MEDLINE/PubMed (.nbib), BibTeX (.bib) ou un CSV avec une ligne d’en-tête.',
    );
  }
  const parsed =
    detected === 'ris'
      ? parseRis(text, source)
      : detected === 'nbib'
        ? parseNbib(text, source)
        : detected === 'bibtex'
          ? parseBibtex(text, source)
          : parseCsv(text, source);
  const warnings: string[] = [];
  if (encoding === 'Windows-1252') warnings.push('Fichier lu en Windows-1252 (Latin-1) : il n’était pas en UTF-8. Vérifiez les accents des premières notices.');
  if (parsed.skipped > 0) {
    warnings.push(`${parsed.skipped.toLocaleString('fr-FR')} notice${parsed.skipped > 1 ? 's' : ''} sans titre ou illisible${parsed.skipped > 1 ? 's' : ''}, écartée${parsed.skipped > 1 ? 's' : ''}.`);
  }
  return { format: detected, encoding, refs: parsed.refs, skipped: parsed.skipped, warnings };
}
