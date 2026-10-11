/**
 * Exports de la revue bibliographique : RIS et BibTeX pour un gestionnaire de
 * références (Zotero, EndNote…), CSV pour le tableur, et le CSV des stratégies
 * de recherche — la pièce qui rend la recherche reproductible.
 */

import { toCsv } from '../lib/csv.js';
import { refTypeFromPublicationTypes } from './eutils.js';
import { authorForBibtex, lastNameOf } from './normalize.js';
import {
  DECISION_LABELS,
  EXCLUSION_REASONS,
  SOURCE_LABELS,
  type BiblioRef,
  type BiblioSearch,
  type RefType,
} from './types.js';

/**
 * Texte sur une ligne, sans caractère de contrôle. Un octet nul ou un code d'échappement venu d'une notice
 * n'a rien à faire dans un fichier que Zotero, EndNote ou un éditeur LaTeX vont relire.
 */
const oneLine = (s: string | null | undefined): string =>
  (s ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const reasonLabel = (ref: BiblioRef): string =>
  ref.exclusionReason ? EXCLUSION_REASONS[ref.exclusionReason] : '';

/* ──────────────────────────────────── RIS ───────────────────────────────── */

/** Pages « 266-274 » → début et fin ; « e15223 » → début seul. */
function splitPages(pages: string | null): { start: string; end: string | null } | null {
  const p = oneLine(pages);
  if (!p) return null;
  const range = /^([^\s–-]+)\s*[–-]\s*([^\s–-]+)$/.exec(p);
  return range ? { start: range[1] ?? p, end: range[2] ?? null } : { start: p, end: null };
}

/**
 * Type RIS d'une référence : celui que la source a donné (import RIS, BibTeX,
 * livre PubMed), sinon déduit des types de publication de PubMed, sinon
 * « article de revue » s'il y a une revue ou si PubMed l'a rendue (hors livres,
 * déjà typés, PubMed n'indexe que des articles), « générique » sinon.
 */
export function risTypeOf(ref: BiblioRef): RefType {
  if (ref.refType) return ref.refType;
  const fromTypes = refTypeFromPublicationTypes(ref.publicationTypes);
  if (fromTypes !== 'JOUR') return fromTypes;
  return ref.journal || ref.sources.includes('pubmed') ? 'JOUR' : 'GEN';
}

export function toRis(refs: BiblioRef[]): string {
  const lines: string[] = [];
  const tag = (code: string, value: string | number | null | undefined) => {
    const text = oneLine(value === null || value === undefined ? '' : String(value));
    if (text) lines.push(`${code}  - ${text}`);
  };

  for (const ref of refs) {
    const type = risTypeOf(ref);
    tag('TY', type);
    for (const author of ref.authors) tag('AU', author);
    tag('TI', ref.title);
    // Revue pour un article ; titre du livre ou des actes pour un chapitre ou une communication.
    if (type === 'CHAP' || type === 'CONF') tag('T2', ref.journal);
    else if (type !== 'BOOK') tag('JO', ref.journal);
    tag('PY', ref.year);
    tag('VL', ref.volume);
    tag('IS', ref.issue);
    const pages = splitPages(ref.pages);
    if (pages) {
      tag('SP', pages.start);
      tag('EP', pages.end);
    }
    tag('DO', ref.doi);
    tag('AN', ref.pmid);
    // PMCID : champ C2, comme les exports PubMed d'EndNote — Zotero et EndNote le relisent.
    tag('C2', ref.pmcid);
    tag('AB', ref.abstract ?? ref.snippet);
    for (const keyword of ref.keywords) tag('KW', keyword);
    tag('UR', ref.url);
    tag('L1', ref.pdfUrl);
    const triage = [
      `Tri : ${DECISION_LABELS[ref.decision]}`,
      ref.exclusionReason ? `Motif : ${reasonLabel(ref)}` : '',
      ref.note ? `Note : ${ref.note}` : '',
      `Sources : ${ref.sources.map((s) => SOURCE_LABELS[s]).join(', ')}`,
    ]
      .filter(Boolean)
      .join(' ; ');
    tag('N1', triage);
    lines.push('ER  - ');
    lines.push('');
  }
  return lines.join('\r\n');
}

/* ────────────────────────────────── BibTeX ──────────────────────────────── */

function bibEscape(value: string): string {
  return oneLine(value).replace(/([\\{}&%$#_])/g, (_m, c: string) => (c === '\\' ? '\\textbackslash{}' : `\\${c}`));
}

const slug = (s: string): string =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '').toLowerCase();

const BIBTEX_TYPES: Record<RefType, string> = {
  JOUR: 'article',
  CONF: 'inproceedings',
  BOOK: 'book',
  CHAP: 'incollection',
  THES: 'phdthesis',
  RPRT: 'techreport',
  UNPB: 'unpublished',
  GEN: 'misc',
  ELEC: 'misc',
  DATA: 'misc',
};

export function toBibtex(refs: BiblioRef[]): string {
  const used = new Set<string>();
  const entries = refs.map((ref) => {
    const first = ref.authors[0] ? slug(lastNameOf(ref.authors[0])) : 'anon';
    let key = `${first || 'anon'}${ref.year ?? 'nd'}`;
    if (used.has(key)) key = `${key}-${ref.id}`;
    used.add(key);

    const type = risTypeOf(ref);
    const container = type === 'CHAP' || type === 'CONF' ? 'booktitle' : type === 'JOUR' ? 'journal' : 'howpublished';
    const fields: [string, string | null][] = [
      ['author', ref.authors.length > 0 ? ref.authors.map((a) => bibEscape(authorForBibtex(a))).join(' and ') : null],
      // Doubles accolades : BibTeX conserve les majuscules du titre.
      ['title', `{${bibEscape(ref.title)}}`],
      [container, ref.journal && type !== 'BOOK' ? bibEscape(ref.journal) : null],
      ['year', ref.year ? String(ref.year) : null],
      ['volume', ref.volume ? bibEscape(ref.volume) : null],
      ['number', ref.issue ? bibEscape(ref.issue) : null],
      ['pages', ref.pages ? bibEscape(ref.pages).replace(/\s*[–-]\s*/, '--') : null],
      ['doi', ref.doi],
      ['pmid', ref.pmid],
      ['pmcid', ref.pmcid],
      ['url', ref.url],
      ['abstract', ref.abstract ? bibEscape(ref.abstract) : null],
      ['keywords', ref.keywords.length > 0 ? bibEscape(ref.keywords.join(', ')) : null],
    ];
    const body = fields
      .filter((f): f is [string, string] => f[1] !== null && f[1] !== '')
      .map(([name, value]) => `  ${name} = {${value}}`)
      .join(',\n');
    return `@${BIBTEX_TYPES[type]}{${key},\n${body}\n}`;
  });
  return entries.join('\n\n') + '\n';
}

/* ───────────────────────────────────── CSV ───────────────────────────────── */

export function refsToCsv(refs: BiblioRef[]): string {
  const headers = [
    'Sources',
    'Titre',
    'Auteurs',
    'Année',
    'Revue',
    'Volume',
    'Numéro',
    'Pages',
    'DOI',
    'PMID',
    'PMCID',
    'Lien',
    'Cité par',
    'Décision',
    'Motif d’exclusion',
    'Note',
    'Résumé ou extrait',
  ];
  const rows = refs.map((r) => [
    r.sources.map((s) => SOURCE_LABELS[s]).join(' + '),
    r.title,
    r.authors.join('; '),
    r.year,
    r.journal,
    r.volume,
    r.issue,
    r.pages,
    r.doi,
    r.pmid,
    r.pmcid,
    r.url,
    r.citedBy,
    DECISION_LABELS[r.decision],
    reasonLabel(r),
    r.note,
    oneLine(r.abstract ?? r.snippet),
  ]);
  return toCsv(headers, rows, { delimiter: ';' });
}

/**
 * Le journal de recherche : ce qu'un relecteur de revue systématique demande
 * en premier, et ce que PRISMA-S détaille — pour chaque source, la date, la
 * chaîne exacte, ce que la source en a compris, le nombre total de résultats
 * et le nombre récupéré ; pour chaque import, la base et le fichier.
 */
export function searchesToCsv(searches: BiblioSearch[]): string {
  const headers = [
    'Date',
    'Type',
    'Source',
    'Service ou format',
    'Équation de recherche',
    'Équation envoyée',
    'Traduction par PubMed',
    'Fichier importé',
    'Année de début',
    'Année de fin',
    'Résultats annoncés',
    'Notices récupérées',
    'Références nouvelles',
    'Déjà connues',
    'Statut',
    'Avertissements',
    'Erreur',
  ];
  const rows = [...searches]
    .sort((a, b) => a.id - b.id)
    .map((s) => [
      s.queriedAt,
      s.kind === 'import' ? 'import' : 'recherche',
      s.sourceLabel ? `${SOURCE_LABELS[s.source]} (${s.sourceLabel})` : SOURCE_LABELS[s.source],
      s.actor,
      s.query,
      s.sentQuery,
      s.queryTranslation,
      s.fileName,
      s.yearFrom,
      s.yearTo,
      s.totalCount,
      s.returned,
      s.added,
      s.duplicates,
      s.status === 'ok' ? 'réussie' : s.status === 'running' ? 'en cours' : 'échec',
      s.warnings.join(' | '),
      s.error,
    ]);
  return toCsv(headers, rows, { delimiter: ';' });
}
