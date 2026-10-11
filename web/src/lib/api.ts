import type {
  ApiKeyStatus,
  CostEstimate,
  BiblioCounts,
  BiblioExportFormat,
  BiblioOverview,
  BiblioPrisma,
  BiblioRef,
  BiblioRefFilter,
  BiblioSearch,
  BiblioSearchParams,
  BiblioStatus,
  BiblioDecision,
  Capabilities,
  ExtractionMode,
  CompletenessField,
  DatasetRow,
  DocumentMeta,
  ExtractionOverview,
  ExtractionRunResult,
  FieldStats,
  QualityReport,
  Patient,
  PatientRecord,
  PatientSummary,
  RuleTestResult,
  Template,
  TemplateField,
  TemplateWithFields,
  UploadResponse,
  ExclusionReason,
  ExtractionRun,
  ValueEdit,
  ValueEvent,
  TableColumnsResponse,
  TableImport,
  TableImportReport,
  TableImportRequest,
  TableUploadResponse,
} from './types';

/** Erreur d'API portant le message renvoyé par le serveur. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    /** Code stable renvoyé par le serveur (`out_of_bounds`…), à tester plutôt que le message. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Délai au-delà duquel un appel sans réponse est abandonné (l'envoi de fichiers et les passes longues n'en ont pas). */
const DEFAULT_TIMEOUT_MS = 60_000;

interface RequestOptions {
  /** `0` : aucun délai (passe d'extraction sur des milliers de dossiers, recherche bibliographique). */
  timeoutMs?: number;
}

/**
 * Écritures réussies : l'espace de travail (compteurs du rail, chiffres du plan de travail) se recompte. Sans ce
 * signal, un import, une passe d'extraction ou une relecture laissait des compteurs périmés jusqu'au rechargement.
 */
type WriteListener = () => void;
const writeListeners = new Set<WriteListener>();

export function onDataWrite(listener: WriteListener): () => void {
  writeListeners.add(listener);
  return () => {
    writeListeners.delete(listener);
  };
}

/** Requêtes en écriture qui ne changent ni les dossiers, ni la fiche, ni les valeurs. */
const NEUTRAL_WRITES = [
  /^\/templates\/fields\/test/,
  /^\/biblio\//,
  /^\/redaction\//,
  // Étapes d'un import de tableau qui n'écrivent aucune valeur : réception, colonnes, simulation, abandon.
  /^\/table-imports$/,
  /^\/table-imports\/\d+(?:\/columns|\/dry-run)?$/,
];

function notifyWrite(path: string, method: string): void {
  if (method === 'GET' || NEUTRAL_WRITES.some((pattern) => pattern.test(path))) return;
  for (const listener of writeListeners) listener();
}

async function request<T>(path: string, init?: RequestInit, options: RequestOptions = {}): Promise<T> {
  let res: Response;
  const method = (init?.method ?? 'GET').toUpperCase();
  const upload = init?.body instanceof FormData;
  const timeoutMs = options.timeoutMs ?? (upload ? 0 : DEFAULT_TIMEOUT_MS);
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      ...(timeoutMs > 0 && !init?.signal ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      headers: upload ? init.headers : { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (error) {
    // Sans délai, un serveur qui accepte la connexion et ne répond jamais laisserait « Enregistrement… » à l'écran sans fin.
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new ApiError(0, `Le serveur ne répond pas (délai de ${Math.round(timeoutMs / 1000)} s dépassé). Réessayez dans un instant.`);
    }
    throw new ApiError(0, "Serveur injoignable. Vérifiez que l’API est démarrée.");
  }

  if (res.status === 204) {
    notifyWrite(path, method);
    return undefined as T;
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Réponse non JSON : on remonte le texte brut comme message d'erreur.
  }

  if (!res.ok) {
    const payload = data as { error?: string; details?: unknown; code?: string } | null;
    // Les détails d'une validation (champ : message) complètent le message ; ceux d'un code
    // métier (valeur hors bornes) sont déjà dits dans le message et servent à l'interface.
    const detailText = payload?.code ? '' : formatDetails(payload?.details);
    throw new ApiError(
      res.status,
      (payload?.error ?? `Erreur ${res.status}`) + (detailText ? ` ${detailText}` : ''),
      payload?.details,
      payload?.code,
    );
  }
  notifyWrite(path, method);
  return data as T;
}

/** Met en forme les erreurs de validation renvoyées par le serveur. */
function formatDetails(details: unknown): string {
  if (!Array.isArray(details)) return '';
  const parts = details
    .filter((d): d is { path?: string; message?: string } => typeof d === 'object' && d !== null)
    .map((d) => (d.path ? `${d.path} : ${d.message}` : d.message))
    .filter(Boolean);
  return parts.length > 0 ? `(${parts.join(' ; ')})` : '';
}

const get = <T>(path: string) => request<T>(path);
const post = <T>(path: string, body?: unknown, options?: RequestOptions) =>
  request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }, options);
const patch = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T>(path: string, body: unknown) =>
  request<T>(path, { method: 'PUT', body: JSON.stringify(body) });
const del = (path: string) => request<void>(path, { method: 'DELETE' });

export const api = {
  // ---------------------------------------------------------------- dossiers
  listPatients: () => get<{ patients: PatientSummary[] }>('/patients'),
  getPatient: (id: number) =>
    get<{ patient: Patient; documents: DocumentMeta[] }>(`/patients/${id}`),
  createPatient: (body: { code: string; label?: string | null; notes?: string | null }) =>
    post<{ patient: Patient }>('/patients', body),
  ensurePatient: (code: string) => post<{ patient: Patient }>('/patients/ensure', { code }),
  updatePatient: (id: number, body: { code?: string; label?: string | null; notes?: string | null }) =>
    patch<{ patient: Patient }>(`/patients/${id}`, body),
  deletePatient: (id: number) => del(`/patients/${id}`),

  // --------------------------------------------------------------- documents
  uploadDocuments: async (patientId: number, files: File[]): Promise<UploadResponse> => {
    const form = new FormData();
    for (const file of files) form.append('files', file, file.name);
    return request<UploadResponse>(`/patients/${patientId}/documents`, {
      method: 'POST',
      body: form,
    });
  },
  uploadTable: async (file: File): Promise<TableUploadResponse> => {
    const form = new FormData();
    form.append('file', file, file.name);
    return request<TableUploadResponse>('/table-imports', { method: 'POST', body: form });
  },
  tableColumns: (id: number, body: { sheet: string | null; headerRow: number; templateId?: number }) =>
    post<TableColumnsResponse>(`/table-imports/${id}/columns`, body),
  tableDryRun: (id: number, body: TableImportRequest) =>
    post<{ report: TableImportReport }>(`/table-imports/${id}/dry-run`, body, { timeoutMs: 0 }),
  tableCommit: (id: number, body: TableImportRequest) =>
    post<{ import: TableImport; report: TableImportReport }>(`/table-imports/${id}/commit`, body, { timeoutMs: 0 }),
  abandonTableImport: (id: number) => del(`/table-imports/${id}`),
  listTableImports: (templateId?: number) =>
    get<{ imports: TableImport[] }>(`/table-imports${templateId ? `?templateId=${templateId}` : ''}`),
  tableImportFileUrl: (id: number) => `/api/table-imports/${id}/file`,
  getDocumentText: (id: number) => get<{ text: string }>(`/documents/${id}/text`),
  documentFileUrl: (id: number) => `/api/documents/${id}/file`,
  reparseDocument: (id: number) => post<{ document: DocumentMeta }>(`/documents/${id}/reparse`),
  renameDocument: (id: number, filename: string) =>
    patch<{ document: DocumentMeta }>(`/documents/${id}`, { filename }),
  deleteDocument: (id: number) => del(`/documents/${id}`),
  capabilities: () => get<Capabilities>('/documents-capabilities'),

  // ------------------------------------------------- clé d'API de l'utilisateur
  apiKey: () => get<ApiKeyStatus>('/llm/key'),
  saveApiKey: (key: string) => put<ApiKeyStatus>('/llm/key', { key }),
  removeApiKey: () => request<ApiKeyStatus>('/llm/key', { method: 'DELETE' }),
  estimateExtraction: (templateId?: number) =>
    get<{ estimate: CostEstimate | null }>(`/llm/estimate${templateId ? `?templateId=${templateId}` : ''}`),

  // ------------------------------------------------------------------ fiches
  listTemplates: () =>
    get<{ templates: Template[]; active: TemplateWithFields | null }>('/templates'),
  getTemplate: (id: number) => get<{ template: TemplateWithFields }>(`/templates/${id}`),
  createTemplate: (body: { name: string; description?: string | null }) =>
    post<{ template: TemplateWithFields }>('/templates', body),
  updateTemplate: (id: number, body: { name?: string; description?: string | null }) =>
    patch<{ template: TemplateWithFields }>(`/templates/${id}`, body),
  activateTemplate: (id: number) => post<{ template: TemplateWithFields }>(`/templates/${id}/activate`),
  duplicateTemplate: (id: number, name?: string) =>
    post<{ template: TemplateWithFields }>(`/templates/${id}/duplicate`, { name }),
  deleteTemplate: (id: number) => del(`/templates/${id}`),
  importTemplate: (payload: unknown) =>
    post<{ template: TemplateWithFields }>('/templates/import', payload),

  createField: (templateId: number, body: Partial<TemplateField>) =>
    post<{ field: TemplateField }>(`/templates/${templateId}/fields`, body),
  updateField: (fieldId: number, body: Partial<TemplateField>) =>
    patch<{ field: TemplateField }>(`/templates/fields/${fieldId}`, body),
  deleteField: (fieldId: number) => del(`/templates/fields/${fieldId}`),
  reorderFields: (templateId: number, fieldIds: number[]) =>
    post<{ template: TemplateWithFields }>(`/templates/${templateId}/fields/reorder`, { fieldIds }),
  testRule: (body: { field: Partial<TemplateField>; patientId?: number; sampleText?: string }) =>
    post<RuleTestResult>('/templates/fields/test', body),

  // ------------------------------------------------------------- extractions
  getRecord: (patientId: number, templateId?: number) =>
    get<{ template: TemplateWithFields; patient: Patient; record: PatientRecord }>(
      `/records?patientId=${patientId}${templateId ? `&templateId=${templateId}` : ''}`,
    ),
  saveValues: (
    templateId: number,
    patientId: number,
    values: ValueEdit[],
    options: { acceptOutOfBounds?: boolean } = {},
  ) =>
    put<{ record: PatientRecord }>(`/records/${templateId}/${patientId}/values`, {
      values,
      ...(options.acceptOutOfBounds ? { acceptOutOfBounds: true } : {}),
    }),
  getValueHistory: (templateId: number, patientId: number, fieldId?: number) =>
    get<{ events: ValueEvent[] }>(
      `/records/${templateId}/${patientId}/history${fieldId ? `?fieldId=${fieldId}` : ''}`,
    ),
  listRuns: () => get<{ runs: ExtractionRun[] }>('/records/runs'),
  runExtraction: (body: {
    templateId?: number;
    patientIds?: number[];
    overwriteManual?: boolean;
    mode?: ExtractionMode;
  }) =>
    // Une passe sur des milliers de dossiers, ou avec un modèle, dure des minutes : pas de délai.
    post<ExtractionRunResult>('/records/extraction/run', body, { timeoutMs: 0 }),

  // --------------------------------------------------------------- rédaction
  redactionStatus: () => get<{ available: boolean }>('/redaction/status'),

  /**
   * Échange avec l'assistant, lu au fil de sa production.
   *
   * Le serveur répond en « événements côté serveur ». `EventSource` ne sait pas
   * émettre de POST : on lit donc le flux à la main, ce qui permet en prime de
   * l'interrompre proprement.
   */
  redactionMessage: async (
    messages: { role: 'user' | 'assistant'; content: string }[],
    signal: AbortSignal,
    handlers: {
      onDelta: (text: string) => void;
      onDone: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number }, costUsd: number | null) => void;
      onError: (message: string) => void;
    },
  ): Promise<void> => {
    const res = await fetch('/api/redaction/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal,
    });

    if (!res.ok || !res.body) {
      throw new ApiError(res.status, `Assistant injoignable (erreur ${res.status}).`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Les événements sont séparés par une ligne vide ; un fragment peut
      // arriver coupé en deux, on ne traite donc que les blocs complets.
      let coupure = buffer.indexOf('\n\n');
      while (coupure !== -1) {
        const bloc = buffer.slice(0, coupure);
        buffer = buffer.slice(coupure + 2);

        const type = /^event: (.+)$/m.exec(bloc)?.[1];
        const brut = /^data: (.*)$/m.exec(bloc)?.[1];
        if (type && brut) {
          const payload = JSON.parse(brut) as Record<string, never>;
          if (type === 'delta') handlers.onDelta(String(payload.text ?? ''));
          else if (type === 'done') handlers.onDone(payload.usage as never, (payload.costUsd as number | null | undefined) ?? null);
          else if (type === 'error') handlers.onError(String(payload.message ?? 'Erreur inconnue.'));
        }
        coupure = buffer.indexOf('\n\n');
      }
    }
  },

  // --------------------------------------------------------------- résultats
  dataset: (templateId?: number) =>
    get<{
      template: TemplateWithFields;
      rows: DatasetRow[];
      summary: { patients: number; fields: number; completeness: number };
    }>(`/analytics/dataset${templateId ? `?templateId=${templateId}` : ''}`),
  stats: (templateId?: number) =>
    get<{ template: TemplateWithFields; patientCount: number; stats: FieldStats[] }>(
      `/analytics/stats${templateId ? `?templateId=${templateId}` : ''}`,
    ),
  extractionOverview: (templateId?: number) =>
    get<ExtractionOverview>(
      `/analytics/extraction${templateId ? `?templateId=${templateId}` : ''}`,
    ),
  quality: (templateId?: number) =>
    get<{ quality: QualityReport }>(`/analytics/quality${templateId ? `?templateId=${templateId}` : ''}`),
  completeness: (templateId?: number) =>
    get<{ patientCount: number; fields: CompletenessField[] }>(
      `/analytics/completeness${templateId ? `?templateId=${templateId}` : ''}`,
    ),

  // ------------------------------------------------- revue bibliographique
  biblioStatus: () => get<BiblioStatus>('/biblio/status'),
  biblioOverview: () => get<BiblioOverview>('/biblio/overview'),
  /** Lance une passe sur PubMed et/ou Google Scholar. Longue : l'acteur Apify tourne côté serveur. */
  biblioSearch: (body: BiblioSearchParams) =>
    post<{ searches: BiblioSearch[]; counts: BiblioCounts; prisma: BiblioPrisma }>(
      '/biblio/searches',
      body,
      { timeoutMs: 0 },
    ),
  biblioRefs: (filter: BiblioRefFilter = {}) => {
    const params = new URLSearchParams();
    if (filter.decision) params.set('decision', filter.decision);
    if (filter.source) params.set('source', filter.source);
    if (filter.q) params.set('q', filter.q);
    if (filter.sort) params.set('sort', filter.sort);
    params.set('limit', '1000');
    return get<{ refs: BiblioRef[]; total: number }>(`/biblio/refs?${params.toString()}`);
  },
  biblioDecide: (
    id: number,
    body: { decision?: BiblioDecision; exclusionReason?: ExclusionReason | null; note?: string | null },
  ) =>
    patch<{ ref: BiblioRef; counts: BiblioCounts; prisma: BiblioPrisma }>(`/biblio/refs/${id}`, body),
  biblioExportUrl: (format: BiblioExportFormat, decision?: BiblioDecision) =>
    `/api/biblio/export?format=${format}${decision ? `&decision=${decision}` : ''}`,

  // ------------------------------------------------------------------ export
  csvUrl: (
    templateId: number,
    opts: { delimiter: string; booleans: string; labels: boolean; decimal?: '.' | ','; deidentify?: boolean },
  ) =>
    `/api/export/csv?templateId=${templateId}&delimiter=${encodeURIComponent(opts.delimiter)}` +
    `&booleans=${opts.booleans}&labels=${opts.labels ? '1' : '0'}` +
    (opts.decimal ? `&decimal=${encodeURIComponent(opts.decimal)}` : '') +
    (opts.deidentify ? '&deidentify=1' : ''),
  xlsxUrl: (templateId: number, labels: boolean) =>
    `/api/export/xlsx?templateId=${templateId}&labels=${labels ? '1' : '0'}`,
  pptxUrl: (templateId: number) => `/api/export/pptx?templateId=${templateId}`,
  dictionaryUrl: (templateId: number, delimiter: string) =>
    `/api/export/dictionary.csv?templateId=${templateId}&delimiter=${encodeURIComponent(delimiter)}`,
  templateJsonUrl: (templateId: number) => `/api/export/template.json?templateId=${templateId}`,
  methodsUrl: (templateId: number, format: 'html' | 'md' | 'json', lang: 'fr' | 'en') =>
    `/api/export/methods?templateId=${templateId}&format=${format}&lang=${lang}`,
  auditUrl: (templateId: number) => `/api/export/audit.csv?templateId=${templateId}`,
};
