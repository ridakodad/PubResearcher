/**
 * Types du domaine.
 *
 * Les types exposés par l'API sont dupliqués côté front dans `web/src/lib/types.ts`.
 * Toute modification ici doit y être répercutée.
 */

/** Nature d'un document, déduite du type MIME et de l'extension. */
export type DocKind = 'pdf' | 'docx' | 'image' | 'dicom' | 'text' | 'unknown';

/** Type d'une variable de la fiche d'exploitation. */
export type FieldType =
  | 'text'
  | 'number'
  | 'integer'
  | 'date'
  | 'boolean'
  | 'enum'
  | 'multi';

export const FIELD_TYPES: FieldType[] = [
  'text',
  'number',
  'integer',
  'date',
  'boolean',
  'enum',
  'multi',
];

/** Origine d'où une règle va lire la donnée. */
export type RuleSource = 'text' | 'dicom' | 'filename';

/** Valeur stockée pour une variable. `multi` stocke un tableau de chaînes. */
export type FieldValue = string | number | boolean | string[] | null;

/**
 * Extrait « Libellé : valeur ». La forme la plus courante dans un compte rendu :
 * on cite les libellés possibles et le moteur construit la regex (accents et
 * séparateurs gérés automatiquement).
 */
export interface LabelRule {
  kind: 'label';
  /** Libellés acceptés, ex. ["Âge", "Age du patient"]. */
  labels: string[];
  /** Nombre max de caractères capturés après le libellé (défaut 120). */
  maxLength?: number;
  source?: RuleSource;
  docKinds?: DocKind[];
  confidence?: number;
}

/** Expression régulière libre, pour les cas que `label` ne couvre pas. */
export interface RegexRule {
  kind: 'regex';
  pattern: string;
  /** Drapeaux ; `i` et `u` sont ajoutés d'office. Utiliser `m`, `s` au besoin. */
  flags?: string;
  /** Groupe capturant à retenir (défaut 1, ou 0 si le motif n'en a pas). */
  group?: number;
  source?: RuleSource;
  docKinds?: DocKind[];
  confidence?: number;
}

/**
 * Présence / absence de mots-clés. Émet une valeur fixe (typiquement `true`
 * pour un antécédent, ou un libellé pour une variable qualitative).
 */
export interface KeywordRule {
  kind: 'keyword';
  /** Déclenche si l'un de ces termes est présent. */
  any: string[];
  /** Annule si l'un de ces termes apparaît à proximité (négations : « pas de », « absence de »). */
  none?: string[];
  /** Fenêtre de recherche des termes de `none`, en caractères avant le terme trouvé (défaut 40). */
  noneWindow?: number;
  /**
   * Ignore une mention dont la proposition contient l'un de ces termes : ni
   * affirmée, ni niée, simplement hors sujet. Typiquement les antécédents
   * familiaux — « père diabétique » ne dit rien du patient, et ne doit pas non
   * plus valoir « Non » comme le ferait une négation.
   */
  skip?: string[];
  /** Fenêtre de recherche des termes de `skip` (défaut : celle de `none`). */
  skipWindow?: number;
  /** Valeur émise en cas de correspondance. */
  emit: FieldValue;
  /**
   * Valeur émise lorsque le terme n'apparaît que sous une forme niée.
   *
   * « Pas de diabète » est une information clinique — l'absence a été
   * recherchée et documentée — et non une donnée manquante. Sans cette
   * option, la variable resterait vide et le manquant ne serait pas
   * interprétable à l'analyse.
   */
  emitIfNegated?: FieldValue;
  /**
   * Mentions placées dans les antécédents (« Antécédents : pneumopathie fébrile », « ATCD de … »).
   *
   * `include` (défaut) les compte : une maladie chronique — diabète, HTA — se documente précisément là.
   * `exclude` les écarte : pour une variable de l'épisode en cours (fièvre, complication), une fièvre
   * d'il y a cinq ans ne dit rien du séjour. Ne s'applique qu'aux variables oui/non.
   */
  history?: 'include' | 'exclude';
  source?: RuleSource;
  docKinds?: DocKind[];
  confidence?: number;
}

/** Lecture d'un tag DICOM, par mot-clé (`PatientAge`) ou par code hexa (`00101010`). */
export interface DicomRule {
  kind: 'dicom';
  tag: string;
  confidence?: number;
}

export type ExtractionRule = LabelRule | RegexRule | KeywordRule | DicomRule;

/** Post-traitement appliqué à la valeur brute avant typage. */
export interface FieldPostProcess {
  /** Correspondances « texte trouvé » -> « option canonique » (clé insensible à la casse/accents). */
  valueMap?: Record<string, string>;
  /** Multiplie une valeur numérique (conversion d'unité, ex. g/L -> mg/L). */
  scale?: number;
  /** Bornes de plausibilité ; hors bornes la valeur est rejetée. */
  min?: number;
  max?: number;
}

/**
 * Valeur à retenir quand plusieurs mentions d'une même règle divergent (deux documents, deux phrases).
 *
 * - `first` : la première, dans l'ordre d'import des documents puis du texte ;
 * - `last`  : la dernière, dans le même ordre ;
 * - `max` / `min` : la plus grande / la plus petite (nombres et dates) ;
 * - `any`   : oui/non — « Oui » dès qu'une mention l'affirme ; choix multiple — la réunion des valeurs.
 *
 * Sans réglage, des mentions discordantes ne donnent aucune valeur : la variable est signalée comme
 * « valeurs discordantes » et se tranche à la main. Exception : le texte libre retient la première.
 */
export type SelectPolicy = 'first' | 'last' | 'max' | 'min' | 'any';

export const SELECT_POLICIES: SelectPolicy[] = ['first', 'last', 'max', 'min', 'any'];

/** Configuration d'extraction attachée à une variable. */
export interface FieldExtraction {
  /** Désactive l'extraction automatique : la variable reste en saisie manuelle. */
  enabled: boolean;
  rules: ExtractionRule[];
  postProcess?: FieldPostProcess;
  /** Valeur retenue quand les mentions divergent ; absent : la variable est signalée, sans valeur. */
  select?: SelectPolicy;
  /**
   * Variable de synthèse (« traitements reçus », « examens réalisés pendant le séjour ») : les règles en proposent les
   * mentions sans remplir la variable, qui reste à valider. Nommer un examen ne dit pas qu'il a été fait pendant cet
   * épisode (« IRM de contrôle dans 6 mois », « scanner réalisé en ville »). Une valeur lue dans un fichier DICOM, elle,
   * est retenue.
   */
  suggestOnly?: boolean;
  /**
   * `admission` : la variable décrit l'arrivée du patient (fièvre, température, bilan d'entrée). Les mentions datées
   * plus tard dans le séjour — « à J4 », « en postopératoire », « pic fébrile le 18/04 », « au cours du séjour » — sont
   * écartées : elles décrivent une complication, pas l'état initial.
   */
  episode?: 'admission';
}

export interface TemplateField {
  id: number;
  templateId: number;
  /** Identifiant technique, utilisé comme en-tête de colonne dans le CSV. */
  key: string;
  label: string;
  type: FieldType;
  section: string;
  unit: string | null;
  description: string | null;
  required: boolean;
  /** Options pour `enum` et `multi`. */
  options: string[];
  position: number;
  extraction: FieldExtraction;
}

export interface Template {
  id: number;
  name: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateWithFields extends Template {
  fields: TemplateField[];
}

export interface Patient {
  id: number;
  code: string;
  label: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentMeta {
  id: number;
  patientId: number;
  filename: string;
  kind: DocKind;
  mime: string;
  size: number;
  sha256: string;
  createdAt: string;
  /** Statut du parsing : le texte est extrait à l'upload. */
  parseStatus: 'pending' | 'ok' | 'error' | 'empty';
  /**
   * Le navigateur peut-il afficher ce document dans la page ? Calculé côté
   * serveur à partir du nom de stockage : le renommage ne peut donc pas rendre
   * un PDF soudain inaffichable, ni un format exécutable soudain affichable.
   */
  previewable: boolean;
  parseError: string | null;
  /** Nombre de caractères de texte extraits (aperçu de la qualité du parsing). */
  textLength: number;
  /** Métadonnées structurées (tags DICOM, EXIF, pages PDF...). */
  metadata: Record<string, unknown>;
}

/** Justification d'une valeur extraite automatiquement. */
export interface Evidence {
  documentId: number;
  documentName: string;
  /** Extrait du document autour de la correspondance. */
  snippet: string;
  /** Position de la correspondance dans le texte du document. */
  start: number;
  end: number;
  /** Description lisible de la règle qui a produit la valeur. */
  rule: string;
  /**
   * Autres valeurs trouvées par la même règle, quand les mentions divergeaient et qu'une règle de sélection
   * (`select`) a tranché : le relecteur voit qu'il y avait un choix, et lequel a été fait.
   */
  alternatives?: EvidenceAlternative[];
  /** Comment la valeur a été choisie parmi des mentions discordantes, en clair. */
  selection?: string;
}

/** Valeur écartée au profit de celle retenue, avec sa source. */
export interface EvidenceAlternative {
  value: FieldValue;
  documentId: number;
  documentName: string;
  snippet: string;
}

/**
 * Valeur trouvée par une règle puis écartée — hors bornes, valeur seuil
 * (« < 5 »), type incompatible. On la garde visible : sans cela, une variable
 * dont la valeur existe dans le document ressemblerait à une variable
 * simplement absente.
 */
export interface Rejection {
  documentId: number;
  documentName: string;
  /** Extrait du document autour de la valeur écartée. */
  snippet: string;
  /** Pourquoi elle n'a pas été retenue, en clair. */
  reason: string;
  /** Description lisible de la règle qui l'a trouvée. */
  rule: string;
  /**
   * Mentions discordantes (« 12,6 » ici, « 8,1 » là, ou « favorable puis décès ») : la variable reste vide et
   * aucune règle de repli n'est essayée — choisir entre deux valeurs écrites revient au relecteur.
   */
  conflict?: boolean;
}

/**
 * Justification d'une valeur importée d'un tableau de cohorte : le fichier conservé (et son empreinte), la feuille, la
 * cellule, l'en-tête de sa colonne et son contenu brut. Ce n'est ni une extraction (aucun document n'a été lu) ni une
 * relecture (personne n'a vérifié la valeur contre le dossier source).
 */
export interface ImportEvidence {
  kind: 'import';
  importId: number;
  fileName: string;
  sha256: string;
  /** Nom de la feuille ; `null` pour un CSV. */
  sheet: string | null;
  /** Référence de la cellule, à la manière du tableur (« E12 »). */
  cell: string;
  header: string;
  /** Contenu de la cellule tel qu'enregistré dans le fichier. */
  raw: string;
}

export function isImportEvidence(evidence: Evidence | ImportEvidence | null | undefined): evidence is ImportEvidence {
  return evidence !== null && evidence !== undefined && (evidence as ImportEvidence).kind === 'import';
}

/**
 * Origine d'une valeur : règle, modèle de langage, saisie ou décision d'un relecteur, import d'un tableau de cohorte,
 * ou absente. Une valeur importée n'est pas une valeur relue : elle vient d'un tableau tenu par l'équipe, que l'outil
 * n'a pas vérifié contre le dossier.
 */
export type ValueSource = 'auto' | 'llm' | 'manual' | 'import' | 'empty';

/**
 * Ce que la machine (ou un tableau importé) avait proposé avant qu'un humain tranche. Présent seulement
 * quand une telle valeur a été relue : pour les valeurs extraites, c'est la matière des mesures de
 * fiabilité (valeurs confirmées, corrigées, vidées) ; les valeurs importées n'y entrent pas.
 */
export interface ValueOrigin {
  source: 'auto' | 'llm' | 'import';
  value: FieldValue;
}

export interface RecordValue {
  fieldId: number;
  value: FieldValue;
  source: ValueSource;
  confidence: number | null;
  evidence: Evidence | ImportEvidence | null;
  updatedAt: string;
  /** Proposition de la machine relue par un humain ; `null` si la valeur n'a pas été relue ou a été saisie de zéro. */
  origin: ValueOrigin | null;
  /** Date de la décision humaine (saisie, confirmation ou vidage). */
  reviewedAt: string | null;
}

export interface PatientRecord {
  id: number;
  templateId: number;
  patientId: number;
  createdAt: string;
  updatedAt: string;
  /** Date du dernier passage du moteur d'extraction. */
  lastExtractionAt: string | null;
  values: RecordValue[];
}
