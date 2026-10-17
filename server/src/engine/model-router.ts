import Anthropic from '@anthropic-ai/sdk';
import { clientOptions, keyStore } from './api-key.js';
import { MODEL_TASKS, type ModelTask } from './model-catalog.js';
import { modelSettings, type ModelSettingsStore, type ProviderId } from './model-settings.js';
import { contextFor, createOllamaClient, fitsContext, OllamaError, type OllamaClient, type OllamaMessage } from './ollama.js';

/**
 * Aiguillage des appels de modèle : chaque tâche (extraction, import de fiche, rédaction, recherche bibliographique)
 * part vers Claude ou vers un modèle ouvert qui tourne sur ce poste, selon les réglages de la page « Modèles d'IA ».
 *
 * Ce module ne fait que choisir et appeler. Ce qui protège le jeu de données — citation vérifiée dans le document,
 * citation qui ne contredit pas la valeur, typage par la fiche — reste dans `llm.ts` et s'applique à la réponse quel
 * que soit le modèle : un modèle local n'a droit à aucune indulgence.
 *
 * Un modèle local est nommé `ollama:<étiquette>` partout où l'outil garde trace du modèle (passes, valeurs, rapport
 * de méthodes) : on sait toujours, après coup, quel modèle a produit une valeur.
 */

export const LOCAL_PREFIX = 'ollama:';
export const isLocalModel = (name: string | null | undefined): boolean => Boolean(name?.startsWith(LOCAL_PREFIX));
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
export const anthropicModel = (): string => process.env.LLM_MODEL ?? DEFAULT_ANTHROPIC_MODEL;

export interface TaskRoute {
  task: ModelTask;
  provider: ProviderId;
  /** Pour Claude : l'identifiant du modèle ; pour un modèle local : l'étiquette Ollama (sans préfixe). */
  model: string;
  /** Le nom consigné : `claude-…` ou `ollama:<étiquette>`. */
  label: string;
}

export class ModelCallError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    /** Réponse reçue mais pas un JSON exploitable (compté à part dans l'évaluation). */
    readonly invalidJson = false,
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}

let store: ModelSettingsStore = modelSettings;
let client: OllamaClient = createOllamaClient(() => store.endpoint().url);

/** Tests : réglages dans un autre fichier, et client Ollama vers un faux serveur. */
export function configureRouter(options: { settings?: ModelSettingsStore; fetchImpl?: typeof fetch }): void {
  if (options.settings) store = options.settings;
  client = createOllamaClient(() => store.endpoint().url, options.fetchImpl ?? fetch);
}

export const routerSettings = (): ModelSettingsStore => store;
export const ollama = (): OllamaClient => client;

export function routeFor(task: ModelTask): TaskRoute {
  const setting = store.task(task);
  if (setting.provider === 'local') {
    const model = store.localModel(task);
    return { task, provider: 'local', model, label: `${LOCAL_PREFIX}${model}` };
  }
  const model = anthropicModel();
  return { task, provider: 'anthropic', model, label: model };
}

/** Route explicite vers un modèle donné (`claude`, `claude-…`, `ollama:qwen3.5:9b` ou `qwen3.5:9b`) : évaluation, test. */
export function explicitRoute(task: ModelTask, name: string): TaskRoute {
  const trimmed = name.trim();
  if (trimmed === 'claude' || trimmed.startsWith('claude-')) {
    const model = trimmed === 'claude' ? anthropicModel() : trimmed;
    return { task, provider: 'anthropic', model, label: model };
  }
  const tag = trimmed.startsWith(LOCAL_PREFIX) ? trimmed.slice(LOCAL_PREFIX.length) : trimmed;
  return { task, provider: 'local', model: tag, label: `${LOCAL_PREFIX}${tag}` };
}

/**
 * La tâche peut-elle être servie ? Claude : une clé est disponible. Modèle local : il est choisi — sa présence réelle
 * (Ollama lancé, modèle téléchargé) se vérifie au premier appel, avec un message qui dit quoi faire.
 */
export function taskAvailable(task: ModelTask, route: TaskRoute = routeFor(task)): boolean {
  return route.provider === 'local' ? true : keyStore.active() !== null;
}

/** Pseudonymiser avant l'appel ? Toujours pour Claude ; pour un modèle local, selon le réglage (désactivé par défaut). */
export function shouldPseudonymize(route: TaskRoute): boolean {
  if (route.provider === 'anthropic') return true;
  return store.get().pseudonymizeLocal || store.endpoint().remote;
}

export const allRoutes = (): Record<ModelTask, TaskRoute> =>
  Object.fromEntries(MODEL_TASKS.map((t) => [t, routeFor(t)])) as Record<ModelTask, TaskRoute>;

// ------------------------------------------------------------------ sortie structurée

export interface StructuredRequest {
  task: ModelTask;
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  /** Route imposée (évaluation, test) ; par défaut, celle des réglages. */
  route?: TaskRoute;
  signal?: AbortSignal;
}

export interface StructuredUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StructuredResult {
  text: string;
  json: unknown;
  model: string;
  provider: ProviderId;
  usage: StructuredUsage;
  latencyMs: number;
}

const zeroUsage = (): StructuredUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/** Plafond de génération d'un modèle local : sur processeur, chaque jeton se paie en secondes. */
const LOCAL_MAX_OUTPUT = 8_192;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelCallError('Réponse du modèle illisible (JSON invalide).', true, true);
  }
}

/**
 * Réponse conforme à un schéma JSON. Modèle local : `format` = schéma (Ollama contraint alors la génération),
 * température 0 (même dossier, même réponse), raisonnement préalable coupé, contexte dimensionné à l'entrée.
 */
export async function generateStructured(req: StructuredRequest): Promise<StructuredResult> {
  const route = req.route ?? routeFor(req.task);
  const started = Date.now();
  if (route.provider === 'local') {
    const inputChars = req.system.length + req.user.length + JSON.stringify(req.schema).length;
    const numPredict = Math.min(req.maxTokens, LOCAL_MAX_OUTPUT);
    if (!fitsContext(inputChars, numPredict)) {
      throw new ModelCallError(
        `Texte trop long pour le modèle local (environ ${Math.ceil(inputChars / 3)} jetons) : augmentez LOCAL_MODEL_MAX_CTX si la mémoire du poste le permet, ou réduisez LLM_MAX_CHARS_PER_DOC.`,
        false,
      );
    }
    const messages: OllamaMessage[] = [
      // Le schéma est aussi rappelé en clair : Ollama le recommande, et les petits modèles s'y tiennent mieux.
      { role: 'system', content: `${req.system}\n\nRéponds uniquement par un objet JSON conforme à ce schéma :\n${JSON.stringify(req.schema)}` },
      { role: 'user', content: req.user },
    ];
    let result;
    try {
      result = await client.chat({
        model: route.model,
        messages,
        format: req.schema,
        temperature: 0,
        think: false,
        numCtx: contextFor(inputChars, numPredict),
        numPredict,
        signal: req.signal,
      });
    } catch (error) {
      if (error instanceof OllamaError) throw new ModelCallError(error.message, error.retryable);
      throw error;
    }
    if (result.doneReason === 'length') {
      throw new ModelCallError('Réponse du modèle local tronquée (plafond de génération atteint).', true, true);
    }
    return {
      text: result.text,
      json: parseJson(result.text),
      model: `${LOCAL_PREFIX}${route.model}`,
      provider: 'local',
      // Rien n'est facturé : les jetons sont comptés pour information.
      usage: { ...zeroUsage(), inputTokens: result.promptTokens, outputTokens: result.outputTokens },
      latencyMs: Date.now() - started,
    };
  }

  const active = keyStore.active();
  if (!active) throw new ModelCallError('Claude n’est pas activé : aucune clé d’API Anthropic.', false);
  const anthropic = new Anthropic(clientOptions(active));
  let message: Anthropic.Beta.Messages.BetaMessage;
  try {
    message = await anthropic.beta.messages.create({
      model: route.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      output_config: { format: { type: 'json_schema', schema: req.schema }, effort: 'medium' },
    } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    throw new ModelCallError(keyStore.redact(raw).slice(0, 200), error instanceof Anthropic.APIConnectionError);
  }
  if (message.stop_reason === 'refusal') throw new ModelCallError('requête déclinée par le modèle', false);
  if (message.stop_reason === 'max_tokens') throw new ModelCallError('réponse tronquée', false);
  const text = message.content
    .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('');
  return {
    text,
    json: parseJson(text),
    model: typeof message.model === 'string' && message.model ? message.model : route.model,
    provider: 'anthropic',
    usage: {
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
    latencyMs: Date.now() - started,
  };
}

// ------------------------------------------------------------------ conversation diffusée (modèle local)

export interface LocalStreamRequest {
  route: TaskRoute;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens: number;
  onChunk: (text: string) => void;
  signal?: AbortSignal;
}

/**
 * Conversation diffusée vers un modèle local (rédaction). Claude garde son propre chemin (`chat.ts`) : cache de la
 * consigne, raisonnement adaptatif.
 */
export async function streamLocalChat(req: LocalStreamRequest): Promise<{ model: string; usage: StructuredUsage }> {
  const inputChars = req.system.length + req.messages.reduce((sum, m) => sum + m.content.length, 0);
  const numPredict = Math.min(req.maxTokens, LOCAL_MAX_OUTPUT);
  if (!fitsContext(inputChars, numPredict)) {
    throw new ModelCallError('Conversation trop longue pour le modèle local : ouvrez un nouveau fil.', false);
  }
  try {
    const result = await client.chatStream(
      {
        model: req.route.model,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        temperature: 0.3,
        numCtx: contextFor(inputChars, numPredict),
        numPredict,
        signal: req.signal,
      },
      req.onChunk,
    );
    return { model: `${LOCAL_PREFIX}${req.route.model}`, usage: { ...zeroUsage(), inputTokens: result.promptTokens, outputTokens: result.outputTokens } };
  } catch (error) {
    if (error instanceof OllamaError) throw new ModelCallError(error.message, error.retryable);
    throw error;
  }
}
