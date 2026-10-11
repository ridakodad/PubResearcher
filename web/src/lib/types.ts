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

export interface FieldExtraction {
  enabled: boolean;
  rules: ExtractionRule[];
  postProcess?: FieldPostProcess;
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
  | (FieldStatsBase & { chart: 'categories'; categories: CategoryCount[] })
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
export type BiblioSource = 'pubmed' | 'scholar';
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
  decision: BiblioDecision;
  exclusionReason: ExclusionReason | null;
  note: string | null;
  firstSearchId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface BiblioSearch {
  id: number;
  source: BiblioSource;
  actor: string;
  query: string;
  yearFrom: number | null;
  yearTo: number | null;
  maxResults: number;
  sort: 'relevance' | 'date';
  status: 'running' | 'ok' | 'error';
  error: string | null;
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
  bySource: { pubmed: number; scholar: number; both: number };
}

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

export interface BiblioSourceStatus {
  label: string;
  /** Identifiant de l'acteur Apify interrogé pour cette source. */
  actor: string;
  /** Faux si l'acteur configuré n'a pas d'adaptateur : la source est alors inutilisable. */
  supported: boolean;
  alternatives: string[];
}

export interface BiblioStatus {
  /** Vrai si `APIFY_TOKEN` est renseigné côté serveur. Le jeton lui-même ne sort jamais. */
  configured: boolean;
  /** Plafond de résultats par source et par passe. */
  maxResults: number;
  running: boolean;
  sources: Record<BiblioSource, BiblioSourceStatus>;
  exclusionReasons: Record<ExclusionReason, string>;
}

export interface BiblioOverview {
  counts: BiblioCounts;
  prisma: BiblioPrisma;
  searches: BiblioSearch[];
}

export interface BiblioSearchParams {
  query: string;
  sources: BiblioSource[];
  maxResults: number;
  yearFrom?: number;
  yearTo?: number;
  sort: 'relevance' | 'date';
}

export interface BiblioRefFilter {
  decision?: BiblioDecision;
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
