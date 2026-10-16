import { RegexTimeout, matchesOf } from './safe-regex.js';
import type {
  DicomRule,
  DocKind,
  Evidence,
  EvidenceAlternative,
  ExtractionRule,
  FieldValue,
  KeywordRule,
  LabelRule,
  RegexRule,
  Rejection,
  TemplateField,
} from '../domain/types.js';
import { canonicalUnit, coerce, ocrSuspect, unitFollowing } from './coerce.js';
import { describeStatus, laterInStay, qualifyMention, type MentionStatus } from './qualifiers.js';
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
  /** Règle « libellé » : 0 avec séparateur explicite (« : », « = »), 1 avec une simple espace (repli). */
  pass?: 0 | 1;
  /** Règle « mot-clé » : la mention est une absence documentée (`emitIfNegated`). */
  negated?: boolean;
  /** Règle « libellé » : début du libellé, pour savoir quelle étendue la mention occupe. */
  labelStart?: number;
}

/** Nombre maximal de mentions lues par règle et par document : borne le travail sur un texte démesuré. */
const MAX_MENTIONS_PER_DOC = 50;

/**
 * Valeur numérique lue dans un tableau : l'unité de la cellule suivante (« 168 : µmol/L ») lui est rattachée, pour que
 * le contrôle d'unité s'applique comme si elle était écrite à côté du nombre.
 */
function withTableUnit(match: RuleMatch, numeric: boolean): FieldValue {
  if (!numeric || typeof match.raw !== 'string' || !match.haystack) return match.raw;
  const unit = unitFollowing(match.haystack.folded, match.end);
  return unit ? `${match.raw} ${unit}` : match.raw;
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

/**
 * Espace horizontale : espaces, tabulations, insécables (U+00A0, U+202F, U+2009…), jamais un saut de ligne. Un tableau
 * copié depuis Word ou un PDF sépare ses cellules par des tabulations ou par plusieurs espaces, et l'OCR double
 * volontiers une espace : tout cela vaut une seule séparation.
 */
const HSPACE = '[^\\S\\r\\n]';

/**
 * Unité entre parenthèses accolée au libellé, comme dans un en-tête de colonne : « CRP (mg/L) : 142 »,
 * « Leucocytes (/mm3) 9 800 ». Elle est lue à part (groupe 1), pour être replacée après la valeur.
 */
const LABEL_UNIT = `(?:${HSPACE}*\\(([^()\\n]{1,24})\\))?`;

/**
 * Séparateurs entre un libellé et sa valeur, du plus fiable au moins sûr.
 *
 * Passe 0 — séparateur explicite : « : », « = », « ： » (deux-points pleine chasse d'un PDF), points de conduite
 * d'un sommaire (« CRP ........ 142 », « Hb…… 12 »), barre de tableau (« CRP | 142 »), tiret entouré d'espaces
 * (« CRP – 142 », « Hb - 12,4 »). Passe 1 — simple espace ou tabulation (repli).
 */
const LABEL_SEPARATORS_BY_PASS = [
  `(?:\\s*[:=\\uff1a]|${HSPACE}*(?:[.\\u2026\\u00b7_]{3,}|\\u2026+)${HSPACE}*[:=]?|${HSPACE}*\\|(?!\\|)|${HSPACE}+[-\\u2013\\u2014](?=\\s))\\s*`,
  `${HSPACE}+`,
];

/**
 * Début de ligne, puce comprise (« - », « • », « * », « ▪ », « ➢ »…) : un libellé seul sur sa ligne, dont la valeur
 * occupe la ligne suivante (« CRP⏎142 mg/L »), comme dans un tableau dont les cellules sont sorties une par ligne.
 */
const LINE_START = `(?:^|\\n)${HSPACE}*(?:[-\\u2013\\u2022*\\u25aa\\u25cf\\u25e6\\u27a2>\\u2192]${HSPACE}*)?`;

/**
 * Unité accolée au libellé, à replacer après la valeur numérique : seulement une écriture d'unité reconnaissable
 * (« mg/L », « /mm3 », « % », « °C », « g/dL »). « Créatinine (N < 110) » ou « Hb (J0) » ne sont pas des unités.
 */
function headerUnit(unit: string | undefined): string | null {
  if (!unit) return null;
  const u = unit.trim();
  if (!/^[a-zµμ%°/][a-zµμ0-9³²/%°.^\s-]{0,23}$/iu.test(u)) return null;
  return canonicalUnit(u) || /[/%°]/.test(u) ? u : null;
}

/**
 * Coupure de mot en fin de ligne d'un PDF (« créati-⏎nine », « hémo-⏎globine ») : le trait d'union et le saut de
 * ligne sont retirés, pour la seule recherche des libellés — une table de correspondance garde les positions
 * d'origine, l'extrait cité reste exact. Ne s'applique qu'entre deux minuscules : « Hb -⏎12 » ou une liste à puces
 * ne sont pas touchées. Les mots-clés gardent le texte tel quel : « grand-⏎mère » doit rester « grand-mère ».
 */
const SOFT_HYPHEN_BREAK = /(?<=\p{Ll})-[^\S\r\n]*\r?\n[^\S\r\n]*(?=\p{Ll})/gu;

function dehyphenated(ft: FoldedText): FoldedText {
  if (!ft.folded.includes('-\n') && !/-[^\S\n]+\n|-\r\n/.test(ft.folded)) return ft;
  // Le texte replié est en minuscules : la casse se lit dans le texte d'origine.
  const keep: number[] = [];
  let out = '';
  let last = 0;
  SOFT_HYPHEN_BREAK.lastIndex = 0;
  for (let m = SOFT_HYPHEN_BREAK.exec(ft.folded); m !== null; m = SOFT_HYPHEN_BREAK.exec(ft.folded)) {
    const before = ft.original[ft.map[m.index - 1] ?? -1] ?? '';
    const after = ft.original[ft.map[m.index + m[0].length] ?? -1] ?? '';
    if (!/\p{Ll}/u.test(before) || !/\p{Ll}/u.test(after)) continue;
    out += ft.folded.slice(last, m.index);
    for (let k = last; k < m.index; k++) keep.push(ft.map[k]!);
    last = m.index + m[0].length;
  }
  if (last === 0) return ft;
  out += ft.folded.slice(last);
  for (let k = last; k < ft.folded.length; k++) keep.push(ft.map[k]!);
  return { folded: out, map: Uint32Array.from(keep), original: ft.original };
}

/**
 * Entre un libellé et un nombre, des mots qui disent que ce nombre n'est pas la valeur : un délai (« dans 48 h »,
 * « depuis 3 jours »), un examen à venir (« à contrôler », « prévue »), une absence (« non dosée », « pas fait »).
 */
const NOT_A_VALUE_GAP =
  /\b(?:dans|depuis|pendant|il y a|apres|avant|toutes? les|tous les|a controler|a refaire|a recontroler|prevue?s?|programmee?s?|non|pas)\b/;

/** Texte replié des libellés : coupures de mot de fin de ligne recousues, calculé une fois par document. */
const labelFolded = new WeakMap<FoldedText, FoldedText>();
function labelHaystack(ft: FoldedText): FoldedText {
  let out = labelFolded.get(ft);
  if (!out) {
    out = dehyphenated(ft);
    labelFolded.set(ft, out);
  }
  return out;
}

/**
 * Toutes les mentions « libellé : valeur » d'un document, dans l'ordre du texte.
 *
 * Deux passes : avec séparateur explicite (fiable), puis simple espace (repli) ; l'appelant ne lit les secondes que
 * si les premières n'ont rien donné d'utilisable dans le document. Une même mention n'est lue qu'une fois : « Durée de
 * séjour : 8 » répond aux libellés « Durée de séjour » et « Séjour », et « Délai de consultation : 5 » aux libellés
 * « Délai de consultation » et « Délai ».
 *
 * Mises en page tolérées : libellé en capitales, puce, unité entre parenthèses (« CRP (mg/L) : 142 »), points de
 * conduite, cellules séparées par des tabulations ou des espaces multiples, espaces insécables, coupure de mot en
 * fin de ligne. Pour un nombre ou une date, la valeur peut aussi occuper la ligne suivante d'un libellé seul sur la
 * sienne (« CRP⏎142 mg/L ») — en repli seulement, et à condition que cette ligne commence par un chiffre.
 */
function applyLabelRule(rule: LabelRule, doc: SourceDoc, typed: boolean, numeric = false, dated = false): RuleMatch[] {
  const base = haystack(doc, rule.source);
  if (!base) return [];
  const ft = labelHaystack(base);
  const max = Math.min(Math.max(rule.maxLength ?? 120, 1), 500);
  const found: RuleMatch[] = [];
  /** Étendues déjà lues (libellé compris), pour ne pas compter deux fois la même mention. */
  const taken: { start: number; end: number }[] = [];

  const value = `([^\\n\\r;]{1,${max}})`;
  const patterns: { pass: 0 | 1; build: (lab: string) => string }[] = [
    { pass: 0, build: (lab) => `(?:^|[^\\p{L}\\p{N}])${lab}${LABEL_UNIT}${LABEL_SEPARATORS_BY_PASS[0]}${value}` },
    { pass: 1, build: (lab) => `(?:^|[^\\p{L}\\p{N}])${lab}${LABEL_UNIT}${LABEL_SEPARATORS_BY_PASS[1]}${value}` },
  ];
  if (numeric || dated) {
    patterns.push({
      pass: 1,
      build: (lab) => `${LINE_START}${lab}${LABEL_UNIT}${HSPACE}*\\r?\\n${HSPACE}*(?=[-+]?\\d)${value}`,
    });
  }
  for (const { pass, build } of patterns) {
    for (const label of rule.labels) {
      const re = compile(build(buildLabelPattern(label)), 'gu');
      if (!re) continue;
      let m: RegExpExecArray | null;
      while ((m = re.exec(ft.folded)) !== null && found.length < MAX_MENTIONS_PER_DOC) {
        let captured = m[2];
        if (captured === undefined || captured.trim().length === 0) continue;
        // Une variable typée (nombre, date, oui/non, choix) ne lit pas au-delà de la
        // phrase : « Âge : NR. Patient âgé de 61 ans » ne doit pas livrer « 6 », le
        // premier chiffre d'une capture coupée par la longueur maximale.
        if (typed) {
          const cut = SENTENCE_END.exec(captured);
          if (cut) captured = captured.slice(0, cut.index);
          if (captured.trim().length === 0) continue;
        }
        const start = m.index + m[0].length - m[2]!.length;
        const end = start + captured.length;
        // La capture brute peut avoir englouti la phrase suivante (« Hb : 12,6 à l'entrée. Hb : 8,1 à J3 ») :
        // la recherche reprend là où la valeur, coupée, s'arrête.
        re.lastIndex = Math.max(m.index + 1, end);
        if (taken.some((t) => m!.index < t.end && end > t.start)) continue;
        let raw: FieldValue = originalSlice(ft, start, end);
        if (raw.length === 0) continue;
        // « CRP (mg/L) : 142 » : l'unité de l'en-tête rejoint la valeur, pour que le contrôle d'unité s'applique.
        const unit = numeric ? headerUnit(m[1]) : null;
        if (unit && !/\d\s*(?:[a-zµμ%°]|\/)/iu.test(raw)) {
          const first = /^[\s:=.-]*-?\d[\d\s\u00a0\u202f.,]*/u.exec(raw);
          raw = first ? `${first[0].trim()} ${unit}${raw.slice(first[0].length)}` : raw;
        }
        // « CRP à contrôler dans 48 h », « CRP : non dosée, à refaire dans 48 h » : le nombre qui suit n'est pas la
        // valeur du libellé. La mention reste lue — sans nombre, elle est écartée et signalée, et le repli suivant
        // n'est pas tenté dans ce document, comme pour « Âge : NR ».
        if (numeric) {
          const gap = /^[^\d]*/.exec(fold(raw))![0];
          if (NOT_A_VALUE_GAP.test(gap)) raw = gap.trim() || raw;
        }
        taken.push({ start: m.index, end });
        found.push({ raw, start, end, haystack: ft, pass, labelStart: m.index });
      }
    }
  }
  return found.sort((x, y) => x.start - y.start);
}

/** Toutes les correspondances d'une expression régulière dans un document. */
function applyRegexRule(rule: RegexRule, doc: SourceDoc): RuleMatch[] {
  const ft = haystack(doc, rule.source);
  if (!ft) return [];
  const pattern = stripDiacritics(rule.pattern);
  const re = compile(pattern, (rule.flags ?? '') + 'g');
  if (!re) return [];

  const found: RuleMatch[] = [];
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
    found.push({ raw, start, end, haystack: ft });
    if (found.length >= MAX_MENTIONS_PER_DOC) break;
  }
  return found;
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
/**
 * Tranche du texte replié où les retours à la ligne de mise en page (une ligne de PDF coupée au milieu d'une phrase :
 * « Pas de⏎diabète ») deviennent des espaces. Un retour à la ligne n'est une coupure de mise en page que si la ligne
 * suivante commence, dans le texte d'origine, par une minuscule : « Pas de tabac⏎Diabète » reste deux lignes d'une liste.
 */
function softWrapped(ft: FoldedText, from: number, to: number): string {
  const slice = ft.folded.slice(from, to);
  if (!slice.includes('\n')) return slice;
  let out = '';
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!;
    if (ch === '\n' && i + 1 < slice.length + (to < ft.folded.length ? 1 : 0)) {
      const next = ft.original[ft.map[from + i + 1] ?? -1] ?? '';
      out += /\p{Ll}/u.test(next) ? ' ' : ch;
    } else out += ch;
  }
  return out;
}

function sentenceContext(window: string): string {
  const parts = window.split(/[.!?\n\r•|]/);
  return parts[parts.length - 1] ?? '';
}

/** Les termes de `list` apparaissent-ils (mots entiers) dans ce contexte ? */
function mentions(context: string, list: string[]): boolean {
  return list.some((term) => findTerm(context, term, 0) !== -1);
}

/** Mention trouvée mais ni affirmée ni niée avec assurance (« suspicion de », « non renseigné »…). */
interface FlaggedMention {
  start: number;
  end: number;
  status: MentionStatus;
  haystack: FoldedText;
}

interface KeywordScan {
  matches: RuleMatch[];
  flagged: FlaggedMention[];
}

/**
 * Toutes les mentions d'un mot-clé dans un document, chacune qualifiée.
 *
 * Pour une variable oui/non (`yesNo`), chaque mention passe en plus par les qualificatifs (`qualifiers.ts`) :
 * hypothèse, absence établie (« éliminé », « ex-fumeur »), épisode passé, antécédent, information non renseignée,
 * négation contredite. Seules les mentions affirmées donnent `emit`, et les absences établies `emitIfNegated` ; les
 * autres sont rendues à part, pour être signalées sans fournir de valeur.
 */
function applyKeywordRule(rule: KeywordRule, doc: SourceDoc, yesNo: boolean): KeywordScan {
  const scan: KeywordScan = { matches: [], flagged: [] };
  const ft = haystack(doc, rule.source);
  if (!ft) return scan;
  const window = rule.noneWindow ?? 40;
  const skipWindow = rule.skipWindow ?? Math.max(window, 80);
  const negations = (rule.none ?? []).map((n) => normalizeElision(fold(n))).filter(Boolean);
  const skips = (rule.skip ?? []).map((n) => normalizeElision(fold(n))).filter(Boolean);
  /** Positions déjà lues : « febrile » et « fébrile » repliés trouvent la même occurrence. */
  const seen = new Set<number>();

  for (const term of rule.any) {
    const needle = fold(term).trim();
    if (needle.length === 0) continue;
    let from = 0;
    for (;;) {
      const idx = findTerm(ft.folded, needle, from);
      if (idx === -1) break;
      const end = idx + needle.length;
      from = end;
      if (seen.has(idx)) continue;
      seen.add(idx);
      if (scan.matches.length + scan.flagged.length >= MAX_MENTIONS_PER_DOC) return sortScan(scan);

      // Mention hors sujet (antécédents familiaux…) : on passe, sans affirmer ni nier.
      if (skips.length > 0) {
        const around = normalizeElision(
          sentenceContext(ft.folded.slice(Math.max(0, idx - skipWindow), idx)),
        );
        if (mentions(around, skips)) continue;
      }

      // Contexte précédant l'occurrence, pour détecter « pas de », « absence de »…
      const before = normalizeElision(negationContext(softWrapped(ft, Math.max(0, idx - window), idx)));
      // Ce qui suit se lit après la fin du mot : le terme « complication » trouvé dans « Complications : aucune »
      // doit voir « : aucune », pas « s : aucune ».
      const wordEnd = end + (WORD_TAIL.exec(ft.folded.slice(end, end + 30))?.[0].length ?? 0);
      // Une règle qui déclare des négations lit aussi ce qui suit le terme :
      // « diabète (-) » ou « HTA exclue » nient autant que « pas de diabète ».
      const negated =
        mentions(before, negations) ||
        (negations.length > 0 && TRAILING_NEGATION.test(ft.folded.slice(wordEnd, wordEnd + 30)));

      if (!yesNo) {
        if (!negated) scan.matches.push({ raw: rule.emit, start: idx, end, haystack: ft });
        else if (rule.emitIfNegated !== undefined) {
          scan.matches.push({ raw: rule.emitIfNegated, start: idx, end, haystack: ft, negated: true });
        }
        continue;
      }

      const status = qualifyMention(ft.folded, idx, wordEnd, {
        negated,
        excludeHistory: rule.history === 'exclude',
      });
      switch (status) {
        case 'affirmed':
          scan.matches.push({ raw: rule.emit, start: idx, end, haystack: ft });
          break;
        case 'ruled-out':
          // « Pas de diabète » ou « diabète éliminé » : une absence documentée, si la règle prévoit
          // une valeur pour ce cas ; sinon la mention ne dit rien de plus.
          if (rule.emitIfNegated !== undefined) {
            scan.matches.push({ raw: rule.emitIfNegated, start: idx, end, haystack: ft, negated: true });
          }
          break;
        case 'history':
          // La règle ne compte que l'épisode en cours : un antécédent est hors sujet, comme une mention familiale.
          break;
        default:
          scan.flagged.push({ start: idx, end, status, haystack: ft });
      }
    }
  }
  return sortScan(scan);
}

/**
 * Dans un même document, une mention affirmée l'emporte sur une mention niée : « Pas de diabète dans la famille. Le
 * patient est diabétique » — la négation, plus large que l'affirmation, porte souvent sur autre chose. Entre deux
 * documents, en revanche, le désaccord est signalé (`resolveMentions`).
 */
/** Fin du mot entamé par un terme-racine (« diabet » dans « diabétiques »). */
const WORD_TAIL = /^[\p{L}\p{N}]*/u;

function sortScan(scan: KeywordScan): KeywordScan {
  if (scan.matches.some((m) => !m.negated)) scan.matches = scan.matches.filter((m) => !m.negated);
  scan.matches.sort((a, b) => a.start - b.start);
  scan.flagged.sort((a, b) => a.start - b.start);
  return scan;
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
/** Nombre maximal d'autres valeurs citées dans la justification d'une valeur choisie parmi plusieurs. */
const MAX_ALTERNATIVES = 4;
/** Baisse de confiance d'une valeur choisie parmi des mentions discordantes : un choix a été fait à la place du relecteur. */
const DISAGREEMENT_PENALTY = 0.15;

/** Valeur typée trouvée par une règle, avec sa source. */
interface Candidate {
  value: FieldValue;
  doc: SourceDoc;
  /** Rang du document dans l'ordre d'import, puis position dans son texte : l'ordre « premier / dernier ». */
  docIndex: number;
  position: number;
  ruleIndex: number;
  rule: ExtractionRule;
  evidence: Evidence;
}

function evidenceOf(doc: SourceDoc, rule: ExtractionRule, match: RuleMatch, field: TemplateField): Evidence {
  return match.haystack
    ? makeEvidence(doc, rule, match.haystack, match.start, match.end)
    : {
        documentId: doc.id,
        documentName: doc.name,
        snippet: `${rule.kind === 'dicom' ? rule.tag : field.key} = ${String(match.raw)}`,
        start: 0,
        end: 0,
        rule: describeRule(rule),
      };
}

/**
 * Une capture d'expression régulière arrêtée net sur une lettre que l'OCR substitue à un chiffre : « CRP\s*(\d+) » lit
 * « 1 » dans « CRP 1O mg/L ». La valeur capturée semble propre, c'est son voisinage qui la trahit.
 */
function truncatedByOcr(match: RuleMatch): string | null {
  const ft = match.haystack;
  if (!ft || match.end <= match.start) return null;
  const { start, end } = toOriginalRange(ft, match.start, match.end);
  const text = ft.original;
  // La capture elle-même et ses deux voisins de droite : « 1O » ; puis son voisin de gauche, s'il est collé (« l2 »).
  const right = ocrSuspect(text.slice(start, Math.min(text.length, end + 2)));
  if (right) return right;
  const left = start > 0 && /\d/.test(text[start] ?? '') ? ocrSuspect(text.slice(start - 1, end)) : null;
  if (left && (start < 2 || !/\p{L}/u.test(text[start - 2]!))) return left;
  return null;
}

/** Clé de comparaison de deux valeurs : « 12.6 » et « 12,6 » lus pareil, l'ordre d'un choix multiple indifférent. */
function valueKey(value: FieldValue, type: TemplateField['type']): string {
  if (Array.isArray(value)) return JSON.stringify([...value].sort());
  if (typeof value === 'number') return String(Math.round(value * 1e6) / 1e6);
  if (typeof value === 'string' && type === 'text') {
    return fold(value).replace(/\s+/g, ' ').replace(/[\s.;,:]+$/, '').trim();
  }
  return JSON.stringify(value);
}

/** Valeur lisible dans un message : « Oui », « 12,6 », « Médical, Chirurgical ». */
function formatValue(value: FieldValue): string {
  if (value === true) return 'Oui';
  if (value === false) return 'Non';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'number') return String(value).replace('.', ',');
  return String(value);
}

type Resolution =
  | { kind: 'value'; value: FieldValue; chosen: Candidate; alternatives: EvidenceAlternative[]; selection?: string }
  | { kind: 'conflict'; rejection: Rejection };

/**
 * Tranche entre les mentions d'une même règle, dans l'ordre d'import des documents puis du texte.
 *
 * Concordantes, elles donnent leur valeur. Discordantes — l'hémoglobine d'entrée dans un compte rendu, celle de sortie
 * dans un autre —, la règle de sélection de la variable (`select`) décide, et la justification garde trace des autres
 * valeurs. Sans règle de sélection, aucune valeur n'est retenue : prendre la première revenait à laisser l'ordre
 * d'import choisir, en silence. Seul le texte libre, qui ne se compare pas, retient la première par défaut.
 *
 * Les documents n'ont pas de date clinique fiable (seul le DICOM en porte une, et un compte rendu n'en a aucune
 * en métadonnée) : « première » et « dernière » s'entendent dans l'ordre d'import.
 */
function resolveMentions(field: TemplateField, candidates: Candidate[]): Resolution {
  const first = candidates[0]!;
  const distinct = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = valueKey(c.value, field.type);
    if (!distinct.has(key)) distinct.set(key, c);
  }
  if (distinct.size === 1) return { kind: 'value', value: first.value, chosen: first, alternatives: [] };

  const pick = (chosen: Candidate, selection: string): Resolution => {
    const chosenKey = valueKey(chosen.value, field.type);
    return {
      kind: 'value',
      value: chosen.value,
      chosen,
      alternatives: [...distinct.entries()]
        .filter(([key]) => key !== chosenKey)
        .slice(0, MAX_ALTERNATIVES)
        .map(([, c]) => ({
          value: c.value,
          documentId: c.doc.id,
          documentName: c.doc.name,
          snippet: c.evidence.snippet,
        })),
      selection,
    };
  };

  const policy = field.extraction.select ?? (field.type === 'text' ? 'first' : undefined);
  const orderable =
    candidates.every((c) => typeof c.value === 'number') ||
    (field.type === 'date' && candidates.every((c) => typeof c.value === 'string'));
  switch (policy) {
    case 'first':
      return pick(first, 'mentions discordantes : la première est retenue (ordre d’import des documents)');
    case 'last':
      return pick(candidates[candidates.length - 1]!, 'mentions discordantes : la dernière est retenue (ordre d’import des documents)');
    case 'max':
    case 'min': {
      if (!orderable) break;
      const better = (a: FieldValue, b: FieldValue) => (policy === 'max' ? a! > b! : a! < b!);
      const best = candidates.reduce((acc, c) => (better(c.value, acc.value) ? c : acc), first);
      return pick(best, `mentions discordantes : la ${policy === 'max' ? 'plus grande' : 'plus petite'} valeur est retenue`);
    }
    case 'any': {
      if (field.type === 'boolean') {
        const yes = candidates.find((c) => c.value === true);
        return pick(yes ?? first, 'mentions discordantes : « Oui » dès qu’une mention l’affirme');
      }
      if (field.type === 'multi') {
        const union: string[] = [];
        for (const c of candidates) {
          for (const v of Array.isArray(c.value) ? c.value : [String(c.value)]) if (!union.includes(v)) union.push(v);
        }
        return {
          kind: 'value',
          value: union,
          chosen: first,
          alternatives: [],
          selection: 'mentions différentes : leurs valeurs sont réunies',
        };
      }
      break;
    }
  }

  const shown = [...distinct.values()].slice(0, MAX_ALTERNATIVES);
  const list = shown.map((c) => `${formatValue(c.value)} (${c.doc.name})`).join(' ; ');
  return {
    kind: 'conflict',
    rejection: {
      documentId: first.doc.id,
      documentName: first.doc.name,
      snippet: first.evidence.snippet,
      reason:
        `valeurs discordantes : ${list}${distinct.size > shown.length ? ' ; …' : ''} — à trancher à la main, ` +
        'ou indiquer dans la fiche quelle valeur retenir quand les mentions divergent',
      rule: describeRule(first.rule),
      conflict: true,
    },
  };
}

/**
 * Applique les règles d'une variable à l'ensemble des documents d'un patient.
 * Les règles sont évaluées dans l'ordre : la première qui produit une valeur
 * typable gagne. Les règles suivantes servent donc de repli.
 *
 * Une règle lit toutes ses mentions, dans tous les documents : concordantes, elles donnent la valeur ; discordantes,
 * la règle de sélection de la variable tranche, ou la variable est signalée sans valeur (`resolveMentions`). Une
 * valeur qui en contient plusieurs (« favorable puis décès ») est signalée de même, sans repli.
 *
 * Une valeur trouvée mais non typable (« CRP < 5 », « Âge : NR ») laisse la main
 * aux règles suivantes — et reste consignée dans `rejected`, pour que le
 * chercheur sache qu'elle existait au lieu de croire la variable absente.
 */
/**
 * Sans séparateur (« Évolution favorable »), le libellé peut être un mot de la phrase : « Suites marquées par une
 * complication infectieuse » n'est pas « Évolution : complications ». Pour une variable à choix, la valeur n'est lue
 * dans ce cas que si une modalité (ou une de ses écritures) ouvre le texte qui suit le libellé ; une modalité enfouie
 * plus loin dans la phrase ne compte pas.
 */
function choiceLeads(field: TemplateField, match: RuleMatch): boolean {
  if (field.type !== 'enum' && field.type !== 'multi' && field.type !== 'boolean') return true;
  const head = stripDiacritics(String(match.raw ?? ''))
    .toLowerCase()
    .replace(/^[\s:=\-–—.,;]+/, '');
  if (!head) return false;
  const choices = [
    ...(field.type === 'boolean' ? ['oui', 'non', 'positif', 'negatif', 'present', 'absent'] : field.options),
    ...Object.keys(field.extraction.postProcess?.valueMap ?? {}),
  ]
    .map((c) => stripDiacritics(c).toLowerCase().trim())
    .filter(Boolean);
  return choices.some((c) => head === c || (head.startsWith(c) && !/[\p{L}\p{N}]/u.test(head.charAt(c.length))));
}

export function extractFieldDetailed(field: TemplateField, docs: SourceDoc[]): FieldExtraction {
  const { extraction } = field;
  const rejected: Rejection[] = [];
  if (!extraction.enabled) return { hit: null, rejected };
  const note = (r: Rejection) => {
    if (rejected.length < MAX_REJECTED) rejected.push(r);
  };
  const numeric = field.type === 'number' || field.type === 'integer';
  /**
   * Oui/non : libellé et mot-clé lisent la même notion. « Diabète : oui » dans un compte rendu et « pas de diabète »
   * dans un autre se contredisent, même lus par deux règles différentes : les mentions de toutes les règles sont
   * mises en commun avant d'être tranchées. Pour les autres types, les règles suivantes restent des replis.
   */
  // Choix multiple dont les valeurs se réunissent : chaque règle apporte ses options (scanner, IRM…), aucune n'est un repli.
  const pooled = field.type === 'boolean' || (field.type === 'multi' && extraction.select === 'any');
  const pool: Candidate[] = [];
  /**
   * Étendues déjà lues par une règle à libellé ou à motif, par document : « Complications : aucune » est une réponse,
   * le mot-clé « complication » qui s'y trouve ne doit pas la relire à sa façon.
   */
  const covered = new Map<number, { start: number; end: number }[]>();
  const isCovered = (docIndex: number, start: number, end: number) =>
    (covered.get(docIndex) ?? []).some((c) => start < c.end && end > c.start);

  for (let i = 0; i < extraction.rules.length; i++) {
    const rule = extraction.rules[i]!;
    const candidates: Candidate[] = [];
    const conflicts: Rejection[] = [];

    for (let docIndex = 0; docIndex < docs.length; docIndex++) {
      const doc = docs[docIndex]!;
      if (!docAllowed(rule, doc)) continue;

      /** Mentions par ordre de fiabilité : un groupe n'est lu que si le précédent n'a rien trouvé dans ce document. */
      let groups: RuleMatch[][] = [];
      let flagged: FlaggedMention[] = [];
      try {
        switch (rule.kind) {
          case 'label': {
            const all = applyLabelRule(rule, doc, field.type !== 'text', numeric, field.type === 'date');
            groups = [all.filter((m) => m.pass === 0), all.filter((m) => m.pass === 1 && choiceLeads(field, m))];
            break;
          }
          case 'regex':
            groups = [applyRegexRule(rule, doc)];
            break;
          case 'keyword': {
            const scan = applyKeywordRule(rule, doc, field.type === 'boolean');
            groups = [scan.matches];
            flagged = scan.flagged;
            break;
          }
          case 'dicom': {
            const match = applyDicomRule(rule, doc);
            groups = [match ? [match] : []];
            break;
          }
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
        note({
          documentId: doc.id,
          documentName: doc.name,
          snippet: '(aucun extrait : la règle n’a pas pu être appliquée)',
          reason,
          rule: describeRule(rule),
        });
        continue;
      }

      // Variable de l'arrivée : une mention datée plus tard dans le séjour (« à J4 », « postopératoire ») est écartée.
      if (extraction.episode === 'admission') {
        const later = (m: { start: number; end: number; haystack: FoldedText | null }) =>
          m.haystack !== null && laterInStay(m.haystack.folded, m.start, m.end);
        groups = groups.map((g) => g.filter((m) => !later(m)));
        flagged = flagged.filter((f) => !later(f));
      }

      if (pooled && rule.kind === 'keyword') {
        // Étendues comparées dans le texte d'origine : un libellé se lit dans un texte aux coupures de mot recousues.
        const inOriginal = (m: { start: number; end: number; haystack: FoldedText | null }) =>
          m.haystack ? toOriginalRange(m.haystack, m.start, m.end) : m;
        groups = groups.map((g) =>
          g.filter((m) => {
            const r = inOriginal(m);
            return !isCovered(docIndex, r.start, r.end);
          }),
        );
        flagged = flagged.filter((f) => {
          const r = inOriginal(f);
          return !isCovered(docIndex, r.start, r.end);
        });
      }

      // Hypothèse, « non renseigné », négation contredite : trouvé, mais rien d'assez sûr pour être retenu.
      for (const f of flagged) {
        note({
          documentId: doc.id,
          documentName: doc.name,
          snippet: makeEvidence(doc, rule, f.haystack, f.start, f.end).snippet,
          reason: describeStatus(f.status),
          rule: describeRule(rule),
        });
      }

      for (const group of groups) {
        for (const match of group) {
          const evidence = evidenceOf(doc, rule, match, field);
          const ocr = numeric && rule.kind === 'regex' ? truncatedByOcr(match) : null;
          const typed = ocr
            ? ({
                ok: false,
                reason: `caractère ambigu « ${ocr} » autour de la valeur capturée (lecture optique probable) : à vérifier puis saisir à la main`,
              } as const)
            : coerce(withTableUnit(match, numeric), field.type, field.options, extraction.postProcess, field.unit);
          if (!typed.ok) {
            const rejection: Rejection = {
              documentId: doc.id,
              documentName: doc.name,
              snippet: evidence.snippet,
              reason: typed.reason,
              rule: describeRule(rule),
            };
            if ('conflict' in typed && typed.conflict) conflicts.push({ ...rejection, conflict: true });
            else note(rejection);
            continue;
          }
          candidates.push({ value: typed.value, doc, docIndex, position: match.start, ruleIndex: i, rule, evidence });
          if (pooled && rule.kind !== 'keyword' && match.haystack) {
            const spans = covered.get(docIndex) ?? [];
            spans.push(toOriginalRange(match.haystack, match.labelStart ?? match.start, match.end));
            covered.set(docIndex, spans);
          }
        }
        // « Âge : NR. Patient âgé de 61 ans » : la mention explicite, même illisible, fait foi pour ce document ;
        // le repli à simple espace (« âgé de 61 ») n'est lu que si elle n'existe pas.
        if (group.length > 0) break;
      }
    }

    // Une valeur qui en cite plusieurs se tranche à la main : aucune règle de repli ne doit choisir à sa place.
    if (conflicts.length > 0) {
      return { hit: null, rejected: [...conflicts, ...rejected].slice(0, MAX_REJECTED) };
    }
    if (candidates.length === 0) continue;
    if (pooled) {
      pool.push(...candidates);
      continue;
    }
    return settle(field, candidates, rejected);
  }

  if (pool.length > 0) {
    pool.sort((a, b) => a.docIndex - b.docIndex || a.position - b.position || a.ruleIndex - b.ruleIndex);
    return settle(field, pool, rejected);
  }
  return { hit: null, rejected };
}

/** Tranche entre les mentions retenues et construit la valeur, sa confiance et sa justification. */
function settle(field: TemplateField, candidates: Candidate[], rejected: Rejection[]): FieldExtraction {
  // Variable de synthèse : ce que disent les fichiers DICOM (la modalité de l'examen réellement acquis) fait foi ; le
  // texte, lui, ne fait que proposer.
  if (field.extraction.suggestOnly) {
    const dicom = candidates.filter((c) => c.rule.kind === 'dicom');
    if (dicom.length > 0) candidates = dicom;
  }
  const resolved = resolveMentions(field, candidates);
  if (resolved.kind === 'conflict') {
    return { hit: null, rejected: [resolved.rejection, ...rejected].slice(0, MAX_REJECTED) };
  }

  // Variable de synthèse : les mentions trouvées sont proposées, la variable reste à valider (sauf DICOM).
  if (field.extraction.suggestOnly && candidates.some((c) => c.rule.kind !== 'dicom')) {
    const first = resolved.chosen;
    const sources = [...new Set(candidates.map((c) => c.doc.name))].slice(0, MAX_ALTERNATIVES).join(', ');
    const suggestion: Rejection = {
      documentId: first.doc.id,
      documentName: first.doc.name,
      snippet: first.evidence.snippet,
      reason:
        `mentions trouvées : ${formatValue(resolved.value)} (${sources}) — variable de synthèse, à valider : ` +
        'une mention ne dit pas que l’examen ou le traitement a eu lieu pendant ce séjour',
      rule: describeRule(first.rule),
    };
    return { hit: null, rejected: [suggestion, ...rejected].slice(0, MAX_REJECTED) };
  }

  const { chosen } = resolved;
  const base = chosen.rule.confidence ?? DEFAULT_CONFIDENCE[chosen.rule.kind];
  // Léger décalage selon le rang : les règles de repli sont moins sûres.
  let confidence = Math.max(0.05, Math.min(1, base - chosen.ruleIndex * 0.03));
  if (resolved.alternatives.length > 0) confidence = Math.max(0.05, confidence - DISAGREEMENT_PENALTY);
  const evidence: Evidence = { ...chosen.evidence };
  if (resolved.alternatives.length > 0) evidence.alternatives = resolved.alternatives;
  if (resolved.selection) evidence.selection = resolved.selection;

  return {
    hit: { value: resolved.value, confidence: Number(confidence.toFixed(2)), evidence },
    // Une valeur écartée par une règle de rang inférieur ne compte plus
    // quand une règle suivante a produit une valeur utilisable.
    rejected: [],
  };
}

/** Version simple : la valeur retenue, ou `null`. */
export function extractField(field: TemplateField, docs: SourceDoc[]): RuleHit | null {
  return extractFieldDetailed(field, docs).hit;
}
