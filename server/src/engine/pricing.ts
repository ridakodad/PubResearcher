/**
 * Ce que coûte une passe par Claude, en dollars, sur le compte Anthropic de l'utilisateur.
 *
 * Tarifs publics de l'API Anthropic (octobre 2026), en dollars par million de jetons. Le raisonnement du modèle est
 * facturé comme de la sortie. La lecture du cache coûte une fraction de l'entrée ; l'écriture, 1,25 fois l'entrée (durée
 * de cinq minutes, celle qu'emploie l'outil). Un modèle absent de la table n'a pas de prix : l'interface affiche alors les
 * jetons seuls, sans inventer de montant.
 *
 * Ces montants sont indicatifs : la facture qui fait foi est celle de la console d'Anthropic.
 */

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const price = (input: number, output: number, cacheRead = input / 10): ModelPrice => ({
  input,
  output,
  cacheRead,
  cacheWrite: input * 1.25,
});

export const PRICES: Readonly<Record<string, ModelPrice>> = {
  'claude-opus-5-5': price(4, 20, 0.2),
  'claude-opus-5': price(5, 25),
  'claude-sonnet-5-5': price(2, 10, 0.2),
  'claude-sonnet-5': price(2, 10),
  // Tarif des requêtes de moins de 100 000 jetons, le cas d'un dossier.
  'claude-haiku-5-5': price(0.1, 0.5),
  'claude-fable-5-1': price(10, 50, 0.25),
};

/** Un modèle local (`ollama:…`) ne coûte rien : les estimations et les coûts affichés valent 0. */
export const LOCAL_PRICE: ModelPrice = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
}

/**
 * Tarif d'un modèle. Le modèle qui répond peut porter un identifiant daté (`claude-opus-5-5-20260601`) :
 * il prend alors le tarif de l'identifiant le plus long dont il est la déclinaison.
 */
export function priceOf(model: string): ModelPrice | null {
  // Modèle ouvert servi par Ollama sur ce poste : rien n'est facturé.
  if (model.startsWith('ollama:')) return LOCAL_PRICE;
  if (PRICES[model]) return PRICES[model]!;
  const base = Object.keys(PRICES)
    .filter((id) => model.startsWith(`${id}-`))
    .sort((a, b) => b.length - a.length)[0];
  return base ? PRICES[base]! : null;
}

const usd = (tokens: number, perMillion: number): number => (tokens * perMillion) / 1_000_000;

/** Coût d'une consommation donnée, en dollars, ou `null` si le tarif du modèle est inconnu. */
export function costOf(model: string | null, usage: TokenUsage | null | undefined): number | null {
  if (!model || !usage) return null;
  const p = priceOf(model);
  if (!p) return null;
  const total =
    usd(usage.inputTokens, p.input) +
    usd(usage.outputTokens, p.output) +
    usd(usage.cacheReadTokens, p.cacheRead) +
    usd(usage.cacheWriteTokens ?? 0, p.cacheWrite);
  return Math.round(total * 10_000) / 10_000;
}

/** Caractères par jeton pour du français médical : une estimation prudente (on compte plutôt trop que pas assez). */
export const CHARS_PER_TOKEN = 3.2;

export interface CostEstimate {
  model: string;
  patients: number;
  /** Fourchette en dollars : la longueur du raisonnement du modèle ne se prévoit pas. */
  low: number;
  high: number;
  inputTokens: number;
}

export interface EstimateInput {
  model: string;
  /** Nombre de caractères envoyés pour chaque dossier (documents déjà plafonnés). */
  charsPerPatient: number[];
  /** Taille de la consigne et du dictionnaire des variables, communs à tous les dossiers (mis en cache). */
  systemChars: number;
  /** Nombre de variables demandées. */
  fieldCount: number;
  /** Plafond de génération par dossier. */
  maxOutputTokens: number;
}

/**
 * Fourchette de coût d'une passe, avant de la lancer.
 *
 * - Entrée : le texte de chaque dossier, plus la consigne — écrite au cache au premier dossier, lue ensuite.
 * - Sortie, bas de fourchette : une ligne par variable. Haut : une ligne plus riche par variable et un raisonnement
 *   soutenu, sans dépasser le plafond de génération.
 */
export function estimateCost(input: EstimateInput): CostEstimate | null {
  const p = priceOf(input.model);
  if (!p) return null;
  const patients = input.charsPerPatient.length;
  const systemTokens = Math.ceil(input.systemChars / CHARS_PER_TOKEN);
  const textTokens = input.charsPerPatient.reduce((sum, chars) => sum + Math.ceil(chars / CHARS_PER_TOKEN), 0);
  const outLow = Math.min(input.maxOutputTokens, 40 * input.fieldCount + 300);
  const outHigh = Math.min(input.maxOutputTokens, 90 * input.fieldCount + 4_000);
  const fixed =
    patients === 0 ? 0 : usd(systemTokens, p.cacheWrite) + usd(systemTokens * (patients - 1), p.cacheRead) + usd(textTokens, p.input);
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    model: input.model,
    patients,
    low: round(fixed + usd(outLow * patients, p.output)),
    high: round(fixed + usd(outHigh * patients, p.output)),
    inputTokens: textTokens + systemTokens * patients,
  };
}
