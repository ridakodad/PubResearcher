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
import { DEMO_SEED, compteRendu, makeRandom, patientFactory } from './demo-corpus.js';

const args = process.argv.slice(2);
// Le chemin de sortie est le premier argument qui n'est pas un drapeau.
// Par défaut on écrit dans le répertoire de données de l'application, quel que
// soit le dossier depuis lequel le script est lancé.
const OUT_DIR = path.resolve(args.find((a) => !a.startsWith('--')) ?? path.join(dataDir, 'demo'));
const UPLOAD = args.includes('--upload');
const API = process.env.API_URL ?? 'http://localhost:4000';
const COUNT = 24;

const random = makeRandom(DEMO_SEED);
const between = (min: number, max: number) => Math.floor(min + random() * (max - min + 1));
const makePatient = patientFactory(random);

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
