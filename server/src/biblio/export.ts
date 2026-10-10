/**
 * Exports de la revue bibliographique : RIS et BibTeX pour un gestionnaire de
 * références (Zotero, EndNote…), CSV pour le tableur, et le CSV des stratégies
 * de recherche — la pièce qui rend la recherche reproductible.
 */

import { toCsv } from '../lib/csv.js';
import { authorForBibtex, lastNameOf } from './normalize.js';
import {
  DECISION_LABELS,
  EXCLUSION_REASONS,
  SOURCE_LABELS,
  type BiblioRef,
  type BiblioSearch,
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

export function toRis(refs: BiblioRef[]): string {
  const lines: string[] = [];
  const tag = (code: string, value: string | number | null | undefined) => {
    const text = oneLine(value === null || value === undefined ? '' : String(value));
    if (text) lines.push(`${code}  - ${text}`);
  };

  for (const ref of refs) {
    tag('TY', 'JOUR');
    for (const author of ref.authors) tag('AU', author);
    tag('TI', ref.title);
    tag('JO', ref.journal);
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

export function toBibtex(refs: BiblioRef[]): string {
  const used = new Set<string>();
  const entries = refs.map((ref) => {
    const first = ref.authors[0] ? slug(lastNameOf(ref.authors[0])) : 'anon';
    let key = `${first || 'anon'}${ref.year ?? 'nd'}`;
    if (used.has(key)) key = `${key}-${ref.id}`;
    used.add(key);

    const fields: [string, string | null][] = [
      ['author', ref.authors.length > 0 ? ref.authors.map((a) => bibEscape(authorForBibtex(a))).join(' and ') : null],
      // Doubles accolades : BibTeX conserve les majuscules du titre.
      ['title', `{${bibEscape(ref.title)}}`],
      ['journal', ref.journal ? bibEscape(ref.journal) : null],
      ['year', ref.year ? String(ref.year) : null],
      ['volume', ref.volume ? bibEscape(ref.volume) : null],
      ['number', ref.issue ? bibEscape(ref.issue) : null],
      ['pages', ref.pages ? bibEscape(ref.pages).replace(/\s*[–-]\s*/, '--') : null],
      ['doi', ref.doi],
      ['pmid', ref.pmid],
      ['url', ref.url],
      ['abstract', ref.abstract ? bibEscape(ref.abstract) : null],
      ['keywords', ref.keywords.length > 0 ? bibEscape(ref.keywords.join(', ')) : null],
    ];
    const body = fields
      .filter((f): f is [string, string] => f[1] !== null && f[1] !== '')
      .map(([name, value]) => `  ${name} = {${value}}`)
      .join(',\n');
    return `@article{${key},\n${body}\n}`;
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

/** La stratégie de recherche : ce qu'un relecteur de revue systématique demande en premier. */
export function searchesToCsv(searches: BiblioSearch[]): string {
  const headers = [
    'Date de la recherche',
    'Source',
    'Acteur Apify',
    'Équation de recherche',
    'Année de début',
    'Année de fin',
    'Résultats demandés',
    'Résultats rendus',
    'Références nouvelles',
    'Déjà connues',
    'Statut',
    'Erreur',
  ];
  const rows = [...searches]
    .sort((a, b) => a.id - b.id)
    .map((s) => [
      s.queriedAt,
      SOURCE_LABELS[s.source],
      s.actor,
      s.query,
      s.yearFrom,
      s.yearTo,
      s.maxResults,
      s.returned,
      s.added,
      s.duplicates,
      s.status === 'ok' ? 'réussie' : s.status === 'running' ? 'en cours' : 'échec',
      s.error,
    ]);
  return toCsv(headers, rows, { delimiter: ';' });
}
