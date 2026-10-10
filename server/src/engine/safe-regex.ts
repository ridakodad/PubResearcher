import vm from 'node:vm';

/**
 * Garde-fou des expressions régulières saisies dans une fiche.
 *
 * Un moteur d'expressions régulières à retour arrière (celui de JavaScript) peut mettre un temps
 * exponentiel à échouer sur certains motifs : `(\w+\s?)+:` appliqué à une ligne de trente mots sans
 * deux-points occupe le serveur pendant des heures. Une fiche est écrite par un chercheur, pas par un
 * spécialiste des expressions régulières, et elle s'applique à des milliers de dossiers : une seule
 * règle maladroite ne doit pas figer l'outil pour tout le monde.
 *
 * Deux protections, qui se complètent :
 *
 * 1. Une analyse du motif repère ceux qui peuvent exploser (quantificateurs imbriqués, alternative
 *    sous un quantificateur, références arrière, quatre quantificateurs ouverts ou plus). Seuls
 *    ceux-là sont exécutés sous chronomètre : la surveillance coûte quelques centaines de
 *    microsecondes par appel, ce qui serait trop pour les motifs ordinaires, qui sont l'immense majorité.
 * 2. Sous chronomètre, l'exécution est interrompue passé le délai accordé. Le motif est alors
 *    « disjoncté » : il n'est plus évalué (il le serait sur chaque dossier, pour le même résultat), et
 *    la règle l'annonce comme valeur écartée, avec la raison en clair.
 *
 * Un motif que l'analyse croyait sain mais qui dépasse le délai en exécution libre est, lui, classé à
 * risque pour la suite : la première évaluation est subie, pas les suivantes.
 */

export class RegexTimeout extends Error {
  constructor(
    readonly pattern: string,
    readonly budgetMs: number,
    readonly reason: string,
  ) {
    super(`Expression régulière interrompue après ${budgetMs} ms : ${reason}`);
    this.name = 'RegexTimeout';
  }
}

/** Délai accordé à une expression à risque, par document. */
const budgetMs = (): number => {
  const n = Number(process.env.REGEX_BUDGET_MS);
  return Number.isFinite(n) && n >= 10 ? Math.floor(n) : 250;
};

interface GroupState {
  /** Contient une répétition de longueur variable (`+`, `*`, `{n,}`, `{n,m}`). */
  hasVariableRepeat: boolean;
  hasAlternation: boolean;
  isLookaround: boolean;
}

/** Un élément du motif, tel que la suite de ses quantificateurs le laisse. */
interface Item {
  /** `unbounded` : `*`, `+`, `{n,}` ; `optional` : `?`, `{0,1}` ; `bounded` : `{n,m}` ; `fixed` : aucun ou `{n}`. */
  quant: 'unbounded' | 'optional' | 'bounded' | 'fixed';
  /** Peut absorber n'importe quel caractère (« . », `[\s\S]`, `[^]`). */
  wildcard: boolean;
  /** Fermeture de groupe : ne compte comme élément que si elle est quantifiée. */
  group: boolean;
}

/** Ruptures de chaîne : une alternative sépare deux branches qui ne s'enchaînent pas. */
const BREAK: Item = { quant: 'fixed', wildcard: false, group: false };

/**
 * Pourquoi ce motif pourrait être coûteux, ou `null` s'il ne l'est pas manifestement.
 * Volontairement large : se tromper vers le prudent ne coûte que du temps de calcul.
 *
 * Ce qui fait exploser un motif :
 * - un quantificateur variable sur un groupe qui en contient déjà un (`(a+)+`) ;
 * - une alternative sous un quantificateur (`(a|aa)+`) ;
 * - une référence arrière ;
 * - un groupe à répétition fixe qui enferme un quantificateur ouvert (`(.*a){12}`) ;
 * - une chaîne d'au moins quatre éléments ouverts qui s'enchaînent sans rien d'obligatoire entre eux
 *   (`\d+\d+\d+\d+`), ou trois « .* » qui peuvent traverser une ligne entière.
 * `\s*:\s*(\d+)` ne rentre dans aucun de ces cas : un caractère obligatoire sépare chaque quantificateur.
 */
export function riskOf(pattern: string, flags = ''): string | null {
  const stack: GroupState[] = [];
  const top = (): GroupState | undefined => stack[stack.length - 1];
  const items: Item[] = [];
  let nested = false;
  let alternation = false;
  let lookaroundQuantified = false;
  let backreference = false;
  let fixedRepeatOfVariable = false;
  /** Dernier élément posé, pour savoir à quoi s'applique un quantificateur. */
  const state: { last: { item: Item; group: GroupState | null } | null } = { last: null };

  const push = (wildcard: boolean, group: GroupState | null = null): void => {
    const item: Item = { quant: 'fixed', wildcard, group: group !== null };
    items.push(item);
    state.last = { item, group };
  };

  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;

    if (c === '\\') {
      const next = pattern[i + 1];
      if (next !== undefined && /[1-9]/.test(next)) backreference = true;
      if (next === 'k' && pattern[i + 2] === '<') backreference = true;
      // \p{...}, \u{...} : on saute le bloc entier.
      if ((next === 'p' || next === 'P' || next === 'u') && pattern[i + 2] === '{') {
        const end = pattern.indexOf('}', i + 3);
        i = end < 0 ? pattern.length : end + 1;
      } else {
        i += 2;
      }
      push(false);
      continue;
    }

    if (c === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j++;
      const bodyStart = j;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      const body = pattern.slice(bodyStart, j);
      const negatedEmpty = pattern[i + 1] === '^' && body === '';
      // [\s\S], [\d\D], [\w\W], [^] : n'importe quel caractère.
      const anything = negatedEmpty || /^(?:\\s\\S|\\S\\s|\\d\\D|\\D\\d|\\w\\W|\\W\\w)$/.test(body);
      i = j + 1;
      push(anything);
      continue;
    }

    if (c === '(') {
      const rest = pattern.slice(i, i + 4);
      const isLookaround = rest.startsWith('(?=') || rest.startsWith('(?!') || rest.startsWith('(?<=') || rest.startsWith('(?<!');
      stack.push({ hasVariableRepeat: false, hasAlternation: false, isLookaround });
      i++;
      continue;
    }

    if (c === ')') {
      const group = stack.pop();
      if (group) {
        const parent = top();
        if (parent) {
          parent.hasVariableRepeat ||= group.hasVariableRepeat;
          parent.hasAlternation ||= group.hasAlternation;
        }
        push(false, group);
      } else {
        push(false);
      }
      i++;
      continue;
    }

    if (c === '|') {
      const group = top();
      if (group) group.hasAlternation = true;
      items.push(BREAK);
      state.last = null;
      i++;
      continue;
    }

    // Quantificateurs.
    let quantifier: 'star' | 'plus' | 'optional' | { min: number; max: number | null } | null = null;
    let width = 1;
    if (c === '*') quantifier = 'star';
    else if (c === '+') quantifier = 'plus';
    else if (c === '?') quantifier = 'optional';
    else if (c === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(i));
      if (m) {
        const min = Number(m[1]);
        const max = m[2] === undefined ? min : m[3] === '' ? null : Number(m[3]);
        quantifier = { min, max };
        width = m[0].length;
      }
    }

    const last = state.last;
    if (quantifier !== null && last !== null) {
      const unbounded =
        quantifier === 'star' || quantifier === 'plus' || (typeof quantifier === 'object' && quantifier.max === null);
      const bounded = typeof quantifier === 'object' && quantifier.max !== null && quantifier.max > quantifier.min;
      const optional = quantifier === 'optional' || (typeof quantifier === 'object' && quantifier.max === 1 && quantifier.min === 0);
      const fixedCount = typeof quantifier === 'object' && quantifier.max === quantifier.min && quantifier.min >= 2;
      // Seule une répétition de longueur variable crée une ambiguïté : (\d{3})+ est sans danger, (\d+)+ non.
      const variable = unbounded || bounded;

      if (last.group) {
        if (variable && last.group.hasVariableRepeat) nested = true;
        if (variable && last.group.hasAlternation) alternation = true;
        if (variable && last.group.isLookaround) lookaroundQuantified = true;
        // (.*a){12} : douze répétitions d'un motif lui-même ouvert, soit un temps en puissance douze.
        if (fixedCount && last.group.hasVariableRepeat && (quantifier as { min: number }).min >= 3) fixedRepeatOfVariable = true;
      }
      if (variable) {
        const parent = top();
        if (parent) parent.hasVariableRepeat = true;
      }
      last.item.quant = unbounded ? 'unbounded' : bounded ? 'bounded' : optional ? 'optional' : 'fixed';
      i += width;
      // Suffixe paresseux (?) : fait partie du quantificateur.
      if (pattern[i] === '?') i++;
      continue;
    }

    // Tout autre caractère : « . » absorbe n'importe quoi (sur une ligne, ou partout avec le drapeau s).
    push(c === '.');
    i++;
  }

  // Chaîne d'éléments ouverts qui s'enchaînent : un élément obligatoire et fixe la rompt, un élément facultatif non.
  let chain = 0;
  let longestChain = 0;
  let wildcardUnbounded = 0;
  for (const item of items) {
    if (item.group && item.quant === 'fixed') continue; // simple fermeture de groupe
    if (item.quant === 'unbounded') {
      chain++;
      longestChain = Math.max(longestChain, chain);
      if (item.wildcard) wildcardUnbounded++;
    } else if (item.quant === 'optional' || item.quant === 'bounded') {
      // neutre : peut être sauté, la chaîne continue à travers
    } else {
      chain = 0;
    }
  }

  const dotAll = flags.includes('s');
  if (nested) return 'quantificateurs imbriqués (par exemple (a+)+)';
  if (alternation) return 'alternative répétée (par exemple (a|aa)+)';
  if (fixedRepeatOfVariable) return 'répétition d’un motif lui-même ouvert (par exemple (.*a){12})';
  if (backreference) return 'référence arrière';
  if (lookaroundQuantified) return 'assertion répétée';
  if (longestChain >= 4) return `${longestChain} quantificateurs ouverts qui s’enchaînent (*, +, {n,})`;
  if (wildcardUnbounded >= 3) return `${wildcardUnbounded} « .* » dans un même motif`;
  if (dotAll && wildcardUnbounded >= 2) return 'plusieurs « .* » avec le drapeau s';
  return null;
}

// ------------------------------------------------------------------ exécution

/** Contexte isolé : il ne voit rien de l'application, seulement l'expression et le texte qu'on lui passe. */
const sandbox = vm.createContext(Object.create(null) as object);
const collectScript = new vm.Script(
  `(() => {
    const found = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) re.lastIndex++;
      found.push(m);
      if (found.length >= limit) break;
    }
    return found;
  })()`,
);

/** Motifs interrompus, avec la raison : ils ne sont plus évalués. */
const tripped = new Map<string, { reason: string }>();
/** Motifs que l'analyse croyait sains mais qui se sont révélés lents : ils passent sous chronomètre. */
const escalated = new Map<string, string>();

const keyOf = (pattern: string, flags: string): string => `${flags}\u0000${pattern}`;

/** À l'usage des tests : remet à zéro la mémoire des motifs interrompus. */
export function resetRegexGuard(): void {
  tripped.clear();
  escalated.clear();
}

export function isTripped(pattern: string, flags: string): boolean {
  return tripped.has(keyOf(pattern, flags));
}

const MAX_MATCHES = 500;

/**
 * Correspondances successives d'un motif, du premier au `MAX_MATCHES`-ième.
 * Lève `RegexTimeout` si le motif est (ou vient d'être) jugé trop coûteux.
 */
export function matchesOf(re: RegExp, pattern: string, text: string): RegExpExecArray[] {
  const key = keyOf(pattern, re.flags);

  const known = tripped.get(key);
  if (known) throw new RegexTimeout(pattern, budgetMs(), known.reason);

  const reason = riskOf(pattern, re.flags) ?? escalated.get(key) ?? null;

  if (reason === null) {
    // Exécution libre, mais chronométrée : un motif lent est classé à risque pour la suite.
    const found: RegExpExecArray[] = [];
    const started = performance.now();
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) re.lastIndex++;
      found.push(m);
      if (found.length >= MAX_MATCHES) break;
    }
    if (performance.now() - started > budgetMs()) {
      escalated.set(key, 'motif lent à évaluer sur ce corpus');
    }
    return found;
  }

  const context = sandbox as Record<string, unknown>;
  context['re'] = re;
  context['text'] = text;
  context['limit'] = MAX_MATCHES;
  try {
    // Array.from : le tableau vient du contexte isolé (autre « Array »), on rend un tableau ordinaire.
    return Array.from(collectScript.runInContext(sandbox, { timeout: budgetMs() }) as Iterable<RegExpExecArray>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      tripped.set(key, { reason });
      throw new RegexTimeout(pattern, budgetMs(), reason);
    }
    throw error;
  } finally {
    context['re'] = null;
    context['text'] = '';
  }
}
