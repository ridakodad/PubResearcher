import { fold } from './fold.js';
import type { FieldType, FieldValue } from '../domain/types.js';

/**
 * La citation dit-elle bien ce que le modèle en a tiré ?
 *
 * Retrouver la citation dans le document ne suffit pas : « Pas de diabète » est une citation exacte, et le modèle
 * peut pourtant en tirer « diabète : oui ». Ce contrôle compare la valeur à sa propre citation, là où la comparaison
 * est sûre :
 *
 * - un nombre doit figurer dans la citation (virgule ou point décimal, espaces de milliers tolérés) ;
 * - une date doit y figurer, sous l'une de ses écritures usuelles (12/03/2024, 12/3/24, 12 mars 2024, 2024-03-12) ;
 * - un « oui » ne peut pas reposer sur une citation qui nie, met en doute ou relègue au passé.
 *
 * Les autres types (texte, options) ne sont pas contrôlés ici : leur formulation varie trop pour qu'une comparaison
 * mot à mot ne rejette pas des valeurs justes. Le contrôle penche vers le rejet : une valeur écartée reste à relever
 * à la main, une valeur fausse acceptée finit dans l'analyse.
 *
 * Renvoie la raison du rejet, ou `null` si la citation soutient la valeur.
 */
export function quoteContradiction(value: FieldValue, type: FieldType, quote: string): string | null {
  const text = quote.trim();
  if (text.length === 0) return null;

  switch (type) {
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      return numbersIn(text).some((n) => Math.abs(n - value) < 1e-9)
        ? null
        : `la citation ne contient pas la valeur ${String(value).replace('.', ',')}`;
    }
    case 'date': {
      if (typeof value !== 'string') return null;
      return datesIn(text).has(value) ? null : 'la citation ne contient pas cette date';
    }
    case 'boolean': {
      if (value !== true) return null;
      const cue = denyingCue(text);
      return cue ? `la citation ne permet pas de conclure « oui » (« ${cue} »)` : null;
    }
    default:
      return null;
  }
}

/** Tous les nombres d'un texte, en écriture française ou anglaise. Un nombre collé à une lettre (« 1O », « 7l ») n'en est pas un. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  // « 38°5 » : la température écrite à la française vaut 38,5.
  for (const match of text.matchAll(/(?<![\p{L}\d])(\d{2})\s?°\s?(\d)(?![\p{L}\d])/gu)) out.push(Number(`${match[1]}.${match[2]}`));
  const pattern = /(?<![\p{L}\d])(\d{1,3}(?:[   ]\d{3})+|\d+)(?:[.,](\d+))?(?![\p{L}\d])/gu;
  for (const match of text.matchAll(pattern)) {
    const whole = match[1]!.replace(/[   ]/g, '');
    const n = Number(match[2] ? `${whole}.${match[2]}` : whole);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

const MONTHS: Record<string, number> = {
  janvier: 1, janv: 1, fevrier: 2, fevr: 2, fev: 2, mars: 3, avril: 4, avr: 4, mai: 5, juin: 6, juillet: 7, juil: 7,
  aout: 8, septembre: 9, sept: 9, octobre: 10, oct: 10, novembre: 11, nov: 11, decembre: 12, dec: 12,
};

/** Les dates d'un texte, au format ISO. Une année sur deux chiffres est lue au XXIe siècle jusqu'à l'année en cours. */
export function datesIn(text: string): Set<string> {
  const found = new Set<string>();
  const folded = fold(text);
  const add = (day: number, month: number, year: number) => {
    if (year < 100) year += year <= new Date().getFullYear() % 100 ? 2000 : 1900;
    if (month < 1 || month > 12 || day < 1 || day > 31) return;
    found.add(`${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`);
  };
  for (const m of folded.matchAll(/(?<!\d)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})(?!\d)/g)) {
    add(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  for (const m of folded.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) {
    add(Number(m[3]), Number(m[2]), Number(m[1]));
  }
  for (const m of folded.matchAll(/(?<!\d)(1er|\d{1,2})\s+([a-z]+)\.?\s+(\d{4})(?!\d)/g)) {
    const month = MONTHS[m[2]!];
    if (month) add(m[1] === '1er' ? 1 : Number(m[1]), month, Number(m[3]));
  }
  return found;
}

/**
 * Formules qui interdisent de conclure « oui » à partir d'une citation : négation, doute, diagnostic écarté,
 * antécédent familial ou état ancien. Cherchées dans le texte replié (minuscules, sans accents).
 */
const DENYING_CUES: readonly RegExp[] = [
  /\bpas d[ e']/,
  /\bpas de\b/,
  /\babsence d/,
  /\baucun(e)?\b/,
  /\bni\b/,
  /\bnegati(f|ve)\b/,
  /\b(elimine|exclu|ecarte|infirme)e?s?\b/,
  /\ba eliminer\b/,
  /\bsuspicion\b/,
  /\bsuspect(e|ee)?\b/,
  /\bprobable\b/,
  /\bpossible\b/,
  /\bevoque(e)?\b/,
  /\bhypothese\b/,
  /\?/,
  /\bancien(ne)?\b/,
  /\bex-/,
  /\bsevre(e)?\b/,
  /\b(pere|mere|frere|soeur|familia(l|ux|le))\b/,
  /\bnon renseigne/,
];

function denyingCue(quote: string): string | null {
  const folded = fold(quote);
  for (const cue of DENYING_CUES) {
    const match = cue.exec(folded);
    if (match) return match[0].trim();
  }
  return null;
}
