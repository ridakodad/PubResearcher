/**
 * Normalisation des champs bibliographiques.
 *
 * Deux sources décrivent le même article avec des conventions différentes :
 * PubMed donne un DOI et un PMID propres, Google Scholar un titre parfois
 * tronqué et une adresse. Tout ce qui sert à reconnaître deux notices comme une
 * seule référence — DOI, PMID, titre normalisé — se calcule ici, à un seul
 * endroit.
 */

/** Chaîne sans retours à la ligne ni espaces multiples ; vide si la valeur n'est pas un texte. */
export function clean(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

export const strOrNull = (value: unknown): string | null => clean(value) || null;

/** Entier lu d'un nombre ou d'une chaîne numérique ; `null` sinon. */
export function intOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^\s*\d+\s*$/.test(value)) return Number(value);
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

export const strings = (value: unknown): string[] =>
  asArray(value).map(clean).filter((s) => s.length > 0);

/**
 * N'accepte que http et https.
 *
 * Les acteurs rendent parfois `javascript:void(0)` à la place d'un lien de PDF.
 * Une adresse de ce genre, posée dans un `href`, exécuterait du code au clic :
 * aucune adresse venue d'un acteur n'est rendue telle quelle.
 */
export function safeUrl(value: unknown): string | null {
  const raw = clean(value);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/** DOI en minuscules, sans préfixe d'adresse ni ponctuation finale. */
export function normDoi(value: unknown): string | null {
  const found = /10\.\d{4,9}\/[^\s"<>]+/i.exec(clean(value))?.[0];
  if (!found) return null;
  return found.replace(/[.,;:)\]]+$/, '').toLowerCase();
}

/**
 * DOI porté par l'adresse d'une page d'éditeur.
 *
 * Seules les adresses qui l'annoncent sont lues (`doi.org/…`, `/doi/abs/10.…`) :
 * un identifiant d'éditeur qui ressemblerait à un DOI sans en être un ne doit
 * pas fusionner deux articles.
 */
export function doiFromUrl(url: string | null): string | null {
  if (!url) return null;
  const announced =
    /doi\.org\/10\./i.test(url) || /\/doi\/(?:abs|full|pdf|epdf|pdfdirect|book)?\/?10\./i.test(url);
  return announced ? normDoi(url) : null;
}

export function pmcFromUrl(url: string | null): string | null {
  const id = url ? /\/(PMC\d+)(?:[/?#]|$)/i.exec(url)?.[1] : undefined;
  return id ? id.toUpperCase() : null;
}

/** Vrai si le titre se termine par une ellipse : Google Scholar tronque les titres longs. */
export const isTruncated = (title: string): boolean => /(?:…|\.\.\.)\s*$/.test(title.trim());

/**
 * Titre réduit à ses lettres et chiffres, sans accents ni casse.
 * C'est la clé de rapprochement quand aucun identifiant ne l'est.
 */
export function normTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // PubMed aplatit les exposants en « 21(st) Century », « CO(2) » ; Scholar écrit « 21st century », « CO2 ».
    .replace(/([a-z0-9])\(([a-z0-9]{1,3})\)/g, '$1$2')
    .replace(/…|\.\.\./g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Auteurs d'une chaîne « J Michalak, D Tzou, J Funk… » : l'ellipse finale est retirée. */
export function splitAuthors(raw: string): string[] {
  return raw
    .split(/\s*,\s*/)
    .map((a) => a.replace(/(?:…|\.\.\.)+\s*$/, '').trim())
    .filter(Boolean);
}

/** « Ritter M » ou « J Michalak » → « Ritter, M » / « Michalak, J », pour BibTeX. */
export function authorForBibtex(author: string): string {
  const lastFirst = /^(.+?)\s+([A-Z]{1,4})$/.exec(author);
  if (lastFirst) return `${lastFirst[1]}, ${lastFirst[2]}`;
  const firstLast = /^([A-Z]{1,4})\s+(.+)$/.exec(author);
  if (firstLast) return `${firstLast[2]}, ${firstLast[1]}`;
  return author;
}

/** Nom de famille approché, pour la clé BibTeX. */
export function lastNameOf(author: string): string {
  const bib = authorForBibtex(author);
  return bib.includes(',') ? (bib.split(',')[0] ?? '').trim() : bib.trim();
}

export function dropUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
