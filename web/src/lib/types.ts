/**
 * Types de l'API.
 * Miroir de `server/src/domain/types.ts` : toute évolution doit être reportée
 * des deux côtés.
 */

export type DocKind = 'pdf' | 'docx' | 'image' | 'dicom' | 'text' | 'unknown';

export type FieldType = 'text' | 'number' | 'integer' | 'date' | 'boolean' | 'enum' | 'multi';

export const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  text: 'Texte libre',
  number: 'Nombre',
  integer: 'Nombre entier',
  date: 'Date',
  boolean: 'Oui / Non',
  enum: 'Choix unique',
  multi: 'Choix multiple',
};

export type RuleSource = 'text' | 'dicom' | 'filename';
export type FieldValue = string | number | boolean | string[] | null;

export interface LabelRule {
  kind: 'label';
  labels: string[];
  maxLength?: number;
  source?: RuleSource;
  docKinds?: DocKind[];
  confidence?: number;
}
export interface RegexRule {
  kind: 'regex';
  pattern: string;
  flags?: string;
  group?: number;
  source?: RuleSource;
  docKinds?: DocKind[];
  confidence?: number;
}
export interface KeywordRule {
  kind: 'keyword';
  any: string[];
  none?: string[];
  noneWindow?: number;
  skip?: string[];
  skipWindow?: number;
  emit: FieldValue;
  emitIfNegated?: FieldValue;
  /** Mentions placées dans les antécédents : comptées (défaut) ou écartées (variable de l'épisode en cours). */
  history?: 'include' | 'exclude';
  source?: RuleSource;
  docKinds?: DocKind[];
  confidence?: number;
}
export interface DicomRule {
  kind: 'dicom';
  tag: string;
  confidence?: number;
}
export type ExtractionRule = LabelRule | RegexRule | KeywordRule | DicomRule;

export interface FieldPostProcess {
  valueMap?: Record<string, string>;
  scale?: number;
  min?: number;
  max?: number;
}

/** Valeur retenue quand plusieurs mentions divergent ; absent : la variable est signalée, sans valeur. */
export type SelectPolicy = 'first' | 'last' | 'max' | 'min' | 'any';

export interface FieldExtraction {
  enabled: boolean;
  rules: ExtractionRule[];
  postProcess?: FieldPostProcess;
  select?: SelectPolicy;
  /** Variable de synthèse : les règles proposent, sans remplir (sauf valeur lue dans un fichier DICOM). */
  suggestOnly?: boolean;
  /** `admission` : seules les mentions de l'arrivée comptent (les mentions « à J4 », « postopératoire » sont écartées). */
  episode?: 'admission';
}

export interface TemplateField {
  id: number;
  templateId: number;
  key: string;
  label: string;
  type: FieldType;
  section: string;
  unit: string | null;
  description: string | null;
  required: boolean;
  options: string[];
  position: number;
  extraction: FieldExtraction;
}

export interface Template {
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateWithFields extends Template {
  fields: TemplateField[];
}

export interface Patient {
  id: number;
  code: string;
  label: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PatientSummary extends Patient {
  documentCount: number;
  unreadableCount: number;
}

export interface DocumentMeta {
  id: number;
  patientId: number;
  filename: string;
  kind: DocKind;
  mime: string;
  size: number;
  sha256: string;
  createdAt: string;
  parseStatus: 'pending' | 'ok' | 'error' | 'empty';
  /** Le serveur accepte-t-il d'afficher ce document dans la page ? */
  previewable: boolean;
  parseError: string | null;
  textLength: number;
  metadata: Record<string, unknown>;
}

export interface Evidence {
  documentId: number;
  documentName: string;
  snippet: string;
  start: number;
  end: number;
  rule: string;
  /** Autres valeurs trouvées par la même règle, quand une règle de sélection a tranché entre des mentions discordantes. */
  alternatives?: { value: FieldValue; documentId: number; documentName: string; snippet: string }[];
  /** Comment la valeur a été choisie parmi ces mentions. */
  selection?: string;
}

/**
 * Justification d'une valeur importée d'un tableau de cohorte : fichier conservé, empreinte, feuille, cellule,
 * en-tête et contenu brut. Ni extraction, ni relecture.
 */
export interface ImportEvidence {
  kind: 'import';
  importId: number;
  fileName: string;
  sha256: string;
  sheet: string | null;
  cell: string;
  header: string;
  raw: string;
}

export function isImportEvidence(evidence: Evidence | ImportEvidence | null | undefined): evidence is ImportEvidence {
  return evidence !== null && evidence !== undefined && (evidence as ImportEvidence).kind === 'import';
}

/** Origine d'une valeur : règle, modèle de langage, relecteur, import d'un tableau, ou absente. */
export type ValueSource = 'auto' | 'llm' | 'manual' | 'import' | 'empty';

/** Ce que la machine (ou un tableau importé) avait proposé avant la décision d'un relecteur. */
export interface ValueOrigin {
  source: 'auto' | 'llm' | 'import';
  value: FieldValue;
}

export interface RecordValue {
  fieldId: number;
  value: FieldValue;
  source: ValueSource;
  confidence: number | null;
  evidence: Evidence | ImportEvidence | null;
  updatedAt: string;
  origin: ValueOrigin | null;
  reviewedAt: string | null;
}

/** Décision d'un relecteur : fixer (ou vider) une valeur, la confirmer telle quelle, ou rendre la main à l'extraction. */
export type ValueEditMode = 'set' | 'confirm' | 'release';

export interface ValueEdit {
  fieldId: number;
  value?: FieldValue;
  mode?: ValueEditMode;
}

/** Valeur saisie hors des bornes de plausibilité de la variable. */
export interface OutOfBounds {
  fieldId: number;
  key: string;
  label: string;
  /** Nombre pour une variable numérique, date ISO pour une date. */
  value: number | string;
  min: number | string | null;
  max: number | string | null;
}

export type EventAction = 'extract' | 'unset' | 'edit' | 'confirm' | 'clear' | 'release' | 'import';

export interface ValueEvent {
  id: number;
  fieldId: number;
  fieldKey: string;
  fieldLabel: string;
  at: string;
  action: EventAction;
  oldValue: FieldValue;
  oldSource: string | null;
  newValue: FieldValue;
  newSource: string | null;
  runId: number | null;
  importId: number | null;
}

export interface ExtractionRun {
  id: number;
  templateId: number | null;
  templateName: string;
  templateFingerprint: string;
  mode: string;
  model: string | null;
  overwriteManual: boolean;
  appVersion: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'done' | 'failed';
  patients: number;
  documents: number;
  extracted: number;
  notFound: number;
  keptManual: number;
  rejected: number;
}

export interface PatientRecord {
  id: number;
  templateId: number;
  patientId: number;
  createdAt: string;
  updatedAt: string;
  lastExtractionAt: string | null;
  values: RecordValue[];
}

export interface UploadOutcome {
  filename: string;
  status: 'imported' | 'duplicate' | 'error';
  documentId?: number;
  kind?: string;
  textLength?: number;
  message?: string;
}

export interface UploadResponse {
  results: UploadOutcome[];
  documents: DocumentMeta[];
  summary: { imported: number; duplicates: number; errors: number };
}

export interface DatasetRow {
  patientId: number;
  patientCode: string;
  patientLabel: string | null;
  documentCount: number;
  values: Record<string, FieldValue>;
  sources: Record<string, ValueSource>;
  confidences: Record<string, number | null>;
  filled: number;
}

export interface NumericSummary {
  n: number; mean: number; sd: number;
  min: number; q1: number; median: number; q3: number; max: number;
}
export interface HistogramBin { label: string; from: number; to: number; count: number }
export interface CategoryCount { label: string; count: number; percent: number }

interface FieldStatsBase {
  key: string;
  label: string;
  type: FieldType;
  unit: string | null;
  section: string;
  n: number;
  missing: number;
}
export type FieldStats =
  | (FieldStatsBase & { chart: 'histogram'; summary: NumericSummary | null; bins: HistogramBin[] })
  | (FieldStatsBase & { chart: 'categories'; multiple?: boolean; categories: CategoryCount[] })
  | (FieldStatsBase & { chart: 'none'; topValues: CategoryCount[] });

export interface CompletenessField {
  key: string; label: string; section: string; required: boolean;
  auto: number; llm: number; manual: number; imported: number; empty: number; rate: number;
}

/** Moteur employé pour une passe d'extraction. */
export type ExtractionMode = 'rules' | 'llm' | 'hybrid';

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ExtractionReport {
  patientId: number;
  patientCode: string;
  documentCount: number;
  extracted: number;
  notFound: number;
  keptManual: number;
  /** Variables restées vides parce qu'une valeur trouvée a été écartée (seuil, bornes, unité). */
  rejected: number;
  unverified: number;
  invalid: number;
  llmError: string | null;
  usage: LlmUsage | null;
  fields: {
    fieldId: number;
    key: string;
    label: string;
    status: 'extracted' | 'not-found' | 'kept-manual' | 'disabled';
    by: 'rules' | 'llm' | null;
    confidence: number | null;
    rejected: Rejection | null;
  }[];
}

export interface ExtractionRunResult {
  templateId: number;
  mode: ExtractionMode;
  patientsProcessed: number;
  totals: {
    extracted: number;
    notFound: number;
    keptManual: number;
    rejected: number;
    unverified: number;
    invalid: number;
  };
  usage: LlmUsage | null;
  /** Modèle employé, et prix de la passe en dollars (`null` : règles seules, ou tarif inconnu). */
  model?: string | null;
  costUsd?: number | null;
  errors: { patientCode: string; message: string }[];
  reports: ExtractionReport[];
}

/** Valeur trouvée par une règle puis écartée (hors bornes, valeur seuil, unité différente…). */
export interface Rejection {
  documentId: number;
  documentName: string;
  snippet: string;
  reason: string;
  rule: string;
  /** Mentions discordantes : à trancher à la main, aucune règle de repli n'a été essayée. */
  conflict?: boolean;
}

export interface RuleTestResult {
  found: boolean;
  value: FieldValue;
  confidence: number | null;
  evidence: Evidence | null;
  rejected: Rejection[];
  documentsTested: number;
}

export interface Capabilities {
  ocr: { available: boolean; lang: string; reason: string | null };
  llm: {
    available: boolean;
    model: string;
    effort: string;
    reason: string | null;
    /** D'où vient la clé d'API : saisie dans l'application, ou environnement du serveur. */
    keySource: 'app' | 'env' | null;
    /** Ses quatre derniers caractères (`…a1B2`). */
    keyHint: string | null;
    /** Qui sert l'extraction : Claude, ou un modèle local (page « Modèles d'IA »). Absent d'un serveur ancien. */
    provider?: ModelProvider;
  };
  maxUploadBytes: number;
}

/** Clé d'API Anthropic de l'utilisateur : jamais transmise en entier, seulement sa provenance et sa fin. */
export interface ApiKeyStatus {
  source: 'app' | 'env' | null;
  hint: string | null;
  savedAt: string | null;
  /** Espace de travail d'Anthropic retenu pour une clé qui en couvre plusieurs (choisi par l'outil). */
  workspace: string | null;
  model: string;
  available: boolean;
}

/** Fourchette de coût d'une passe par Claude, en dollars, sur le compte Anthropic de l'utilisateur. */
export interface CostEstimate {
  model: string;
  patients: number;
  low: number;
  high: number;
  inputTokens: number;
}

/* ----------------------------------------------- rendement de l'extraction */

/** Un fichier du dossier, et les variables qu'il a permis de renseigner. */
export interface ExtractionDocument {
  documentId: number;
  filename: string;
  kind: DocKind;
  parseStatus: 'pending' | 'ok' | 'error' | 'empty';
  textLength: number;
  /** Libellés des variables justifiées par ce document. Vide = n'a rien produit. */
  fields: string[];
}

export interface ExtractionRow {
  patientId: number;
  patientCode: string;
  patientLabel: string | null;
  lastExtractionAt: string | null;
  filled: number;
  total: number;
  bySource: { auto: number; llm: number; manual: number; import: number };
  /** Valeurs renseignées sans document justificatif : saisies à la main. */
  sansJustification: number;
  documents: ExtractionDocument[];
}

export interface ExtractionOverview {
  template: TemplateWithFields;
  rows: ExtractionRow[];
  summary: {
    patients: number;
    emptyPatients: number;
    barrenDocuments: number;
    documents: number;
  };
}

/* ------------------------------------------------- revue bibliographique */

/** Miroir de `server/src/biblio/types.ts`. */
/** Sources interrogées d'ici : PubMed (E-utilities du NCBI) et, en option, Google Scholar (Apify). */
export type BiblioSearchableSource = 'pubmed' | 'scholar';
/** Toutes les sources d'une référence, bases importées comprises. */
export type BiblioSource =
  | BiblioSearchableSource
  | 'embase'
  | 'central'
  | 'scopus'
  | 'wos'
  | 'lissa'
  | 'cinahl'
  | 'psycinfo'
  | 'clinicaltrials'
  | 'ictrp'
  | 'other_db'
  | 'other';
/** Colonne du diagramme PRISMA 2020 : bases de données, registres, autres méthodes. */
export type PrismaCategory = 'database' | 'register' | 'other';
export type BiblioRefType = 'JOUR' | 'CONF' | 'BOOK' | 'CHAP' | 'THES' | 'RPRT' | 'GEN' | 'UNPB' | 'ELEC' | 'DATA';
export type BiblioDecision = 'pending' | 'include' | 'maybe' | 'exclude';
export type ExclusionReason =
  | 'population'
  | 'intervention'
  | 'outcome'
  | 'design'
  | 'language'
  | 'no_fulltext'
  | 'duplicate_report'
  | 'other';

export interface BiblioRef {
  id: number;
  /** Toutes les sources qui ont rendu cette référence. */
  sources: BiblioSource[];
  title: string;
  titleTruncated: boolean;
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
  refType: BiblioRefType | null;
  decision: BiblioDecision;
  exclusionReason: ExclusionReason | null;
  note: string | null;
  firstSearchId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BiblioSearch {
  id: number;
  /** Une interrogation lancée d'ici, ou l'import d'un fichier. */
  kind: 'search' | 'import';
  source: BiblioSource;
  /** Service interrogé (« NCBI E-utilities », acteur Apify) ou format du fichier importé. */
  actor: string;
  query: string;
  /** Équation réellement transmise, quand elle diffère (balises PubMed retirées pour Scholar). */
  sentQuery: string | null;
  /** Traduction de l'équation par PubMed. */
  queryTranslation: string | null;
  fileName: string | null;
  sourceLabel: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  /** Résultats demandés ; 0 : tout récupérer (PubMed) ou sans objet (import). */
  maxResults: number;
  sort: 'relevance' | 'date';
  status: 'running' | 'ok' | 'error';
  error: string | null;
  warnings: string[];
  /** Nombre total de résultats annoncé par la source ; `null` quand elle ne le dit pas. */
  totalCount: number | null;
  returned: number;
  skipped: number;
  added: number;
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
  bySource: Partial<Record<BiblioSource, number>>;
  /** Références trouvées par au moins deux sources. */
  multiSource: number;
}

export interface BiblioPrismaSource {
  source: BiblioSource;
  label: string;
  category: PrismaCategory;
  count: number;
}

export interface BiblioPrisma {
  identified: number;
  bySource: BiblioPrismaSource[];
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

export interface BiblioSourceStatus {
  label: string;
  /** Service interrogé : « NCBI E-utilities », ou l'acteur Apify. */
  actor: string;
  /** Faux si l'acteur configuré n'a pas d'adaptateur. */
  supported: boolean;
  /** Vrai si la source peut être interrogée maintenant (Scholar : jeton Apify présent et acteur pris en charge). */
  available: boolean;
  alternatives: string[];
}

export interface BiblioStatus {
  /** Vrai si `APIFY_TOKEN` est renseigné côté serveur (Google Scholar). Le jeton lui-même ne sort jamais. */
  configured: boolean;
  /** Plafond de résultats Google Scholar par passe. */
  maxResults: number;
  running: boolean;
  pubmed: {
    service: string;
    /** Une clé NCBI_API_KEY est posée (10 requêtes/s au lieu de 3). */
    apiKey: boolean;
    email: boolean;
    /** Plafond de notices d'une passe « tout récupérer ». */
    maxRecords: number;
    /** Au plus ce nombre de premiers résultats en exploration (9 999). */
    window: number;
  };
  sources: Record<BiblioSearchableSource, BiblioSourceStatus>;
  importSources: { id: BiblioSource; label: string; category: PrismaCategory }[];
  importFormats: { id: 'ris' | 'nbib' | 'bibtex' | 'csv'; label: string }[];
  importMaxBytes: number;
  exclusionReasons: Record<ExclusionReason, string>;
}

export interface BiblioOverview {
  counts: BiblioCounts;
  prisma: BiblioPrisma;
  searches: BiblioSearch[];
}

export interface BiblioSearchParams {
  query: string;
  sources: BiblioSearchableSource[];
  /** Résultats Google Scholar (facturés par Apify). */
  maxResults: number;
  /** PubMed : `null` = tout récupérer, sinon les N premiers. */
  pubmedMax: number | null;
  yearFrom?: number;
  yearTo?: number;
  sort: 'relevance' | 'date';
}

export interface BiblioRefFilter {
  decision?: BiblioDecision;
  /** `both` : trouvées par plusieurs sources. */
  source?: BiblioSource | 'both';
  q?: string;
  sort?: 'added' | 'recent' | 'cited';
}

export type BiblioExportFormat = 'csv' | 'ris' | 'bibtex' | 'searches';

/** Fiabilité de l'extraction automatique, mesurée sur les décisions des relecteurs. */
export interface QualityProportion {
  value: number;
  low: number;
  high: number;
  of: number;
}

export interface QualityCounts {
  unreviewed: number;
  confirmed: number;
  corrected: number;
  emptied: number;
  added: number;
  confirmedEmpty: number;
  reviewed: number;
  agreement: QualityProportion | null;
  recall: QualityProportion | null;
}

export interface FieldQuality extends QualityCounts {
  fieldId: number;
  key: string;
  label: string;
  type: FieldType;
}

export interface QualityReport {
  templateId: number;
  patients: number;
  patientsReviewed: number;
  overall: QualityCounts;
  fields: FieldQuality[];
}

/* ───────────────────────── Import de tableaux de cohorte ───────────────── */

export type TableFormat = 'xlsx' | 'csv' | 'tsv';

export interface TableImportOptions {
  createPatients: boolean;
  overwriteExtracted: boolean;
  overwriteManual: boolean;
}

export interface TableImport {
  id: number;
  templateId: number | null;
  templateName: string | null;
  filename: string;
  format: TableFormat;
  size: number;
  sha256: string;
  sheet: string | null;
  headerRow: number | null;
  codeColumn: number | null;
  mapping: { column: number; fieldId: number }[];
  options: TableImportOptions;
  status: 'draft' | 'done';
  createdAt: string;
  committedAt: string | null;
  dataRows: number;
  patientsCreated: number;
  patientsExisting: number;
  written: number;
  unchanged: number;
  rejected: number;
  conflicts: number;
}

export interface TableSheetInfo {
  name: string;
  hidden: boolean;
  rows: number;
  columns: number;
  merges: number;
  formulas: number;
  formulasWithoutValue: number;
  error: string | null;
  suggestedHeaderRow: number;
  /** Premières lignes, en texte, pour choisir la ligne d'en-tête. */
  preview: string[][];
}

export interface TableUploadResponse {
  import: TableImport;
  workbook: {
    format: TableFormat;
    delimiter: string | null;
    charset: string | null;
    date1904: boolean;
    warnings: string[];
    sheets: TableSheetInfo[];
  };
  previousImports: { id: number; filename: string; committedAt: string | null; written: number }[];
}

export interface TableColumn {
  index: number;
  letter: string;
  text: string;
  label: string;
  unit: string | null;
  knownUnit: string | null;
  filled: number;
  sample: string[];
  distinct: number;
}

export interface TableColumnsResponse {
  template: { id: number; name: string };
  sheet: string;
  headerRow: number;
  dataRows: number;
  columns: TableColumn[];
  suggestion: {
    codeColumn: number | null;
    mapping: { column: number; fieldId: number; reason: string; unitWarning: string | null }[];
  };
}

export interface TableImportRequest {
  sheet: string | null;
  headerRow: number;
  codeColumn: number;
  mapping: { column: number; fieldId: number }[];
  options: TableImportOptions;
  templateId?: number;
  expectedPlan?: string;
}

interface TableCellIssue {
  row: number;
  cell: string;
  code: string;
  fieldId: number;
  fieldLabel: string;
  header: string;
  raw: string;
}

export interface TableImportReport {
  templateId: number;
  sheet: string | null;
  headerRow: number;
  codeColumn: number;
  options: TableImportOptions;
  dataRows: number;
  rows: { used: number; empty: number; skipped: number };
  patients: { created: number; existing: number; createdCodes: string[] };
  values: {
    write: number;
    replaceExtracted: number;
    replaceManual: number;
    unchanged: number;
    empty: number;
    rejected: number;
    conflicts: number;
  };
  fields: {
    fieldId: number;
    fieldLabel: string;
    column: number;
    letter: string;
    header: string;
    write: number;
    unchanged: number;
    empty: number;
    rejected: number;
    conflicts: number;
  }[];
  rowIssues: { row: number; code: string | null; reason: string }[];
  rejected: (TableCellIssue & { reason: string })[];
  conflicts: (TableCellIssue & { incoming: FieldValue; current: FieldValue; currentSource: ValueSource; resolution: 'kept' | 'replaced' })[];
  truncated: boolean;
  planHash: string;
}

// ------------------------------------------------------------- import de fiche

/** Variable proposée par l'analyse d'une fiche existante (Word, Excel, CSV), avant relecture. */
export interface DraftField {
  label: string;
  key: string;
  type: FieldType;
  section: string;
  unit: string | null;
  options: string[];
  required: boolean;
  description: string | null;
}

export interface TemplateImportDraft {
  /** Nom proposé pour la fiche : celui du fichier, sans extension. */
  name: string;
  fields: DraftField[];
  /** `claude` : lu par Claude ; `rules` : analyse par règles (sans clé, ou repli). */
  method: 'claude' | 'rules';
  warnings: string[];
}

export interface TemplateImportCommit {
  name: string;
  description?: string | null;
  fields: DraftField[];
  activate?: boolean;
}

/* --- recherche en langage naturel --- */

/** Types d'études pour lesquels l'assistant ajoute un filtre validé (essais randomisés : filtre Cochrane). */
export type BiblioStudyType = 'rct' | 'systematic_review' | 'observational' | 'diagnostic';

/** Un concept de la question : un bloc « OU » de descripteurs MeSH et de synonymes en texte libre. */
export interface BiblioStrategyConcept {
  name: string;
  role: 'population' | 'intervention' | 'comparison' | 'outcome' | 'other';
  /** 1 = indispensable, 3 = accessoire. */
  importance: number;
  mesh: string[];
  freeText: string[];
  block: string;
}

/** Stratégie proposée par `POST /api/biblio/assistant/build`, vérifiée sur les nombres PubMed. */
export interface BiblioStrategy {
  question: string;
  pico: { population: string; intervention: string; comparison: string; outcome: string; studyDesign: string };
  concepts: BiblioStrategyConcept[];
  equation: string;
  filters: string[];
  counts: { total: number | null; perConcept: { name: string; count: number | null }[] };
  rationale: string;
  warnings: string[];
  model: string | null;
  method: 'llm' | 'rules';
}

export interface BiblioStrategyRequest {
  question: string;
  lang?: 'fr' | 'en';
  yearFrom?: number;
  yearTo?: number;
  studyTypes?: BiblioStudyType[];
}

export interface BiblioCountResult {
  total: number | null;
  perConcept: { name: string; count: number | null }[];
  warnings: string[];
}

/** Lancement d'une recherche issue de l'assistant : la question et la stratégie entrent au journal. */
export interface BiblioAssistantSearchParams extends BiblioSearchParams {
  question?: string;
  strategy?: BiblioStrategy;
}

// --------------------------------------------------------------- modèles d'IA (Claude ou modèle local)

export type ModelTask = 'extraction' | 'form-import' | 'writing' | 'search-query';
export type ModelProvider = 'anthropic' | 'local';

export interface CatalogModel {
  tag: string;
  family: string;
  downloadGb: number;
  ramGb: number;
  licence: string;
  licenceNote?: string;
  french: 'excellent' | 'bon' | 'correct';
  note: string;
}

export interface ModelEvaluation {
  model: string;
  provider: ModelProvider;
  measuredAt: string;
  corpus: string;
  patients: number;
  precision: number | null;
  recall: number | null;
  correct: number;
  extracted: number;
  expected: number;
  invalidJsonRate: number;
  unverifiedRate: number;
  errors: number;
  meanLatencyMs: number;
}

export interface InstalledModel {
  name: string;
  size: number;
  modifiedAt: string | null;
  parameterSize: string | null;
  quantization: string | null;
}

export interface ModelTaskStatus {
  task: ModelTask;
  label: string;
  provider: ModelProvider;
  /** Modèle effectivement utilisé : `claude-…` ou `ollama:<étiquette>`. */
  model: string;
  /** Le modèle local de la tâche (choisi, ou recommandé). */
  localModel: string;
  localModelChosen: string | null;
  available: boolean;
  installed: boolean | null;
  recommendation: { recommended: CatalogModel; light: CatalogModel; strong: CatalogModel; why: string };
  evaluation: ModelEvaluation | null;
}

export interface ModelsStatus {
  ollama: {
    reachable: boolean;
    version: string | null;
    installed: InstalledModel[];
    error: string | null;
    url: string;
    remote: boolean;
    warning: string | null;
    install: { url: string; steps: { windows: string; macos: string; linux: string } };
  };
  anthropic: { available: boolean; keyHint: string | null };
  pseudonymizeLocal: boolean;
  tasks: ModelTaskStatus[];
  catalog: CatalogModel[];
  evaluations: Record<string, ModelEvaluation>;
  medicalNote: string;
}

export interface ModelPullProgress {
  status?: string;
  total?: number;
  completed?: number;
  digest?: string;
  error?: string;
}

export interface ModelTestResult {
  task: ModelTask;
  model: string;
  pass: boolean;
  latencyMs: number;
  validJson?: boolean;
  unverified?: number;
  checks: { key: string; expected: unknown; got: unknown; ok: boolean }[];
  details: string | null;
}
