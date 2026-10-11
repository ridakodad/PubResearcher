import Anthropic from '@anthropic-ai/sdk';
import type { Evidence, FieldValue, TemplateField } from '../domain/types.js';
import { coerce } from './coerce.js';
import { numberOr } from '../lib/env-check.js';
import { clientIdentity, clientOptions, keyStore, type KeySource } from './api-key.js';
import { explainProblem, explainRefusedKey, problemOf } from './anthropic-errors.js';
import { locateEvidence } from './llm-verify.js';
import { quoteContradiction } from './quote-check.js';
import { estimateCost, type CostEstimate } from './pricing.js';
import {
  buildOutputSchema,
  buildSystemPrompt,
  buildUserPrompt,
  documentAlias,
  type LlmResponse,
} from './llm-schema.js';
import type { SourceDoc } from './rules.js';

/**
 * Extraction assistée par Claude.
 *
 * Complète le moteur de règles là où celui-ci atteint ses limites : le texte
 * rédigé, où l'information n'est pas introduite par un libellé.
 *
 * Deux garde-fous encadrent la sortie du modèle, parce qu'une valeur inventée
 * est plus coûteuse qu'une case vide dans un jeu de données de recherche :
 *
 *  - chaque valeur doit être accompagnée d'une citation retrouvée dans le
 *    document (`llm-verify.ts`), faute de quoi elle est rejetée ;
 *  - chaque valeur passe par le même typage que les règles (`coerce`), donc
 *    par les listes d'options et les bornes de plausibilité de la fiche.
 */

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** Modèle utilisé. Configurable, mais le défaut est le modèle recommandé. */
const model = process.env.LLM_MODEL ?? DEFAULT_MODEL;

/**
 * Profondeur de raisonnement. `high` est le défaut de l'API et le réglage
 * adapté à un travail où l'exactitude prime ; `medium` ou `low` réduisent
 * sensiblement le coût sur de grandes séries.
 */
const effort = (process.env.LLM_EFFORT ?? 'high') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Plafond de texte transmis par document, pour borner le coût d'un dossier volumineux. */
const maxCharsPerDocument = numberOr(process.env.LLM_MAX_CHARS_PER_DOC, 60_000, 1000);

/** Plafond de génération. Couvre le raisonnement, actif par défaut sur ce modèle. */
const maxTokens = numberOr(process.env.LLM_MAX_TOKENS, 16_000, 256);

/** Raison affichée quand aucune clé n'est disponible. */
export const NO_KEY_REASON =
  "Claude n'est pas activé : aucune clé d'API Anthropic. Ajoutez la vôtre dans l'application (page « Activer Claude », 5 minutes), ou renseignez ANTHROPIC_API_KEY dans l'environnement du serveur.";

let client: Anthropic | null = null;
let clientKey = '';

/** Le client de la clé active : recréé quand l'utilisateur change de clé, abandonné quand il la retire. */
function getClient(): Anthropic | null {
  const active = keyStore.active();
  if (!active) {
    client = null;
    clientKey = '';
    return null;
  }
  if (!client || clientKey !== clientIdentity(active)) {
    client = new Anthropic(clientOptions(active));
    clientKey = clientIdentity(active);
  }
  return client;
}

export interface LlmStatus {
  available: boolean;
  model: string;
  effort: string;
  reason: string | null;
  /** D'où vient la clé : saisie dans l'application, ou environnement du serveur. */
  keySource: KeySource | null;
  /** Ses quatre derniers caractères, pour la reconnaître. */
  keyHint: string | null;
}

export function llmStatus(): LlmStatus {
  const ready = getClient() !== null;
  const key = keyStore.status();
  return { available: ready, model, effort, reason: ready ? null : NO_KEY_REASON, keySource: key.source, keyHint: key.hint };
}

/** Le modèle utilisé pour l'extraction (celui que la clé doit pouvoir interroger). */
export const extractionModel = (): string => model;

/**
 * Fourchette de coût d'une passe par Claude sur ces dossiers, avant de la lancer. En mode mixte, les règles
 * trouveront une partie des variables et Claude n'aura que le reste : la fourchette est alors un plafond.
 */
export function estimateExtraction(
  fields: TemplateField[],
  templateName: string,
  patients: SourceDoc[][],
): CostEstimate | null {
  const system = buildSystemPrompt(fields, templateName);
  const charsPerPatient = patients.map((docs) =>
    docs.reduce((sum, doc) => sum + Math.min(doc.text.trim().length, maxCharsPerDocument), 0),
  );
  return estimateCost({
    model,
    charsPerPatient: charsPerPatient.filter((chars) => chars > 0),
    systemChars: system.length,
    fieldCount: fields.length,
    maxOutputTokens: maxTokens,
  });
}

/** Consommation de jetons d'une passe, pour afficher le coût à l'utilisateur. */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface LlmFieldOutcome {
  fieldId: number;
  key: string;
  value: FieldValue;
  confidence: number;
  evidence: Evidence;
}

export interface LlmExtraction {
  values: LlmFieldOutcome[];
  /** Variables laissées vides par le modèle. */
  notFound: string[];
  /** Valeurs écartées : citation introuvable dans les documents, ou qui ne dit pas ce que la valeur affirme. */
  unverified: { key: string; value: string; quote: string; reason?: string }[];
  /** Valeurs écartées parce qu'incompatibles avec le type ou les options. */
  invalid: { key: string; value: string; reason: string }[];
  usage: LlmUsage;
  /** Le modèle qui a réellement répondu : le repli côté serveur peut en désigner un autre que celui demandé. */
  model: string;
}

export class LlmError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'LlmError';
  }
}

/**
 * Relève les variables demandées dans les documents d'un patient.
 *
 * `fields` peut être un sous-ensemble de la fiche : en mode mixte, seules les
 * variables que les règles n'ont pas trouvées sont soumises au modèle. La consigne, elle, décrit toujours la fiche
 * entière (`dictionary`) : identique d'un dossier à l'autre, elle reste en cache et n'est facturée au tarif plein
 * qu'une fois par série ; la liste des variables à relever pour ce dossier passe dans le message.
 */
export async function extractWithLlm(
  fields: TemplateField[],
  docs: SourceDoc[],
  templateName: string,
  dictionary: TemplateField[] = fields,
): Promise<LlmExtraction> {
  const anthropic = getClient();
  if (!anthropic) throw new LlmError(NO_KEY_REASON, false);

  const usable = docs.filter((doc) => doc.text.trim().length > 0);
  if (fields.length === 0 || usable.length === 0) {
    return { values: [], notFound: fields.map((f) => f.key), unverified: [], invalid: [], usage: emptyUsage(), model };
  }

  // Le modèle ne voit ni le code du dossier ni les noms de fichiers : les documents lui sont présentés sous des alias.
  const subset = fields.length < dictionary.length;
  const documents = buildUserPrompt(usable.map((d, i) => ({ name: documentAlias(i), text: d.text })), maxCharsPerDocument);
  const response = await callModel(
    anthropic,
    buildSystemPrompt(dictionary, templateName),
    subset
      ? `Variables à relever pour ce dossier (les autres sont déjà renseignées) : ${fields.map((f) => f.key).join(', ')}.

${documents}`
      : documents,
    buildOutputSchema(fields),
  );

  // Sa réponse désigne les documents par leurs alias : on y remet les vrais noms avant de vérifier les citations.
  const nameOf = new Map(usable.map((d, i) => [documentAlias(i), d.name]));
  for (const finding of Object.values(response.parsed.fields)) {
    if (finding && typeof finding.document === 'string') finding.document = nameOf.get(finding.document.trim()) ?? finding.document;
  }

  return interpret(fields, usable, response.parsed, response.usage, response.model);
}

interface ModelCall {
  parsed: LlmResponse;
  usage: LlmUsage;
  model: string;
}

async function callModel(
  anthropic: Anthropic,
  system: string,
  user: string,
  schema: Record<string, unknown>,
): Promise<ModelCall> {
  const request = {
    model,
    max_tokens: maxTokens,
    // La consigne et le dictionnaire des variables sont identiques d'un
    // dossier à l'autre : mis en cache, ils ne sont facturés au tarif plein
    // qu'une fois par série.
    system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
    messages: [{ role: 'user' as const, content: user }],
    output_config: { format: { type: 'json_schema' as const, schema }, effort },
  };

  // Les classificateurs de sûreté peuvent décliner une requête ; le repli
  // côté serveur relance alors sur un autre modèle dans le même appel.
  // Le paramètre est refusé sur certaines plateformes : en cas de rejet
  // explicite, on réessaie sans, plutôt que de faire échouer l'extraction.
  let message: Anthropic.Beta.Messages.BetaMessage;
  try {
    message = await anthropic.beta.messages.create({
      ...request,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    } as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming);
  } catch (error) {
    if (!mentionsFallback(error)) throw toLlmError(error);
    try {
      message = await anthropic.beta.messages.create(
        request as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming,
      );
    } catch (retryError) {
      throw toLlmError(retryError);
    }
  }

  if (message.stop_reason === 'refusal') {
    throw new LlmError(
      'La requête a été déclinée par les classificateurs de sûreté du modèle.',
      false,
    );
  }
  if (message.stop_reason === 'max_tokens') {
    throw new LlmError(
      `Réponse tronquée : augmentez LLM_MAX_TOKENS (actuellement ${maxTokens}).`,
      false,
    );
  }

  const text = message.content
    .filter((block): block is Anthropic.Beta.Messages.BetaTextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  let parsed: LlmResponse;
  try {
    parsed = JSON.parse(text) as LlmResponse;
  } catch {
    throw new LlmError('Réponse du modèle illisible (JSON invalide).', true);
  }
  if (!parsed || typeof parsed.fields !== 'object' || parsed.fields === null) {
    throw new LlmError('Réponse du modèle inattendue : champ « fields » absent.', true);
  }

  return {
    parsed,
    model: typeof message.model === 'string' && message.model.length > 0 ? message.model : model,
    usage: {
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
    },
  };
}

/** Le rejet porte-t-il sur le paramètre de repli plutôt que sur la requête elle-même ? */
function mentionsFallback(error: unknown): boolean {
  if (!(error instanceof Anthropic.APIError) || error.status !== 400) return false;
  return /fallback|beta/i.test(error.message);
}

function toLlmError(error: unknown): LlmError {
  // Crédit, limite de dépenses, plafond mensuel, espace de travail : à l'utilisateur d'agir, réessayer n'y change rien.
  const problem = problemOf(error);
  if (problem) return new LlmError(explainProblem(problem, keyStore.active()?.source ?? null), false);
  if (error instanceof Anthropic.RateLimitError) {
    return new LlmError('Limite de débit atteinte. Relancez l’extraction dans un instant.', true);
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new LlmError(explainRefusedKey(keyStore.active()?.source ?? null), false);
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new LlmError(`Accès refusé au modèle « ${model} » pour cette clé.`, false);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new LlmError(`Modèle « ${model} » introuvable. Vérifiez LLM_MODEL.`, false);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new LlmError('Connexion à l’API impossible.', true);
  }
  if (error instanceof Anthropic.APIError) {
    return new LlmError(`Erreur API ${error.status ?? ''} : ${withoutKey(error.message)}`, (error.status ?? 0) >= 500);
  }
  return new LlmError(withoutKey(error instanceof Error ? error.message : String(error)), false);
}

/** Un message d'erreur qui répéterait la clé d'API (passerelle, mandataire) ne la fait pas parvenir à l'interface. */
function withoutKey(message: string): string {
  return keyStore.redact(message);
}

/**
 * Confronte la réponse du modèle aux documents et au type de chaque variable.
 * Tout ce qui ne passe pas les deux contrôles est écarté et comptabilisé.
 */
export function interpret(
  fields: TemplateField[],
  docs: SourceDoc[],
  response: LlmResponse,
  usage: LlmUsage,
  servedModel: string = model,
): LlmExtraction {
  const values: LlmFieldOutcome[] = [];
  const notFound: string[] = [];
  const unverified: LlmExtraction['unverified'] = [];
  const invalid: LlmExtraction['invalid'] = [];

  for (const field of fields) {
    const finding = response.fields[field.key];
    const raw = (finding?.value ?? '').trim();

    if (raw.length === 0) {
      notFound.push(field.key);
      continue;
    }

    const typed = coerce(raw, field.type, field.options, field.extraction.postProcess, field.unit);
    if (!typed.ok) {
      invalid.push({ key: field.key, value: raw, reason: typed.reason });
      continue;
    }

    const located = locateEvidence(docs, finding?.quote ?? '', raw, finding?.document ?? '');
    if (!located) {
      unverified.push({ key: field.key, value: raw, quote: finding?.quote ?? '' });
      continue;
    }

    // La citation existe ; encore faut-il qu'elle dise ce que la valeur affirme (« Pas de diabète » ne justifie
    // pas « diabète : oui », « CRP 45 » ne justifie pas 180).
    const contradiction = located.method === 'quote' ? quoteContradiction(typed.value, field.type, finding?.quote ?? '') : null;
    if (contradiction) {
      unverified.push({ key: field.key, value: raw, quote: finding?.quote ?? '', reason: contradiction });
      continue;
    }

    // Une citation retrouvée telle quelle est plus fiable que la seule
    // localisation de la valeur : la confiance affichée le reflète.
    values.push({
      fieldId: field.id,
      key: field.key,
      value: typed.value,
      confidence: located.method === 'quote' ? 0.9 : 0.75,
      evidence: {
        documentId: located.documentId,
        documentName: located.documentName,
        snippet: located.snippet,
        start: located.start,
        end: located.end,
        rule: `Claude (${servedModel})`,
      },
    });
  }

  return { values, notFound, unverified, invalid, usage, model: servedModel };
}

function emptyUsage(): LlmUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}
