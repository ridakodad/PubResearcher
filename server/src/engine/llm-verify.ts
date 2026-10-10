import { fold, foldText, makeSnippet, toOriginalRange } from './fold.js';
import type { SourceDoc } from './rules.js';

/**
 * Vérification des citations produites par le modèle.
 *
 * Une valeur relevée par un modèle de langage n'a de valeur scientifique que
 * si l'on peut la rattacher au document dont elle provient. Chaque citation
 * est donc recherchée dans le texte réellement extrait : introuvable, la
 * valeur est rejetée plutôt qu'enregistrée.
 *
 * La comparaison tolère la casse, les accents et les différences d'espaces —
 * le modèle recopie rarement les sauts de ligne d'un PDF à l'identique — mais
 * pas la reformulation.
 */

export interface LocatedEvidence {
  documentId: number;
  documentName: string;
  snippet: string;
  start: number;
  end: number;
  /** Comment la citation a été retrouvée. */
  method: 'quote' | 'value';
}

/** Réduit un fragment à sa forme comparable : minuscules, sans accents, espaces normalisés. */
function normalize(text: string): string {
  return fold(text).replace(/\s+/g, ' ').trim();
}

/**
 * Recherche un fragment dans un document en ignorant les différences d'espaces.
 *
 * Les positions sont converties vers le texte d'origine, de façon que
 * l'extrait affiché à l'utilisateur soit celui du document et non celui
 * recopié par le modèle.
 */
/**
 * Longueur minimale d'un fragment recherché.
 *
 * En deçà, une correspondance ne prouve rien : « 54 » se retrouve un peu
 * partout dans un compte rendu. Conséquence assumée — une valeur courte
 * (un âge, un score) doit être accompagnée d'une vraie citation pour être
 * retenue, la valeur seule ne suffit pas à la justifier.
 */
const MIN_FRAGMENT_LENGTH = 4;

function findInDocument(doc: SourceDoc, fragment: string): { start: number; end: number } | null {
  const needle = normalize(fragment);
  if (needle.length < MIN_FRAGMENT_LENGTH) return null;

  const ft = foldText(doc.text);
  // Le texte replié conserve les espaces d'origine : on construit une version
  // à espaces normalisés en gardant la correspondance des index.
  const compact: string[] = [];
  const indexMap: number[] = [];
  let previousWasSpace = false;

  for (let i = 0; i < ft.folded.length; i++) {
    const char = ft.folded[i]!;
    if (/\s/.test(char)) {
      if (previousWasSpace) continue;
      compact.push(' ');
      indexMap.push(i);
      previousWasSpace = true;
    } else {
      compact.push(char);
      indexMap.push(i);
      previousWasSpace = false;
    }
  }

  const haystack = compact.join('');
  const at = haystack.indexOf(needle);
  if (at === -1) return null;

  const foldedStart = indexMap[at] ?? 0;
  const foldedEnd = (indexMap[at + needle.length - 1] ?? foldedStart) + 1;
  return toOriginalRange(ft, foldedStart, foldedEnd);
}

/**
 * Localise la justification d'une valeur.
 *
 * On cherche d'abord la citation ; à défaut, la valeur elle-même, ce qui
 * couvre le cas où le modèle relève une donnée d'un tableau sans réussir à en
 * recopier une phrase. Si ni l'une ni l'autre n'est retrouvée, la valeur est
 * considérée comme non justifiée.
 */
export function locateEvidence(
  docs: SourceDoc[],
  quote: string,
  value: string,
  preferredDocument: string,
): LocatedEvidence | null {
  // Le document cité par le modèle est examiné en premier.
  const ordered = [...docs].sort((a, b) => {
    const aMatch = normalize(a.name) === normalize(preferredDocument) ? 0 : 1;
    const bMatch = normalize(b.name) === normalize(preferredDocument) ? 0 : 1;
    return aMatch - bMatch;
  });

  for (const method of ['quote', 'value'] as const) {
    const fragment = method === 'quote' ? quote : value;
    if (!fragment || fragment.trim().length === 0) continue;

    for (const doc of ordered) {
      const range = findInDocument(doc, fragment);
      if (!range) continue;
      return {
        documentId: doc.id,
        documentName: doc.name,
        snippet: makeSnippet(doc.text, range.start, range.end),
        start: range.start,
        end: range.end,
        method,
      };
    }
  }

  return null;
}
