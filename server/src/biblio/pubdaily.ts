/**
 * Client MCP (Model Context Protocol, Streamable HTTP) pour PubDaily.
 *
 * PubDaily (https://pubdaily.app) expose un serveur MCP public et sans
 * authentification à `/api/mcp`, avec cinq outils en lecture seule :
 *   - `list_specialties`
 *   - `get_research_trends`
 *   - `find_trend`
 *   - `get_top_papers`
 *   - `search_papers`
 *
 * Protocole MCP 2025-06-18 (Streamable HTTP) : un POST `initialize` ouvre une
 * session (identifiant lu dans l'en-tête `Mcp-Session-Id`), un POST
 * `notifications/initialized` la signale, puis chaque `tools/call` emporte
 * l'en-tête de session. Un 404 → la session est perdue, on en rouvre une.
 *
 * Pour éviter de solliciter PubDaily (données mises à jour quotidiennement) un
 * petit cache mémoire de dix minutes est posé par (outil, arguments). Le
 * client refuse toute URL non `https` autre que `localhost`/`127.0.0.1`.
 */

import { z } from 'zod';

/* ───────────────────────────── Configuration ───────────────────────────── */

export const PUBDAILY_DEFAULT_URL = 'https://pubdaily.app/api/mcp';
export const PUBDAILY_PROTOCOL = '2025-06-18';
export const PUBDAILY_TIMEOUT_MS = 20_000;
export const PUBDAILY_SESSION_IDLE_MS = 5 * 60_000;
export const PUBDAILY_CACHE_TTL_MS = 10 * 60_000;

export interface PubdailyConfig {
  baseUrl: string;
  timeoutMs: number;
  sessionIdleMs: number;
  cacheTtlMs: number;
  disabled: boolean;
}

export function pubdailyConfig(env: NodeJS.ProcessEnv = process.env): PubdailyConfig {
  const raw = (env.PUBDAILY_MCP_URL ?? PUBDAILY_DEFAULT_URL).trim();
  let baseUrl = PUBDAILY_DEFAULT_URL;
  try {
    const parsed = new URL(raw);
    const isLoopback =
      parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
    if (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopback)) {
      baseUrl = parsed.toString().replace(/\/+$/, '');
    } else {
      throw new PubdailyError('config', `URL PubDaily refusée (http hors loopback) : ${raw}`);
    }
  } catch (error) {
    if (error instanceof PubdailyError) throw error;
    throw new PubdailyError('config', `URL PubDaily invalide (${raw}).`);
  }
  return {
    baseUrl,
    timeoutMs: Number(env.PUBDAILY_TIMEOUT_MS) || PUBDAILY_TIMEOUT_MS,
    sessionIdleMs: PUBDAILY_SESSION_IDLE_MS,
    cacheTtlMs: PUBDAILY_CACHE_TTL_MS,
    disabled: env.PUBDAILY_DISABLED === '1',
  };
}

/* ───────────────────────────────── Erreurs ─────────────────────────────── */

export type PubdailyErrorKind = 'config' | 'network' | 'timeout' | 'protocol' | 'tool' | 'parse';

export class PubdailyError extends Error {
  constructor(readonly kind: PubdailyErrorKind, message: string) {
    super(message);
    this.name = 'PubdailyError';
  }
}

/* ────────────────────────── Schémas des sorties ───────────────────────── */

const specialtySchema = z.object({
  name: z.string(),
  topicCount: z.number().int().nullable().optional(),
  slug: z.string().optional(),
});
export const listSpecialtiesSchema = z.object({
  specialties: z.array(z.union([z.string(), specialtySchema])).default([]),
});

const trendTopicSchema = z.object({
  topic: z.string(),
  trend_score: z.number().nullable().optional(),
  papers_last_12_months: z.number().nullable().optional(),
  growth_vs_previous_12_months_pct: z.number().nullable().optional(),
  new_trials_last_12_months: z.number().nullable().optional(),
  pubmed_search: z.string().nullable().optional(),
  page: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
});
export const getResearchTrendsSchema = z.object({
  specialty: z.string().optional(),
  topics: z.array(trendTopicSchema).default([]),
});

export const findTrendSchema = z.object({
  found: z.boolean().optional(),
  topic: trendTopicSchema.optional(),
  specialty: z.string().optional(),
});

const paperSchema = z.object({
  title: z.string(),
  journal: z.string().nullable().optional(),
  published: z.string().nullable().optional(),
  type: z.string().nullable().optional(),
  specialty: z.string().nullable().optional(),
  pubdaily_score: z.number().nullable().optional(),
  pubmed: z.string().nullable().optional(),
  pmid: z.union([z.string(), z.number()]).nullable().optional(),
  summary: z.string().nullable().optional(),
  page: z.string().nullable().optional(),
});
export const papersListSchema = z.object({
  specialty: z.string().optional(),
  papers: z.array(paperSchema).default([]),
});

export type PubdailySpecialty = { name: string; topicCount: number | null };
export type PubdailyTopic = z.infer<typeof trendTopicSchema>;
export type PubdailyPaper = z.infer<typeof paperSchema> & { pmid: string | null };

/* ────────────────────────── Client Streamable HTTP ────────────────────── */

interface Session {
  id: string;
  usedAt: number;
}

export interface PubdailyFetch {
  (url: string, init?: RequestInit): Promise<Response>;
}

export class PubdailyClient {
  private session: Session | null = null;
  private readonly cache = new Map<string, { value: unknown; expires: number }>();
  private nextId = 1;

  constructor(
    private readonly cfg: PubdailyConfig,
    private readonly fetchImpl: PubdailyFetch = (url, init) => fetch(url, init),
  ) {}

  /** Pour les tests : vide la session et le cache. */
  reset(): void {
    this.session = null;
    this.cache.clear();
  }

  /** Pour les tests : lire ou vider le cache. */
  cacheSize(): number {
    return this.cache.size;
  }

  private cacheGet(key: string): unknown | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (entry.expires < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private cacheSet(key: string, value: unknown): void {
    this.cache.set(key, { value, expires: Date.now() + this.cfg.cacheTtlMs });
  }

  private async ensureSession(): Promise<string | null> {
    if (this.session && Date.now() - this.session.usedAt < this.cfg.sessionIdleMs) {
      return this.session.id;
    }
    this.session = null;
    const response = await this.rpc('initialize', {
      protocolVersion: PUBDAILY_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'PubResearcher', version: '1.0' },
    });
    const sessionId = response.sessionId;
    if (sessionId) {
      this.session = { id: sessionId, usedAt: Date.now() };
      // Notification « initialized » : jamais de corps de réponse à lire.
      try {
        await this.rpc('notifications/initialized', {}, { notification: true, sessionId });
      } catch {
        /* la notification est optionnelle. */
      }
      return sessionId;
    }
    // Serveur sans état : pas de session à garder, les appels passent sans en-tête.
    return null;
  }

  /** Appel JSON-RPC enveloppé par le protocole MCP Streamable HTTP. */
  private async rpc(
    method: string,
    params: unknown,
    opts: { notification?: boolean; sessionId?: string } = {},
  ): Promise<{ result?: unknown; error?: { code: number; message: string }; sessionId: string | null }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PUBDAILY_PROTOCOL,
    };
    if (opts.sessionId) headers['Mcp-Session-Id'] = opts.sessionId;
    const body = opts.notification
      ? { jsonrpc: '2.0', method, params }
      : { jsonrpc: '2.0', id: this.nextId++, method, params };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.cfg.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PubdailyError('timeout', `PubDaily n’a pas répondu en ${this.cfg.timeoutMs} ms.`);
      }
      throw new PubdailyError('network', `Appel PubDaily impossible : ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    const sessionId = response.headers.get('mcp-session-id') ?? response.headers.get('Mcp-Session-Id') ?? null;

    if (response.status === 404) {
      // Session perdue côté serveur : on la laisse se recréer au prochain appel.
      this.session = null;
      throw new PubdailyError('protocol', 'Session PubDaily expirée (404).');
    }
    if (!response.ok && response.status !== 202) {
      const text = await response.text().catch(() => '');
      throw new PubdailyError('protocol', `Réponse PubDaily ${response.status} : ${text.slice(0, 200)}`);
    }
    if (opts.notification) return { sessionId };

    const text = await response.text().catch(() => '');
    if (!text) return { sessionId };
    // Streamable HTTP tolère text/event-stream : on lit le dernier JSON-RPC.
    const payload = parseMcpBody(text);
    return { ...payload, sessionId };
  }

  async callTool<T>(name: string, args: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
    if (this.cfg.disabled) throw new PubdailyError('config', 'Intégration PubDaily désactivée (PUBDAILY_DISABLED=1).');
    const key = `${name}:${stableKey(args)}`;
    const cached = this.cacheGet(key);
    if (cached !== undefined) return cached as T;

    const attempt = async (): Promise<unknown> => {
      const sessionId = await this.ensureSession();
      const resp = await this.rpc(
        'tools/call',
        { name, arguments: args },
        sessionId ? { sessionId } : {},
      );
      if (this.session) this.session.usedAt = Date.now();
      if (resp.error) throw new PubdailyError('tool', `PubDaily/${name} : ${resp.error.message}`);
      return extractStructuredContent(resp.result);
    };

    let structured: unknown;
    try {
      structured = await attempt();
    } catch (error) {
      if (error instanceof PubdailyError && error.kind === 'protocol' && /404|expir/i.test(error.message)) {
        structured = await attempt();
      } else {
        throw error;
      }
    }
    const parsed = schema.safeParse(structured);
    if (!parsed.success) {
      throw new PubdailyError('parse', `Sortie PubDaily/${name} inattendue : ${parsed.error.message.slice(0, 200)}`);
    }
    this.cacheSet(key, parsed.data);
    return parsed.data;
  }

  // Façades fortement typées.

  async listSpecialties(): Promise<{ specialties: PubdailySpecialty[] }> {
    const raw = await this.callTool('list_specialties', {}, listSpecialtiesSchema);
    const specialties = (raw.specialties ?? []).map((s): PubdailySpecialty =>
      typeof s === 'string' ? { name: s, topicCount: null } : { name: s.name, topicCount: s.topicCount ?? null },
    );
    return { specialties };
  }

  async getResearchTrends(specialty: string, limit?: number): Promise<{ specialty: string; topics: PubdailyTopic[] }> {
    const args: Record<string, unknown> = { specialty };
    if (limit != null) args.limit = limit;
    const r = await this.callTool('get_research_trends', args, getResearchTrendsSchema);
    return { specialty: r.specialty ?? specialty, topics: r.topics ?? [] };
  }

  async findTrend(query: string): Promise<{ found: boolean; topic: PubdailyTopic | null; specialty: string | null }> {
    const r = await this.callTool('find_trend', { query }, findTrendSchema);
    return { found: r.found ?? Boolean(r.topic), topic: r.topic ?? null, specialty: r.specialty ?? null };
  }

  async getTopPapers(
    specialty: string,
    opts: { limit?: number; summarizedOnly?: boolean } = {},
  ): Promise<{ specialty: string; papers: PubdailyPaper[] }> {
    const args: Record<string, unknown> = { specialty };
    if (opts.limit != null) args.limit = opts.limit;
    if (opts.summarizedOnly != null) args.summarized_only = opts.summarizedOnly;
    const r = await this.callTool('get_top_papers', args, papersListSchema);
    return { specialty: r.specialty ?? specialty, papers: (r.papers ?? []).map(normalizePaper) };
  }

  async searchPapers(
    query: string,
    opts: { specialty?: string; limit?: number } = {},
  ): Promise<{ papers: PubdailyPaper[] }> {
    const args: Record<string, unknown> = { query };
    if (opts.specialty) args.specialty = opts.specialty;
    if (opts.limit != null) args.limit = opts.limit;
    const r = await this.callTool('search_papers', args, papersListSchema);
    return { papers: (r.papers ?? []).map(normalizePaper) };
  }
}

/* ─────────────────────────────── Utilitaires ──────────────────────────── */

function normalizePaper(raw: z.infer<typeof paperSchema>): PubdailyPaper {
  const pmid = raw.pmid != null
    ? String(raw.pmid)
    : raw.pubmed
      ? (/\b(\d{4,10})\b/.exec(raw.pubmed)?.[1] ?? null)
      : null;
  return { ...raw, pmid };
}

/** Clé stable pour le cache : les propriétés sont triées. */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableKey).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableKey(v)).join(',') + '}';
}

/**
 * Lit le corps d'une réponse MCP : JSON brut, ou flux SSE dont on prend le
 * dernier événement `message` (c'est le JSON-RPC final).
 */
function parseMcpBody(text: string): { result?: unknown; error?: { code: number; message: string } } {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    try {
      return JSON.parse(trimmed) as { result?: unknown; error?: { code: number; message: string } };
    } catch {
      throw new PubdailyError('parse', 'Réponse PubDaily illisible (JSON attendu).');
    }
  }
  // SSE : on prend le dernier `data:` qui parse comme JSON.
  const lines = trimmed.split(/\r?\n/);
  let last: string | null = null;
  for (const line of lines) {
    const m = /^data:\s?(.*)$/.exec(line);
    if (m) last = m[1] ?? null;
  }
  if (!last) throw new PubdailyError('parse', 'Flux SSE PubDaily sans données.');
  try {
    return JSON.parse(last) as { result?: unknown; error?: { code: number; message: string } };
  } catch {
    throw new PubdailyError('parse', 'Événement SSE PubDaily illisible.');
  }
}

/** Un `tools/call` MCP renvoie un `result.content[]` (text) ET un `result.structuredContent`. */
function extractStructuredContent(result: unknown): unknown {
  if (!result || typeof result !== 'object') {
    throw new PubdailyError('tool', 'Réponse PubDaily sans résultat.');
  }
  const r = result as { structuredContent?: unknown; content?: unknown[]; isError?: boolean };
  if (r.isError) {
    const text = Array.isArray(r.content) && r.content[0] && typeof r.content[0] === 'object'
      ? ((r.content[0] as { text?: string }).text ?? 'erreur')
      : 'erreur';
    throw new PubdailyError('tool', `PubDaily a renvoyé une erreur : ${text}`);
  }
  if (r.structuredContent !== undefined) return r.structuredContent;
  // Repli : premier bloc texte en JSON.
  if (Array.isArray(r.content)) {
    for (const block of r.content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const text = (block as { text?: string }).text ?? '';
        try {
          return JSON.parse(text);
        } catch {
          /* bloc texte non JSON : on continue. */
        }
      }
    }
  }
  throw new PubdailyError('tool', 'Réponse PubDaily sans structuredContent exploitable.');
}

/* ───────────────────────── Instance partagée ──────────────────────────── */

let shared: PubdailyClient | null = null;
export function getPubdailyClient(): PubdailyClient {
  if (!shared) shared = new PubdailyClient(pubdailyConfig());
  return shared;
}

/** Pour les tests : remplace l'instance partagée (ou `null` pour revenir au défaut). */
export function setPubdailyClient(client: PubdailyClient | null): void {
  shared = client;
}

export function extractEsearchTerm(pubmedSearchUrl: string | null | undefined): string | null {
  if (!pubmedSearchUrl) return null;
  try {
    const url = new URL(pubmedSearchUrl);
    const term = url.searchParams.get('term') ?? url.searchParams.get('query') ?? url.searchParams.get('q');
    return term ? term.trim() : null;
  } catch {
    return null;
  }
}
