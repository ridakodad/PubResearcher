/**
 * Repliage de texte pour une recherche insensible à la casse et aux accents,
 * en conservant la correspondance avec les positions du texte d'origine.
 *
 * Un simple `normalize('NFD').replace(/\p{M}/gu,'')` décale les index et rend
 * impossible la citation exacte de l'extrait justificatif. On construit donc
 * une table de correspondance index replié -> index original.
 */
export interface FoldedText {
  /** Texte minuscule, sans diacritiques. */
  folded: string;
  /** `map[i]` = index dans le texte original du caractère `folded[i]`. */
  map: ArrayLike<number>;
  /** Texte d'origine, pour les extraits. */
  original: string;
}

const COMBINING = /\p{M}/u;

/**
 * Apostrophes typographiques (celle que Word substitue à l'apostrophe droite, « ’ », et ses cousines), ramenées à
 * l'apostrophe droite. « d’insuffisance rénale » et « d'insuffisance rénale » se cherchent alors pareil, qu'on ait
 * saisi le terme avec l'une ou l'autre : sans cela, un mot-clé tapé au clavier ne trouvait rien dans un compte rendu
 * rédigé sous Word. Un caractère pour un caractère : la table de correspondance des positions n'en est pas changée.
 */
const TYPOGRAPHIC_APOSTROPHE = /[‘’‛ʼ´′]/;
const TYPOGRAPHIC_APOSTROPHES = /[‘’‛ʼ´′]/g;

/** Replie une unité UTF-16 non ASCII : décomposition, retrait des marques, minuscules. */
function computeFoldUnit(ch: string): string {
  if (TYPOGRAPHIC_APOSTROPHE.test(ch)) return "'";
  let out = '';
  for (const part of ch.normalize('NFD')) {
    if (!COMBINING.test(part)) out += part;
  }
  return out.toLowerCase();
}

/**
 * Un texte n'emploie qu'une poignée de lettres accentuées, répétées des milliers de fois : le repli de chacune
 * est mémorisé, ce qui évite de décomposer, filtrer et abaisser la même lettre à chaque occurrence.
 */
const UNIT_CACHE = new Map<number, string>();
const UNIT_CACHE_LIMIT = 4096;

function foldUnit(ch: string, code: number): string {
  const known = UNIT_CACHE.get(code);
  if (known !== undefined) return known;
  const out = computeFoldUnit(ch);
  if (UNIT_CACHE.size < UNIT_CACHE_LIMIT) UNIT_CACHE.set(code, out);
  return out;
}

/**
 * Replie `original` en gardant, pour chaque unité du résultat, l'index de l'unité d'origine dont elle provient.
 *
 * Un compte rendu est presque entièrement en ASCII : ces plages-là, sans accent à retirer, ne changent que de casse
 * et gardent leur longueur, donc se traitent d'un bloc. Seules les unités non ASCII passent par la décomposition.
 * Repliées une à une, 8 millions de caractères coûtaient 3 secondes pendant lesquelles le serveur ne répondait
 * plus à personne ; en blocs, c'est une fraction de seconde, et la table tient dans un tableau typé.
 */
export function foldText(original: string): FoldedText {
  const n = original.length;
  const pieces: string[] = [];
  let map = new Uint32Array(n + 64);
  let size = 0;
  const reserve = (extra: number): void => {
    if (size + extra <= map.length) return;
    const grown = new Uint32Array(Math.max(map.length * 2, size + extra));
    grown.set(map.subarray(0, size));
    map = grown;
  };

  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && original.charCodeAt(j) < 128) j++;
    if (j > i) {
      pieces.push(original.slice(i, j).toLowerCase());
      reserve(j - i);
      for (let k = i; k < j; k++) map[size++] = k;
      i = j;
      if (i >= n) break;
    }
    const code = original.charCodeAt(i);
    const out = foldUnit(original[i]!, code);
    pieces.push(out);
    reserve(out.length);
    for (let k = 0; k < out.length; k++) map[size++] = i;
    i++;
  }

  return { folded: pieces.join(''), map: map.subarray(0, size), original };
}

/** Convertit un intervalle du texte replié en intervalle du texte original. */
export function toOriginalRange(
  ft: FoldedText,
  foldedStart: number,
  foldedEnd: number,
): { start: number; end: number } {
  if (ft.map.length === 0) return { start: 0, end: 0 };
  const clampedStart = Math.max(0, Math.min(foldedStart, ft.map.length - 1));
  const start = ft.map[clampedStart]!;
  if (foldedEnd <= foldedStart) return { start, end: start };
  // `foldedEnd` est exclusif : on prend le dernier caractère inclus puis +1.
  const lastIdx = Math.max(0, Math.min(foldedEnd - 1, ft.map.length - 1));
  const end = ft.map[lastIdx]! + 1;
  return { start, end: Math.max(start, end) };
}

/** Replie une chaîne sans table de correspondance (pour les motifs et les clés de mapping). */
export function fold(s: string): string {
  let out = '';
  for (const part of s.normalize('NFD')) {
    if (!COMBINING.test(part)) out += part;
  }
  return out.toLowerCase().replace(TYPOGRAPHIC_APOSTROPHES, "'");
}

/** Ramène les apostrophes typographiques à l'apostrophe droite, sans toucher à la casse (motifs d'expressions régulières). */
export function straightenApostrophes(s: string): string {
  return s.replace(TYPOGRAPHIC_APOSTROPHES, "'");
}

/** Échappe une chaîne destinée à être insérée dans une expression régulière. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extrait un fragment de texte autour d'une correspondance, pour l'affichage. */
export function makeSnippet(
  text: string,
  start: number,
  end: number,
  padding = 90,
): string {
  const from = Math.max(0, start - padding);
  const to = Math.min(text.length, end + padding);
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  return (prefix + text.slice(from, to) + suffix).replace(/\s+/g, ' ').trim();
}

const WORD_CHAR = /[\p{L}\p{N}]/u;
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && ch !== '' && WORD_CHAR.test(ch);

/**
 * Longueur au plus de laquelle un terme doit être un mot entier.
 *
 * Un terme court (« mme », « hta », « irm », « mr ») est un sigle : le trouver à
 * l'intérieur d'un autre mot est presque toujours un faux positif — « mme »
 * dans « homme », « irm » dans « affirme », « hta » dans « HTAP », qui est
 * une autre maladie. Un terme long, lui, peut être une racine volontaire
 * (« diabet », « tabag ») et reste cherché comme début de mot.
 */
export const SHORT_TERM_LENGTH = 4;

/**
 * Cherche `needle` dans `haystack` à partir de `from`, en respectant les
 * frontières de mot : le terme ne doit jamais commencer au milieu d'un mot, et
 * un terme court ne doit pas non plus se terminer au milieu d'un mot.
 *
 * Les deux textes doivent être repliés (minuscules, sans accents). Renvoie -1
 * si aucune occurrence valide n'existe.
 */
export function findTerm(haystack: string, needle: string, from = 0): number {
  if (needle.length === 0) return -1;
  const first = needle[0];
  const last = needle[needle.length - 1];
  let idx = haystack.indexOf(needle, from);
  while (idx !== -1) {
    const leftOk = !(isWordChar(first) && idx > 0 && isWordChar(haystack[idx - 1]));
    const rightOk = !(
      needle.length <= SHORT_TERM_LENGTH &&
      isWordChar(last) &&
      isWordChar(haystack[idx + needle.length])
    );
    if (leftOk && rightOk) return idx;
    idx = haystack.indexOf(needle, idx + 1);
  }
  return -1;
}
