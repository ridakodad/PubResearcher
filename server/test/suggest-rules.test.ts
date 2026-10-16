/**
 * Règles proposées d'office (`suggest-rules.ts`) : une variable qui n'arrive qu'avec son libellé, son type, ses options
 * et son unité — fiche saisie de zéro, importée d'un tableur — doit se remplir sur des phrases rédigées de façons
 * variées, et rester vide (ou « Non ») sur les phrases niées, hypothétiques ou familiales.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { suggestExtraction, type SuggestInput } from '../src/engine/suggest-rules.js';
import { variantsFor, findConcept, CONCEPTS } from '../src/engine/lexicon.js';
import { extractFieldDetailed, type SourceDoc } from '../src/engine/rules.js';
import { fieldExtractionSchema } from '../src/lib/schemas.js';
import type { TemplateField } from '../src/domain/types.js';

function field(input: SuggestInput): TemplateField {
  return {
    id: 1, templateId: 1, key: input.key ?? 'v', label: input.label, type: input.type, section: 'Test',
    unit: input.unit ?? null, description: null, required: false, options: input.options ?? [], position: 0,
    extraction: suggestExtraction(input),
  };
}
const doc = (text: string): SourceDoc => ({ id: 1, name: 'cr.txt', kind: 'text', text, dicomTags: {} });
const read = (f: TemplateField, text: string) => extractFieldDetailed(f, [doc(text)]).hit?.value ?? null;

interface Case {
  input: SuggestInput;
  /** Phrases dont la valeur attendue est connue. */
  yes: [string, unknown][];
  /** Phrases qui ne doivent RIEN donner (ou la valeur indiquée, « Non » pour une absence documentée). */
  no?: [string, unknown][];
}

const CASES: Case[] = [
  {
    input: { label: 'CRP (mg/L)', type: 'number', unit: 'mg/L' },
    yes: [
      ['CRP : 142 mg/L', 142],
      ['Protéine C réactive à 87 mg/L.', null],
      ['PROTÉINE C-RÉACTIVE ........ 56', 56],
      ['Biologie : 142 mg/L de CRP, leucocytose à 15 000.', 142],
      ['CRP\n33,5 mg/L', 33.5],
    ],
    no: [['CRP non dosée.', null], ['CRP < 5 mg/L', null], ['CRP à contrôler dans 48 h', null]],
  },
  {
    input: { label: "Hémoglobine à l'admission", type: 'number', unit: 'g/dL' },
    yes: [['Hb : 11,2 g/dL', 11.2], ['Hgb 9.8', 9.8], ['Hémoglobinémie = 13 g/dL', 13]],
    no: [['Hb : 7,1 g/dL à J4', null], ['Hb : 112 g/L', null]],
  },
  {
    input: { label: 'Globules blancs', type: 'number', unit: '/mm3' },
    yes: [['GB : 12 500/mm3', 12500], ['Leucocytes\t9 800', 9800], ['WBC = 15000', 15000]],
  },
  {
    input: { label: 'Créatinine sérique', type: 'number', unit: 'mg/L' },
    yes: [['Créat : 12 mg/L', 12], ['Créatininémie à 9', null], ['Créatinine - 15 mg/L', 15]],
    no: [['Créatinine : 85 µmol/L', null]],
  },
  {
    input: { label: 'Température', type: 'number', unit: '°C' },
    yes: [['T° : 38,5 °C', 38.5], ['Temp 39.2', 39.2], ['TEMPÉRATURE : 37,8', 37.8]],
    no: [['Température : non prise', null]],
  },
  {
    input: { label: 'Fréquence cardiaque', type: 'integer', unit: 'bpm' },
    yes: [['FC : 110 bpm', 110], ['Pouls = 88/min', 88]],
  },
  {
    input: { label: 'SpO2 (%)', type: 'number', unit: '%' },
    yes: [['Saturation : 94 %', 94], ['SpO2 92% en air ambiant', 92]],
  },
  {
    input: { label: 'IMC', type: 'number', unit: 'kg/m²' },
    yes: [['BMI : 31,2', 31.2], ['Indice de masse corporelle = 27', 27]],
  },
  {
    input: { label: 'Poids (kg)', type: 'number', unit: 'kg' },
    yes: [['Poids : 72 kg', 72], ['POIDS 68,5 KG', 68.5]],
    no: [['P = 0,03', null]],
  },
  {
    input: { label: 'Âge', type: 'integer', unit: 'ans' },
    yes: [['Âge : 54 ans', 54], ['Patiente âgée de 67 ans, admise pour dyspnée.', 67]],
    no: [['Tabagisme depuis 30 ans.', null]],
  },
  {
    input: { label: 'Durée de séjour (jours)', type: 'integer', unit: 'jours' },
    yes: [['Durée d’hospitalisation : 8 jours', 8], ['DMS : 5 j', 5], ['Séjour du 03/05/2024 au 10/05/2024', 7]],
  },
  {
    input: { label: "Date d'entrée", type: 'date' },
    yes: [
      ["Date d'admission : 12/03/2024", '2024-03-12'],
      ['Admis le 5 avril 2024 pour dyspnée.', '2024-04-05'],
      ['Hospitalisée le 01.02.2023', '2023-02-01'],
      ['DATE D’ENTRÉE\n14/01/2024', '2024-01-14'],
    ],
  },
  {
    input: { label: 'Date de sortie', type: 'date' },
    yes: [['Sortie le 20/03/2024', '2024-03-20'], ['Date de sortie = 2024-03-21', '2024-03-21']],
  },
  {
    input: { label: 'Date de naissance', type: 'date' },
    yes: [['Né le 03/07/1956', '1956-07-03'], ['DDN : 12/12/1949', '1949-12-12']],
  },
  {
    input: { label: 'HTA', type: 'boolean' },
    yes: [
      ['ATCD : HTA sous amlodipine.', true],
      ['Patiente hypertendue connue.', true],
      ['Hypertension artérielle : oui', true],
      ['HTA : non', false],
      ['Pas d’HTA.', false],
    ],
    no: [['Mère hypertendue.', null], ['HTA à éliminer ?', null], ['Suspicion d’hypertension artérielle.', null]],
  },
  {
    input: { label: 'Diabète', type: 'boolean' },
    yes: [['DT2 sous metformine', true], ['Diabétique depuis 10 ans', true], ['Diabète : oui', true], ['Non diabétique.', false]],
    no: [['Père diabétique.', null], ['Diabète gestationnel ? à rechercher', null]],
  },
  {
    input: { label: 'Tabagisme actif', type: 'boolean' },
    yes: [['Fumeur à 20 PA.', true], ['Tabac : oui', true], ['Tabagisme sevré depuis 2010.', false]],
    no: [['Son conjoint est fumeur ; sa famille aussi', null]],
  },
  {
    input: { label: 'Insuffisance rénale chronique', type: 'boolean' },
    yes: [['IRC stade 3.', true], ['Patient hémodialysé 3 fois par semaine.', true], ['Absence d’insuffisance rénale.', false]],
  },
  {
    input: { label: 'BPCO', type: 'boolean' },
    yes: [['Bronchopneumopathie chronique obstructive post-tabagique.', true], ['Emphysème pulmonaire.', true]],
    no: [['Suspicion de BPCO, EFR à prévoir.', null]],
  },
  {
    input: { label: 'Antécédent d’AVC', type: 'boolean' },
    yes: [['ATCD d’AIT en 2019.', true], ['Antécédents : accident vasculaire cérébral ischémique en 2020.', true]],
    no: [['Pas d’antécédent d’AVC.', false]],
  },
  {
    input: { label: 'Fièvre', type: 'boolean' },
    yes: [['Patient fébrile à 39 °C.', true], ['Fièvre : oui', true], ['Apyrétique, pas de fièvre.', false]],
    no: [['Antécédents : pneumopathie fébrile en 2019.', null]],
  },
  {
    input: { label: 'Fibrillation atriale', type: 'boolean' },
    yes: [['ACFA connue sous apixaban.', true], ['Fibrillation auriculaire paroxystique.', true]],
    no: [['Pas de trouble du rythme, pas de FA.', false]],
  },
  {
    input: { label: 'Décès', type: 'boolean' },
    yes: [['Patient décédé à J5.', true], ['Décès : oui', true]],
    no: [['Risque de décès élevé ?', null]],
  },
  {
    input: { label: 'Sexe', type: 'enum', options: ['Masculin', 'Féminin'] },
    yes: [['Sexe : M', 'Masculin'], ['Sexe : F', 'Féminin'], ['Genre : homme', 'Masculin'], ['Mme X., 54 ans', 'Féminin']],
    no: [['Le patient a été admis.', null]],
  },
  {
    input: { label: 'Côté', type: 'enum', options: ['Droit', 'Gauche', 'Bilatéral'] },
    yes: [['Côté : G', 'Gauche'], ['Côté : bilat', 'Bilatéral']],
  },
  {
    input: { label: 'Évolution', type: 'enum', options: ['Favorable', 'Défavorable', 'Décès'] },
    yes: [['Évolution : bonne', 'Favorable'], ['Devenir : aggravation', 'Défavorable'], ['Le patient est décédé à J3.', 'Décès']],
    no: [['Pas de décès.', null]],
  },
  {
    input: { label: 'Imagerie réalisée', type: 'multi', options: ['Scanner', 'IRM', 'Échographie', 'Radiographie'] },
    yes: [['TDM thoracique et écho abdominale.', ['Scanner', 'Échographie']], ['Imagerie : radio + IRM', ['Radiographie', 'IRM']]],
    no: [['Pas d’IRM.', null]],
  },
  {
    input: { label: 'Antibiothérapie', type: 'boolean' },
    yes: [['Mise sous ATB : amoxicilline.', true], ['Ceftriaxone 2 g/j.', true]],
    no: [['Pas d’antibiotique.', false]],
  },
  {
    input: { label: 'Motif de consultation', type: 'text' },
    yes: [['Motif d’hospitalisation : douleur thoracique', 'douleur thoracique'], ['MOTIF : dyspnée', 'dyspnée']],
  },
  {
    input: { label: 'Kaliémie (mmol/L)', type: 'number', unit: 'mmol/L' },
    yes: [['K+ : 4,2 mmol/L', 4.2], ['Kaliémie 5.1', 5.1], ['Potassium = 3,4', 3.4]],
  },
  {
    input: { label: 'Variable inconnue du lexique', type: 'number' },
    yes: [['Variable inconnue du lexique : 12', 12]],
  },
];

describe('règles proposées : la valeur attendue sur des phrases variées', () => {
  for (const c of CASES) {
    const f = field(c.input);
    for (const [text, expected] of c.yes) {
      if (expected === null) continue;
      test(`${c.input.label} ← « ${text.replace(/\n/g, '⏎')} »`, () => assert.deepEqual(read(f, text), expected));
    }
  }
});

describe('règles proposées : rien sur les phrases niées, hypothétiques ou hors sujet', () => {
  for (const c of CASES) {
    const f = field(c.input);
    for (const [text, expected] of c.no ?? []) {
      test(`${c.input.label} ← « ${text} » donne ${JSON.stringify(expected)}`, () => assert.deepEqual(read(f, text), expected));
    }
  }
});

describe('règles proposées : contrat', () => {
  test('passent le validateur des règles', () => {
    for (const c of CASES) {
      const parsed = fieldExtractionSchema.safeParse(suggestExtraction(c.input));
      assert.ok(parsed.success, `${c.input.label} : ${parsed.success ? '' : parsed.error.message}`);
    }
  });
  test('une variable reçoit toujours au moins une règle, activée', () => {
    for (const type of ['text', 'number', 'integer', 'date', 'boolean', 'enum', 'multi'] as const) {
      const e = suggestExtraction({ label: 'Zorglub', type, options: ['A', 'B'] });
      assert.equal(e.enabled, true);
      assert.ok(e.rules.length > 0);
    }
  });
  test('la mesure à l’admission seulement si le libellé le dit', () => {
    assert.equal(suggestExtraction({ label: 'CRP à l’admission', type: 'number', unit: 'mg/L' }).episode, 'admission');
    assert.equal(suggestExtraction({ label: 'CRP', type: 'number', unit: 'mg/L' }).episode, undefined);
  });
  test('bornes de plausibilité seulement dans l’unité du lexique', () => {
    assert.deepEqual(
      [suggestExtraction({ label: 'Hb', type: 'number', unit: 'g/dL' }).postProcess?.max],
      [25],
    );
    assert.equal(suggestExtraction({ label: 'Hb', type: 'number', unit: 'g/L' }).postProcess?.max, undefined);
  });
});

describe('lexique', () => {
  test('au moins 150 notions', () => assert.ok(CONCEPTS.length >= 150, String(CONCEPTS.length)));
  test('rapprochement insensible à la casse, aux accents, à l’ordre et aux unités', () => {
    assert.equal(findConcept('CRP (mg/L)')?.id, 'crp');
    assert.equal(findConcept('réactive, PROTEINE C')?.id, 'crp');
    assert.equal(findConcept("Taux d'hémoglobine à l'entrée")?.id, 'hemoglobine');
    assert.equal(findConcept('Traitement par insuline')?.id, 'insuline');
    assert.equal(findConcept('Zorglub'), null);
  });
  test('variantsFor garde toujours le libellé nettoyé en tête', () => {
    assert.equal(variantsFor('CRP (mg/L)')[0], 'CRP');
    assert.ok(variantsFor('HTA').includes('Hypertension artérielle'));
    assert.ok(variantsFor('globules blancs').includes('Leucocytes'));
    assert.ok(variantsFor('Créatinine').includes('Créat'));
    assert.ok(variantsFor('Scanner').includes('TDM'));
    assert.deepEqual(variantsFor('Zorglub'), ['Zorglub']);
  });
});
