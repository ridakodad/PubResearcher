/**
 * Types de la revue bibliographique.
 * Miroir côté interface : `web/src/lib/types.ts` (section « Revue bibliographique »).
 */

/**
 * Sources d'une référence : les deux qu'on interroge d'ici (PubMed par les
 * E-utilities du NCBI, Google Scholar par un acteur Apify) et les bases dont on
 * importe un export (RIS, nbib, BibTeX, CSV).
 */
export const SEARCHABLE_SOURCES = ['pubmed', 'scholar'] as const;
export type SearchableSource = (typeof SEARCHABLE_SOURCES)[number];

export const BIBLIO_SOURCES = [
  'pubmed',
  'scholar',
  'embase',
  'central',
  'scopus',
  'wos',
  'lissa',
  'cinahl',
  'psycinfo',
  'clinicaltrials',
  'ictrp',
  'other_db',
  'other',
] as const;
export type BiblioSource = (typeof BIBLIO_SOURCES)[number];

export const SOURCE_LABELS: Record<BiblioSource, string> = {
  pubmed: 'PubMed',
  scholar: 'Google Scholar',
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

/**
 * Colonne du diagramme PRISMA 2020 où se comptent les notices d'une source.
 * Google Scholar est un moteur de recherche, pas une base bibliographique : il
 * se range, comme les sites web et la recherche de citations, sous « autres
 * méthodes ».
 */
export type PrismaCategory = 'database' | 'register' | 'other';
export const SOURCE_CATEGORY: Record<BiblioSource, PrismaCategory> = {
  pubmed: 'database',
  scholar: 'other',
  embase: 'database',
  central: 'database',
  scopus: 'database',
  wos: 'database',
  lissa: 'database',
  cinahl: 'database',
  psycinfo: 'database',
  clinicaltrials: 'register',
  ictrp: 'register',
  other_db: 'database',
  other: 'other',
};

export const isBiblioSource = (value: unknown): value is BiblioSource =>
  typeof value === 'string' && (BIBLIO_SOURCES as readonly string[]).includes(value);

/**
 * Types de référence, codés comme le champ `TY` du format RIS. Un import garde
 * le type que la base d'origine a donné ; PubMed le déduit de ses types de
 * publication.
 */
export const REF_TYPES = ['JOUR', 'CONF', 'BOOK', 'CHAP', 'THES', 'RPRT', 'GEN', 'UNPB', 'ELEC', 'DATA'] as const;
export type RefType = (typeof REF_TYPES)[number];
export const isRefType = (value: unknown): value is RefType =>
  typeof value === 'string' && (REF_TYPES as readonly string[]).includes(value);

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
 * Motifs d'exclusion, que le diagramme de flux dénombre. Au tri sur titre et
 * résumé, PRISMA 2020 n'exige pas de motif : une exclusion sans motif est
 * acceptée et se compte sous « motif non précisé ». Le motif devient
 * obligatoire à l'évaluation du texte intégral.
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
  /** Type RIS de la référence, quand la source le dit ; sinon déduit à l'export. */
  refType?: RefType | null;
}

export interface BiblioRef extends Omit<BiblioRefInput, 'source' | 'refType'> {
  refType: RefType | null;
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
/** Une interrogation lancée d'ici, ou l'import d'un fichier exporté d'une autre base. */
export type SearchKind = 'search' | 'import';

/**
 * Une interrogation d'une source — ou un import — : la chaîne exacte, sa date,
 * ce qu'elle a rendu. C'est le journal de recherche que PRISMA-S demande.
 */
export interface BiblioSearch {
  id: number;
  kind: SearchKind;
  source: BiblioSource;
  /** Service interrogé (« NCBI E-utilities », acteur Apify) ou format du fichier importé. */
  actor: string;
  query: string;
  /** Chaîne réellement transmise, quand elle diffère de `query` (balises PubMed retirées pour Scholar). */
  sentQuery: string | null;
  /** Traduction de l'équation par PubMed (termes MeSH développés, dates) : la chaîne qui a vraiment tourné. */
  queryTranslation: string | null;
  /** Question en langage naturel d'où l'assistant a tiré l'équation ; `null` pour une équation saisie à la main. */
  question: string | null;
  /** Stratégie proposée par l'assistant (PICO, concepts, nombres, modèle ou règles), relue puis validée par l'utilisateur. */
  strategy: GeneratedStrategy | null;
  /** Nom du fichier importé. */
  fileName: string | null;
  /** Nom libre de la source, pour « Autre ». */
  sourceLabel: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  maxResults: number;
  sort: SearchSort;
  status: SearchStatus;
  error: string | null;
  /** Avertissements de la passe (plafond atteint, balises retirées, lignes écartées…). */
  warnings: string[];
  /** Nombre total de résultats annoncé par la source (`Count` de PubMed) ; `null` quand elle ne le dit pas. */
  totalCount: number | null;
  /** Références exploitables rendues par la source, ou lues dans le fichier. */
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
  /** Références par source (une référence trouvée par deux sources compte pour chacune). */
  bySource: Partial<Record<BiblioSource, number>>;
  /** Références trouvées par au moins deux sources. */
  multiSource: number;
}

export interface PrismaSourceCount {
  source: BiblioSource;
  label: string;
  category: PrismaCategory;
  count: number;
}

/**
 * Données du diagramme de flux, calculées des recherches, des imports et des
 * décisions (voir `prisma()` dans `repo/biblio.ts` pour les définitions).
 */
export interface BiblioPrisma {
  identified: number;
  /** Notices identifiées, source par source, avec la colonne PRISMA de chacune. */
  bySource: PrismaSourceCount[];
  identifiedDatabases: number;
  identifiedRegisters: number;
  identifiedOther: number;
  duplicatesRemoved: number;
  screened: number;
  excluded: number;
  excludedByReason: { reason: ExclusionReason | 'unspecified'; count: number }[];
  maybe: number;
  pending: number;
  included: number;
}

/** Ce que le journal garde de la stratégie de l'assistant : au moins la méthode et le modèle, le reste tel quel. */
export interface GeneratedStrategy {
  method: 'llm' | 'rules';
  model: string | null;
  [key: string]: unknown;
}
