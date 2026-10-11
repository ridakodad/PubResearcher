import { db } from './index.js';
import { createField, createTemplate, setActiveTemplate, type FieldInput } from '../repo/templates.js';

/**
 * Fiche d'exploitation livrée par défaut.
 *
 * Elle couvre la trame classique d'une thèse de médecine (identité,
 * antécédents, clinique, paraclinique, prise en charge, évolution) et sert
 * surtout d'exemple de paramétrage : chaque type de règle y est illustré.
 * Elle est entièrement modifiable depuis l'interface.
 */
/**
 * Mentions qui ne concernent pas le patient : antécédents familiaux, proches.
 * « Sa mère est diabétique » ne dit rien du diabète du patient, et ne doit pas
 * non plus valoir « Non » comme une négation — d'où `skip`, distinct de `none`.
 */
const PROCHES = [
  'mere', 'pere', 'frere', 'soeur', 'fils', 'fille', 'parents', 'enfants', 'epouse', 'epoux',
  'grand-pere', 'grand-mere', 'oncle', 'tante', 'famille', 'familial', 'familiale', 'familiaux',
];

/** Négations qui précèdent un terme dans un compte rendu (« non diabétique », « ni HTA »). */
const NEGATIONS = ['pas de', 'absence de', 'sans', 'aucun', 'aucune', 'non', 'ni', 'jamais'];

export const DEFAULT_FIELDS: FieldInput[] = [
  // ---------------------------------------------------------------- Identité
  {
    key: 'numero_dossier',
    label: 'Numéro de dossier',
    type: 'text',
    section: 'Identité',
    description: "Identifiant du dossier tel qu'il figure sur le compte rendu.",
    extraction: {
      enabled: true,
      rules: [
        // Un identifiant est un seul mot qui contient au moins un chiffre : « (N° dossier V-2024-00813) » donne
        // V-2024-00813, sans la parenthèse ni ce qu'une lecture optique aurait collé derrière.
        {
          kind: 'regex',
          pattern: String.raw`(?:n[°o]\.?\s*(?:de\s+)?dossier|numero\s+de\s+dossier|dossier\s+n[°o]|ipp)\s*[:.]?\s*((?=[a-z0-9/-]*\d)[a-z0-9](?:[a-z0-9/-]{0,28}[a-z0-9])?)(?![a-z0-9])`,
        },
        { kind: 'dicom', tag: 'PatientID' },
      ],
    },
  },
  {
    key: 'age',
    label: 'Âge',
    type: 'integer',
    section: 'Identité',
    unit: 'ans',
    required: true,
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Âge', 'Age'], maxLength: 20 },
        { kind: 'regex', pattern: '(?:patient|patiente|malade)\\s+(?:âgée?\\s+)?de\\s+(\\d{1,3})\\s*ans' },
        // Repli : « 54 ans » seul. Ne lit ni « depuis 5 ans », ni « il y a 5 ans », ni
        // « 20 ans de tabagisme » : ce sont des durées, pas l'âge du patient.
        { kind: 'regex', pattern: '(?<!\\d)(?<!depuis\\s|il y a\\s|pendant\\s|pour\\s|evoluant depuis\\s)(\\d{1,3})\\s*ans\\b(?!\\s+(?:d\\x27|de\\s|d\\s|d\\u2019))' },
        { kind: 'dicom', tag: 'PatientAge' },
      ],
      // Bornes de plausibilité : évite de capturer « 120 ans d'évolution ».
      postProcess: { min: 0, max: 120 },
    },
  },
  {
    key: 'sexe',
    label: 'Sexe',
    type: 'enum',
    section: 'Identité',
    options: ['Masculin', 'Féminin'],
    required: true,
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Sexe', 'Genre'], maxLength: 20 },
        { kind: 'dicom', tag: 'PatientSex' },
        // Mots entiers : « mme » ne se lit plus dans « homme ». « patient » seul est
        // omis : le masculin y est générique, et un sexe inventé vaut moins qu'un vide.
        { kind: 'keyword', any: ['patiente', 'madame', 'mme', 'une femme', 'femme de', 'femme enceinte'], emit: 'Féminin' },
        { kind: 'keyword', any: ['monsieur', 'mr', 'm.', 'un homme', 'homme de'], emit: 'Masculin' },
      ],
      postProcess: {
        valueMap: {
          m: 'Masculin', h: 'Masculin', homme: 'Masculin', masculin: 'Masculin', male: 'Masculin',
          f: 'Féminin', femme: 'Féminin', feminin: 'Féminin', female: 'Féminin',
        },
      },
    },
  },
  {
    key: 'date_admission',
    label: "Date d'admission",
    type: 'date',
    section: 'Identité',
    extraction: {
      enabled: true,
      rules: [
        {
          kind: 'label',
          labels: ["Date d'admission", 'Admission le', 'Admis le', 'Admise le', "Date d'entrée", 'Entré le', 'Entrée le'],
          maxLength: 40,
        },
        { kind: 'dicom', tag: 'StudyDate' },
      ],
    },
  },

  // ----------------------------------------------------------- Antécédents
  {
    key: 'diabete',
    label: 'Diabète',
    type: 'boolean',
    section: 'Antécédents',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Diabète', 'Diabete'], maxLength: 30 },
        {
          kind: 'keyword',
          // Sigles usuels : « DT2 sous metformine », « DNID », « DID ».
          any: ['diabete', 'diabétique', 'diabetique', 'dt1', 'dt2', 'dnid', 'did'],
          // Évite le faux positif sur « pas de diabète », très fréquent.
          none: NEGATIONS,
          skip: PROCHES,
          emit: true,
          // « Pas de diabète » documente une absence : c'est un « Non », pas
          // une donnée manquante.
          emitIfNegated: false,
        },
      ],
    },
  },
  {
    key: 'hta',
    label: 'HTA',
    type: 'boolean',
    section: 'Antécédents',
    description: 'Hypertension artérielle connue.',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['HTA', 'Hypertension'], maxLength: 30 },
        {
          kind: 'keyword',
          any: ['hta', 'hypertension arterielle', 'hypertendu', 'hypertendue'],
          none: NEGATIONS,
          skip: PROCHES,
          emit: true,
          emitIfNegated: false,
        },
      ],
    },
  },
  {
    key: 'tabagisme',
    label: 'Tabagisme',
    type: 'boolean',
    section: 'Antécédents',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Tabagisme', 'Tabac'], maxLength: 30 },
        {
          kind: 'keyword',
          any: ['tabagique', 'tabagisme', 'fumeur', 'fumeuse'],
          none: [...NEGATIONS, 'sevre'],
          skip: PROCHES,
          emit: true,
          emitIfNegated: false,
        },
      ],
      // « Tabac : ancien » décrit un ancien fumeur (pour une maladie, « ancienne » voudrait dire « de longue date »).
      postProcess: { valueMap: { ancien: 'non', ancienne: 'non', anciens: 'non' } },
    },
  },
  {
    key: 'antecedents_libre',
    label: 'Antécédents (texte libre)',
    type: 'text',
    section: 'Antécédents',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Antécédents', 'Antecedents', 'ATCD', 'Antécédents personnels'], maxLength: 300 },
      ],
    },
  },

  // -------------------------------------------------------------- Clinique
  {
    key: 'motif_consultation',
    label: 'Motif de consultation',
    type: 'text',
    section: 'Clinique',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ["Motif d'hospitalisation", 'Motif de consultation', 'Motif', "Motif d'admission"], maxLength: 200 },
      ],
    },
  },
  {
    key: 'delai_consultation',
    label: 'Délai de consultation',
    type: 'number',
    section: 'Clinique',
    unit: 'jours',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Délai de consultation', 'Délai'], maxLength: 30 },
        { kind: 'regex', pattern: 'évoluant\\s+depuis\\s+(\\d+)\\s*jours?' },
      ],
    },
  },
  {
    key: 'fievre',
    label: 'Fièvre',
    type: 'boolean',
    section: 'Clinique',
    description: "À l'arrivée : température ≥ 38 °C mesurée, ou fièvre rapportée pour l'épisode en cours.",
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Fièvre', 'Fievre'], maxLength: 30 },
        {
          kind: 'keyword',
          any: ['fievre', 'febrile', 'fébrile'],
          none: [...NEGATIONS, 'apyre'],
          // « Antécédents : pneumopathie fébrile » ne dit rien de la fièvre de ce séjour.
          history: 'exclude',
          emit: true,
          emitIfNegated: false,
        },
      ],
      // Fièvre à l'arrivée : une mention qui l'affirme suffit, même si un autre compte rendu la dit absente ; une
      // fièvre apparue plus tard dans le séjour (« à J4 ») est une complication, pas l'état initial.
      select: 'any',
      episode: 'admission',
    },
  },
  {
    key: 'temperature',
    label: 'Température',
    type: 'number',
    section: 'Clinique',
    unit: '°C',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Température', 'Temperature', 'Temp.', 'Temp', 'T°', 'TC', 'T'], maxLength: 20 },
        { kind: 'regex', pattern: '(\\d{2}[.,]\\d)\\s*°?\\s*c\\b' },
      ],
      episode: 'admission',
      postProcess: { min: 30, max: 45 },
    },
  },

  // ---------------------------------------------------------- Paraclinique
  {
    key: 'hemoglobine',
    label: 'Hémoglobine',
    type: 'number',
    section: 'Paraclinique',
    unit: 'g/dL',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Hémoglobine', 'Hemoglobine', 'Hb', 'HGB'], maxLength: 25 },
      ],
      episode: 'admission',
      postProcess: { min: 1, max: 25 },
    },
  },
  {
    key: 'globules_blancs',
    label: 'Globules blancs',
    type: 'number',
    section: 'Paraclinique',
    unit: '10³/mm³',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Globules blancs', 'GB', 'Leucocytes', 'WBC'], maxLength: 25 },
      ],
      episode: 'admission',
      postProcess: { min: 0, max: 200 },
    },
  },
  {
    key: 'crp',
    label: 'CRP',
    type: 'number',
    section: 'Paraclinique',
    unit: 'mg/L',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['CRP', 'C-réactive', 'Protéine C réactive'], maxLength: 25 },
      ],
      episode: 'admission',
      postProcess: { min: 0, max: 600 },
    },
  },
  {
    key: 'creatinine',
    label: 'Créatinine',
    type: 'number',
    section: 'Paraclinique',
    unit: 'mg/L',
    extraction: {
      enabled: true,
      rules: [{ kind: 'label', labels: ['Créatinine', 'Creatinine', 'Créat'], maxLength: 25 }],
      episode: 'admission',
      postProcess: { min: 0, max: 200 },
    },
  },
  {
    key: 'modalite_imagerie',
    label: 'Modalité d’imagerie',
    type: 'multi',
    section: 'Paraclinique',
    options: ['Radiographie', 'Échographie', 'Scanner', 'IRM', 'Scintigraphie', 'TEP'],
    description: "Renseignée automatiquement à partir des fichiers DICOM importés.",
    extraction: {
      enabled: true,
      rules: [
        { kind: 'dicom', tag: 'Modality' },
        { kind: 'label', labels: ['Imagerie', 'Examen réalisé'], maxLength: 120 },
        { kind: 'keyword', any: ['scanner', 'tdm', 'tomodensitometrie'], emit: 'Scanner' },
        { kind: 'keyword', any: ['irm', 'imagerie par resonance'], emit: 'IRM' },
        { kind: 'keyword', any: ['echographie', 'echo-doppler'], emit: 'Échographie' },
        { kind: 'keyword', any: ['radiographie', 'radiographies', 'radio de', 'cliche', 'cliches'], emit: 'Radiographie' },
        { kind: 'keyword', any: ['tep-scanner', 'tep scanner', 'tep-tdm', 'pet-scan'], emit: 'TEP' },
        { kind: 'keyword', any: ['scintigraphie'], emit: 'Scintigraphie' },
      ],
      postProcess: {
        // Codes de modalité DICOM vers libellés de la fiche.
        valueMap: {
          CT: 'Scanner', MR: 'IRM', US: 'Échographie', CR: 'Radiographie',
          DX: 'Radiographie', RF: 'Radiographie', XA: 'Radiographie',
          NM: 'Scintigraphie', PT: 'TEP', MG: 'Radiographie',
          TDM: 'Scanner', scanner: 'Scanner', irm: 'IRM',
        },
      },
      // Plusieurs examens de modalités différentes : toutes sont retenues.
      select: 'any',
      // Nommer un examen ne dit pas qu'il a été fait pendant le séjour (« IRM de contrôle dans 6 mois ») : les mentions
      // sont proposées à la relecture ; seules les modalités lues dans les fichiers DICOM remplissent la variable.
      suggestOnly: true,
    },
  },
  {
    key: 'date_imagerie',
    label: "Date de l'imagerie",
    type: 'date',
    section: 'Paraclinique',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'dicom', tag: 'StudyDate' },
        { kind: 'label', labels: ["Date de l'examen", "Date de l'imagerie"], maxLength: 40 },
      ],
      // Plusieurs examens : le premier importé fait foi (les coupes d'un même examen portent la même date).
      select: 'first',
    },
  },

  // ------------------------------------------------------- Prise en charge
  {
    key: 'traitement',
    label: 'Traitement',
    type: 'multi',
    section: 'Prise en charge',
    options: ['Médical', 'Chirurgical', 'Endoscopique', 'Radiothérapie', 'Chimiothérapie', 'Abstention'],
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Traitement', 'Prise en charge', 'Conduite à tenir', 'CAT'], maxLength: 200 },
        {
          kind: 'keyword',
          any: ['intervention chirurgicale', 'opere', 'operee', 'chirurgie'],
          // « Antécédent de chirurgie » n'est pas le traitement de cette prise en charge.
          skip: ['antecedent', 'antecedents', 'atcd', 'ancien', 'ancienne'],
          emit: 'Chirurgical',
        },
        { kind: 'keyword', any: ['chimiotherapie'], emit: 'Chimiothérapie' },
        { kind: 'keyword', any: ['radiotherapie'], emit: 'Radiothérapie' },
        { kind: 'keyword', any: ['endoscopie', 'endoscopique', 'cpre', 'fibroscopie', 'coloscopie'], emit: 'Endoscopique' },
        { kind: 'keyword', any: ['antibiotherapie', 'anticoagulation', 'traitement medical'], emit: 'Médical' },
      ],
      postProcess: {
        valueMap: {
          medical: 'Médical', chirurgie: 'Chirurgical', chirurgical: 'Chirurgical',
          operatoire: 'Chirurgical', endoscopie: 'Endoscopique', surveillance: 'Abstention',
          // Gestes et traitements nommés plutôt que leur catégorie : « cholécystectomie », « antibiothérapie ».
          ectomie: 'Chirurgical', laparotomie: 'Chirurgical', coelioscopi: 'Chirurgical', 'cœlioscopi': 'Chirurgical',
          antibiotherapie: 'Médical', antibiotique: 'Médical',
        },
      },
      // Traitements cités dans plusieurs documents : ils s'additionnent.
      select: 'any',
      // Variable de synthèse : les traitements cités sont proposés à la relecture, la catégorie reste un jugement.
      suggestOnly: true,
    },
  },
  {
    key: 'duree_hospitalisation',
    label: "Durée d'hospitalisation",
    type: 'number',
    section: 'Évolution',
    unit: 'jours',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ["Durée d'hospitalisation", 'Durée de séjour', 'Séjour'], maxLength: 70 },
        { kind: 'regex', pattern: 'hospitalis[ée]{1,2}\\s+pendant\\s+(\\d+)\\s*jours?' },
      ],
      postProcess: { min: 0, max: 400 },
    },
  },
  {
    key: 'complications',
    label: 'Complications',
    type: 'boolean',
    section: 'Évolution',
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Complications', 'Complication'], maxLength: 120 },
        {
          kind: 'keyword',
          any: ['complication'],
          none: NEGATIONS,
          // Une complication passée (« ATCD de complication ») n'est pas une complication de ce séjour.
          history: 'exclude',
          emit: true,
          emitIfNegated: false,
        },
      ],
      // Une complication rapportée dans un document suffit, même si un autre, antérieur, n'en signale pas.
      select: 'any',
    },
  },
  {
    key: 'evolution',
    label: 'Évolution',
    type: 'enum',
    section: 'Évolution',
    options: ['Favorable', 'Stationnaire', 'Défavorable', 'Décès', 'Perdu de vue'],
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Évolution', 'Evolution', 'Devenir'], maxLength: 80 },
        {
          kind: 'keyword',
          any: ['deces', 'décédé', 'decede', 'decedee'],
          none: ['pas de', 'aucun', 'sans', 'risque de', 'non'],
          skip: PROCHES,
          emit: 'Décès',
        },
        { kind: 'keyword', any: ['perdu de vue'], emit: 'Perdu de vue' },
      ],
      postProcess: {
        valueMap: {
          bonne: 'Favorable', favorable: 'Favorable', simple: 'Favorable',
          stable: 'Stationnaire', stationnaire: 'Stationnaire',
          defavorable: 'Défavorable', mauvaise: 'Défavorable',
          deces: 'Décès', mort: 'Décès',
        },
      },
    },
  },
];

/** Crée la fiche par défaut au premier démarrage, sur une base vide. */
export function seedIfEmpty(): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM templates').get() as { n: number }).n;
  if (count > 0) return;

  const template = createTemplate({
    name: "Fiche d'exploitation générale",
    description:
      "Trame par défaut : identité, antécédents, clinique, paraclinique, prise en charge et évolution. " +
      'À adapter au protocole de votre étude.',
  });

  for (const field of DEFAULT_FIELDS) {
    createField(template.id, field);
  }
  setActiveTemplate(template.id);
}
