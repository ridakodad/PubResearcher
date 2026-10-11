/**
 * Tests du contrôle « la citation soutient-elle la valeur ? » (engine/quote-check.ts).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { datesIn, numbersIn, quoteContradiction } from '../src/engine/quote-check.js';
import { priceOf } from '../src/engine/pricing.js';

describe('nombres d’une citation', () => {
  test('écritures française et anglaise, espaces de milliers', () => {
    assert.deepEqual(numbersIn('Hb 8,1 g/dL ; plaquettes 250 000 /mm³ ; T 38.5'), [8.1, 250000, 38.5]);
  });

  test('une température à la française', () => {
    assert.equal(quoteContradiction(38.5, 'number', 'T 38°5 à l’arrivée'), null);
  });

  test('un nombre collé à une lettre (lecture optique) n’en est pas un', () => {
    assert.deepEqual(numbersIn('CRP : 1O mg/L, âge 7l ans'), []);
    assert.equal(quoteContradiction(1, 'number', 'CRP : 1O mg/L') !== null, true);
  });
});

describe('dates d’une citation', () => {
  test('les écritures usuelles donnent la même date ISO', () => {
    for (const text of ['le 12/03/2024', 'le 12/3/24', 'le 12.03.2024', 'le 12 mars 2024', 'le 2024-03-12']) {
      assert.equal(datesIn(text).has('2024-03-12'), true, text);
    }
    assert.equal(datesIn('le 1er février 2025').has('2025-02-01'), true);
  });
});

describe('« oui » et sa citation', () => {
  for (const quote of [
    'Pas de diabète',
    'Absence de fièvre',
    'Suspicion de diabète',
    'HTA ? (à confirmer)',
    'Diabète éliminé',
    'Ancien fumeur',
    'Ex-fumeur',
    'Père diabétique',
    'Embolie pulmonaire probable',
  ]) {
    test(`« ${quote} » ne justifie pas « oui »`, () => {
      assert.notEqual(quoteContradiction(true, 'boolean', quote), null);
    });
  }

  test('une affirmation simple justifie « oui », et « non » n’est pas contrôlé', () => {
    assert.equal(quoteContradiction(true, 'boolean', 'Diabète de type 2 sous metformine'), null);
    assert.equal(quoteContradiction(false, 'boolean', 'Pas de diabète'), null);
  });
});

describe('tarif d’un identifiant de modèle daté', () => {
  test('il prend le tarif de son modèle', () => {
    assert.deepEqual(priceOf('claude-opus-5-5-20260601'), priceOf('claude-opus-5-5'));
    assert.equal(priceOf('modele-inconnu'), null);
  });
});
