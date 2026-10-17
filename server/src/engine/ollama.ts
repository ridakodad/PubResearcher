import { numberOr } from '../lib/env-check.js';

/**
 * Client minimal de l'API HTTP d'Ollama (https://docs.ollama.com/api), sans dépendance : `fetch` de Node suffit.
 *
 * Ollama tourne sur le poste et sert des modèles ouverts. On n'en utilise que cinq points :
 * `/api/version`, `/api/tags` (modèles installés), `/api/chat` (réponse structurée par `format` = schéma JSON, ou
 * diffusée), `/api/pull` (téléchargement, progression diffusée) et `/api/delete`.
 *
 * Toutes les erreurs ressortent en `OllamaError`, au message français et actionnable : Ollama absent, modèle non
 * téléchargé, mémoire insuffisante, délai dépassé.
 */

export type OllamaProblem = 'unreachable' | 'model-missing' | 'memory' | 'timeout' | 'context' | 'other';

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly problem: OllamaProblem,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OllamaError';
  }
}

/** Délai d'une réponse complète. Un modèle de 9 milliards de paramètres sur processeur peut demander plusieurs minutes. */
export const LOCAL_TIMEOUT_MS = numberOr(process.env.LOCAL_MODEL_TIMEOUT_MS, 15 * 60_000, 5_000);
/** Plafond du contexte demandé à Ollama : au-delà, la mémoire d'un portable ne suit plus. */
export const LOCAL_MAX_CTX = numberOr(process.env.LOCAL_MODEL_MAX_CTX, 32_768, 2_048);

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  format?: Record<string, unknown>;
  temperature?: number;
  numCtx: number;
  numPredict?: number;
  /** Raisonnement préalable des modèles « thinking » : coupé pour une sortie structurée (plus rapide, aussi précis). */
  think?: boolean;
  signal?: AbortSignal;
}

export interface OllamaChatResult {
  text: string;
  model: string;
  promptTokens: number;
  outputTokens: number;
  doneReason: string | null;
}

export interface InstalledModel {
  name: string;
  size: number;
  modifiedAt: string | null;
  parameterSize: string | null;
  quantization: string | null;
}

/** Nombre de jetons de contexte à demander : l'entrée estimée plus la sortie, arrondi, borné. */
export function contextFor(inputChars: number, outputTokens: number): number {
  const needed = Math.ceil(inputChars / 3) + outputTokens + 256;
  const rounded = Math.ceil(needed / 2048) * 2048;
  return Math.max(4096, Math.min(LOCAL_MAX_CTX, rounded));
}

/** L'entrée tient-elle dans le contexte maximal ? Sinon Ollama tronquerait le début — c'est-à-dire la consigne. */
export function fitsContext(inputChars: number, outputTokens: number): boolean {
  return Math.ceil(inputChars / 3) + outputTokens + 256 <= LOCAL_MAX_CTX;
}

function translate(base: string, status: number, body: string, model?: string): OllamaError {
  let message = body;
  try {
    const parsed = JSON.parse(body) as { error?: string };
    if (parsed.error) message = parsed.error;
  } catch {
    // texte brut
  }
  if (status === 404 || /not found|pull the model|no such file/i.test(message)) {
    return new OllamaError(
      `Le modèle « ${model ?? '?'} » n’est pas téléchargé dans Ollama. Ouvrez la page « Modèles d’IA » et cliquez « Télécharger » (ou, dans un terminal : ollama pull ${model ?? '<modèle>'}).`,
      'model-missing',
      false,
    );
  }
  if (/memory|out of memory|oom|insufficient|cudaMalloc|failed to allocate/i.test(message)) {
    return new OllamaError(
      `Mémoire insuffisante pour faire tourner « ${model ?? '?'} » sur ce poste (${message.slice(0, 160)}). Fermez d’autres applications, ou choisissez la variante légère proposée sur la page « Modèles d’IA ».`,
      'memory',
      false,
    );
  }
  if (/context|too long|exceeds/i.test(message)) {
    return new OllamaError(`Texte trop long pour le contexte du modèle local : ${message.slice(0, 200)}`, 'context', false);
  }
  return new OllamaError(`Ollama (${base}) a répondu ${status} : ${message.slice(0, 300)}`, 'other', status >= 500);
}

function connectionError(base: string, error: unknown): OllamaError {
  if (error instanceof OllamaError) return error;
  const name = (error as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new OllamaError(
      'Le modèle local n’a pas répondu dans le délai imparti. Sur un poste sans carte graphique, préférez la variante légère, ou augmentez LOCAL_MODEL_TIMEOUT_MS.',
      'timeout',
      true,
    );
  }
  return new OllamaError(
    `Ollama ne répond pas à ${base}. Lancez l’application Ollama (ou « ollama serve » dans un terminal), puis réessayez. Pas encore installé ? https://ollama.com/download`,
    'unreachable',
    true,
  );
}

export function createOllamaClient(baseUrl: () => string, fetchImpl: typeof fetch = fetch) {
  async function request(pathname: string, init: RequestInit & { model?: string; timeoutMs?: number }): Promise<Response> {
    const base = baseUrl();
    const timeout = AbortSignal.timeout(init.timeoutMs ?? 10_000);
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetchImpl(`${base}${pathname}`, { ...init, signal, headers: { 'Content-Type': 'application/json' } });
    } catch (error) {
      throw connectionError(base, error);
    }
    if (!response.ok) throw translate(base, response.status, await response.text().catch(() => ''), init.model);
    return response;
  }

  /** Lit un flux NDJSON ligne à ligne. */
  async function* lines(response: Response): AsyncGenerator<Record<string, unknown>> {
    if (!response.body) return;
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line) as Record<string, unknown>;
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer) as Record<string, unknown>;
  }

  function body(req: OllamaChatRequest, stream: boolean): string {
    return JSON.stringify({
      model: req.model,
      messages: req.messages,
      stream,
      ...(req.format ? { format: req.format } : {}),
      ...(req.think !== undefined ? { think: req.think } : {}),
      options: {
        num_ctx: req.numCtx,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.numPredict ? { num_predict: req.numPredict } : {}),
      },
    });
  }

  /** Les modèles sans raisonnement refusent le paramètre `think` : on le retire et on réessaie. */
  async function withThinkFallback(req: OllamaChatRequest, stream: boolean): Promise<Response> {
    try {
      return await request('/api/chat', { method: 'POST', body: body(req, stream), model: req.model, timeoutMs: LOCAL_TIMEOUT_MS, signal: req.signal });
    } catch (error) {
      if (req.think !== undefined && error instanceof OllamaError && /think/i.test(error.message)) {
        const { think: _omit, ...rest } = req;
        return request('/api/chat', { method: 'POST', body: body(rest, stream), model: req.model, timeoutMs: LOCAL_TIMEOUT_MS, signal: req.signal });
      }
      throw error;
    }
  }

  return {
    baseUrl,

    async version(): Promise<string> {
      const response = await request('/api/version', { method: 'GET', timeoutMs: 3_000 });
      return String(((await response.json()) as { version?: string }).version ?? '?');
    },

    async installed(): Promise<InstalledModel[]> {
      const response = await request('/api/tags', { method: 'GET', timeoutMs: 5_000 });
      const data = (await response.json()) as { models?: Record<string, any>[] };
      return (data.models ?? []).map((m) => ({
        name: String(m.name ?? m.model ?? ''),
        size: Number(m.size ?? 0),
        modifiedAt: typeof m.modified_at === 'string' ? m.modified_at : null,
        parameterSize: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null,
      }));
    },

    async chat(req: OllamaChatRequest): Promise<OllamaChatResult> {
      const response = await withThinkFallback(req, false);
      let data: Record<string, any>;
      try {
        data = (await response.json()) as Record<string, any>;
      } catch (error) {
        throw connectionError(baseUrl(), error);
      }
      if (data.error) throw translate(baseUrl(), 500, JSON.stringify({ error: data.error }), req.model);
      return {
        text: String(data.message?.content ?? ''),
        model: String(data.model ?? req.model),
        promptTokens: Number(data.prompt_eval_count ?? 0),
        outputTokens: Number(data.eval_count ?? 0),
        doneReason: typeof data.done_reason === 'string' ? data.done_reason : null,
      };
    },

    async chatStream(req: OllamaChatRequest, onChunk: (text: string) => void): Promise<OllamaChatResult> {
      const response = await withThinkFallback(req, true);
      let text = '';
      let last: Record<string, any> = {};
      try {
        for await (const event of lines(response)) {
          if (event.error) throw translate(baseUrl(), 500, JSON.stringify({ error: event.error }), req.model);
          const piece = String((event.message as { content?: string } | undefined)?.content ?? '');
          if (piece) {
            text += piece;
            onChunk(piece);
          }
          last = event;
        }
      } catch (error) {
        if (error instanceof OllamaError) throw error;
        throw connectionError(baseUrl(), error);
      }
      return {
        text,
        model: String(last.model ?? req.model),
        promptTokens: Number(last.prompt_eval_count ?? 0),
        outputTokens: Number(last.eval_count ?? 0),
        doneReason: typeof last.done_reason === 'string' ? last.done_reason : null,
      };
    },

    /** Télécharge un modèle ; chaque étape de progression d'Ollama est transmise telle quelle. */
    async pull(model: string, onProgress: (event: { status: string; total?: number; completed?: number; digest?: string }) => void, signal?: AbortSignal): Promise<void> {
      const response = await request('/api/pull', {
        method: 'POST',
        body: JSON.stringify({ model, stream: true }),
        model,
        timeoutMs: 6 * 60 * 60_000,
        signal,
      });
      for await (const event of lines(response)) {
        if (event.error) throw new OllamaError(`Téléchargement de « ${model} » interrompu : ${String(event.error).slice(0, 300)}`, 'other', true);
        onProgress({
          status: String(event.status ?? ''),
          ...(typeof event.total === 'number' ? { total: event.total } : {}),
          ...(typeof event.completed === 'number' ? { completed: event.completed } : {}),
          ...(typeof event.digest === 'string' ? { digest: event.digest } : {}),
        });
      }
    },

    async remove(model: string): Promise<void> {
      await request('/api/delete', { method: 'DELETE', body: JSON.stringify({ model }), model, timeoutMs: 30_000 });
    },
  };
}

export type OllamaClient = ReturnType<typeof createOllamaClient>;
