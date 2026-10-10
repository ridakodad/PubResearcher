import Anthropic from '@anthropic-ai/sdk';
import type { TemplateWithFields } from '../domain/types.js';
import type { FieldStats } from '../routes/analytics.js';
import { numberOr } from '../lib/env-check.js';
import { redactSecret } from '../lib/redact.js';

/**
 * Assistant de rédaction scientifique.
 *
 * Discuter des résultats d'une cohorte et en tirer un texte publiable demande
 * deux choses que le tableau seul ne donne pas : savoir quels chiffres méritent
 * d'être rapportés, et savoir comment un journal attend qu'ils le soient.
 *
 * Deux partis pris encadrent cet assistant.
 *
 * Le premier tient à ce qu'on lui transmet : **des agrégats, jamais les
 * dossiers**. Il reçoit les effectifs, les distributions et le dictionnaire des
 * variables — de quoi rédiger une section « Résultats » — mais aucune ligne
 * patient ne quitte la machine pour cet usage. Écrire un article n'exige pas de
 * connaître les individus.
 *
 * Le second tient à ce qu'on lui interdit : inventer un chiffre. Un modèle qui
 * comble un trou par une valeur vraisemblable produit un article faux, et le
 * relecteur n'a aucun moyen de s'en apercevoir. La consigne lui impose de
 * n'employer que les chiffres fournis et de signaler ce qui manque.
 */

export const DEFAULT_CHAT_MODEL = 'claude-opus-5';

const model = process.env.LLM_MODEL ?? DEFAULT_CHAT_MODEL;
const maxTokens = numberOr(process.env.CHAT_MAX_TOKENS, 8_000, 256);

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (client) return client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  client = new Anthropic();
  return client;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface CohortContext {
  template: TemplateWithFields;
  patientCount: number;
  completeness: number;
  stats: FieldStats[];
}

/**
 * Décrit la cohorte au modèle, en texte compact.
 *
 * Le format est stable d'un tour à l'autre : placé en tête de la consigne
 * système avec mise en cache, il n'est facturé au tarif plein qu'une fois par
 * conversation, quel que soit le nombre d'échanges.
 */
export function buildCohortBrief(context: CohortContext): string {
  const { template, patientCount, completeness, stats } = context;
  const lignes: string[] = [
    `Étude : « ${template.name} »`,
    template.description ? `Objet : ${template.description}` : '',
    `Effectif : ${patientCount} dossiers`,
    `Complétude globale du recueil : ${completeness} %`,
    '',
    'VARIABLES ET RÉSULTATS',
  ].filter(Boolean);

  for (const stat of stats) {
    const unite = stat.unit ? ` (${stat.unit})` : '';
    const manquants = stat.missing > 0 ? `, ${stat.missing} manquantes` : '';
    const entete = `- ${stat.label}${unite} [${stat.section}] — n = ${stat.n}${manquants}`;

    if (stat.chart === 'histogram') {
      const s = stat.summary;
      lignes.push(
        s
          ? `${entete} ; moyenne ${round(s.mean)} ± ${round(s.sd)}, médiane ${round(s.median)} ` +
            `[${round(s.q1)} – ${round(s.q3)}], extrêmes ${round(s.min)} – ${round(s.max)}`
          : entete,
      );
    } else if (stat.chart === 'categories') {
      const parts = stat.categories
        .map((c) => {
          const pct = stat.n > 0 ? Math.round((c.count / stat.n) * 100) : 0;
          return `${c.label} ${c.count} (${pct} %)`;
        })
        .join(' ; ');
      lignes.push(parts ? `${entete} ; ${parts}` : entete);

      // Une modalité prévue mais jamais rencontrée se rapporte : elle dit
      // quelque chose de la cohorte, et son absence du tableau pourrait
      // passer pour un oubli de recueil.
      const declarees = template.fields.find((f) => f.key === stat.key)?.options ?? [];
      const absentes = declarees.filter(
        (option) => !stat.categories.some((c) => c.label === option),
      );
      if (absentes.length > 0) {
        lignes.push(`    modalités déclarées jamais observées : ${absentes.join(', ')}`);
      }
    } else {
      // Texte libre (et tout type sans distribution) : ses valeurs sont celles des dossiers — numéros, antécédents en
      // clair — et ne quittent pas la machine. Le modèle ne reçoit que les effectifs.
      lignes.push(`${entete} ; texte libre, valeurs non transmises`);
    }
  }

  const definitions = template.fields.filter((f) => f.description);
  if (definitions.length > 0) {
    lignes.push('', 'DÉFINITIONS DES VARIABLES');
    for (const field of definitions) {
      lignes.push(`- ${field.label} : ${field.description}`);
    }
  }

  return lignes.join('\n');
}

function round(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '');
}

export function buildSystemPrompt(brief: string): string {
  return `Tu assistes un chercheur clinicien dans l'exploitation d'une cohorte et la rédaction d'un article scientifique. Tu réponds en français, sauf demande contraire.

RÈGLES ABSOLUES SUR LES CHIFFRES

1. Tu n'emploies que les chiffres présents dans le relevé ci-dessous. Tu n'en inventes aucun, tu n'en extrapoles aucun, tu n'en arrondis aucun au-delà de ce qui est fourni.
2. Si une donnée manque pour répondre, tu le dis explicitement et tu indiques quelle variable il faudrait recueillir. Tu ne combles jamais un trou par une valeur vraisemblable : un article faux est plus coûteux qu'un article incomplet, et le relecteur n'a aucun moyen de s'en apercevoir.
3. Tu ne calcules aucun test statistique dont les données brutes ne te sont pas données. Les comparaisons entre sous-groupes, les p, les intervalles de confiance et les modèles multivariés exigent les données individuelles, que tu n'as pas. Tu peux dire quel test conviendrait et pourquoi ; tu ne peux pas en donner le résultat.
4. Tu signales spontanément ce qui fragilise une interprétation : effectif faible, forte proportion de données manquantes, modalité jamais observée, biais de sélection propre à un recueil rétrospectif.

RÉDACTION

Tu suis les usages internationaux de la publication médicale : structure IMRaD, et pour une étude observationnelle les rubriques attendues par la déclaration STROBE — population et critères d'éligibilité, sources de données, variables et leur définition, gestion des données manquantes, effectifs à chaque étape.

Tu écris comme un article, pas comme un rapport : phrases complètes, temps du passé pour les résultats, pas de liste à puces dans les sections rédigées. Les effectifs s'écrivent « n (%) », les quantitatives « moyenne ± écart-type » ou « médiane [Q1 – Q3] » selon la distribution, et tu choisis la forme en le justifiant brièvement quand ce n'est pas évident.

Tu ne rédiges pas de discussion affirmant une causalité à partir d'un recueil rétrospectif. Tu ne cites aucune référence bibliographique : tu n'as pas accès à la littérature et une référence inventée est une faute grave.

RELEVÉ DE LA COHORTE

${brief}`;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export class ChatError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'ChatError';
  }
}

export function chatAvailable(): boolean {
  return getClient() !== null;
}

/**
 * Diffuse la réponse au fil de sa production.
 *
 * Une section « Résultats » fait plusieurs milliers de caractères : attendre
 * la réponse entière donnerait une impression de blocage, et une requête
 * longue s'expose à expirer. Le texte est donc transmis par fragments.
 */
export async function streamReply(
  context: CohortContext,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
): Promise<ChatUsage> {
  const anthropic = getClient();
  if (!anthropic) {
    throw new ChatError(
      "Aucune clé API. Renseignez ANTHROPIC_API_KEY dans l'environnement du serveur.",
      false,
    );
  }
  if (messages.length === 0) throw new ChatError('Aucun message à traiter.', false);

  const system = buildSystemPrompt(buildCohortBrief(context));

  try {
    const stream = anthropic.messages.stream({
      model,
      max_tokens: maxTokens,
      // Le relevé de cohorte est identique à chaque tour : mis en cache, il
      // n'est facturé au tarif plein qu'une fois par conversation.
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      // Choisir la forme d'un résultat, repérer ce qui fragilise une
      // interprétation : c'est du raisonnement, pas de la reformulation.
      thinking: { type: 'adaptive' },
    } as unknown as Anthropic.MessageStreamParams);

    stream.on('text', (text) => onChunk(text));
    const final = await stream.finalMessage();

    if (final.stop_reason === 'refusal') {
      throw new ChatError(
        'La requête a été déclinée par les classificateurs de sûreté du modèle.',
        false,
      );
    }

    return {
      inputTokens: final.usage.input_tokens ?? 0,
      outputTokens: final.usage.output_tokens ?? 0,
      cacheReadTokens: final.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: final.usage.cache_creation_input_tokens ?? 0,
    };
  } catch (error) {
    if (error instanceof ChatError) throw error;
    throw toChatError(error);
  }
}

function toChatError(error: unknown): ChatError {
  if (error instanceof Anthropic.RateLimitError) {
    return new ChatError('Limite de débit atteinte. Réessayez dans un instant.', true);
  }
  if (error instanceof Anthropic.AuthenticationError) {
    return new ChatError('Clé API refusée. Vérifiez ANTHROPIC_API_KEY.', false);
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new ChatError(`Accès refusé au modèle « ${model} » pour cette clé.`, false);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new ChatError(`Modèle « ${model} » introuvable. Vérifiez LLM_MODEL.`, false);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ChatError("Connexion à l'API impossible.", true);
  }
  if (error instanceof Anthropic.APIError) {
    return new ChatError(
      `Erreur API ${error.status ?? ''} : ${withoutKey(error.message)}`,
      (error.status ?? 0) >= 500,
    );
  }
  return new ChatError(withoutKey(error instanceof Error ? error.message : String(error)), false);
}

/** Un message d'erreur qui répéterait la clé d'API (passerelle, mandataire) ne la fait pas parvenir à l'interface. */
function withoutKey(message: string): string {
  return redactSecret(message, process.env.ANTHROPIC_API_KEY ?? '', '[clé masquée]');
}
