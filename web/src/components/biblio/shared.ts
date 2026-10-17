import type { BiblioDecision, BiblioRef, BiblioSource } from '../../lib/types';

export const SOURCE_LABELS: Record<BiblioSource, string> = {
  pubmed: 'PubMed',
  scholar: 'Google Scholar',
  pubdaily: 'PubDaily',
  embase: 'Embase',
  central: 'Cochrane CENTRAL',
  scopus: 'Scopus',
  wos: 'Web of Science',
  lissa: 'LiSSa',
  cinahl: 'CINAHL',
  psycinfo: 'PsycINFO',
  clinicaltrials: 'ClinicalTrials.gov',
  ictrp: 'OMS ICTRP',
  other_db: 'Autre base de données',
  other: 'Autre (citations, sites, experts…)',
};

/** Libellé court d'une source, pour une puce : « Autre (citations, sites, experts…) » n'y tient pas. */
export const SOURCE_SHORT: Partial<Record<BiblioSource, string>> = {
  scholar: 'Scholar',
  central: 'CENTRAL',
  clinicaltrials: 'ClinicalTrials',
  other_db: 'Autre base',
  other: 'Autre',
};
export const shortSource = (source: BiblioSource): string => SOURCE_SHORT[source] ?? SOURCE_LABELS[source];

/** « 1 234 » : les effectifs se lisent mieux groupés par milliers. */
export const fmtCount = (n: number): string => n.toLocaleString('fr-FR');

/** « 1 052 déjà connues » : `plural`, avec les milliers groupés. */
export const countOf = (n: number, singular: string, pluralForm?: string): string =>
  `${fmtCount(n)} ${n > 1 ? (pluralForm ?? `${singular}s`) : singular}`;

export const DECISION_LABELS: Record<BiblioDecision, string> = {
  pending: 'À trier',
  include: 'Retenue',
  maybe: 'À voir',
  exclude: 'Exclue',
};

/**
 * Puce de décision. Le libellé porte le sens, la teinte ne fait que le souligner.
 * Le rouge reste réservé aux erreurs : une référence exclue n'est pas en faute,
 * elle s'efface — d'où l'encre neutre, et non un vert opposé à un rouge.
 */
export const DECISION_BADGE: Record<BiblioDecision, string> = {
  pending: 'badge badge-empty',
  include: 'badge badge-auto',
  maybe: 'badge badge-warn',
  exclude: 'badge badge-manual',
};

/** Un lien n'est affiché que s'il est http(s) : le serveur filtre déjà, on ne se fie pas à lui seul. */
export function safeHref(url: string | null | undefined): string | null {
  return url && /^https?:\/\//i.test(url) ? url : null;
}

export const doiHref = (doi: string): string =>
  `https://doi.org/${doi.split('/').map(encodeURIComponent).join('/')}`;

export const pmidHref = (pmid: string): string | null =>
  /^\d{1,9}$/.test(pmid) ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : null;

export const pmcHref = (pmcid: string): string | null =>
  /^PMC\d+$/i.test(pmcid) ? `https://pmc.ncbi.nlm.nih.gov/articles/${pmcid.toUpperCase()}/` : null;

/** Les six premiers auteurs, puis le nombre des suivants : la liste complète reste dans l'export. */
export function formatAuthors(authors: string[], max = 6): string {
  if (authors.length === 0) return 'Auteurs non indiqués';
  const head = authors.slice(0, max).join(', ');
  return authors.length > max ? `${head}, et al. (+${authors.length - max})` : head;
}

/** « Eur Urol. 2026;12(3):266-274 » — ce que la source a donné, sans rien compléter. */
export function formatCitation(item: BiblioRef): string {
  const volume = `${item.volume ?? ''}${item.issue ? `(${item.issue})` : ''}`;
  const locator = [volume, item.pages].filter(Boolean).join(':');
  const dated = [item.year, locator].filter(Boolean).join(';');
  return [item.journal, dated].filter(Boolean).join('. ');
}

/** « 1 min 12 s » — le temps d'attente d'une passe, qui se compte en dizaines de secondes. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** « 2019–2024 », « depuis 2019 », « jusqu'en 2024 » ou « — ». */
export function formatPeriod(from: number | null, to: number | null): string {
  if (from !== null && to !== null) return from === to ? String(from) : `${from}–${to}`;
  if (from !== null) return `depuis ${from}`;
  if (to !== null) return `jusqu’en ${to}`;
  return '—';
}
