import type { DocKind, FieldValue, TemplateField } from './types';

/** Rend une valeur lisible dans un tableau ou une fiche. */
export function displayValue(value: FieldValue, field?: Pick<TemplateField, 'type'>): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  if (typeof value === 'boolean') return value ? 'Oui' : 'Non';
  if (field?.type === 'date') return formatDate(String(value));
  if (typeof value === 'number') return formatNumber(value);
  return String(value);
}

// Un formateur coûte cher à construire : un tableau de cinq mille dossiers en demande plus de cent mille.
const NUMBER_FORMAT = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });

export function formatNumber(n: number): string {
  return NUMBER_FORMAT.format(n);
}

const USD_FORMAT = new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });

const MODEL_LABELS: Record<string, string> = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-opus-5': 'Claude Opus 5',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
  'claude-fable-5-1': 'Claude Fable 5.1',
};

/** Nom lisible d'un modèle (« Claude Opus 5.5 ») ; un identifiant inconnu est rendu tel quel. */
export function modelLabel(id: string | null | undefined): string {
  if (!id) return 'Claude';
  return MODEL_LABELS[id] ?? id;
}

/** Montant en dollars, à la française (« 0,14 $US ») ; sous le centime, « moins de 0,01 $US ». */
export function formatUsd(amount: number): string {
  if (amount > 0 && amount < 0.005) return `moins de ${USD_FORMAT.format(0.01)}`;
  return USD_FORMAT.format(amount);
}

/** Minuscules sans accents, pour comparer ce que l'on tape à ce qui est affiché. */
export function foldForSearch(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** `2024-03-15` -> `15/03/2024` */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(d);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[i]}`;
}

export const DOC_KIND_LABELS: Record<DocKind, string> = {
  pdf: 'PDF',
  docx: 'Word',
  image: 'Image',
  dicom: 'DICOM',
  text: 'Texte',
  unknown: 'Inconnu',
};

/** Pluriel simple : « 1 dossier » / « 3 dossiers ». */
export function plural(count: number, singular: string, plural?: string): string {
  return `${count} ${count > 1 ? (plural ?? `${singular}s`) : singular}`;
}

/**
 * Transforme un libellé en clé technique valide (`Âge du patient` -> `age_du_patient`).
 *
 * Deux libellés différents ne doivent jamais donner la même clé : la clé est l'en-tête de colonne des exports
 * et l'identité de la variable. Un libellé sans lettre latine (arabe, chinois) reçoit une clé dérivée de son
 * contenu plutôt qu'un « var_ » commun à tous ; une clé déjà prise reçoit un numéro (`age_2`).
 */
export function slugifyKey(label: string, taken: ReadonlySet<string> = new Set()): string {
  let base = label
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 56);
  if (base === '') {
    // Petit condensat du libellé : stable, court, et différent d'un libellé à l'autre.
    let h = 5381;
    for (const ch of label.trim()) h = ((h << 5) + h + (ch.codePointAt(0) ?? 0)) >>> 0;
    base = `var_${h.toString(36).slice(0, 6)}`;
  }
  // La clé doit commencer par une lettre.
  let key = /^[a-z]/.test(base) ? base : `var_${base}`;
  for (let n = 2; taken.has(key); n++) key = `${key.replace(/_\d+$/, '')}_${n}`;
  return key.slice(0, 60);
}

/** Nombre saisi : signe facultatif, chiffres, virgule ou point décimal. Ni notation scientifique, ni séparateur de milliers. */
const NUMERIC_INPUT = /^\s*([-+\u2212]?\d+(?:[.,]\d+)?)\s*$/;

export type NumberParse = { ok: true; value: number | null } | { ok: false; message: string };

/**
 * Lit un nombre tel qu'on le tape en français (« 12,5 ») ou à l'anglaise (« 12.5 »).
 *
 * Un `<input type="number">` ne convient pas ici : sa lecture dépend de la langue du navigateur, et un poste
 * en anglais comprend « 12,5 » comme 125 — sans rien dire.
 */
export function parseNumberInput(text: string, integer: boolean): NumberParse {
  if (text.trim() === '') return { ok: true, value: null };
  // Saisie en cours : un signe seul, ou « 12, » en route vers « 12,5 », n'est pas une faute.
  if (/^\s*[-+\u2212]\s*$/.test(text)) return { ok: true, value: null };
  const pending = /^\s*([-+\u2212]?\d+)[.,]\s*$/.exec(text);
  const m = NUMERIC_INPUT.exec(pending ? pending[1]! : text);
  if (!m) return { ok: false, message: integer ? 'Entier attendu (ex. 54).' : 'Nombre attendu (ex. 12,5).' };
  const n = Number(m[1]!.replace(',', '.').replace('\u2212', '-'));
  if (!Number.isFinite(n)) return { ok: false, message: 'Nombre trop grand.' };
  if (integer && !Number.isInteger(n)) return { ok: false, message: 'Entier attendu : pas de décimale ici.' };
  return { ok: true, value: n };
}

/** Écriture d'un nombre dans un champ de saisie : virgule décimale, sans séparateur de milliers. */
export function numberToInput(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value).replace('.', ',') : '';
}

/** Égalité de deux valeurs de fiche (les choix multiples sont comparés élément par élément). */
export function sameValue(a: FieldValue, b: FieldValue): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Langue probable d'un texte court (titre, résumé), pour l'attribut `lang` : un lecteur d'écran qui lit « Laser
 * enucleation of the prostate » avec l'accent français est inintelligible (WCAG 3.1.2). Comptage de mots
 * grammaticaux de chaque langue ; en cas de doute, `undefined` — mieux vaut ne rien déclarer qu'une langue fausse.
 */
const EN_WORDS = new Set(['the', 'of', 'and', 'in', 'with', 'for', 'to', 'was', 'were', 'is', 'are', 'a', 'an', 'on', 'by', 'at', 'from', 'versus', 'vs', 'after', 'among', 'between', 'outcomes', 'study', 'trial']);
const FR_WORDS = new Set(
  ['le', 'la', 'les', 'des', 'du', 'de', 'et', 'est', 'une', 'un', 'dans', 'pour', 'chez', 'avec', 'sur', 'par', 'au', 'aux', 'en', 'sont', 'ou', 'après', 'entre', 'étude'].map(foldForSearch),
);

export function guessLang(text: string | null | undefined): 'en' | 'fr' | undefined {
  if (!text) return undefined;
  const words = foldForSearch(text).match(/[a-z]+/g) ?? [];
  if (words.length < 4) return undefined;
  let en = 0;
  let fr = 0;
  for (const word of words) {
    if (EN_WORDS.has(word)) en++;
    if (FR_WORDS.has(word)) fr++;
  }
  if (/[éèêàùç]/i.test(text)) fr += 2;
  if (en >= 2 && en > fr * 1.5) return 'en';
  if (fr >= 2 && fr > en * 1.5) return 'fr';
  return undefined;
}
