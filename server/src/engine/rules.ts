import { RegexTimeout, matchesOf } from './safe-regex.js';
import type {
  DicomRule,
  DocKind,
  Evidence,
  ExtractionRule,
  FieldValue,
  KeywordRule,
  LabelRule,
  RegexRule,
  Rejection,
  TemplateField,
} from '../domain/types.js';
import { coerce } from './coerce.js';
import {
  escapeRegex,
  findTerm,
  fold,
  foldText,
  makeSnippet,
  straightenApostrophes,
  toOriginalRange,
  type FoldedText,
} from './fold.js';

/** Document tel que le moteur le consomme. */
export interface SourceDoc {
  id: number;
  name: string;
  kind: DocKind;
  text: string;
  /** Tags DICOM aplatis : mot-clé et code hexa pointent vers la même valeur. */
  dicomTags: Record<string, string>;
  /** Cache du texte replié, calculé une fois par passe d'extraction. */
  folded?: FoldedText;
}

export interface RuleHit {
  value: FieldValue;
  confidence: number;
  evidence: Evidence;
}

const DEFAULT_CONFIDENCE: Record<ExtractionRule['kind'], number> = {
  dicom: 0.95,
  label: 0.85,
  regex: 0.8,
  keyword: 0.7,
};

/**
 * Correspondance trouvée par une règle.
 *
 * `start` et `end` désignent des positions dans le texte *replié* ; `haystack`
 * est le texte qui a été parcouru — pas nécessairement celui du document,
 * puisqu'une règle peut viser le nom de fichier ou les tags DICOM. Conserver
 * les deux permet de restituer la valeur et l'extrait avec leur casse et leurs
 * accents d'origine.
 */
interface RuleMatch {
  raw: FieldValue;
  start: number;
  end: number;
  haystack: FoldedText | null;
}

/** Restitue le fragment d'origine correspondant à un intervalle replié. */
function originalSlice(ft: FoldedText, start: number, end: number): string {
  const range = toOriginalRange(ft, start, end);
  return ft.original.slice(range.start, range.end).trim();
}

/**
 * Retire les diacritiques sans toucher à la casse (préserve `\D`, `\S`… dans les motifs), et ramène les
 * apostrophes typographiques à l'apostrophe droite, comme le texte replié dans lequel le motif cherche.
 */
function stripDiacritics(s: string): string {
  return straightenApostrophes(s.normalize('NFD').replace(/\p{M}/gu, ''));
}

function foldedOf(doc: SourceDoc): FoldedText {
  if (!doc.folded) doc.folded = foldText(doc.text);
  return doc.folded;
}

/** Compile un motif en tolérant les échappements invalides en mode Unicode. */
function compile(pattern: string, flags: string): RegExp | null {
  const base = flags.includes('i') ? flags : flags + 'i';
  try {
    return new RegExp(pattern, base.includes('u') ? base : base + 'u');
  } catch {
    try {
      return new RegExp(pattern, base.replace(/u/g, ''));
    } catch {
      return null;
    }
  }
}

function describeRule(rule: ExtractionRule): string {
  switch (rule.kind) {
    case 'label':
      return `libellé « ${rule.labels.join(' » ou « ')} »`;
    case 'regex':
      return `expression régulière /${rule.pattern}/`;
    case 'keyword':
      return `mot-clé « ${rule.any.join(' » / « ')} »`;
    case 'dicom':
      return `tag DICOM ${rule.tag}`;
  }
}

function makeEvidence(
  doc: SourceDoc,
  rule: ExtractionRule,
  ft: FoldedText,
  foldedStart: number,
  foldedEnd: number,
): Evidence {
  const { start, end } = toOriginalRange(ft, foldedStart, foldedEnd);
  return {
    documentId: doc.id,
    documentName: doc.name,
    snippet: makeSnippet(ft.original, start, end),
    start,
    end,
    rule: describeRule(rule),
  };
}

/** Texte dans lequel la règle doit chercher. */
function haystack(doc: SourceDoc, source: 'text' | 'dicom' | 'filename' | undefined): FoldedText | null {
  switch (source ?? 'text') {
    case 'text':
      return foldedOf(doc);
    case 'filename':
      return foldText(doc.name);
    case 'dicom':
      // Les tags sont aplatis en « clé: valeur » par ligne pour rester interrogeables.
      return foldText(
        Object.entries(doc.dicomTags)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\n'),
      );
    default:
      return null;
  }
}

/** Caractères qui séparent les mots d'un libellé : espaces et apostrophes. */
const LABEL_SEPARATORS = /[\s'‘’ʼ´`]+/g;

/**
 * Construit le motif d'un libellé.
 *
 * Les apostrophes et les espaces sont rendus interchangeables et facultatifs :
 * selon la source, « Durée d'hospitalisation » ressort en « Duree
 * d'hospitalisation », « Durée d’hospitalisation » ou « Duree d hospitalisation »
 * — l'extraction de texte d'un PDF remplace fréquemment l'apostrophe par une
 * espace. Un libellé saisi une fois doit couvrir ces variantes.
 */
function buildLabelPattern(label: string): string {
  return escapeRegex(fold(label).trim()).replace(
    LABEL_SEPARATORS,
    "[\\s'\\u2018\\u2019\\u02bc\\u00b4`]{0,3}",
  );
}

/** Fin de phrase : un point, ou un « ! » / « ? », suivi d'une espace ou de la fin du texte. */
const SENTENCE_END = /[.!?](?=\s|$)/;

function applyLabelRule(rule: LabelRule, doc: SourceDoc, typed: boolean): RuleMatch | null {
  const ft = haystack(doc, rule.source);
  if (!ft) return null;
  const max = Math.min(Math.max(rule.maxLength ?? 120, 1), 500);

  // Deux passes : avec séparateur explicite (fiable), puis simple espace (fallback).
  const separators = ['\\s*[:=]\\s*', '[  \\t]+'];
  for (const sep of separators) {
    for (const label of rule.labels) {
      const lab = buildLabelPattern(label);
      const re = compile(`(?:^|[^\\p{L}\\p{N}])${lab}${sep}([^\\n\\r;]{1,${max}})`, 'gu');
      if (!re) continue;
      let m: RegExpExecArray | null;
      while ((m = re.exec(ft.folded)) !== null) {
        let captured = m[1];
        if (captured === undefined || captured.trim().length === 0) continue;
        // Une variable typée (nombre, date, oui/non, choix) ne lit pas au-delà de la
        // phrase : « Âge : NR. Patient âgé de 61 ans » ne doit pas livrer « 6 », le
        // premier chiffre d'une capture coupée par la longueur maximale.
        if (typed) {
          const cut = SENTENCE_END.exec(captured);
          if (cut) captured = captured.slice(0, cut.index);
          if (captured.trim().length === 0) continue;
        }
        const start = m.index + m[0].length - m[1]!.length;
        const end = start + captured.length;
        const raw = originalSlice(ft, start, end);
        if (raw.length === 0) continue;
        return { raw, start, end, haystack: ft };
      }
    }
  }
  return null;
}

function applyRegexRule(rule: RegexRule, doc: SourceDoc): RuleMatch | null {
  const ft = haystack(doc, rule.source);
  if (!ft) return null;
  const pattern = stripDiacritics(rule.pattern);
  const re = compile(pattern, (rule.flags ?? '') + 'g');
  if (!re) return null;

  // Le motif est de l'utilisateur : `matchesOf` le surveille s'il peut s'emballer, et lève
  // `RegexTimeout` s'il s'emballe — l'appelant l'annonce comme valeur écartée.
  for (const m of matchesOf(re, pattern, ft.folded)) {
    const wanted = rule.group ?? 1;
    const captured = m[wanted] ?? m[0];
    if (captured === undefined || captured.trim().length === 0) continue;
    const offsetInMatch = m[0].indexOf(captured);
    const start = m.index + (offsetInMatch >= 0 ? offsetInMatch : 0);
    const end = start + captured.length;
    const raw = originalSlice(ft, start, end);
    if (raw.length === 0) continue;
    return { raw, start, end, haystack: ft };
  }
  return null;
}

/** Élisions françaises courantes, ramenées à leur forme pleine. */
const ELISIONS: Record<string, string> = {
  d: 'de', l: 'le', n: 'ne', s: 'se', c: 'ce', j: 'je', m: 'me', t: 'te', qu: 'que',
};

/**
 * Normalise un fragment pour la détection de négation.
 *
 * « pas de », « pas d'HTA » et « pas d’HTA » expriment la même chose ; sans
 * cette normalisation, l'utilisateur devrait saisir chaque variante
 * d'apostrophe et d'élision comme terme d'exclusion distinct.
 *
 * Utilisée uniquement pour un test de présence : elle modifie les longueurs
 * et ne doit donc jamais servir à calculer une position.
 */
function normalizeElision(fragment: string): string {
  return fragment
    .replace(/['‘’ʼ´`]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b(qu|[dlnscjmt])\b/g, (_, group: string) => ELISIONS[group] ?? group);
}

/** Ponctuation qui clôt une proposition dans un compte rendu. */
const CLAUSE_BOUNDARY = /[,;.!?\n\r•|]/;

/**
 * Restreint le contexte de négation à la proposition qui contient le terme.
 *
 * Dans « pas de diabète, HTA sous traitement », le « pas de » porte sur le
 * diabète seul : une simple fenêtre de caractères le rattacherait à tort à
 * l'HTA et inverserait la variable. On ne remonte donc que jusqu'à la
 * ponctuation précédente.
 *
 * Exception : une proposition introduite par « ni » prolonge la négation
 * précédente — « pas de diabète, ni d'HTA » nie bien les deux.
 */
function negationContext(window: string): string {
  const parts = window.split(CLAUSE_BOUNDARY);
  let index = parts.length - 1;
  let context = parts[index] ?? '';
  while (index > 0 && /^\s*ni\b/.test(parts[index] ?? '')) {
    index--;
    context = `${parts[index] ?? ''} ${context}`;
  }
  return context;
}

/**
 * Marques de négation placées *après* le terme : « diabète : non », « diabète
 * (-) », « HTA exclue ».
 *
 * Volontairement étroites. « Diabète non insulinodépendant » et « HTA non
 * traitée » AFFIRMENT la maladie : un simple « non » qui suit le terme ne dit
 * donc rien ; seul « : non » (réponse à un libellé), « (-) » et les participes
 * de négation (« exclu », « écarté », « négatif », « absent ») valent négation.
 */
const TRAILING_NEGATION =
  /^\s*(?:[:=]\s*(?:non(?=\s*(?:$|[,.;)(]|retrouv|note|connu|documente|precis|renseign|mentionn|signal|rapport|decel|observ|constat|evoque|objective|existant|present))|no\b|neg\w*|absent\w*|aucun\w*|nul\w*)|\(\s*[-–−]\s*\)|(?:(?:est|etait|semble|parait|reste|a ete)\s+)?(?:negatif|negative|absent|absente|exclu|exclue|ecarte|ecartee)\b)/;

/**
 * Contexte de PHRASE (et non de proposition) précédant un terme.
 *
 * Pour attribuer une mention à un proche, la virgule ne coupe pas : dans
 * « Antécédents familiaux : diabète, HTA », l'HTA est elle aussi familiale, et
 * dans « Père décédé, diabétique », le diabète est celui du père. Seuls le point
 * et le saut de ligne ferment la portée. Se tromper dans ce sens fait perdre une
 * valeur (le chercheur la saisit) plutôt que d'en inventer une.
 */
function sentenceContext(window: string): string {
  const parts = window.split(/[.!?\n\r•|]/);
  return parts[parts.length - 1] ?? '';
}

/** Les termes de `list` apparaissent-ils (mots entiers) dans ce contexte ? */
function mentions(context: string, list: string[]): boolean {
  return list.some((term) => findTerm(context, term, 0) !== -1);
}

function applyKeywordRule(rule: KeywordRule, doc: SourceDoc): RuleMatch | null {
  const ft = haystack(doc, rule.source);
  if (!ft) return null;
  const window = rule.noneWindow ?? 40;
  const skipWindow = rule.skipWindow ?? Math.max(window, 80);
  const negations = (rule.none ?? []).map((n) => normalizeElision(fold(n))).filter(Boolean);
  const skips = (rule.skip ?? []).map((n) => normalizeElision(fold(n))).filter(Boolean);

  /** Première occurrence niée, retenue au cas où aucune occurrence affirmée n'existe. */
  let negatedHit: { start: number; end: number } | null = null;

  for (const term of rule.any) {
    const needle = fold(term).trim();
    if (needle.length === 0) continue;
    let from = 0;
    for (;;) {
      const idx = findTerm(ft.folded, needle, from);
      if (idx === -1) break;
      const end = idx + needle.length;
      from = end;

      // Mention hors sujet (antécédents familiaux…) : on passe, sans affirmer ni nier.
      if (skips.length > 0) {
        const around = normalizeElision(
          sentenceContext(ft.folded.slice(Math.max(0, idx - skipWindow), idx)),
        );
        if (mentions(around, skips)) continue;
      }

      // Contexte précédant l'occurrence, pour détecter « pas de », « absence de »…
      const before = normalizeElision(
        negationContext(ft.folded.slice(Math.max(0, idx - window), idx)),
      );
      // Une règle qui déclare des négations lit aussi ce qui suit le terme :
      // « diabète (-) » ou « HTA exclue » nient autant que « pas de diabète ».
      const negated =
        mentions(before, negations) ||
        (negations.length > 0 && TRAILING_NEGATION.test(ft.folded.slice(end, end + 30)));
      if (!negated) {
        return { raw: rule.emit, start: idx, end, haystack: ft };
      }
      negatedHit ??= { start: idx, end };
    }
  }

  // Aucune mention affirmée dans ce document : l'absence documentée est une
  // information à part entière si la règle prévoit une valeur pour ce cas.
  if (negatedHit && rule.emitIfNegated !== undefined) {
    return { raw: rule.emitIfNegated, start: negatedHit.start, end: negatedHit.end, haystack: ft };
  }
  return null;
}

function applyDicomRule(rule: DicomRule, doc: SourceDoc): RuleMatch | null {
  const wanted = rule.tag.trim();
  const direct = doc.dicomTags[wanted];
  const value =
    direct ??
    // Recherche insensible à la casse et au formatage du code (x0010,0010).
    Object.entries(doc.dicomTags).find(
      ([k]) => fold(k) === fold(wanted) || fold(k) === fold(wanted.replace(/[(),x]/gi, '')),
    )?.[1];
  if (value === undefined || String(value).trim().length === 0) return null;
  return { raw: String(value).trim(), start: 0, end: 0, haystack: null };
}

/** Le document est-il éligible à cette règle (filtre par nature de document) ? */
function docAllowed(rule: ExtractionRule, doc: SourceDoc): boolean {
  if (rule.kind === 'dicom') return doc.kind === 'dicom';
  const kinds = rule.docKinds;
  if (!kinds || kinds.length === 0) return true;
  return kinds.includes(doc.kind);
}

/** Résultat détaillé de l'application des règles à un patient. */
export interface FieldExtraction {
  hit: RuleHit | null;
  /** Valeurs trouvées puis écartées (hors bornes, seuil, type incompatible), les premières seulement. */
  rejected: Rejection[];
}

/** Nombre maximal de valeurs écartées conservées par variable et par passe. */
const MAX_REJECTED = 3;

/**
 * Applique les règles d'une variable à l'ensemble des documents d'un patient.
 * Les règles sont évaluées dans l'ordre : la première qui produit une valeur
 * typable gagne. Les règles suivantes servent donc de repli.
 *
 * Une valeur trouvée mais non typable (« CRP < 5 », « Âge : NR ») laisse la main
 * aux règles suivantes — et reste consignée dans `rejected`, pour que le
 * chercheur sache qu'elle existait au lieu de croire la variable absente.
 */
export function extractFieldDetailed(field: TemplateField, docs: SourceDoc[]): FieldExtraction {
  const { extraction } = field;
  const rejected: Rejection[] = [];
  if (!extraction.enabled) return { hit: null, rejected };

  for (let i = 0; i < extraction.rules.length; i++) {
    const rule = extraction.rules[i]!;
    for (const doc of docs) {
      if (!docAllowed(rule, doc)) continue;

      let match: RuleMatch | null = null;
      try {
        switch (rule.kind) {
          case 'label':
            match = applyLabelRule(rule, doc, field.type !== 'text');
            break;
          case 'regex':
            match = applyRegexRule(rule, doc);
            break;
          case 'keyword':
            match = applyKeywordRule(rule, doc);
            break;
          case 'dicom':
            match = applyDicomRule(rule, doc);
            break;
        }
      } catch (error) {
        // Une expression régulière qui s'emballe ne doit ni figer l'outil ni faire taire la
        // variable : la règle est écartée et le dit, les suivantes continuent.
        //
        // V8 compile un motif à sa première exécution, pas à sa construction : un libellé démesuré
        // ne lève « Regular expression too large » (SyntaxError) que là, et un motif très profond
        // peut épuiser la pile (RangeError). Même traitement : une règle inapplicable n'est pas une panne.
        const reason =
          error instanceof RegexTimeout
            ? `${error.message}. Simplifiez le motif ; les autres règles de la variable sont appliquées.`
            : error instanceof SyntaxError || error instanceof RangeError
              ? 'Le motif est trop long ou trop complexe pour le moteur d’expressions régulières : raccourcissez-le. Les autres règles de la variable sont appliquées.'
              : null;
        if (reason === null) throw error;
        if (rejected.length < MAX_REJECTED) {
          rejected.push({
            documentId: doc.id,
            documentName: doc.name,
            snippet: '(aucun extrait : la règle n’a pas pu être appliquée)',
            reason,
            rule: describeRule(rule),
          });
        }
        continue;
      }
      if (!match) continue;

      const typed = coerce(match.raw, field.type, field.options, extraction.postProcess, field.unit);
      if (!typed.ok) {
        if (rejected.length < MAX_REJECTED) {
          rejected.push({
            documentId: doc.id,
            documentName: doc.name,
            snippet: match.haystack
              ? makeEvidence(doc, rule, match.haystack, match.start, match.end).snippet
              : `${rule.kind === 'dicom' ? rule.tag : field.key} = ${String(match.raw)}`,
            reason: typed.reason,
            rule: describeRule(rule),
          });
        }
        continue;
      }

      const base = rule.confidence ?? DEFAULT_CONFIDENCE[rule.kind];
      // Léger décalage selon le rang : les règles de repli sont moins sûres.
      const confidence = Math.max(0.05, Math.min(1, base - i * 0.03));

      return {
        hit: {
          value: typed.value,
          confidence: Number(confidence.toFixed(2)),
          evidence: match.haystack
            ? makeEvidence(doc, rule, match.haystack, match.start, match.end)
            : {
                documentId: doc.id,
                documentName: doc.name,
                snippet: `${rule.kind === 'dicom' ? rule.tag : field.key} = ${String(match.raw)}`,
                start: 0,
                end: 0,
                rule: describeRule(rule),
              },
        },
        // Une valeur écartée par une règle de rang inférieur ne compte plus
        // quand une règle suivante a produit une valeur utilisable.
        rejected: [],
      };
    }
  }

  return { hit: null, rejected };
}

/** Version simple : la valeur retenue, ou `null`. */
export function extractField(field: TemplateField, docs: SourceDoc[]): RuleHit | null {
  return extractFieldDetailed(field, docs).hit;
}
