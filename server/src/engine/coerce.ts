import type { FieldType, FieldValue, FieldPostProcess } from '../domain/types.js';
import { findTerm, fold } from './fold.js';
import { describeStatus, qualifyAnswer } from './qualifiers.js';

/**
 * `conflict` : la valeur écrite en contient plusieurs (« favorable puis décès ») — ce n'est pas une valeur
 * illisible qu'une règle de repli pourrait remplacer, c'est un choix qui revient au relecteur.
 */
export type CoerceResult =
  | { ok: true; value: FieldValue }
  | { ok: false; reason: string; conflict?: boolean };

const MONTHS_FR: Record<string, number> = {
  janvier: 1, janv: 1, jan: 1,
  fevrier: 2, fevr: 2, fev: 2,
  mars: 3, mar: 3,
  avril: 4, avr: 4,
  mai: 5,
  juin: 6,
  juillet: 7, juil: 7, jul: 7,
  aout: 8, aou: 8,
  septembre: 9, sept: 9, sep: 9,
  octobre: 10, oct: 10,
  novembre: 11, nov: 11,
  decembre: 12, dec: 12,
};

const TRUE_WORDS = new Set([
  'oui', 'yes', 'true', 'vrai', '1', '+', 'positif', 'positive', 'present',
  'presente', 'presents', 'presentes', 'o', 'y', 'x',
]);
const FALSE_WORDS = new Set([
  'non', 'no', 'false', 'faux', '0', '-', 'negatif', 'negative', 'absent',
  'absente', 'absents', 'absentes', 'n', 'nil', 'neant',
]);

/** Sépare une valeur multi-choix : virgule, point-virgule, barre, saut de ligne, «+». */
const MULTI_SPLIT_BASE = /[;,/\n|]+|\s+\+\s+/;
/** Idem, avec les liaisons de la langue (« scanner et IRM »). */
const MULTI_SPLIT = /[;,/\n|]+|\s+\+\s+|\s+(?:et|ou|puis|avec)\s+/;
/** Un fragment qui commence par une négation ne désigne aucune option (« pas de diabète »). */
const PART_NEGATION =
  /^(?:pas d(?:e|u|es)?|absence d(?:e|u|es)?|sans|aucun|aucune|non|ni|jamais|nie)(?:[\s'’‘ʼ´`]|$)/;

function cleanText(raw: string): string {
  return raw
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    // Ponctuation en tête de capture (« : 54 », « = 54 », « - 54 »)…
    .replace(/^[\s:;=.]+/, '')
    // …y compris les tirets, sauf un signe moins collé à un chiffre : « -3,2 » est un nombre
    // négatif, pas une puce. Le retirer ferait de « Excès de base : -3,2 » une valeur positive.
    .replace(/^[-–—\u2212]+(?!\d)/, '')
    .replace(/^[\s:;=.]+/, '')
    // Ponctuation résiduelle en fin de capture (« Âge : 54 ans. » -> « 54 ans »).
    .replace(/[\s:;.,\-–—]+$/, '')
    .trim();
}

/**
 * Extrait le premier nombre d'une chaîne en gérant la virgule décimale
 * française et les espaces de milliers. « 12,5 g/dL » -> 12.5
 */
export function parseNumber(raw: string): number | null {
  // Le signe moins typographique (U+2212) des PDF est un « - » pour la lecture ; les espaces insécables
  // (U+00A0), fines insécables (U+202F) et fines (U+2009) sont des espaces.
  const s = raw.replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/\u2212/g, '-');
  const m =
    // 1.200,5 : point de milliers et virgule décimale (usage français), sans ambiguïté.
    // 1,200.5 : virgule de milliers et point décimal (usage anglais), sans ambiguïté.
    // 12 500,5 : espace de milliers. Puis le nombre simple.
    // « 1.200 » seul reste lu 1,2 : trois chiffres après un point peuvent être des milliers ou des décimales,
    // et le contexte seul ne le dit pas.
    /-?\d{1,3}(?:\.\d{3})+,\d+|-?\d{1,3}(?:,\d{3})+\.\d+|-?\d{1,3}(?: \d{3})+(?:[.,]\d+)?|-?\d+(?:[.,]\d+)?/.exec(s);
  if (!m) return null;
  let text = m[0];
  if (/^-?\d{1,3}(?:\.\d{3})+,\d+$/.test(text)) text = text.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(?:,\d{3})+\.\d+$/.test(text)) text = text.replace(/,/g, '');
  else text = text.replace(/ /g, '').replace(',', '.');
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function buildDate(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  // Rejette les dates qui « débordent » (31/02 par exemple).
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return `${y}-${pad2(m)}-${pad2(d)}`;
}

function expandYear(yy: number): number {
  if (yy >= 100) return yy;
  const pivot = new Date().getUTCFullYear() % 100;
  return yy <= pivot ? 2000 + yy : 1900 + yy;
}

/** Convertit une date écrite sous les formes usuelles en ISO `YYYY-MM-DD`. */
export function parseDate(raw: string): string | null {
  const s = fold(cleanText(raw));

  // YYYY-MM-DD / YYYY/MM/DD
  let m = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return buildDate(Number(m[1]), Number(m[2]), Number(m[3]));

  // DD/MM/YYYY, DD-MM-YY, DD.MM.YYYY (convention francophone : jour en premier)
  m = /(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) return buildDate(expandYear(Number(m[3])), Number(m[2]), Number(m[1]));

  // 12 mars 2021
  m = /(\d{1,2})\s*(?:er)?\s+([a-z]+)\.?\s+(\d{4})/.exec(s);
  if (m) {
    const month = MONTHS_FR[m[2]!];
    if (month) return buildDate(Number(m[3]), month, Number(m[1]));
  }

  // mars 2021 -> premier du mois
  m = /^([a-z]+)\.?\s+(\d{4})$/.exec(s);
  if (m) {
    const month = MONTHS_FR[m[1]!];
    if (month) return buildDate(Number(m[2]), month, 1);
  }

  // YYYYMMDD (format DICOM DA)
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(s.replace(/\s/g, ''));
  if (m) return buildDate(Number(m[1]), Number(m[2]), Number(m[3]));

  return null;
}

/** Interprète une valeur booléenne écrite en clair. */
/**
 * « non » suivi d'un qualificatif qui décrit la maladie PRÉSENTE — « non
 * insulinodépendant », « non équilibré », « non traitée », « non contrôlée » —
 * ne répond pas « non » à la question posée. Seuls « non » seul, ou suivi d'une
 * mention d'absence de renseignement (« non retrouvé », « non noté »), valent
 * négation.
 */
const NON_AVEC_QUALIFICATIF =
  /^non[\s,.;:(]*(?!$|retrouv|note|connu|documente|precis|renseign|mentionn|signal|rapport|decel|observ|constat|evoque|objective|existant|present)\S/;

export function parseBoolean(raw: string): boolean | null {
  const s = fold(cleanText(raw));
  if (s.length === 0) return null;
  // « non renseigné », « NR », « ? », « probable », « éliminé », « sevré » : la lecture mot à mot se tromperait
  // (« non renseigné » commence par « non »). Ces réponses sont qualifiées d'abord.
  const qualified = qualifyAnswer(s);
  if (qualified === 'ruled-out') return false;
  if (qualified !== null) return null;
  // Notations de carnet : « (+) » et « (-) ».
  if (/^\(\s*\+\s*\)/.test(s)) return true;
  if (/^\(\s*[-\u2013\u2212]\s*\)/.test(s)) return false;
  if (TRUE_WORDS.has(s)) return true;
  if (FALSE_WORDS.has(s)) return false;
  if (NON_AVEC_QUALIFICATIF.test(s)) return null;
  // Formulations négatives fréquentes dans les comptes rendus. Pas de `\b`
  // final : « absence de » enchaîne deux caractères de mot, la frontière
  // n'existe pas et la négation serait manquée.
  if (/^(pas d|absence d|aucun|sans|jamais|nie |non )/.test(s)) return false;
  if (/^(presence d|notion d|oui )/.test(s)) return true;
  // Premier mot seul (« oui, depuis 3 ans »).
  const first = s.split(/[\s,;]/)[0] ?? '';
  if (TRUE_WORDS.has(first)) return true;
  if (FALSE_WORDS.has(first)) return false;
  return null;
}

/** Rapproche un texte libre d'une option de la liste (comparaison repliée). */
function matchOption(raw: string, options: string[]): string | null {
  const s = fold(cleanText(raw));
  if (s.length === 0) return null;
  for (const opt of options) {
    if (fold(opt) === s) return opt;
  }
  // Correspondance partielle : l'option est citée dans le texte capturé.
  for (const opt of options) {
    const f = fold(opt);
    if (f.length >= 3 && s.includes(f)) return opt;
  }
  return null;
}

/**
 * Toutes les options citées dans un fragment, mots entiers, la plus longue d'abord.
 *
 * « scanner IRM » donne les deux ; « diabète gestationnel » donne l'option
 * « Diabète gestationnel » et non en plus « Diabète », qu'elle contient.
 */
function matchAllOptions(raw: string, options: string[]): string[] {
  const s = fold(cleanText(raw));
  if (s.length === 0 || PART_NEGATION.test(s)) return [];
  for (const opt of options) {
    if (fold(opt) === s) return [opt];
  }
  const taken: { start: number; end: number }[] = [];
  const found: { start: number; opt: string }[] = [];
  for (const opt of [...options].sort((a, b) => b.length - a.length)) {
    const f = fold(opt);
    if (f.length < 3) continue;
    const at = findTerm(s, f, 0);
    if (at === -1) continue;
    const end = at + f.length;
    if (taken.some((t) => at < t.end && end > t.start)) continue;
    taken.push({ start: at, end });
    found.push({ start: at, opt });
  }
  return found.sort((a, b) => a.start - b.start).map((f) => f.opt);
}

function applyValueMap(raw: string, map: Record<string, string> | undefined): string {
  if (!map) return raw;
  const s = fold(cleanText(raw));
  for (const [from, to] of Object.entries(map)) {
    if (fold(from) === s) return to;
  }
  for (const [from, to] of Object.entries(map)) {
    const f = fold(from);
    if (f.length >= 3 && s.includes(f)) return to;
  }
  return raw;
}

/**
 * Convertit une valeur brute (chaîne extraite, ou valeur déjà typée émise par
 * une règle mot-clé) vers le type déclaré de la variable.
 */
/** Unités de temps reconnues, repliées, ramenées à leur famille. */
const TIME_UNITS: Record<string, 'an' | 'mois' | 'semaine' | 'jour' | 'heure'> = {
  an: 'an', ans: 'an', annee: 'an', annees: 'an',
  mois: 'mois',
  semaine: 'semaine', semaines: 'semaine', sem: 'semaine',
  jour: 'jour', jours: 'jour', j: 'jour',
  heure: 'heure', heures: 'heure', h: 'heure',
};

/** Famille d'unité de temps attendue par une variable, d'après son champ « unité ». */
function expectedTimeUnit(unit: string | null | undefined): 'an' | 'mois' | 'semaine' | 'jour' | 'heure' | null {
  if (!unit) return null;
  return TIME_UNITS[fold(unit).trim()] ?? null;
}

/**
 * Détecte une unité de temps différente de celle de la variable juste après le
 * nombre : « 6 mois » pour un âge en années, « 2 semaines » pour une durée en
 * jours. Lire « 6 » ferait d'un nourrisson un enfant de six ans, sans qu'aucun
 * contrôle de plausibilité ne s'en aperçoive.
 */
function timeUnitMismatch(text: string, unit: string | null | undefined): string | null {
  const wanted = expectedTimeUnit(unit);
  if (!wanted) return null;
  const m = /-?\d+(?:[.,]\d+)?\s*([a-z]+)/.exec(fold(text));
  const found = m?.[1] ? TIME_UNITS[m[1]] : undefined;
  return found && found !== wanted ? `${m![1]}` : null;
}

/**
 * Unités usuelles des variables numériques d'un dossier clinique.
 *
 * « Créatinine : 85 µmol/L » dans une variable en mg/L passe tous les contrôles de bornes dès que 85 est plausible :
 * la valeur était lue « 85 mg/L » sans rien dire, et la moyenne de la cohorte, fausse, ne se voyait nulle part.
 * Comme pour les unités de temps, une unité écrite dans le texte et différente de celle de la variable fait écarter
 * la valeur, qui reste visible comme telle et se saisit à la main après conversion.
 *
 * Seules les unités de cette liste servent à détecter une discordance : une unité inconnue, d'un côté comme de
 * l'autre, ne bloque jamais une valeur. Un facteur de conversion déclaré sur la variable (« g/L → mg/L ») signifie que
 * l'utilisateur a pris la conversion en charge : le contrôle ne s'applique plus.
 */
const KNOWN_UNITS = [
  'mg/L', 'g/L', 'µg/L', 'ng/L', 'ng/mL', 'pg/mL', 'µg/mL', 'mg/dL', 'g/dL', 'µg/dL', 'ng/dL',
  'mmol/L', 'µmol/L', 'nmol/L', 'pmol/L', 'mEq/L', 'UI/L', 'UI/mL',
  '%', 'mmHg', 'kg', 'g', 'mg', 'µg', 'cm', 'mm', 'm', 'mL', 'L', '°C', '°F',
] as const;

/** Écritures équivalentes de la même unité. */
const UNIT_SYNONYMS: Record<string, (typeof KNOWN_UNITS)[number]> = {
  'u/l': 'UI/L', 'iu/l': 'UI/L', 'u/ml': 'UI/mL', 'iu/ml': 'UI/mL',
};

/** Forme comparable d'une unité : minuscules, sans espace, micro unifié (« µ » et « μ » valent « u »), exposants à plat. */
function normalizeUnit(raw: string): string {
  return fold(raw)
    .replace(/[µμ]/g, 'u')
    .replace(/º/g, '°')
    .replace(/³/g, '3')
    .replace(/²/g, '2')
    .replace(/\s+/g, '');
}

const UNIT_BY_FORM = new Map<string, string>([
  ...KNOWN_UNITS.map((u): [string, string] => [normalizeUnit(u), u]),
  ...Object.entries(UNIT_SYNONYMS).map(([form, u]): [string, string] => [form, u]),
]);

/** L'unité écrite juste après le premier nombre : « 85 µmol/L », « 37,5 °C », « 98 % ». */
const UNIT_AFTER_NUMBER = /-?\d[\d\s.,]*?\s*(°\s?[cf]\b|%|[a-zµμ]+(?:\s*\/\s*[a-zµμ]+)?)(.{0,2})/u;

/**
 * Unité composée écrite plus loin dans la valeur : « 98 (N : 60-110) µmol/L », ou « 8O µmol/L » où l'OCR a glissé une
 * lettre entre le nombre et l'unité. Seules les écritures sans ambiguïté comptent — avec une barre, un degré, un « % »
 * ou « mmHg » : une lettre isolée (« l », « g », « m ») est trop souvent un mot pour valoir unité.
 */
const COMPOUND_UNIT = /(?:^|[^a-zµμ0-9])((?:[a-zµμ]+\s*\/\s*[a-zµμ]+)|°\s?[cf]\b|%|mmhg\b)/gu;

function unitMismatch(text: string, unit: string | null | undefined): string | null {
  const wanted = unit ? UNIT_BY_FORM.get(normalizeUnit(unit)) : undefined;
  if (!wanted) return null;
  const folded = fold(text);
  const m = UNIT_AFTER_NUMBER.exec(folded);
  if (m?.[1]) {
    // « mg.L-1 », « mg·L⁻¹ », « mg/24h », « mg/1 » (L lu 1 par l'OCR) : unité composée qu'on ne sait pas lire d'un bloc.
    if (/^[.·∙⁻/-]\s*[a-zµμ0-9]/i.test(m[2] ?? '')) return null;
    const found = UNIT_BY_FORM.get(normalizeUnit(m[1]));
    if (found) return found !== wanted ? found : null;
  }
  // Pas d'unité connue collée au nombre : la première unité composée connue de la valeur fait foi.
  COMPOUND_UNIT.lastIndex = 0;
  for (let c = COMPOUND_UNIT.exec(folded); c !== null; c = COMPOUND_UNIT.exec(folded)) {
    const found = UNIT_BY_FORM.get(normalizeUnit(c[1]!));
    if (found) return found !== wanted ? found : null;
  }
  return null;
}

/** Caractères que l'OCR confond avec un chiffre : O/o pour 0, l/I pour 1 (la barre « | » sépare souvent des cellules). */
const OCR_LOOKALIKE = /[OoIl]/;

/**
 * Le premier nombre de la valeur touche-t-il une lettre que l'OCR substitue à un chiffre ? Renvoie le fragment
 * suspect (« 1O », « 7l », « O5 »), ou `null`.
 *
 * Seule une lettre isolée compte : « 10mg » (unité collée) et « PaO2 » (la lettre appartient à un mot) passent.
 */
export function ocrSuspect(text: string): string | null {
  const m = /\d+(?:[.,]\d+)?/.exec(text);
  if (!m) return null;
  const from = m.index;
  const to = from + m[0].length;
  const isLetter = (ch: string | undefined) => ch !== undefined && /\p{L}/u.test(ch);
  const next = text[to];
  if (next !== undefined && OCR_LOOKALIKE.test(next) && !isLetter(text[to + 1])) {
    return text.slice(from, to + 1 + (/\d/.test(text[to + 1] ?? '') ? 1 : 0));
  }
  const prev = text[from - 1];
  if (prev !== undefined && OCR_LOOKALIKE.test(prev) && !isLetter(text[from - 2])) {
    return text.slice(from - 1, to);
  }
  return null;
}

/**
 * « 38°5 » : notation française d'une température, 38,5 °C. Lue telle quelle, elle donnait 38 — ou rien, le « 5 »
 * suivant le degré n'étant pas une unité. Seul un chiffre isolé après le degré est lu comme décimale.
 */
function degreeDecimal(text: string): string {
  return text.replace(/(\d)\s?°\s?(\d)(?![\d.,])/, '$1,$2');
}

/** Négation qui précède une option citée : « favorable, sans décès ». */
const OPTION_NEGATED = /(?:pas d(?:e|u|es)?|sans|aucun|aucune|absence d(?:e|u|es)?|ni|non|jamais)[\s']*$/;

/**
 * Options distinctes citées dans la valeur — directement ou par la table de correspondances —, sans compter celles
 * qui sont niées. « Favorable puis décès » en cite deux ; « Évolution simple » une seule (« simple » → Favorable).
 */
function optionsCited(raw: string, options: string[], map: Record<string, string> | undefined): string[] {
  const s = fold(cleanText(raw));
  if (s.length === 0) return [];
  const cited = new Set<string>();
  const consider = (term: string, option: string | undefined) => {
    const f = fold(term).trim();
    if (!option || f.length < 3) return;
    let from = 0;
    for (;;) {
      const at = findTerm(s, f, from);
      if (at === -1) return;
      from = at + f.length;
      if (!OPTION_NEGATED.test(s.slice(Math.max(0, at - 20), at))) {
        cited.add(option);
        return;
      }
    }
  };
  for (const opt of options) consider(opt, opt);
  for (const [from, to] of Object.entries(map ?? {})) {
    consider(from, options.find((o) => fold(o) === fold(to)));
  }
  return [...cited];
}

export function coerce(
  raw: FieldValue,
  type: FieldType,
  options: string[],
  post?: FieldPostProcess,
  unit?: string | null,
): CoerceResult {
  if (raw === null || raw === undefined) return { ok: false, reason: 'valeur vide' };

  // Une règle `keyword` peut émettre directement un booléen ou un nombre.
  if (typeof raw === 'boolean') {
    if (type === 'boolean') return { ok: true, value: raw };
    if (type === 'text') return { ok: true, value: raw ? 'Oui' : 'Non' };
    return { ok: false, reason: `booléen incompatible avec le type ${type}` };
  }
  if (Array.isArray(raw)) {
    if (type !== 'multi') return { ok: false, reason: `liste incompatible avec le type ${type}` };
    const picked = raw
      .map((v) => matchOption(String(v), options))
      .filter((v): v is string => v !== null);
    return picked.length > 0
      ? { ok: true, value: [...new Set(picked)] }
      : { ok: false, reason: 'aucune option reconnue' };
  }

  const rawText = typeof raw === 'number' ? String(raw) : raw;
  const text = cleanText(rawText);
  if (text.length === 0) return { ok: false, reason: 'valeur vide' };

  switch (type) {
    case 'text': {
      const mapped = applyValueMap(text, post?.valueMap);
      return { ok: true, value: mapped };
    }

    case 'number':
    case 'integer': {
      // Une lettre collée au nombre (« 1O », « 7l ») est presque toujours un chiffre mal lu par l'OCR : lire
      // le nombre jusqu'à elle donnerait 1 pour 10 et 7 pour 71, sans qu'aucune borne ne s'en aperçoive.
      const ocr = ocrSuspect(text);
      if (ocr) {
        return {
          ok: false,
          reason: `caractère ambigu « ${ocr} » dans « ${text} » (lecture optique probable : O pour 0, l ou I pour 1) : à vérifier puis saisir à la main`,
        };
      }
      return coerceNumber(degreeDecimal(text), type, post, unit);
    }

    case 'date': {
      const d = parseDate(text);
      return d
        ? { ok: true, value: d }
        : { ok: false, reason: `date non reconnue dans « ${text} »` };
    }

    case 'boolean': {
      const mapped = applyValueMap(text, post?.valueMap);
      // Une correspondance déclarée par l'utilisateur prime ; sinon, « non renseigné » ou « probable »
      // sont dits comme tels plutôt que confondus avec un booléen illisible.
      if (mapped === text) {
        const qualified = qualifyAnswer(fold(text));
        if (qualified === 'not-documented' || qualified === 'uncertain' || qualified === 'contradicted') {
          return { ok: false, reason: `${describeStatus(qualified)} (« ${text} »)` };
        }
      }
      const b = parseBoolean(mapped);
      return b === null
        ? { ok: false, reason: `booléen non reconnu dans « ${text} »` }
        : { ok: true, value: b };
    }

    case 'enum': {
      // « Favorable puis décès » cite deux options : prendre la première de la liste serait un choix
      // silencieux, et le mauvais une fois sur deux. La valeur est signalée, et tranchée à la main.
      const cited = optionsCited(text, options, post?.valueMap);
      if (cited.length > 1) {
        return {
          ok: false,
          conflict: true,
          reason: `plusieurs options citées (${cited.join(', ')}) dans « ${text} » : à trancher à la main`,
        };
      }
      const mapped = applyValueMap(text, post?.valueMap);
      // Le mapping peut déjà renvoyer une option canonique.
      const direct = options.find((o) => fold(o) === fold(mapped));
      if (direct) return { ok: true, value: direct };
      const opt = matchOption(mapped, options);
      return opt
        ? { ok: true, value: opt }
        : { ok: false, reason: `« ${text} » ne correspond à aucune option` };
    }

    case 'multi': {
      // Si une option contient elle-même « et » / « ou », on ne coupe pas sur ces liaisons.
      const splitter = options.some((o) => /\s(?:et|ou|puis|avec)\s/.test(fold(o)))
        ? MULTI_SPLIT_BASE
        : MULTI_SPLIT;
      const parts = text.split(splitter).map((p) => p.trim()).filter(Boolean);
      const picked: string[] = [];
      for (const part of parts) {
        if (PART_NEGATION.test(fold(cleanText(part)))) continue;
        const mapped = applyValueMap(part, post?.valueMap);
        picked.push(...matchAllOptions(mapped, options));
      }
      return picked.length > 0
        ? { ok: true, value: [...new Set(picked)] }
        : { ok: false, reason: `aucune option reconnue dans « ${text} »` };
    }

    default:
      return { ok: false, reason: `type inconnu ${String(type)}` };
  }
}

/** Lecture d'un nombre, une fois écartés les caractères ambigus de l'OCR. */
function coerceNumber(
  text: string,
  type: 'number' | 'integer',
  post: FieldPostProcess | undefined,
  unit: string | null | undefined,
): CoerceResult {
  // « < 5 » dit seulement que la valeur est sous le seuil de détection :
  // la lire « 5 » biaiserait toute moyenne. On la laisse à la saisie humaine.
  if (/^[(\s]*(?:[<>]=?|[\u2264\u2265])\s*-?\d/.test(text)) {
    return { ok: false, reason: `valeur seuil « ${text} » : à saisir à la main` };
  }
  const mismatch = timeUnitMismatch(text, unit);
  if (mismatch) {
    return {
      ok: false,
      reason: `unité « ${mismatch} » différente de « ${unit} » dans « ${text} » : à saisir à la main`,
    };
  }
  const other = post?.scale ? null : unitMismatch(text, unit);
  if (other) {
    return {
      ok: false,
      reason: `unité « ${other} » différente de « ${unit} » dans « ${text} » : à convertir puis à saisir à la main`,
    };
  }
  const n = parseNumber(text);
  if (n === null) return { ok: false, reason: `nombre introuvable dans « ${text} »` };
  let v = post?.scale ? n * post.scale : n;
  if (type === 'integer') {
    // Un arrondi silencieux fabriquerait une donnée (3,5 jours -> 4) : la valeur décimale est
    // écartée et signalée, le relecteur tranche. L'écart de virgule flottante (61.0000000001) passe.
    if (Math.abs(v - Math.round(v)) > 1e-9) {
      return { ok: false, reason: `valeur décimale ${v} pour une variable entière : à saisir à la main` };
    }
    v = Math.round(v);
  }
  if (post?.min !== undefined && v < post.min) {
    return { ok: false, reason: `valeur ${v} sous le minimum ${post.min}` };
  }
  if (post?.max !== undefined && v > post.max) {
    return { ok: false, reason: `valeur ${v} au-dessus du maximum ${post.max}` };
  }
  return { ok: true, value: v };
}
