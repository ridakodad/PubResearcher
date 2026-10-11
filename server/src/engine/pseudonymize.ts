/**
 * Pseudonymisation locale du texte envoyé à Claude.
 *
 * Les documents importés devraient déjà être anonymisés (charte affichée avant l'import), mais un compte rendu garde
 * souvent un nom dans l'en-tête, un numéro de téléphone ou une date de naissance. Avant tout envoi à l'API, ce module
 * remplace ces données directement identifiantes par une étiquette (`[NOM]`, `[TÉLÉPHONE]`…) : la méthodologie de
 * référence MR-004 n'autorise un transfert hors de l'Union que de données pseudonymisées et strictement nécessaires.
 *
 * Ce qui est remplacé : noms précédés d'une civilité ou d'un titre (M., Mme, Dr…) et champs « Nom », « Prénom » ;
 * dates de naissance ; numéros de sécurité sociale ; téléphones ; adresses électroniques ; identifiants de dossier
 * annoncés par leur libellé (IPP, NDA, N° de dossier) ; adresses postales. Les valeurs cliniques (examens, dates de
 * soins, traitements) ne sont pas touchées : ce sont elles que Claude doit relever.
 *
 * Ce n'est pas une anonymisation : un nom sans civilité, au milieu d'une phrase, passe. Le texte reste donc
 * « pseudonymisé », et la charte d'anonymisation garde tout son sens.
 *
 * Chaque remplacement garde sa position d'origine : une citation relevée dans le texte pseudonymisé est ramenée au
 * texte du document, pour que l'extrait surligné à la relecture soit celui du dossier.
 */

export type PseudonymKind = 'nom' | 'naissance' | 'nir' | 'telephone' | 'email' | 'identifiant' | 'adresse';

const LABELS: Record<PseudonymKind, string> = {
  nom: '[NOM]',
  naissance: '[DATE DE NAISSANCE]',
  nir: '[N° SÉCURITÉ SOCIALE]',
  telephone: '[TÉLÉPHONE]',
  email: '[E-MAIL]',
  identifiant: '[IDENTIFIANT]',
  adresse: '[ADRESSE]',
};

interface Hit {
  start: number;
  end: number;
  kind: PseudonymKind;
}

/** Un segment du texte produit : recopié du document (`kept`) ou mis à la place d'un passage (`replaced`). */
interface Segment {
  from: number;
  to: number;
  originalFrom: number;
  originalTo: number;
  replaced: boolean;
}

export interface Pseudonymized {
  text: string;
  /** Nombre de remplacements, par nature de donnée. */
  counts: Partial<Record<PseudonymKind, number>>;
  /** Ramène une plage du texte pseudonymisé au texte d'origine. */
  toOriginal(start: number, end: number): { start: number; end: number };
}

const UPPER_WORD = String.raw`\p{Lu}[\p{L}'’\-]+`;

/**
 * Motifs : chacun désigne, par le groupe nommé `v`, la partie à remplacer (le libellé qui l'annonce reste en clair,
 * ce qui garde la phrase lisible pour le modèle). Bornés et sans répétition imbriquée : aucun retour arrière explosif.
 */
const PATTERNS: readonly { kind: PseudonymKind; re: RegExp }[] = [
  { kind: 'email', re: /(?<v>[\p{L}\d._%+-]{1,64}@[\p{L}\d.-]{1,128}\.[a-z]{2,10})/giu },
  // Numéro de sécurité sociale : 13 chiffres (sexe, année, mois, département, commune, ordre), clé facultative.
  { kind: 'nir', re: /(?<![\d])(?<v>[12][ .]?\d{2}[ .]?\d{2}[ .]?(?:\d{2}|2[AB])[ .]?\d{3}[ .]?\d{3}(?:[ .]?\d{2})?)(?![\d])/g },
  // Téléphones : indicatif international (+33, +212…) ou numéro national à dix chiffres commençant par 0.
  { kind: 'telephone', re: /(?<![\d+])(?<v>(?:\+|00)\d{2,3}[ .-]?\(?0?\)?[ .-]?\d(?:[ .-]?\d{2}){4})(?![\d])/g },
  { kind: 'telephone', re: /(?<![\d])(?<v>0[1-9](?:[ .-]?\d{2}){4})(?![\d])/g },
  {
    kind: 'naissance',
    re: /\b(?:n[ée]e?\s+le|date\s+de\s+naissance|DDN)\s*:?\s*(?<v>\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{1,2}(?:er)?\s+\p{L}{3,9}\.?\s+\d{4})/giu,
  },
  {
    kind: 'identifiant',
    re: /\b(?:IPP|NIP|NDA|N°\s*(?:de\s+)?(?:dossier|patient|s[ée]jour|venue)|num[ée]ro\s+(?:de\s+)?(?:dossier|patient|s[ée]jour))\s*:?\s*(?<v>[A-Z0-9][A-Z0-9/-]{3,24})/giu,
  },
  // Champs d'en-tête « Nom : … », « Prénom : … », « Nom de naissance : … » : jusqu'à la fin de la ligne ou du champ.
  {
    kind: 'nom',
    re: /\b(?:nom(?:\s+(?:de\s+naissance|d['’]usage|de\s+jeune\s+fille|marital))?|pr[ée]noms?|patient(?:e)?)\s*:\s*(?<v>[\p{L}'’ -]{2,60}?)(?=\s*(?:[,;\n\r]|$|n[ée]e?\s|\s{2}|\bpr[ée]nom))/gimu,
  },
  // Civilité ou titre suivi d'un à trois mots à majuscule initiale : « Mme DUPONT Marie », « Dr Martin ».
  {
    kind: 'nom',
    re: new RegExp(
      String.raw`(?<![\p{L}])(?:M\.|Mr\.?|Mme\.?|Mlle\.?|Monsieur|Madame|Mademoiselle|Dr\.?|Docteur|Pr\.?|Professeur)\s+(?<v>${UPPER_WORD}(?:[ ](?:${UPPER_WORD})){0,2})`,
      'gu',
    ),
  },
  {
    kind: 'adresse',
    re: /(?<![\p{L}\d])(?<v>\d{1,4}(?:\s?(?:bis|ter))?,?\s+(?:rue|avenue|av\.|boulevard|bd|chemin|all[ée]e|place|impasse|route|quai|cours|r[ée]sidence|lotissement|hay|derb)\b[^\n;]{2,80}?(?:\d{5}\s+[\p{L}' -]{2,40}?)?)(?=[\n;]|$|\.\s)/gimu,
  },
];

/** Repère et remplace les données directement identifiantes d'un texte. */
export function pseudonymize(input: string): Pseudonymized {
  const hits: Hit[] = [];
  for (const { kind, re } of PATTERNS) {
    for (const match of input.matchAll(re)) {
      const value = match.groups?.v;
      if (!value || value.trim().length === 0) continue;
      const offset = match[0].indexOf(value);
      const start = (match.index ?? 0) + offset;
      hits.push({ start, end: start + value.trimEnd().length, kind });
    }
  }

  // Plages qui se chevauchent : la première l'emporte, et la plus longue à départ égal.
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: Hit[] = [];
  for (const hit of hits) {
    const last = kept[kept.length - 1];
    if (last && hit.start < last.end) continue;
    kept.push(hit);
  }

  const segments: Segment[] = [];
  const counts: Partial<Record<PseudonymKind, number>> = {};
  let out = '';
  let cursor = 0;
  for (const hit of kept) {
    if (hit.start > cursor) {
      segments.push({ from: out.length, to: out.length + hit.start - cursor, originalFrom: cursor, originalTo: hit.start, replaced: false });
      out += input.slice(cursor, hit.start);
    }
    const label = LABELS[hit.kind];
    segments.push({ from: out.length, to: out.length + label.length, originalFrom: hit.start, originalTo: hit.end, replaced: true });
    out += label;
    counts[hit.kind] = (counts[hit.kind] ?? 0) + 1;
    cursor = hit.end;
  }
  if (cursor < input.length) {
    segments.push({ from: out.length, to: out.length + input.length - cursor, originalFrom: cursor, originalTo: input.length, replaced: false });
    out += input.slice(cursor);
  }

  const locate = (position: number, edge: 'start' | 'end'): number => {
    for (const segment of segments) {
      const inside = edge === 'start' ? position >= segment.from && position < segment.to : position > segment.from && position <= segment.to;
      if (!inside) continue;
      if (segment.replaced) return edge === 'start' ? segment.originalFrom : segment.originalTo;
      return segment.originalFrom + (position - segment.from);
    }
    return edge === 'start' ? 0 : input.length;
  };

  return {
    text: out,
    counts,
    toOriginal: (start, end) => {
      if (segments.length === 0) return { start, end };
      const from = locate(start, 'start');
      return { start: from, end: Math.max(from, locate(end, 'end')) };
    },
  };
}
