/**
 * Corpus de démonstration : 24 patients fictifs dont la vérité est connue.
 *
 * Partagé par `generate-demo.ts` (qui en fait des fichiers PDF, Word, DICOM) et par `eval-local-models.ts` (qui mesure
 * la précision d'un modèle sur ces mêmes dossiers). Données entièrement synthétiques.
 */

export const DEMO_SEED = 20240315;
export const DEMO_COUNT = 24;

/** Générateur pseudo-aléatoire à graine : le jeu de démonstration est reproductible. */
export function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}


const MOTIFS = [
  'douleurs abdominales aiguës',
  'altération de l état général',
  'dyspnée d effort',
  'fièvre prolongée',
  'masse abdominale',
  'ictère cutanéo-muqueux',
];
const EVOLUTIONS = ['favorable', 'stationnaire', 'défavorable', 'décès'] as const;
const TRAITEMENTS = ['médical', 'chirurgical', 'endoscopique', 'chimiothérapie'] as const;
const MODALITES = ['CT', 'MR', 'US', 'CR'] as const;

export interface DemoPatient {
  code: string;
  age: number;
  sexe: 'Masculin' | 'Féminin';
  diabete: boolean;
  hta: boolean;
  tabac: boolean;
  temperature: number;
  hemoglobine: number;
  gb: number;
  crp: number;
  creatinine: number;
  duree: number;
  motif: string;
  evolution: (typeof EVOLUTIONS)[number];
  traitement: (typeof TRAITEMENTS)[number];
  modalite: (typeof MODALITES)[number];
  admission: string;
  complications: boolean;
}

/** Tirage des patients ; partage le générateur de l'appelant pour que `generate-demo` reste identique octet pour octet. */
export function patientFactory(random: () => number): (index: number) => DemoPatient {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const between = (min: number, max: number) => Math.floor(min + random() * (max - min + 1));
  return (index: number): DemoPatient => makePatient(index);
  function makePatient(index: number): DemoPatient {
  const sexe = random() > 0.45 ? 'Masculin' : 'Féminin';
  return {
    code: `PAT-${String(index + 1).padStart(3, '0')}`,
    // Distribution étalée pour que l'histogramme ait une forme lisible.
    age: between(19, 84),
    sexe,
    diabete: random() < 0.32,
    hta: random() < 0.41,
    tabac: sexe === 'Masculin' ? random() < 0.45 : random() < 0.14,
    temperature: Number((36.4 + random() * 3.1).toFixed(1)),
    hemoglobine: Number((7.5 + random() * 8).toFixed(1)),
    gb: Number((3.8 + random() * 16).toFixed(1)),
    crp: between(2, 340),
    creatinine: Number((6 + random() * 22).toFixed(1)),
    duree: between(2, 34),
    motif: pick(MOTIFS),
    evolution: random() < 0.62 ? 'favorable' : pick(EVOLUTIONS),
    traitement: pick(TRAITEMENTS),
    modalite: pick(MODALITES),
    admission: `${between(1, 28)}/${between(1, 12)}/2024`,
    complications: random() < 0.28,
  };
}
}

/** Compte rendu d'hospitalisation : la source principale de l'extraction. */
export function compteRendu(p: DemoPatient): string[] {
  const genre = p.sexe === 'Féminin' ? 'patiente' : 'patient';
  const antecedents = [
    p.diabete ? 'diabète type 2' : 'pas de diabète',
    p.hta ? 'HTA sous traitement' : "pas d'HTA",
    p.tabac ? 'tabagisme actif' : 'pas de tabagisme',
  ].join(', ');

  return [
    'COMPTE RENDU D HOSPITALISATION',
    `N° dossier : ${p.code}`,
    `Age : ${p.age} ans`,
    `Sexe : ${p.sexe}`,
    `Date d admission : ${p.admission}`,
    '',
    `Motif d hospitalisation : ${p.motif}`,
    `Antecedents : ${antecedents}`,
    '',
    'EXAMEN CLINIQUE',
    `Temperature : ${String(p.temperature).replace('.', ',')} C`,
    `Il s agit d un ${genre} de ${p.age} ans admis pour ${p.motif}.`,
    '',
    'BIOLOGIE',
    `Hemoglobine : ${String(p.hemoglobine).replace('.', ',')} g/dL`,
    `CRP : ${p.crp} mg/L`,
    '',
    'PRISE EN CHARGE',
    `Traitement : ${p.traitement}`,
    `Duree d hospitalisation : ${p.duree} jours`,
    `Complications : ${p.complications ? 'oui' : 'aucune'}`,
    `Evolution : ${p.evolution}`,
  ];
}

