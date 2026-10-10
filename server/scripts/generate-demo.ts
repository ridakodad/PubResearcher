/**
 * Génère une arborescence de dossiers patients de démonstration.
 *
 *   npm run demo --workspace server            # écrit dans data/demo
 *   npm run demo --workspace server -- --upload # et les importe via l'API
 *
 * Les dossiers produits imitent la structure d'un recueil réel : un
 * sous-dossier par patient, contenant un compte rendu PDF, une observation
 * Word, un bilan biologique en tableau et quelques coupes DICOM.
 * Les données sont entièrement synthétiques.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { makeDicom, makeDocx, makeDocxTable, makePdf } from '../test/fixtures.js';
import { dataDir } from '../src/config.js';

const args = process.argv.slice(2);
// Le chemin de sortie est le premier argument qui n'est pas un drapeau.
// Par défaut on écrit dans le répertoire de données de l'application, quel que
// soit le dossier depuis lequel le script est lancé.
const OUT_DIR = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(dataDir, 'demo'));
const UPLOAD = args.includes('--upload');
const API = process.env.API_URL ?? 'http://localhost:4000';
const COUNT = 24;

/** Générateur pseudo-aléatoire à graine : le jeu de démonstration est reproductible. */
function makeRandom(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const random = makeRandom(20240315);
const pick = <T,>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
const between = (min: number, max: number) => Math.floor(min + random() * (max - min + 1));

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

interface DemoPatient {
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

/** Compte rendu d'hospitalisation : la source principale de l'extraction. */
function compteRendu(p: DemoPatient): string[] {
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

/**
 * Vérifie que l'API répond avant de commencer.
 *
 * `--upload` passe par l'API : sans ce contrôle, l'échec survient au premier
 * dossier, après écriture partielle, et se présente sous la forme d'une pile
 * d'appels `fetch failed` qui n'indique pas quoi faire.
 */
async function checkServer(): Promise<void> {
  try {
    const res = await fetch(`${API}/api/health`);
    if (res.ok) return;
    throw new Error(`réponse ${res.status}`);
  } catch {
    console.error(
      [
        `L'API ne répond pas sur ${API}.`,
        '',
        "L'option --upload envoie les dossiers à l'application : celle-ci doit",
        'donc tourner. Ouvrez un second terminal, laissez « npm start » actif',
        'dans le premier, puis relancez cette commande.',
        '',
        'Autre possibilité : générer les fichiers sans les importer,',
        '',
        '  npm run demo --workspace server',
        '',
        `puis glisser le dossier ${OUT_DIR} dans l'écran « Importer des dossiers ».`,
      ].join('\n'),
    );
    process.exit(1);
  }
}

async function main(): Promise<void> {
  // Contrôlé avant toute écriture, pour ne pas laisser une arborescence
  // à moitié générée derrière soi.
  if (UPLOAD) await checkServer();

  await fs.rm(OUT_DIR, { recursive: true, force: true });
  await fs.mkdir(OUT_DIR, { recursive: true });

  const patients = Array.from({ length: COUNT }, (_, i) => makePatient(i));

  for (const patient of patients) {
    const dir = path.join(OUT_DIR, patient.code);
    await fs.mkdir(dir, { recursive: true });

    const files: { name: string; buffer: Buffer }[] = [
      { name: 'compte-rendu.pdf', buffer: makePdf(compteRendu(patient)) },
      {
        name: 'observation.docx',
        buffer: await makeDocx([
          `Observation médicale — ${patient.code}`,
          `Motif de consultation : ${patient.motif}`,
          `Délai de consultation : ${between(1, 21)} jours`,
          patient.complications
            ? 'Suites marquées par une complication infectieuse.'
            : 'Suites simples, sans complication.',
        ]),
      },
      {
        name: 'bilan-biologique.docx',
        buffer: await makeDocxTable([
          ['Globules blancs', String(patient.gb).replace('.', ',')],
          ['Créatinine', String(patient.creatinine).replace('.', ',')],
          ['Hémoglobine', String(patient.hemoglobine).replace('.', ',')],
        ]),
      },
    ];

    // Quelques dossiers n'ont pas d'imagerie : la complétude n'est jamais
    // parfaite en pratique, l'interface doit le montrer.
    if (random() > 0.2) {
      const coupes = between(1, 3);
      for (let i = 0; i < coupes; i++) {
        files.push({
          name: `imagerie/coupe-${String(i + 1).padStart(3, '0')}.dcm`,
          buffer: makeDicom({
            patientId: patient.code,
            patientAge: `${String(patient.age).padStart(3, '0')}Y`,
            patientSex: patient.sexe === 'Féminin' ? 'F' : 'M',
            modality: patient.modalite,
            studyDate: `2024${String(between(1, 12)).padStart(2, '0')}${String(between(1, 28)).padStart(2, '0')}`,
            studyDescription: `Exploration ${patient.motif}`,
          }),
        });
      }
    }

    for (const file of files) {
      const target = path.join(dir, file.name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, file.buffer);
    }

    if (UPLOAD) await uploadPatient(patient.code, dir, files);
  }

  console.log(`${patients.length} dossiers de démonstration générés dans ${OUT_DIR}`);
  if (UPLOAD) {
    console.log('Importés via l’API. Lancez l’extraction depuis l’écran « Dossiers patients ».');
  } else {
    console.log('Glissez ce dossier dans l’application pour l’importer.');
  }
}

async function uploadPatient(
  code: string,
  dir: string,
  files: { name: string; buffer: Buffer }[],
): Promise<void> {
  const ensure = await fetch(`${API}/api/patients/ensure`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  if (!ensure.ok) throw new Error(`Création du dossier ${code} impossible : ${ensure.status}`);
  const { patient } = (await ensure.json()) as { patient: { id: number } };

  const form = new FormData();
  for (const file of files) {
    const buffer = await fs.readFile(path.join(dir, file.name));
    form.append(
      'files',
      new Blob([new Uint8Array(buffer)]),
      path.basename(file.name),
    );
  }
  const res = await fetch(`${API}/api/patients/${patient.id}/documents`, {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Import de ${code} impossible : ${res.status}`);
}

main().catch((err: unknown) => {
  // Une coupure en cours d'import mérite le même message que l'absence
  // initiale de serveur : c'est la même cause.
  const cause = (err as { cause?: { code?: string } })?.cause;
  if (cause?.code === 'ECONNREFUSED') {
    console.error(`L'API a cessé de répondre sur ${API}. Vérifiez que « npm start » tourne toujours.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
