/**
 * Tests de la pseudonymisation locale du texte envoyé à Claude (engine/pseudonymize.ts).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pseudonymize } from '../src/engine/pseudonymize.js';

const NOTE = [
  'CHU de Grenoble — Service de médecine interne',
  'Patient : DUPONT Jean, né le 12/03/1962',
  'IPP : 8812345 — N° de séjour : S24-0091',
  'Adresse : 12 rue des Lilas, 38000 Grenoble',
  'Tél. 06 12 34 56 78 ; jean.dupont@exemple.fr ; NIR 1 62 03 38 185 042 17',
  'Adressé par le Dr Martin pour fièvre.',
  'Mme Durand, infirmière, note une CRP à 180 mg/L le 14/03/2024. Hémoglobine : 8,1 g/dL.',
  'Antécédents : HTA, diabète de type 2. Pas de tabac.',
].join('\n');

describe('ce qui est masqué', () => {
  const { text, counts } = pseudonymize(NOTE);

  test('aucune donnée directement identifiante ne reste', () => {
    for (const leak of ['DUPONT', 'Jean,', '12/03/1962', '8812345', 'S24-0091', 'Lilas', '06 12 34 56 78', 'jean.dupont', '185 042', 'Martin', 'Durand']) {
      assert.equal(text.includes(leak), false, `fuite : ${leak}\n${text}`);
    }
  });

  test('les données cliniques restent intactes', () => {
    for (const kept of ['CRP à 180 mg/L le 14/03/2024', 'Hémoglobine : 8,1 g/dL', 'HTA, diabète de type 2', 'Pas de tabac', 'fièvre', 'CHU de Grenoble']) {
      assert.equal(text.includes(kept), true, `perdu : ${kept}\n${text}`);
    }
  });

  test('les libellés restent lisibles et les remplacements sont comptés', () => {
    assert.match(text, /Patient : \[NOM\]/);
    assert.match(text, /né le \[DATE DE NAISSANCE\]/);
    assert.match(text, /Dr \[NOM\]/);
    assert.equal(counts.telephone, 1);
    assert.equal(counts.email, 1);
    assert.equal(counts.nir, 1);
    assert.equal(counts.adresse, 1);
  });
});

describe('positions ramenées au document', () => {
  test('une plage du texte masqué retrouve le passage d’origine', () => {
    const original = 'Mme DUPONT Marie présente une CRP à 180 mg/L.';
    const masked = pseudonymize(original);
    const at = masked.text.indexOf('CRP à 180');
    const range = masked.toOriginal(at, at + 'CRP à 180'.length);
    assert.equal(original.slice(range.start, range.end), 'CRP à 180');
  });

  test('une plage qui couvre une étiquette couvre tout le passage remplacé', () => {
    const original = 'Mme DUPONT Marie, 54 ans';
    const masked = pseudonymize(original);
    const range = masked.toOriginal(0, masked.text.indexOf(','));
    assert.equal(original.slice(range.start, range.end), 'Mme DUPONT Marie');
  });

  test('un texte sans donnée identifiante est rendu tel quel', () => {
    const original = 'CRP 45 mg/L, puis 180 mg/L. Pas de complication.';
    const masked = pseudonymize(original);
    assert.equal(masked.text, original);
    assert.deepEqual(masked.toOriginal(4, 6), { start: 4, end: 6 });
  });
});

describe('pas de faux positif sur le vocabulaire clinique', () => {
  for (const sentence of [
    'Le patient présente une douleur abdominale depuis 48 h.',
    'Nom du traitement : amoxicilline 1 g x 3/j.',
    'Plaquettes 250 000/mm³, leucocytes 12,4 G/L.',
    'Date d’admission : 12/03/2024. Sortie le 18/03/2024.',
    'Score de Glasgow 15, PA 132/78 mmHg, FC 92/min.',
  ]) {
    test(sentence, () => {
      assert.equal(pseudonymize(sentence).text, sentence);
    });
  }
});
