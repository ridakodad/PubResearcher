/**
 * Contrôle des réglages de l'environnement, au démarrage.
 *
 * Un plafond mal écrit (`PDF_MAX_PAGES=abc`, `LLM_MAX_CHARS_PER_DOC=60 000`) ne doit pas se changer en silence en
 * « valeur par défaut » — ou, pire, en `NaN`, qui désactive la protection qu'il réglait (une longueur n'est jamais
 * supérieure à `NaN` : plus aucune troncature du texte transmis à Anthropic). Chaque réglage numérique est donc
 * vérifié avant que quoi que ce soit ne démarre, tous les défauts d'un coup, avec un message qui dit lequel et pourquoi.
 *
 * Les lecteurs de chaque réglage (`extract/limits.ts`, `engine/llm.ts`…) gardent leur repli sur le défaut : ils
 * servent aux tests et aux réglages posés après le démarrage. Au démarrage, ils ne rencontrent plus que des valeurs
 * déjà vérifiées ici.
 */

export interface NumericSetting {
  min: number;
  max: number;
  /** Accepte une partie décimale (`OCR_PDF_SCALE=2.5`). Sinon, des chiffres seulement. */
  decimals?: boolean;
}

const GB = 1024 ** 3;

/** Les réglages numériques de l'outil, avec leurs bornes (voir le guide de l'administrateur, § 4). */
export const NUMERIC_SETTINGS = {
  PORT: { min: 1, max: 65_535 },
  MAX_UPLOAD_BYTES: { min: 1024, max: 100 * GB },
  MAX_REQUEST_BYTES: { min: 1024, max: 1024 * GB },
  MAX_TEXT_CHARS: { min: 1, max: 500_000_000 },
  PDF_MAX_PAGES: { min: 1, max: 1_000_000 },
  PDF_PARSE_TIMEOUT_MS: { min: 1000, max: 86_400_000 },
  DOCX_MAX_XML_MB: { min: 1, max: 100_000 },
  DOCX_MAX_TOTAL_MB: { min: 1, max: 1_000_000 },
  IMAGE_MAX_MEGAPIXELS: { min: 1, max: 10_000 },
  PARSE_CONCURRENCY: { min: 1, max: 64 },
  PARSE_HARD_TIMEOUT_MS: { min: 1000, max: 86_400_000 },
  PARSE_WORKER_MB: { min: 128, max: 1_048_576 },
  PARSE_MAX_GROWTH_MB: { min: 64, max: 1_048_576 },
  REGEX_BUDGET_MS: { min: 10, max: 60_000 },
  OCR_MAX_PAGES: { min: 0, max: 100_000 },
  OCR_PDF_SCALE: { min: 1, max: 4, decimals: true },
  LLM_MAX_CHARS_PER_DOC: { min: 1000, max: 10_000_000 },
  LLM_MAX_TOKENS: { min: 256, max: 1_000_000 },
  CHAT_MAX_TOKENS: { min: 256, max: 1_000_000 },
  BIBLIO_MAX_RESULTS: { min: 1, max: 10_000 },
  APIFY_TIMEOUT_MS: { min: 1000, max: 3_600_000 },
} as const satisfies Record<string, NumericSetting>;

/** Réglages qui n'acceptent qu'une liste de valeurs. */
export const CHOICE_SETTINGS = {
  LLM_EFFORT: ['low', 'medium', 'high', 'xhigh', 'max'],
} as const satisfies Record<string, readonly string[]>;

/**
 * Lit un nombre dans l'environnement. Une valeur absente ou vide donne le défaut ; une valeur qui n'est pas un
 * nombre dans les bornes lève une erreur qui dit laquelle et pourquoi.
 */
export function readNumericEnv(name: string, raw: string | undefined, fallback: number, setting: NumericSetting): number {
  const text = raw?.trim();
  if (text === undefined || text === '') return fallback;
  // Chiffres décimaux seulement : `Number('0x1F90')` et `Number('1e3')` donneraient des valeurs que personne n'a voulu écrire.
  const plain = setting.decimals ? /^-?\d+(\.\d+)?$/ : /^-?\d+$/;
  const n = plain.test(text) ? Number(text) : Number.NaN;
  const whole = setting.decimals ? Number.isFinite(n) : Number.isSafeInteger(n);
  if (!whole || n < setting.min || n > setting.max) {
    const kind = setting.decimals ? 'un nombre' : 'un entier';
    throw new Error(`${name}=« ${text} » n'est pas valide : ${kind} entre ${setting.min} et ${setting.max} est attendu.`);
  }
  return n;
}

/** Lit un entier dans l'environnement, avec ses bornes en paramètres (voir `readNumericEnv`). */
export function readIntEnv(name: string, raw: string | undefined, fallback: number, min: number, max: number): number {
  return readNumericEnv(name, raw, fallback, { min, max });
}

/**
 * Lecture tolérante, pour les modules qui lisent leur réglage eux-mêmes : une valeur absente, non numérique ou sous
 * le minimum donne le défaut — jamais `NaN`, qui rend faux toute comparaison (`longueur > NaN`) et désactive le plafond.
 * Au démarrage, `environmentProblems` a déjà refusé ces valeurs ; ceci couvre les tests et les réglages posés après coup.
 */
export function numberOr(raw: string | undefined, fallback: number, min = 1): number {
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

/** Tous les réglages invalides de l'environnement, un message par réglage. Vide : tout est valide. */
export function environmentProblems(env: Record<string, string | undefined> = process.env): string[] {
  const problems: string[] = [];
  for (const [name, setting] of Object.entries(NUMERIC_SETTINGS) as [string, NumericSetting][]) {
    try {
      readNumericEnv(name, env[name], 0, setting);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const [name, allowed] of Object.entries(CHOICE_SETTINGS) as [string, readonly string[]][]) {
    const text = env[name]?.trim();
    if (text && !allowed.includes(text)) {
      problems.push(`${name}=« ${text} » n'est pas valide : ${allowed.map((v) => `« ${v} »`).join(', ')} sont attendus.`);
    }
  }
  return problems;
}
