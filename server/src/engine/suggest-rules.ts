/**
 * Règles d'extraction proposées d'office pour une variable qui n'en a pas.
 *
 * Une fiche créée de zéro ou importée d'un document Word ou d'un tableur n'apporte, pour chaque variable, qu'un
 * libellé, un type, des options et une unité. Sans règle, la variable ne se remplirait jamais seule. Ce module en
 * déduit un jeu de règles raisonnable, sur le modèle de la fiche livrée (`db/seed.ts`) :
 *
 * - libellés : le libellé saisi et toutes ses écritures connues du lexique (`lexicon.ts`) — « CRP », « protéine C
 *   réactive », « C-réactive » ; le moteur tolère ensuite la mise en page (« CRP ...... 142 », « CRP⏎142 ») ;
 * - oui/non : en plus du libellé (« HTA : oui »), un mot-clé sur les écritures et formes dérivées (« hypertendu »),
 *   avec les négations, les mentions familiales et les antécédents traités par les qualificatifs du moteur — « pas
 *   de diabète » vaut « Non », « père diabétique » et « suspicion de diabète » ne valent rien ;
 * - choix : correspondances d'écriture vers chaque option (« H », « homme » -> « Masculin ») et, pour un choix
 *   multiple, un mot-clé par option reconnue (« TDM » -> « Scanner ») ;
 * - nombres : bornes de plausibilité quand l'unité de la variable est celle du lexique, et la tournure « 142 mg/L de
 *   CRP » — seulement avec l'unité écrite, qui seule rend la lecture sûre ;
 * - `episode: 'admission'` quand le libellé situe la mesure à l'arrivée (« CRP à l'admission », « T° d'entrée »).
 *
 * Le résultat passe les validateurs des règles (`lib/schemas.ts`) : au plus 50 libellés de 200 caractères, 100
 * mots-clés, 30 règles, motifs de moins de 500 caractères.
 */
import type {
  ExtractionRule,
  FieldExtraction,
  FieldPostProcess,
  FieldType,
  KeywordRule,
} from '../domain/types.js';
import { canonicalUnit } from './coerce.js';
import { escapeRegex, fold } from './fold.js';
import { cleanLabel, findConcept, mentionsAdmission, variantsFor, type Concept } from './lexicon.js';

export interface SuggestInput {
  label: string;
  type: FieldType;
  options?: string[];
  unit?: string | null;
  key?: string;
}

/** Négations qui précèdent un terme (« pas de diabète », « ni HTA ») — celles de la fiche livrée. */
export const NEGATIONS = ['pas de', 'absence de', 'sans', 'aucun', 'aucune', 'non', 'ni', 'jamais', 'nie', 'negatif'];

/** Proches : une mention qui les concerne ne dit rien du patient (« mère diabétique »). */
export const PROCHES = [
  'mere', 'pere', 'frere', 'soeur', 'fils', 'fille', 'parents', 'enfants', 'epouse', 'epoux',
  'grand-pere', 'grand-mere', 'oncle', 'tante', 'cousin', 'cousine', 'famille', 'familial', 'familiale', 'familiaux',
  'conjoint', 'conjointe', 'mari', 'compagnon', 'compagne', 'entourage',
];

/** Limites des validateurs (`lib/schemas.ts`). */
const MAX_LABELS = 50;
const MAX_KEYWORDS = 100;
const MAX_RULES = 30;
const MAX_TERM = 200;
const MAX_PATTERN = 500;

/**
 * Écritures courantes d'options usuelles, repliées. Une option de la variable qui appartient à l'un de ces groupes
 * reçoit toutes les écritures du groupe comme correspondances (`valueMap`).
 */
const OPTION_GROUPS: string[][] = [
  ['masculin', 'm', 'h', 'homme', 'male', 'garcon', 'sexe masculin', 'masc'],
  ['feminin', 'f', 'femme', 'female', 'fille', 'sexe feminin', 'fem'],
  ['oui', 'o', 'yes', 'present', 'presente', 'positif', 'positive'],
  ['non', 'n', 'no', 'absent', 'absente', 'negatif', 'negative', 'neant'],
  ['droite', 'droit', 'dte', 'dt', 'cote droit'],
  ['gauche', 'g', 'gche', 'cote gauche'],
  ['bilateral', 'bilaterale', 'bilat', 'des deux cotes', 'bilaterales', 'bilateraux'],
  ['favorable', 'bonne', 'bonne evolution', 'simple', 'simples', 'amelioration', 'evolution favorable', 'suites simples'],
  ['defavorable', 'mauvaise', 'aggravation', 'evolution defavorable', 'deterioration'],
  ['stationnaire', 'stable', 'stabilisation', 'inchange'],
  ['deces', 'decede', 'decedee', 'mort', 'dcd', 'dc', 'exitus'],
  ['perdu de vue', 'perdue de vue', 'pdv'],
  ['gueri', 'guerison', 'guerie', 'remission complete'],
  ['urgence', 'urgent', 'en urgence', 'urgente'],
  ['programme', 'programmee', 'reglee', 'a froid', 'elective'],
  ['domicile', 'retour a domicile', 'rad', 'sortie a domicile'],
  ['mutation', 'transfert', 'transfere', 'transferee', 'mute', 'mutee'],
  ['medical', 'traitement medical', 'medicale'],
  ['chirurgical', 'chirurgie', 'operatoire', 'opere', 'operee', 'chirurgicale'],
  ['celibataire', 'celib'],
  ['marie', 'mariee', 'en couple'],
  ['positif', 'positive', '+', 'pos'],
  ['negatif', 'negative', '-', 'neg'],
];

function clip(list: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const t = raw.trim();
    const k = fold(t).replace(/\s+/g, ' ');
    if (t.length === 0 || t.length > MAX_TERM || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Une lettre seule (« P », « T ») n'est pas un libellé sûr : « P = 0,03 » est une valeur de p. */
const labelUsable = (t: string) => fold(t).replace(/[^\p{L}\p{N}°%+]/gu, '').length >= 2;
/** Un mot-clé cherché seul dans le texte doit être assez long pour ne pas être une abréviation quelconque. */
const keywordUsable = (t: string) => fold(t).replace(/[^\p{L}\p{N}]/gu, '').length >= 3;

/** Libellés de la variable : son libellé nettoyé, puis les écritures de sa notion. */
function labelsOf(label: string, concept: Concept | null, withForms: boolean): string[] {
  const cleaned = cleanLabel(label) || label.trim();
  const base = concept
    ? [cleaned, ...concept.terms, ...(concept.labelOnly ?? []), ...(withForms ? (concept.forms ?? []) : [])]
    : variantsFor(label);
  // Une variable sans libellé utilisable (« T ») garde le sien : c'est le choix de l'utilisateur.
  const usable = base.filter(labelUsable);
  return clip(usable.length > 0 ? usable : [cleaned], MAX_LABELS);
}

/** Mots-clés d'une notion : écritures sûres et formes dérivées, sans les sigles ambigus. */
function keywordsOf(label: string, concept: Concept | null): string[] {
  const cleaned = cleanLabel(label) || label.trim();
  const terms = concept ? [cleaned, ...concept.terms, ...(concept.forms ?? [])] : [cleaned];
  const ambiguous = new Set((concept?.labelOnly ?? []).map((t) => fold(t)));
  return clip(
    terms.filter((t) => keywordUsable(t) && !ambiguous.has(fold(t))).map((t) => fold(t)),
    MAX_KEYWORDS,
  );
}

/** Même unité, à l'écriture près (« mg/l » et « mg/L », « µmol/L » et « umol/l »). */
function sameUnit(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const ca = canonicalUnit(a);
  const cb = canonicalUnit(b);
  if (ca && cb) return ca === cb;
  const norm = (u: string) => fold(u).replace(/[µμ]/g, 'u').replace(/³/g, '3').replace(/²/g, '2').replace(/\s+/g, '');
  return norm(a) === norm(b);
}

/** Motif d'une unité dans le texte replié : espaces facultatives, micro sous ses deux écritures. */
function unitPattern(unit: string): string {
  return fold(unit)
    .trim()
    .split('')
    .map((ch) => (/\s/.test(ch) ? '\\s*' : ch === 'µ' || ch === 'μ' ? '[µμu]' : ch === '/' ? '\\s*/\\s*' : escapeRegex(ch)))
    .join('');
}

/**
 * « 142 mg/L de CRP », « 9 800 leucocytes/mm3 » : la valeur avant le libellé. Lecture sûre seulement avec l'unité
 * écrite entre les deux — « 3 jours de fièvre » ou « 20 ans de tabac » sont des durées, pas des valeurs —, et
 * seulement pour une unité que l'outil connaît.
 */
function valueBeforeLabel(terms: string[], unit: string | null | undefined): ExtractionRule | null {
  if (!unit || !canonicalUnit(unit)) return null;
  const u = unitPattern(unit);
  const alternatives: string[] = [];
  let size = 0;
  for (const t of terms.filter((x) => keywordUsable(x))) {
    const p = escapeRegex(fold(t)).replace(/\s+/g, '\\s+');
    if (size + p.length + 1 > 260) break;
    alternatives.push(p);
    size += p.length + 1;
  }
  if (alternatives.length === 0) return null;
  const pattern =
    `(?<![\\d.,])(\\d{1,4}(?:[.,]\\d{1,3})?)\\s*${u}\\s+(?:de\\s+(?:la\\s+)?|d'|d\\s)(?:${alternatives.join('|')})(?![\\p{L}\\p{N}])`;
  if (pattern.length > MAX_PATTERN) return null;
  return { kind: 'regex', pattern, confidence: 0.75 };
}

/** Correspondances d'écriture vers les options de la variable. */
function optionValueMap(options: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  const optionKeys = new Set(options.map((o) => fold(o).trim()));
  const put = (from: string, to: string) => {
    const k = fold(from).trim();
    if (k.length === 0 || k.length > MAX_TERM) return;
    // Une écriture qui est elle-même une autre option ne lui est pas retirée.
    if (optionKeys.has(k) && k !== fold(to).trim()) return;
    if (!(k in map)) map[k] = to;
  };
  for (const option of options) {
    const o = fold(option).trim();
    for (const group of OPTION_GROUPS) {
      if (group.includes(o) || (o.length >= 5 && group.some((g) => g.length >= 5 && o.startsWith(g)))) {
        for (const g of group) put(g, option);
      }
    }
    const concept = findConcept(option);
    if (concept && !concept.generic) {
      for (const v of [...concept.terms, ...(concept.forms ?? [])]) if (labelUsable(v)) put(v, option);
    }
  }
  return map;
}

/** Mots-clés qui désignent une option d'un choix multiple : l'option, ses écritures du lexique. */
function optionKeywords(option: string): string[] {
  const concept = findConcept(option);
  const terms = [option, ...(concept && !concept.generic ? [...concept.terms, ...(concept.forms ?? [])] : [])];
  const ambiguous = new Set((concept?.labelOnly ?? []).map((t) => fold(t)));
  return clip(
    terms.filter((t) => keywordUsable(t) && !ambiguous.has(fold(t))).map((t) => fold(t)),
    MAX_KEYWORDS,
  );
}

const MALE = new Set(['masculin', 'm', 'h', 'homme', 'male', 'masc']);
const FEMALE = new Set(['feminin', 'f', 'femme', 'female', 'fem']);

/**
 * Propose la configuration d'extraction d'une variable à partir de son seul libellé, de son type, de ses options et
 * de son unité. Toujours activée ; une variable que rien ne permet de chercher reçoit au moins son libellé.
 */
export function suggestExtraction(input: SuggestInput): FieldExtraction {
  const { label, type } = input;
  const options = (input.options ?? []).filter((o) => o.trim().length > 0);
  const unit = input.unit ?? null;
  const concept = findConcept(label);
  const admission = mentionsAdmission(label);
  const rules: ExtractionRule[] = [];
  const extraction: FieldExtraction = { enabled: true, rules };
  const post: FieldPostProcess = {};

  switch (type) {
    case 'number':
    case 'integer': {
      const labels = labelsOf(label, concept, false);
      rules.push({ kind: 'label', labels, maxLength: 40 });
      if (concept?.id === 'age') {
        rules.push({ kind: 'regex', pattern: "(?:patient|patiente|malade|homme|femme|enfant|nourrisson)\\s+(?:age|agee)?\\s*de\\s+(\\d{1,3})\\s*ans" });
        rules.push({ kind: 'regex', pattern: '\\b(?:age|agee)\\s+de\\s+(\\d{1,3})\\s*ans' });
        rules.push({ kind: 'dicom', tag: 'PatientAge' });
      }
      if (concept?.id === 'duree_sejour') {
        rules.push({ kind: 'regex', pattern: "hospitalise(?:e|s|es)?\\s+(?:pendant|durant)\\s+(\\d{1,3})\\s*(?:jours?|j)\\b" });
      }
      if (concept?.id === 'poids') rules.push({ kind: 'dicom', tag: 'PatientWeight' });
      if (concept?.id === 'taille') rules.push({ kind: 'dicom', tag: 'PatientSize', confidence: 0.6 });
      const before = valueBeforeLabel(concept ? [cleanLabel(label), ...concept.terms] : [cleanLabel(label)], unit);
      if (before) rules.push(before);
      if (concept?.range && sameUnit(unit ?? concept.unit, concept.unit)) {
        [post.min, post.max] = concept.range;
      }
      if (admission && (!concept || concept.category === 'biologie' || concept.category === 'constante' || concept.category === 'score')) {
        extraction.episode = 'admission';
      }
      break;
    }

    case 'date': {
      rules.push({ kind: 'label', labels: labelsOf(label, concept, false), maxLength: 40 });
      if (concept?.id === 'date_naissance') rules.push({ kind: 'dicom', tag: 'PatientBirthDate' });
      if (concept?.id === 'date_examen') rules.push({ kind: 'dicom', tag: 'StudyDate' });
      // Plusieurs dates d'admission dans un dossier (deux séjours, deux comptes rendus) : la première importée.
      if (concept?.id === 'date_admission' || concept?.id === 'date_diagnostic') extraction.select = 'first';
      if (concept?.id === 'date_sortie' || concept?.id === 'date_derniere_nouvelle') extraction.select = 'last';
      break;
    }

    case 'boolean': {
      rules.push({ kind: 'label', labels: labelsOf(label, concept, false), maxLength: 30 });
      const any = keywordsOf(label, concept);
      if (any.length > 0) {
        const keyword: KeywordRule = {
          kind: 'keyword',
          any,
          none: concept?.id === 'tabac' ? [...NEGATIONS, 'sevre', 'sevree', 'ancien', 'ancienne'] : NEGATIONS,
          skip: PROCHES,
          emit: true,
          emitIfNegated: false,
        };
        if (concept?.acute) keyword.history = 'exclude';
        rules.push(keyword);
      }
      if (concept?.id === 'tabac') post.valueMap = { ancien: 'non', ancienne: 'non', sevre: 'non', sevree: 'non' };
      // Notion de l'épisode : une mention qui l'affirme suffit, même si un autre compte rendu ne la signale pas.
      if (concept?.acute) extraction.select = 'any';
      if (admission) extraction.episode = 'admission';
      break;
    }

    case 'enum':
    case 'multi': {
      rules.push({ kind: 'label', labels: labelsOf(label, concept, false), maxLength: type === 'multi' ? 200 : 80 });
      const map = optionValueMap(options);
      if (Object.keys(map).length > 0) post.valueMap = map;

      if (concept?.id === 'sexe') {
        const male = options.find((o) => MALE.has(fold(o).trim()));
        const female = options.find((o) => FEMALE.has(fold(o).trim()));
        rules.push({ kind: 'dicom', tag: 'PatientSex' });
        // « patient » seul est omis : le masculin y est générique.
        if (female) rules.push({ kind: 'keyword', any: ['patiente', 'madame', 'mme', 'une femme', 'femme de', 'femme agee', 'parturiente', 'enceinte'], emit: female });
        if (male) rules.push({ kind: 'keyword', any: ['monsieur', 'mr', 'm.', 'un homme', 'homme de', 'homme age'], emit: male });
        if (post.valueMap && male && female) {
          // Codes DICOM.
          post.valueMap.m = male;
          post.valueMap.f = female;
        }
        break;
      }

      // Un mot-clé par option reconnue. Choix unique : seulement les options qui sont des notions du lexique (« Décès »,
      // « Scanner ») — une option générale (« Favorable ») trouvée n'importe où ne dit rien de la variable.
      for (const option of options) {
        if (rules.length >= MAX_RULES) break;
        const optionConcept = findConcept(option);
        if (type === 'enum' && (!optionConcept || optionConcept.generic)) continue;
        const any = optionKeywords(option);
        if (any.length === 0) continue;
        rules.push({ kind: 'keyword', any, none: NEGATIONS, skip: PROCHES, emit: option });
      }
      // Choix multiple : les options citées dans les documents s'additionnent.
      if (type === 'multi') extraction.select = 'any';
      break;
    }

    case 'text':
    default: {
      const long = concept?.generic || concept?.category === 'rubrique';
      rules.push({ kind: 'label', labels: labelsOf(label, concept, false), maxLength: long ? 300 : 200 });
      break;
    }
  }

  if (Object.keys(post).length > 0) extraction.postProcess = post;
  extraction.rules = rules.slice(0, MAX_RULES);
  return extraction;
}
