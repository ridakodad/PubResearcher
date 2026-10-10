/**
 * Types de la revue bibliographique.
 * Miroir côté interface : `web/src/lib/types.ts` (section « Revue bibliographique »).
 */

/** Sources interrogeables, chacune par un acteur Apify. */
export const BIBLIO_SOURCES = ['pubmed', 'scholar'] as const;
export type BiblioSource = (typeof BIBLIO_SOURCES)[number];

export const SOURCE_LABELS: Record<BiblioSource, string> = {
  pubmed: 'PubMed',
  scholar: 'Google Scholar',
};

/** Tri d'une référence. `pending` = pas encore lue. */
export const DECISIONS = ['pending', 'include', 'maybe', 'exclude'] as const;
export type Decision = (typeof DECISIONS)[number];

export const DECISION_LABELS: Record<Decision, string> = {
  pending: 'À trier',
  include: 'Retenue',
  maybe: 'À voir',
  exclude: 'Exclue',
};

/**
 * Motifs d'exclusion. Ce sont eux que le diagramme de flux dénombre : une
 * exclusion sans motif ne se compte nulle part, le serveur la refuse.
 */
export const EXCLUSION_REASONS = {
  population: 'Population hors sujet',
  intervention: 'Intervention hors sujet',
  outcome: 'Critère de jugement hors sujet',
  design: "Schéma d'étude non retenu",
  language: 'Langue',
  no_fulltext: 'Texte intégral introuvable',
  duplicate_report: 'Doublon de publication',
  other: 'Autre motif',
} as const;
export type ExclusionReason = keyof typeof EXCLUSION_REASONS;

export const isExclusionReason = (value: unknown): value is ExclusionReason =>
  typeof value === 'string' && Object.hasOwn(EXCLUSION_REASONS, value);

/** Une référence telle que la lit un adaptateur, avant dédoublonnage. */
export interface BiblioRefInput {
  source: BiblioSource;
  title: string;
  /** Une chaîne par auteur, telle que la source la donne (« Ritter M » ou « J Michalak »). */
  authors: string[];
  year: number | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  pdfUrl: string | null;
  /** Résumé structuré : seul PubMed en fournit un. */
  abstract: string | null;
  /** Extrait affiché par Google Scholar — jamais présenté comme un résumé. */
  snippet: string | null;
  keywords: string[];
  meshTerms: string[];
  publicationTypes: string[];
  citedBy: number | null;
  citedByUrl: string | null;
}

export interface BiblioRef extends Omit<BiblioRefInput, 'source'> {
  id: number;
  /** Toutes les sources qui ont rendu cette référence. */
  sources: BiblioSource[];
  titleTruncated: boolean;
  decision: Decision;
  exclusionReason: ExclusionReason | null;
  note: string | null;
  firstSearchId: number | null;
  createdAt: string;
  updatedAt: string;
}

export type SearchStatus = 'running' | 'ok' | 'error';
export type SearchSort = 'relevance' | 'date';

/** Une interrogation d'une source : la chaîne exacte, sa date, ce qu'elle a rendu. */
export interface BiblioSearch {
  id: number;
  source: BiblioSource;
  actor: string;
  query: string;
  yearFrom: number | null;
  yearTo: number | null;
  maxResults: number;
  sort: SearchSort;
  status: SearchStatus;
  error: string | null;
  /** Références exploitables rendues par l'acteur. */
  returned: number;
  /** Lignes rendues mais inexploitables (sans titre, message d'accompagnement…). */
  skipped: number;
  /** Références nouvelles pour la bibliothèque. */
  added: number;
  /** Références déjà connues (autre source, autre recherche, ou même liste). */
  duplicates: number;
  durationMs: number | null;
  queriedAt: string;
}

export interface BiblioCounts {
  total: number;
  pending: number;
  include: number;
  maybe: number;
  exclude: number;
  bySource: { pubmed: number; scholar: number; both: number };
}

/** Données du diagramme de flux, calculées des recherches et des décisions. */
export interface BiblioPrisma {
  identified: number;
  bySource: { pubmed: number; scholar: number };
  duplicatesRemoved: number;
  screened: number;
  excluded: number;
  excludedByReason: { reason: ExclusionReason | 'unspecified'; count: number }[];
  maybe: number;
  pending: number;
  included: number;
}
