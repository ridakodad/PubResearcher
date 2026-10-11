/**
 * Banc d'essai du moteur d'extraction sur la fiche LIVRÉE PAR DÉFAUT.
 *
 * Des phrases cliniques courantes, rédigées à la main, dont la bonne réponse
 * est connue. Ce n'est PAS une validation clinique : le corpus est synthétique
 * et écrit par les auteurs du moteur. Il sert à trois choses :
 *
 *   1. empêcher qu'un faux positif corrigé réapparaisse (« homme » lu comme
 *      « Féminin » parce qu'il contient « mme », « CRP < 5 » lu comme 5…) ;
 *   2. dire noir sur blanc ce que les règles livrées ne savent pas faire — la
 *      liste `LIMITES` est un contrat : si l'une d'elles change de résultat,
 *      le test échoue et force à mettre la documentation à jour ;
 *   3. donner un chiffre de départ, qu'aucune fiche réelle ne remplace : la
 *      précision sur VOS dossiers se mesure sur un échantillon relu (voir la
 *      section « Contrôle qualité » de la documentation).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-bench-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

type Field = import('../src/domain/types.js').TemplateField;
let fields: Map<string, Field>;
let extractFieldDetailed: typeof import('../src/engine/rules.js').extractFieldDetailed;
let closeDb: () => void;

before(async () => {
  const { seedIfEmpty } = await import('../src/db/seed.js');
  const { getActiveTemplate } = await import('../src/repo/templates.js');
  ({ extractFieldDetailed } = await import('../src/engine/rules.js'));
  ({ db: { close: closeDb } } = await import('../src/db/index.js'));
  seedIfEmpty();
  fields = new Map(getActiveTemplate()!.fields.map((f) => [f.key, f]));
});

after(() => {
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

interface Case {
  key: string;
  text: string;
  /** Valeur attendue ; `null` = le moteur ne doit RIEN renvoyer (mieux vaut un vide qu'une valeur fausse). */
  expect: unknown;
  note?: string;
}

const doc = (text: string) => ({ id: 1, name: 'cr.pdf', kind: 'pdf' as const, text, dicomTags: {} });

function run(c: Case): { got: unknown; rejected: number } {
  const result = extractFieldDetailed(fields.get(c.key)!, [doc(c.text)]);
  return { got: result.hit ? result.hit.value : null, rejected: result.rejected.length };
}

/* ───────────────────────────── cas attendus ───────────────────────────── */

const CASES: Case[] = [
  // ── Sexe : libellés, formules, et pièges de sous-chaîne
  { key: 'sexe', text: 'Sexe : M', expect: 'Masculin' },
  { key: 'sexe', text: 'Sexe : féminin', expect: 'Féminin' },
  { key: 'sexe', text: 'Genre : Homme', expect: 'Masculin' },
  { key: 'sexe', text: 'Sexe : F', expect: 'Féminin' },
  { key: 'sexe', text: "Il s'agit d'un homme de 54 ans admis pour douleurs abdominales.", expect: 'Masculin', note: '« mme » ne se lit plus dans « homme »' },
  { key: 'sexe', text: "Il s'agit d'une femme de 54 ans admise pour douleurs abdominales.", expect: 'Féminin' },
  { key: 'sexe', text: 'Madame X, 54 ans, hospitalisée pour une pneumopathie.', expect: 'Féminin' },
  { key: 'sexe', text: 'Monsieur X, 54 ans, hospitalisé.', expect: 'Masculin' },
  { key: 'sexe', text: 'Patiente de 31 ans, G2P1, adressée pour métrorragies.', expect: 'Féminin' },
  { key: 'sexe', text: "Il vit avec son épouse. Tumeur de 5 cm. au scanner.", expect: null, note: '« cm. » ne vaut pas « m. » ; « épouse » n’est pas le patient' },

  // ── Âge
  { key: 'age', text: 'Âge : 54 ans', expect: 54 },
  { key: 'age', text: 'Age: 7', expect: 7 },
  { key: 'age', text: 'Mr X, âgé de 54 ans, consulte pour toux.', expect: 54 },
  { key: 'age', text: 'Patient de 54 ans ayant 20 ans de tabagisme.', expect: 54 },
  { key: 'age', text: 'Patiente âgée de 67 ans.', expect: 67 },
  { key: 'age', text: "ATCD : appendicectomie il y a 5 ans. Suivi depuis 12 ans.", expect: null, note: 'des durées ne sont pas l’âge' },
  { key: 'age', text: 'Tabagisme : 20 ans de tabagisme actif.', expect: null },
  { key: 'age', text: 'Né le 12/03/1970', expect: null, note: 'pas d’âge écrit : ne pas le déduire' },
  { key: 'age', text: 'Âge : 6 mois', expect: null, note: 'unité différente : jamais lue comme 6 ans' },
  { key: 'age', text: 'Âge : 140 ans', expect: null, note: 'hors bornes de plausibilité' },

  // ── Antécédents booléens : affirmation, négation, notations, proches
  { key: 'diabete', text: 'Antécédents : diabète type 2, HTA sous traitement', expect: true },
  { key: 'diabete', text: 'Patient diabétique de type 2 depuis 10 ans.', expect: true },
  { key: 'diabete', text: 'Antécédents : pas de diabète, HTA sous traitement', expect: false },
  { key: 'diabete', text: "Pas de notion de diabète ni d'HTA.", expect: false },
  { key: 'diabete', text: 'Diabète : non', expect: false },
  { key: 'diabete', text: 'Diabète (-), HTA (+)', expect: false, note: 'notation de carnet' },
  { key: 'diabete', text: 'Le diabète est exclu. Patient non diabétique.', expect: false },
  { key: 'diabete', text: 'Sa mère est diabétique.', expect: null, note: 'antécédent familial : ni vrai ni faux pour le patient' },
  { key: 'diabete', text: 'Père décédé, diabétique. Patient sans particularité.', expect: null },
  { key: 'diabete', text: 'Diabète non insulinodépendant.', expect: true, note: '« non » qualifie le diabète, il ne le nie pas' },
  { key: 'diabete', text: 'Diabète : non équilibré.', expect: true },
  { key: 'diabete', text: 'Prédiabète découvert ce jour.', expect: null, note: 'prédiabète ≠ diabète' },
  { key: 'hta', text: 'HTA : oui', expect: true },
  { key: 'hta', text: 'ATCD : HTA', expect: true },
  { key: 'hta', text: "Absence d'HTA connue.", expect: false },
  { key: 'hta', text: 'Hypertendu sous amlodipine.', expect: true },
  { key: 'hta', text: 'HTAP diagnostiquée en 2019.', expect: null, note: 'hypertension artérielle PULMONAIRE : autre maladie' },
  { key: 'hta', text: 'Son père était hypertendu.', expect: null },
  { key: 'tabagisme', text: 'Tabagisme : non', expect: false },
  { key: 'tabagisme', text: 'Patient fumeur depuis 20 ans.', expect: true },
  { key: 'tabagisme', text: "Pas de tabagisme, pas d'éthylisme.", expect: false },
  { key: 'tabagisme', text: 'Jamais fumeur.', expect: false },
  { key: 'tabagisme', text: 'Son frère est fumeur.', expect: null },
  { key: 'tabagisme', text: 'Tabagisme sevré depuis 5 ans', expect: false, note: 'sevré : pas de tabagisme actuel' },
  { key: 'tabagisme', text: 'Ancien fumeur, 30 PA.', expect: false, note: 'ancien fumeur : pas de tabagisme actuel' },
  { key: 'fievre', text: 'Fièvre : oui', expect: true },
  { key: 'fievre', text: 'Patiente fébrile à 39°C.', expect: true },
  { key: 'fievre', text: 'Apyrétique, pas de fièvre.', expect: false },
  { key: 'fievre', text: 'Non fébrile.', expect: false },
  { key: 'complications', text: 'Complications : aucune', expect: false },
  { key: 'complications', text: 'Complications : oui', expect: true },
  { key: 'complications', text: 'Suites simples, sans complication.', expect: false },

  // ── Nombres : formats français, seuils, bornes
  { key: 'hemoglobine', text: 'Hémoglobine : 11,2 g/dL', expect: 11.2 },
  { key: 'hemoglobine', text: 'Hb : 11.2 g/dl', expect: 11.2 },
  { key: 'hemoglobine', text: 'HGB = 9,8', expect: 9.8 },
  { key: 'hemoglobine', text: 'Hémoglobine : 112 g/L', expect: null, note: 'bonne valeur, mauvaise unité : écartée et signalée, jamais lue 112 g/dL' },
  { key: 'crp', text: 'CRP : 142 mg/L', expect: 142 },
  { key: 'crp', text: 'CRP : 1 250 mg/L', expect: null, note: 'au-dessus de la borne de plausibilité' },
  { key: 'crp', text: 'CRP < 5', expect: null, note: 'valeur seuil : jamais lue comme 5' },
  { key: 'crp', text: 'CRP : > 200', expect: null },
  { key: 'creatinine', text: 'Créatinine : 9,5 mg/L', expect: 9.5 },
  { key: 'creatinine', text: 'Créatinine : 85 µmol/L', expect: null, note: 'autre unité : écartée et signalée, jamais lue 85 mg/L' },
  { key: 'creatinine', text: 'Créatinine : 0,95 mg/dL', expect: null, note: 'autre unité : écartée et signalée, jamais lue 0,95 mg/L' },
  { key: 'crp', text: 'CRP : 12 mg/l', expect: 12, note: 'même unité, autre casse' },
  { key: 'temperature', text: 'Température : 38,5°C', expect: 38.5 },
  { key: 'temperature', text: 'T° : 37.2', expect: 37.2 },
  { key: 'temperature', text: 'Température : 3,8', expect: null, note: 'hors bornes' },
  { key: 'globules_blancs', text: 'GB : 12 500 /mm3', expect: null, note: 'la fiche attend des milliers par mm³ : 12 500 est hors bornes, donc écarté et signalé' },
  { key: 'globules_blancs', text: 'Leucocytes : 12,5 G/L', expect: 12.5 },
  { key: 'duree_hospitalisation', text: "Durée d'hospitalisation : 12 jours", expect: 12 },
  { key: 'duree_hospitalisation', text: 'Hospitalisée pendant 12 jours.', expect: 12 },
  { key: 'duree_hospitalisation', text: "Durée d'hospitalisation : 2 semaines", expect: null, note: 'unité de temps différente' },

  // ── Dates
  { key: 'date_admission', text: "Date d'admission : 12/03/2024", expect: '2024-03-12' },
  { key: 'date_admission', text: "Admise le 3 mars 2024 pour douleurs.", expect: '2024-03-03' },
  { key: 'date_admission', text: "Date d'admission : 03-12-24", expect: '2024-12-03' },
  { key: 'date_admission', text: "Date d'admission : 2024-03-12", expect: '2024-03-12' },
  { key: 'date_admission', text: "Date d'admission : 31/02/2024", expect: null, note: 'date impossible' },
  { key: 'date_admission', text: "Date d'admission : NR", expect: null },

  // ── Évolution, traitement, imagerie
  { key: 'evolution', text: 'Évolution : favorable', expect: 'Favorable' },
  { key: 'evolution', text: 'Devenir : décédé', expect: 'Décès' },
  { key: 'evolution', text: 'La patiente est décédée le 3 mars.', expect: 'Décès' },
  { key: 'evolution', text: 'Son père est décédé en 2010. Évolution : favorable', expect: 'Favorable' },
  { key: 'evolution', text: 'Pas de décès à déplorer. Patient perdu de vue.', expect: 'Perdu de vue' },
  { key: 'evolution', text: 'Risque de décès à discuter avec la famille.', expect: null },
  { key: 'traitement', text: 'Traitement : chirurgical', expect: ['Chirurgical'] },
  { key: 'traitement', text: 'Patient opéré le 3 mars par laparotomie.', expect: ['Chirurgical'] },
  { key: 'traitement', text: 'Antécédent de chirurgie bariatrique. Traitement médical seul.', expect: ['Médical'] },
  { key: 'modalite_imagerie', text: 'Imagerie : scanner et IRM', expect: ['Scanner', 'IRM'] },
  { key: 'modalite_imagerie', text: 'Le patient affirme ne rien avoir de grave.', expect: null, note: '« irm » dans « affirme »' },
  { key: 'numero_dossier', text: 'N° dossier : 24-0153', expect: '24-0153' },

  // ── Hypothèse, absence établie, épisode passé, non renseigné : jamais un « Oui » (ni un « Non ») inventé
  { key: 'diabete', text: 'Suspicion de diabète, HbA1c à contrôler.', expect: null, note: 'hypothèse' },
  { key: 'diabete', text: 'Diabète à éliminer devant une glycosurie.', expect: null, note: '« à éliminer » : hypothèse' },
  { key: 'diabete', text: 'Diabète éliminé par HGPO.', expect: false, note: '« éliminé » : absence établie' },
  { key: 'diabete', text: 'ATCD : DT2 sous metformine.', expect: true, note: 'sigle' },
  { key: 'diabete', text: 'DNID connu.', expect: true, note: 'sigle' },
  { key: 'diabete', text: 'Diabète gestationnel en 2012, résolutif.', expect: null, note: 'épisode passé et clos' },
  { key: 'diabete', text: 'Diabète : non renseigné', expect: null, note: 'information absente : pas un « Non »' },
  { key: 'hta', text: 'HTA ? (MAPA prévue)', expect: null, note: '« ? »' },
  { key: 'hta', text: 'HTA probable, à confirmer.', expect: null },
  { key: 'hta', text: 'HTA ancienne, sous bithérapie.', expect: null, note: '« ancienne » : de longue date ou arrêtée ? ambigu, jamais un « Non »' },
  { key: 'tabagisme', text: 'Tabac : ancien', expect: false },
  { key: 'tabagisme', text: 'Ex-fumeur (20 PA).', expect: false },
  { key: 'tabagisme', text: 'Tabagisme : NR', expect: null },
  { key: 'tabagisme', text: 'Statut tabagique inconnu.', expect: null },
  { key: 'fievre', text: 'Antécédents : pneumopathie fébrile en 2017. Pas de fièvre ce jour.', expect: false, note: 'antécédent écarté, épisode en cours lu' },
  { key: 'fievre', text: 'Antécédent de fièvre typhoïde.', expect: null },
  { key: 'fievre', text: 'Sans antécédent notable, admise pour fièvre.', expect: true, note: 'une rubrique niée n’ouvre pas les antécédents' },
  { key: 'complications', text: 'Pas de complication précoce ; abcès de paroi à J8.', expect: null, note: 'négation restreinte : ni oui ni non' },
  { key: 'complications', text: 'Aucune complication, mais reprise au bloc à J3.', expect: null, note: 'négation contredite' },
  { key: 'complications', text: 'Complications : aucune', expect: false },

  // ── Lecture optique, notation de la température, date d'entrée
  { key: 'crp', text: 'CRP : 2O mg/L', expect: null, note: 'O pour 0 : jamais lu 2' },
  { key: 'age', text: 'Âge : 6l ans', expect: null, note: 'l pour 1 : jamais lu 6' },
  { key: 'creatinine', text: 'Créatinine : 7O µmol/L', expect: null, note: 'lettre parasite : l’unité reste contrôlée' },
  { key: 'creatinine', text: 'Créatinine : 90 (N : 60-110) µmol/L', expect: null, note: 'unité écrite après les normes' },
  { key: 'temperature', text: 'T 39°2 à l’admission.', expect: 39.2, note: '« 39°2 » vaut 39,2' },
  { key: 'date_admission', text: 'Mme Y., entrée le 05/04/2024 pour dyspnée.', expect: '2024-04-05' },

  // ── Plusieurs options citées : signalées, pas tranchées au hasard de l'ordre de la liste
  { key: 'evolution', text: 'Évolution : stationnaire puis défavorable.', expect: null },
  { key: 'evolution', text: 'Évolution : favorable sans décès.', expect: 'Favorable', note: 'option niée ignorée' },
  { key: 'traitement', text: 'Traitement : antibiothérapie puis colectomie.', expect: ['Médical', 'Chirurgical'] },
];

/* ───────────────────────────── limites connues ─────────────────────────── */

/**
 * Ce que les règles livrées NE font PAS. Le résultat `actual` est celui
 * d'aujourd'hui, figé : un changement (en bien ou en mal) fait échouer le test
 * et oblige à relire la documentation.
 */
interface Limit extends Case {
  actual: unknown;
  why: string;
}
const LIMITES: Limit[] = [
  { key: 'tabagisme', text: 'Tabac : 20 paquets-années', expect: true, actual: null, why: 'une quantité n’est pas reconnue comme « oui »' },
  { key: 'sexe', text: 'Le patient a été admis pour douleurs abdominales.', expect: undefined, actual: null, why: '« patient » est un masculin générique : un sexe inventé vaut moins qu’un vide' },
  { key: 'hemoglobine', text: 'Hémoglobine : 11 g/dL puis 9,5 g/dL à J3', expect: undefined, actual: 11, why: 'la première valeur gagne : aucune notion de chronologie' },
];

describe('banc d’essai — fiche par défaut, cas attendus', () => {
  for (const c of CASES) {
    test(`${c.key} ← « ${c.text.slice(0, 60)} »${c.note ? ` — ${c.note}` : ''}`, () => {
      const { got } = run(c);
      assert.deepEqual(got, c.expect);
    });
  }

  test('bilan chiffré', () => {
    let correct = 0;
    let wrong = 0;
    let empty = 0;
    for (const c of CASES) {
      const { got } = run(c);
      if (JSON.stringify(got) === JSON.stringify(c.expect)) correct++;
      else if (got === null) empty++;
      else wrong++;
    }
    console.log(
      `# banc d'essai : ${correct}/${CASES.length} corrects, ${wrong} valeurs fausses, ${empty} vides à tort`,
    );
    assert.equal(wrong, 0, 'aucune valeur fausse tolérée sur ce banc');
  });
});

describe('banc d’essai — limites connues, figées', () => {
  for (const l of LIMITES) {
    test(`${l.key} ← « ${l.text.slice(0, 50)} » : ${l.why}`, () => {
      assert.deepEqual(run(l).got, l.actual);
    });
  }
});

describe('valeurs trouvées puis écartées', () => {
  test('une valeur seuil est signalée, pas silencieusement perdue', () => {
    const result = extractFieldDetailed(fields.get('crp')!, [doc('Biologie : CRP < 5 mg/L')]);
    assert.equal(result.hit, null);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0]!.reason, /seuil/);
    assert.match(result.rejected[0]!.snippet, /CRP/);
  });

  test('une valeur hors bornes est signalée avec son extrait', () => {
    const result = extractFieldDetailed(fields.get('hemoglobine')!, [doc('Hémoglobine : 112 g/dL')]);
    assert.equal(result.hit, null);
    assert.match(result.rejected[0]!.reason, /au-dessus du maximum/);
  });

  test('une valeur dans une autre unité est signalée avec les deux unités, pas lue comme si de rien n’était', () => {
    const hb = extractFieldDetailed(fields.get('hemoglobine')!, [doc('Hémoglobine : 112 g/L')]);
    assert.equal(hb.hit, null);
    assert.match(hb.rejected[0]!.reason, /unité « g\/L » différente de « g\/dL »/);
    const cr = extractFieldDetailed(fields.get('creatinine')!, [doc('Créatinine : 85 µmol/L')]);
    assert.equal(cr.hit, null);
    assert.match(cr.rejected[0]!.reason, /unité « µmol\/L » différente de « mg\/L »/);
    assert.match(cr.rejected[0]!.snippet, /85/);
  });

  test('une règle suivante qui réussit efface les rejets des règles précédentes', () => {
    const result = extractFieldDetailed(fields.get('age')!, [doc('Âge : NR. Patient âgé de 61 ans.')]);
    assert.equal(result.hit?.value, 61);
    assert.deepEqual(result.rejected, []);
  });
});
