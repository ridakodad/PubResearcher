/**
 * Qualificatifs d'une mention clinique : ce que la phrase dit *de* la maladie, et pas seulement qu'elle la nomme.
 *
 * « Suspicion de diabète », « HTA ? (à confirmer) », « diabète éliminé », « ancien fumeur », « pneumopathie fébrile
 * en 2019 », « tabagisme non renseigné » nomment tous la variable sans l'affirmer pour le patient, aujourd'hui. Lire
 * « Oui » dans chacun de ces cas fabrique une donnée ; lire « Non » dans « tabagisme non renseigné » aussi. Ce module
 * classe une mention en quelques catégories, avec des indices volontairement étroits et une portée limitée à la
 * proposition (ou à la phrase pour les antécédents) : dans le doute, la mention n'est pas retenue et reste visible
 * comme valeur écartée, plutôt que d'être affirmée ou niée à tort.
 *
 * Tout travaille sur du texte replié (minuscules, sans accents, apostrophe droite). Les motifs sont ancrés ou
 * bornés, sans quantificateur imbriqué : leur coût reste linéaire quelle que soit la phrase.
 */

/**
 * Ce que dit une mention, du plus au moins prioritaire.
 *
 * - `not-documented` : « tabagisme non renseigné », « HTA : NR » — l'information manque, ce n'est pas un « Non ».
 * - `uncertain`      : hypothèse, suspicion, « ? », « à confirmer », « à éliminer » — rien n'est établi.
 * - `ruled-out`      : « diabète éliminé », « ex-fumeur », « tabagisme sevré » — absent aujourd'hui : vaut négation.
 * - `contradicted`   : négation aussitôt contredite (« pas de complication… mais pneumopathie ») ou restreinte
 *                      (« pas de complication immédiate ») — ni oui ni non sûrs.
 * - `past`           : épisode passé et clos (« fébrile en 2019 », « HTA gravidique », « diabète gestationnel »).
 * - `history`        : citée dans les antécédents (« Antécédents : … », « ATCD de … »), écartée seulement par les
 *                      règles qui ne comptent que l'épisode en cours.
 * - `affirmed`       : rien de ce qui précède.
 */
export type MentionStatus =
  | 'affirmed'
  | 'not-documented'
  | 'uncertain'
  | 'ruled-out'
  | 'contradicted'
  | 'past'
  | 'history';

/** Ponctuation qui ferme une proposition (le « ? » est traité à part : c'est un indice d'incertitude). */
const CLAUSE_END = /[,;.!?\n\r•|]/;
/** Ponctuation qui ferme une phrase. */
const SENTENCE_END = /[.!?\n\r•|]/;

/** Ce qui suit le terme jusqu'à la fin de sa proposition, parenthèses comprises : « HTA ? (à confirmer) ». */
function clauseAfter(folded: string, end: number, max = 80): string {
  const tail = folded.slice(end, end + max);
  // Un « ? » collé au terme est un indice, pas une fin de proposition : on le garde dans la portée.
  const lead = /^\s*\?+/.exec(tail)?.[0] ?? '';
  const rest = tail.slice(lead.length);
  const cut = CLAUSE_END.exec(rest);
  return lead + (cut ? rest.slice(0, cut.index) : rest);
}

/** Ce qui précède le terme depuis le début de sa proposition. */
function clauseBefore(folded: string, start: number, max = 60): string {
  const head = folded.slice(Math.max(0, start - max), start);
  const parts = head.split(CLAUSE_END);
  return parts[parts.length - 1] ?? '';
}

/** Ce qui précède le terme depuis le début de sa phrase (la virgule ne coupe pas : « Antécédents : HTA, diabète »). */
function sentenceBefore(folded: string, start: number, max = 160): string {
  const head = folded.slice(Math.max(0, start - max), start);
  const parts = head.split(SENTENCE_END);
  return parts[parts.length - 1] ?? '';
}

/** Ce qui suit le terme jusqu'à la fin de sa phrase. */
function sentenceAfter(folded: string, end: number, max = 200): string {
  const tail = folded.slice(end, end + max);
  const cut = SENTENCE_END.exec(tail);
  return cut ? tail.slice(0, cut.index) : tail;
}

// ------------------------------------------------------------------ indices

/** Absence d'information, juste après le terme ou en réponse à un libellé : « non renseigné », « NR », « inconnu ». */
const NOT_DOCUMENTED =
  /^[\s:=(-]*(?:non\s+(?:renseigne|precise|documente|evalue|communique|disponible|recherche|retrouve dans le dossier)|n\.?r\.?(?![a-z])|n\.?c\.?(?![a-z])|inconnue?s?\b|indetermine|ne sait pas|non connu du patient|statut inconnu)/;

/**
 * Hypothèse placée APRÈS le terme, dans la proposition : « HTA probable », « diabète à éliminer », « HTA ? ».
 *
 * « Ancien » juste après le terme y figure aussi, comme ambiguïté : « HTA ancienne » est une HTA de longue date,
 * « tabagisme ancien » un tabagisme arrêté. Ni « Oui » ni « Non » sans relecture.
 */
const AMBIGUOUS_AFTER = /^[\s:=]*anciens?\b|^[\s:=]*anciennes?\b/;
const UNCERTAIN_AFTER =
  /^[\s:=]*\?|^\s*passi(?:f|ve|fs|ves)\b|\b(?:probables?|possibles?|suspecte?s?|suspicion|presumee?s?|douteu(?:x|se)s?|evoquee?s?|hypothetique|eventuel(?:le)?s?|a (?:confirmer|eliminer|exclure|discuter|evoquer|rechercher|verifier|preciser|explorer|documenter|objectiver)|non (?:confirmee?s?|exclue?s?|eliminee?s?|ecartee?s?)|pas (?:exclue?s?|eliminee?s?)|ne peut (?:etre )?(?:exclue?|eliminee?|ecartee?))\b/;

/**
 * Hypothèse placée AVANT le terme, à trois mots au plus : « suspicion de diabète », « probable HTA », « recherche
 * d'un diabète », « risque de décès », « prévention de la MTEV » (un risque ou une prévention ne sont pas l'événement). Au-delà, l'hypothèse porte sur autre chose (« suspicion d'embolie chez un patient diabétique »).
 */
const UNCERTAIN_BEFORE =
  /\b(?:suspicion|suspecte?|probable|possible|eventuel(?:le)?|hypothese|evocat(?:eur|rice)|evoquant|evoque|compatible avec|en faveur|recherche|depistage|doute|risques?|prevention|prophylaxie)\b(?:\s*(?:d'|de |du |des |la |le |l'|un |une |avec )?\s*)(?:[a-z0-9'-]+\s+){0,3}$/;

/**
 * Absence actuelle établie, juste APRÈS le terme : « diabète éliminé », « tabagisme sevré », « tabac arrêté ».
 * « Ancien » n'en fait pas partie : placé après une maladie, il la dit ancienne, donc présente (« diabète ancien »).
 */
const RULED_OUT_AFTER =
  /^[\s:=]*(?:(?:est|etait|a ete|semble|actuellement|desormais|totalement|completement|definitivement)\s+)?(?:elimine|exclu|ecarte|infirme|sevre|arrete|stoppe|interrompu|abandonne)(?:e|s|es)?\b/;

/** Absence actuelle établie, juste AVANT le terme : « ex-fumeur », « ancien fumeur », « sevrage tabagique ». */
const RULED_OUT_BEFORE =
  /(?:^|[^a-z])(?:ex|anciens?|anciennes?|sevre(?:e|s|es)?\s+(?:du|de|d')?|sevrage|arret\s+(?:du|de|d')|a arrete\s+(?:le|la|l'|de|d')?|a cesse\s+(?:le|la|l'|de|d')?)[\s'-]*$/;

/** Conjonction qui contredit une négation dans la même phrase : « pas de complication… mais pneumopathie ». */
const CONTRADICTION = /\b(?:mais|cependant|toutefois|neanmoins|pourtant|en revanche|sauf|hormis|excepte|a l'exception)\b/;

/** Négation restreinte dans le temps : « pas de complication immédiate » ne dit rien des suivantes. */
const RESTRICTED_AFTER =
  /^\s*(?:[a-z-]+\s+)?(?:immediate?s?|precoces?|initiale?s?|initiaux|per-?\s?operatoires?|intra-?\s?operatoires?|anesthesiques?|a ce stade|pour le moment|pour l'instant|a court terme|jusqu'a present|a ce jour|(?:connue?s?\s+)?avant (?:la grossesse|l'hospitalisation|l'admission|l'intervention|ce sejour|cet episode))\b/;

/**
 * Épisode passé et clos, dans la proposition du terme : année précédée de « en » (« fébrile en 2019 »), « il y a
 * N ans », « lors de sa grossesse », « dans l'enfance », « résolutif », « guéri » ; ou une forme transitoire par nature
 * (« HTA gravidique », « diabète gestationnel »).
 */
const PAST_EPISODE =
  /\b(?:en (?:(?:janvier|fevrier|mars|avril|mai|juin|juillet|aout|septembre|octobre|novembre|decembre) )?(?:19|20)\d\d|il y a \d+ (?:ans?|mois|semaines?)|lors (?:de|d'|du|des)|dans l'enfance|dans (?:sa|son) (?:enfance|jeunesse)|pendant (?:sa|la) grossesse|resolutive?s?|resolue?s?|guerie?s?|regressive?s?|gravidiques?|gestationnel(?:le)?s?)\b/;

/** Épisode clos par nature, quelle que soit la rubrique : « gestationnel », « gravidique », « résolutif », « guéri ». */
const TRANSIENT = /\b(?:resolutive?s?|resolue?s?|guerie?s?|regressive?s?|gravidiques?|gestationnel(?:le)?s?)\b/;

/** Ce qui fait d'une date le début d'un état toujours présent : « depuis 2010 », « découvert en 2015 ». */
const ONGOING = /\b(?:depuis|decouverte?s?|diagnostiquee?s?|connue?s?|depistee?s?|actuellement|toujours|persistante?s?|chronique)\b/;

/** Date d'un épisode en cours, avant le terme : « admis en mars 2024 pour fièvre » n'est pas un épisode passé. */
const CURRENT_EPISODE = /\b(?:admise?s?|hospitalisee?s?|adressee?s?|entree?s?|consulte|amenee?s?|transferee?s?|vue?s?|recue?s?|opere(?:e|s|es)?)\b/;

/** Rubrique des antécédents : « Antécédents : … », « ATCD de … ». */
const HISTORY = /\b(?:antecedents?|atcd|anamnese)\b/g;

/**
 * La mention tombe-t-elle sous une rubrique d'antécédents ouverte plus tôt dans la phrase ?
 *
 * « Sans antécédent notable, admis pour fièvre » ne range pas la fièvre dans les antécédents : une rubrique niée ne
 * compte pas. « Antécédents : diabète ; motif : fièvre » non plus : un nouveau libellé (« motif : ») ferme la rubrique.
 */
function underHistory(sentence: string): boolean {
  let last: RegExpExecArray | null = null;
  HISTORY.lastIndex = 0;
  for (let m = HISTORY.exec(sentence); m !== null; m = HISTORY.exec(sentence)) last = m;
  if (!last) return false;
  const lead = sentence.slice(Math.max(0, last.index - 16), last.index);
  if (/(?:sans|pas d'?|pas de|aucun|absence d'?|absence de)\s*$/.test(lead)) return false;
  const rest = sentence.slice(last.index + last[0].length);
  if (/^\s*(?:particuliers?|notables?|connus?)\b/.test(rest)) return false;
  // Le deux-points de la rubrique elle-même est admis ; un second libellé la referme.
  const body = rest.replace(/^[^:]*?:/, '');
  return !/[a-z)]\s*:/.test(body);
}

export interface QualifyOptions {
  /** La mention est-elle déjà niée par la règle (liste « none », négation qui suit) ? */
  negated: boolean;
  /** Écarter les mentions placées dans les antécédents (variables de l'épisode en cours : fièvre, complication). */
  excludeHistory: boolean;
}

/**
 * Classe la mention `[start, end)` d'un texte replié.
 *
 * L'ordre compte : « non renseigné » et « à éliminer » priment sur une négation (« diabète non exclu » n'est pas un
 * « Non ») ; une négation contredite dans la phrase n'est plus une négation sûre ; un antécédent n'est écarté qu'à
 * la demande de la règle.
 */
export function qualifyMention(folded: string, start: number, end: number, options: QualifyOptions): MentionStatus {
  const after = clauseAfter(folded, end);
  const before = clauseBefore(folded, start);

  if (NOT_DOCUMENTED.test(after)) return 'not-documented';
  if (UNCERTAIN_AFTER.test(after) || UNCERTAIN_BEFORE.test(before) || AMBIGUOUS_AFTER.test(after)) return 'uncertain';

  const ruledOut = RULED_OUT_AFTER.test(after) || RULED_OUT_BEFORE.test(before);
  if (options.negated || ruledOut) {
    // Une absence affirmée puis contredite, ou limitée à une période, n'est pas une absence sûre.
    if (CONTRADICTION.test(sentenceAfter(folded, end))) return 'contradicted';
    if (RESTRICTED_AFTER.test(after)) return 'contradicted';
    return 'ruled-out';
  }

  const pastAfter = PAST_EPISODE.test(after);
  const pastBefore = PAST_EPISODE.test(before) && !CURRENT_EPISODE.test(before);
  if ((pastAfter || pastBefore) && !ONGOING.test(after) && !ONGOING.test(before)) {
    // « ATCD : AVC en 2019 » : sous la rubrique des antécédents, un événement daté est précisément l'antécédent que
    // la variable recueille — pour une règle qui compte les antécédents. Une forme transitoire par nature (« diabète
    // gestationnel », « HTA gravidique », « résolutive ») reste un épisode clos.
    const transient = TRANSIENT.test(after) || TRANSIENT.test(before);
    if (!options.excludeHistory && !transient && underHistory(sentenceBefore(folded, start))) return 'affirmed';
    return 'past';
  }
  if (options.excludeHistory && underHistory(sentenceBefore(folded, start))) return 'history';
  return 'affirmed';
}

/**
 * Qualifie la réponse lue après un libellé (« Diabète : … ») pour une variable oui/non.
 *
 * - `not-documented` : « non renseigné », « NR », « ? » seul ;
 * - `uncertain`      : « probable », « suspecté », « à confirmer », « oui ? » ;
 * - `ruled-out`      : « éliminé », « sevré en 2015 », « ancien », « ex » — vaut « Non » pour l'état actuel ;
 * - `contradicted`   : une négation suivie de « mais … » ;
 * - `null`           : rien de particulier, la lecture oui/non habituelle s'applique.
 */
export function qualifyAnswer(foldedAnswer: string): Exclude<MentionStatus, 'affirmed' | 'past' | 'history'> | null {
  const s = foldedAnswer.trim();
  if (s.length === 0) return null;
  if (/^\?+$/.test(s) || NOT_DOCUMENTED.test(s)) return 'not-documented';
  if (UNCERTAIN_AFTER.test(s) || /\?/.test(s)) return 'uncertain';
  // « Sevré » vaut pour toute la réponse : « oui, sevré depuis 2 ans » décrit un ancien fumeur.
  // « Non prêt au sevrage », « sevrage envisagé », « aide au sevrage proposée » : le patient fume encore.
  if (/\bsevrage\b/.test(s) && /\b(?:non|pas)\s+pret|\benvisag|\bpropos|\bsouhait|\baide au sevrage|\ben cours de sevrage|\bconsultation\b/.test(s)) {
    return 'uncertain';
  }
  if (/^(?:ex\b|ex-|arret\b)/.test(s) || /\b(?:sevree?s?|sevrage)\b/.test(s) || RULED_OUT_AFTER.test(s)) {
    return 'ruled-out';
  }
  // « Ancien » seul répond à la question (« Tabac : ancien », « ancien fumeur ») ; suivi d'autre chose, il peut aussi
  // qualifier une maladie de longue date (« HTA ancienne, sous bithérapie ») : ambigu.
  // « Ancien fumeur » est un ancien fumeur ; « ancien(ne) » seul dépend de la variable — « Tabac : ancien » (sevré)
  // mais « HTA ancienne » (de longue date) — : ambigu ici, la fiche le traduit au besoin (`valueMap` du tabagisme).
  if (/^(?:anciens?|anciennes?)\s+(?:fumeur|fumeuse|fumeurs|fumeuses)[\s.;,]*$/.test(s)) return 'ruled-out';
  if (/^(?:anciens?|anciennes?)\b/.test(s)) return 'uncertain';
  if (/^(?:non|pas|aucun|aucune|absence|sans|neant|negatif|negative|ras)\b/.test(s) && CONTRADICTION.test(s)) {
    return 'contradicted';
  }
  return null;
}

/** Libellé lisible d'une mention écartée, pour la liste des valeurs à trancher. */
export function describeStatus(status: MentionStatus): string {
  switch (status) {
    case 'not-documented':
      return 'non renseigné dans le document : la variable reste vide';
    case 'uncertain':
      return 'mention incertaine (hypothèse, suspicion, « ? », « à confirmer ») : à vérifier';
    case 'contradicted':
      return 'négation contredite ou restreinte dans la même phrase (« mais… », « immédiate ») : à trancher';
    case 'past':
      return 'épisode passé (date ancienne, « résolutif », « gestationnel »…) : non retenu pour l’état actuel';
    case 'history':
      return 'mention placée dans les antécédents : non retenue pour l’épisode en cours';
    case 'ruled-out':
      return 'absence établie (« éliminé », « sevré », « ancien »)';
    case 'affirmed':
      return 'mention affirmée';
  }
}

/**
 * Indices d'une mention datée après l'arrivée : jour d'hospitalisation (« J4 », « (J2) »), suites opératoires,
 * « au cours du séjour », « secondairement », « pic fébrile ». Une date seule ne suffit pas : l'entrée aussi est datée.
 */
const LATER_IN_STAY =
  /(?:\bj\s?[1-9]\d?\b|\bpost-?op|\bpostoperatoire|\bapres (?:l'intervention|l'operation|la chirurgie)|\bau cours (?:du sejour|de l'hospitalisation|de son sejour)|\bpendant (?:le sejour|l'hospitalisation|son sejour)|\ben cours de sejour|\bdurant (?:le|son) sejour|\bsecondairement|\bpic febrile|\bdans les suites|\b(?:baisse|chute|ascension|remontee|aggravation|normalisation|deglobulisation)\s+(?:de|du|des|a)\b|\bnadir\b)/;

/**
 * Indices d'une valeur antérieure à l'arrivée : « dernier bilan (octobre 2025) », « bilan antérieur », « valeur
 * habituelle », « créatinine de base », « en ville », « pré-cure ».
 */
const BEFORE_STAY =
  /(?:\bdernier bilan|\bbilan (?:anterieur|precedent|habituel|de ville|pre-?cure|pre-?therapeutique)|\bvaleurs? (?:habituelles?|de base|anterieures?)|\bde base\b|\bhabituel(?:le)?s?\b|\ben ville\b|\bpre-?cure\b|\bil y a \d+\s*(?:jours?|semaines?|mois|ans?)\b)/;

/**
 * La mention `[start, end)` décrit-elle un moment postérieur à l'arrivée ? La phrase qui la précède et la proposition
 * qui la suit sont lues : « Le 13/09 (J4), pneumopathie : fièvre à 38,7 °C » comme « fièvre à 38,7 °C à J4 ».
 */
export function laterInStay(folded: string, start: number, end: number): boolean {
  // La mention elle-même fait partie de l'indice : « pic fébrile » se lit à cheval sur le terme « fébrile ». Une
  // valeur longue (« 11 g/dL puis 9,5 g/dL à J3 », lue après un libellé) ne compte que par son début : c'est sa
  // première valeur qui est retenue, et elle date de l'arrivée.
  const mention = folded.slice(start, end);
  // Après une valeur chiffrée, la suite ne la concerne que jusqu'au nombre suivant : dans « 11 g/dL puis 9,5 g/dL à
  // J3 », « à J3 » date la seconde valeur, pas la première.
  let after = clauseAfter(folded, end);
  if (/^\d/.test(mention)) after = after.slice(0, after.search(/\d/) === -1 ? after.length : after.search(/\d/));
  const own = mention.length <= 25 ? mention + after : mention.slice(0, 12);
  const sentence = sentenceBefore(folded, start) + own;
  // Une valeur antérieure à l'arrivée (« dernier bilan : créatinine 11 ») n'est pas plus l'état d'entrée.
  return LATER_IN_STAY.test(sentence) || BEFORE_STAY.test(sentence);
}
