import Anthropic from '@anthropic-ai/sdk';
import type { KeySource } from './api-key.js';

/**
 * Les refus d'Anthropic que l'utilisateur peut lever lui-même, traduits en une phrase qui dit quoi faire.
 *
 * Chacun paie l'IA avec sa propre clé : quand le crédit s'épuise, qu'une limite de dépenses est atteinte ou que la clé
 * expire, c'est à lui d'agir, dans la console d'Anthropic. Le message brut de l'API (en anglais, avec du JSON) ne le
 * lui dirait pas.
 */

export type AnthropicProblem = 'credit' | 'spend-limit' | 'monthly-cap' | 'workspace';

/** Reconnaît, d'après le statut et le message d'Anthropic, un refus que l'utilisateur peut corriger. */
export function problemOf(error: unknown): AnthropicProblem | null {
  if (!(error instanceof Anthropic.APIError)) return null;
  const text = error.message;
  // Plafond mensuel du palier du compte : 429 comme une limite de débit, mais réessayer n'y change rien.
  if (error.status === 429 && /enforced_spend_limit_reached|monthly API usage threshold/i.test(text)) return 'monthly-cap';
  if (error.status !== 400) return null;
  if (/credit balance/i.test(text)) return 'credit';
  if (/reached your specified (workspace )?API usage limits/i.test(text)) return 'spend-limit';
  // Une clé qui vaut pour plusieurs espaces de travail doit nommer le sien à chaque requête.
  if (/anthropic-workspace-id/i.test(text)) return 'workspace';
  return null;
}

/** La phrase à montrer, selon le refus et la provenance de la clé (saisie dans l'application ou environnement). */
export function explainProblem(problem: AnthropicProblem, source: KeySource | null): string {
  switch (problem) {
    case 'credit':
      return 'Crédit épuisé sur votre compte Anthropic : ajoutez du crédit dans la console d’Anthropic (Billing), puis relancez.';
    case 'spend-limit':
      return 'Vous avez atteint la limite de dépenses fixée sur votre compte Anthropic : relevez-la dans la console d’Anthropic (Billing › Spend limits), ou attendez la date de reprise qu’indique Anthropic, puis relancez.';
    case 'monthly-cap':
      return 'Votre compte Anthropic a atteint son plafond mensuel : l’usage reprend le 1er du mois prochain, ou plus tôt si Anthropic relève votre palier (console d’Anthropic › Limits).';
    case 'workspace':
      return source === 'env'
        ? 'La clé ANTHROPIC_API_KEY vaut pour plusieurs espaces de travail d’Anthropic : renseignez aussi ANTHROPIC_WORKSPACE_ID, ou employez une clé liée à un seul espace de travail.'
        : 'Cette clé vaut pour plusieurs espaces de travail d’Anthropic : enregistrez-la de nouveau (page « Activer Claude ») pour que l’outil choisisse le bon, ou créez une clé liée à un seul espace de travail.';
  }
}

/** Clé refusée en cours d'usage : expirée, désactivée ou supprimée. */
export function explainRefusedKey(source: KeySource | null): string {
  return source === 'env'
    ? 'Clé API refusée. Vérifiez ANTHROPIC_API_KEY.'
    : 'Anthropic refuse votre clé d’API : elle a expiré, ou a été désactivée ou supprimée. Créez-en une nouvelle dans la console d’Anthropic et enregistrez-la (page « Activer Claude »).';
}
