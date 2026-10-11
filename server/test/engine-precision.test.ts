/**
 * Corrections de précision de la phase 1, chacune sur des phrases écrites pour l'occasion : durée de séjour donnée
 * par ses dates, unité dans la cellule suivante d'un tableau, option contenue dans une autre, ligne de PDF coupée au
 * milieu d'une négation, mentions datées après l'arrivée, identifiant suivi de ponctuation, variables de synthèse.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractFieldDetailed } from '../src/engine/rules.js';
import { coerce, dateSpanDays } from '../src/engine/coerce.js';
import { DEFAULT_FIELDS } from '../src/db/seed.js';
import type { TemplateField } from '../src/domain/types.js';
import type { SourceDoc } from '../src/engine/rules.js';

const field = (key: string): TemplateField => {
  const f = DEFAULT_FIELDS.find((x) => x.key === key)!;
  return { ...f, id: 1, templateId: 1, unit: f.unit ?? null, description: f.description ?? null, required: false, options: f.options ?? [], position: 0, section: f.section ?? 'Test' } as TemplateField;
};
const doc = (text: string): SourceDoc => ({ id: 1, name: 'cr.txt', kind: 'text', text, dicomTags: {} });
const read = (key: string, text: string) => extractFieldDetailed(field(key), [doc(text)]);
const value = (key: string, text: string) => read(key, text).hit?.value ?? null;

describe('durée en jours donnée par une période', () => {
  test('les écritures usuelles d’une période', () => {
    assert.equal(dateSpanDays('du 03/05/2024 au 10/05/2024'), 7);
    assert.equal(dateSpanDays('02/02/2025 – 09/02/2025'), 7);
    assert.equal(dateSpanDays('du 5 au 12 juin 2024'), 7);
    assert.equal(dateSpanDays('du 28 décembre 2024 au 2 janvier 2025'), 5);
    assert.equal(dateSpanDays('du 10/05/2024 au 03/05/2024'), null, 'une période à l’envers n’est pas une durée');
  });

  test('« Séjour du … au … » donne la durée, jamais le jour du mois', () => {
    assert.equal(value('duree_hospitalisation', 'Séjour du 03/05/2024 (entrée par les urgences) au 10/05/2024'), 7);
  });

  test('une date n’est pas un nombre', () => {
    assert.equal(coerce('03/05/2024', 'number', [], {}, 'mg/L').ok, false);
    assert.equal(coerce('11.2', 'number', [], {}, 'g/dL').ok, true, '« 11.2 » reste un nombre');
  });
});

describe('unité écrite dans la cellule suivante', () => {
  test('« Créatinine : 150 : µmol/L » est signalée pour une fiche en mg/L', () => {
    const r = read('creatinine', 'Urée : 9 : mmol/L\nCréatinine : 150 : µmol/L : 50 – 100');
    assert.equal(r.hit, null);
    assert.match(r.rejected[0]!.reason, /µmol\/L/);
  });

  test('une cellule sur sa propre ligne, et une unité mal lue par l’OCR', () => {
    assert.equal(read('creatinine', 'Créatinine\n: 150\n: µmol/L').hit, null);
    assert.equal(read('creatinine', 'Créatinine | 85 | Hmol/L | 60-110').hit, null);
  });

  test('la bonne unité passe', () => {
    assert.equal(value('creatinine', 'Créatinine : 12,4 : mg/L : 6 – 12'), 12.4);
  });
});

describe('options et correspondances', () => {
  test('« défavorable » ne se lit pas « favorable »', () => {
    assert.equal(value('evolution', 'Évolution défavorable malgré le traitement.'), 'Défavorable');
    assert.equal(value('evolution', 'Évolution : favorable.'), 'Favorable');
  });

  test('« HTA ancienne » n’est pas un « non » ; « Tabac : ancien » l’est', () => {
    assert.notEqual(value('hta', 'Antécédents : HTA ancienne.'), false);
    assert.equal(value('tabagisme', 'Tabac : ancien'), false);
  });
});

describe('ligne coupée par la mise en page', () => {
  test('une négation coupée en fin de ligne reste une négation', () => {
    assert.equal(value('diabete', 'Antécédents : asthme. Pas de\ndiabète. Allergie à la pénicilline.'), false);
  });

  test('une liste à une ligne par élément n’est pas recollée', () => {
    assert.equal(value('diabete', 'Pas de tabagisme\nDiabète de type 2 sous metformine'), true);
  });
});

describe('valeur à l’arrivée', () => {
  test('une fièvre datée plus tard dans le séjour n’est pas celle de l’arrivée', () => {
    assert.equal(value('fievre', 'À l’arrivée : apyrétique. Le 12/06 (J3), fièvre à 38,9 °C sur pneumopathie.'), null);
    assert.equal(value('fievre', 'Pic fébrile isolé à 38,2 °C au cours du séjour.'), null);
  });

  test('la fièvre de l’arrivée est retenue', () => {
    assert.equal(value('fievre', 'Admis pour fièvre à 39,2 °C et frissons depuis la veille.'), true);
  });

  test('la première valeur d’un libellé garde sa date, la suivante non', () => {
    assert.equal(value('hemoglobine', 'Hémoglobine : 12 g/dL puis 10,1 g/dL à J4'), 12);
  });
});

describe('identifiant de dossier', () => {
  test('ni parenthèse ni débris d’OCR collés à l’identifiant', () => {
    assert.equal(value('numero_dossier', 'Patient : (N° dossier B-2025-00412) opéré le 03/03'), 'B-2025-00412');
    assert.equal(value('numero_dossier', 'IPP 40211876 [: rq Ë'), '40211876');
  });

  test('un « IPP » sans chiffre n’est pas un identifiant', () => {
    assert.equal(value('numero_dossier', 'IPP : inconnu'), null);
  });
});
