/**
 * Repliage du texte : la version par blocs doit rendre exactement ce que rendait la version caractère par caractère
 * (texte replié et table de correspondance), et rester rapide sur un document volumineux.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { foldText, toOriginalRange } from '../src/engine/fold.js';

/** L'implémentation d'origine, gardée ici comme référence. */
function referenceFold(original: string): { folded: string; map: number[] } {
  const COMBINING = /\p{M}/u;
  let folded = '';
  const map: number[] = [];
  for (let i = 0; i < original.length; i++) {
    const ch = original[i]!;
    const decomposed = ch.normalize('NFD');
    let out = '';
    for (const part of decomposed) {
      if (!COMBINING.test(part)) out += part;
    }
    out = out.toLowerCase().replace(/[‘’‛ʼ´′]/g, "'");
    for (const c of out) {
      folded += c;
      map.push(i);
    }
  }
  return { folded, map };
}

const ALPHABET = [
  ...'abcXYZ019 .,:;-_/\n\t',
  ...'éèêëàâäîïôöùûüçÉÈÀÂÎÔÙÇœŒæÆﬁß',
  '\u0301', // accent combinant seul
  'e\u0301', // lettre + accent combinant
  '\u00a0', // espace insécable
  '\u200b', // espace de largeur nulle
  ..."'‘’‛ʼ´′", // apostrophe droite et typographiques : ramenées à l'apostrophe droite, sans changer de longueur
  'İ', // majuscule I point : le passage en minuscules rallonge
  'ǆ',
  'Ω',
  'Ж',
  '漢',
  '\u{1f600}', // hors plan de base : deux unités
  '\ud83d', // moitié de paire seule
];

/** Générateur pseudo-aléatoire déterministe (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('repliage par blocs', () => {
  test('rend le même texte et la même table que la version caractère par caractère', () => {
    const rand = rng(20260101);
    for (let round = 0; round < 400; round++) {
      let s = '';
      const length = Math.floor(rand() * 60);
      for (let k = 0; k < length; k++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
      const expected = referenceFold(s);
      const actual = foldText(s);
      assert.equal(actual.folded, expected.folded, `texte replié différent pour ${JSON.stringify(s)}`);
      assert.deepEqual(Array.from(actual.map), expected.map, `table différente pour ${JSON.stringify(s)}`);
      assert.equal(actual.original, s);
    }
  });

  test('texte vide, ASCII pur, accents seuls', () => {
    assert.deepEqual({ ...foldText(''), map: Array.from(foldText('').map) }, { folded: '', map: [], original: '' });
    assert.equal(foldText('Hello WORLD 42').folded, 'hello world 42');
    assert.deepEqual(Array.from(foldText('Hello').map), [0, 1, 2, 3, 4]);
    assert.equal(foldText('éÉèÈ').folded, 'eeee');
    assert.deepEqual(Array.from(foldText('éÉèÈ').map), [0, 1, 2, 3]);
  });

  test('une unité qui s’allonge en minuscules garde la même origine pour chaque unité produite', () => {
    const ft = foldText('aİb');
    assert.equal(ft.folded, referenceFold('aİb').folded);
    assert.equal(ft.map.length, ft.folded.length);
    assert.deepEqual(Array.from(ft.map), referenceFold('aİb').map);
  });

  test('la table reste de la même longueur que le texte replié', () => {
    for (const s of ['Père décédé', 'Créatinine élevée', 'ﬁèvre à 39,5 °C', 'x\u{1f600}y', 'œdème']) {
      const ft = foldText(s);
      assert.equal(ft.map.length, ft.folded.length, s);
    }
  });

  test('retrouve l’extrait d’origine après un document long mêlant ASCII et accents', () => {
    const unit = 'Patient né en 1960 ; créatinine : 112 µmol/L ; hémoglobine : 13,5 g/dL. ';
    const text = unit.repeat(5000) + 'Numéro de dossier : AB-12345 ; fin.';
    const ft = foldText(text);
    const at = ft.folded.indexOf('ab-12345');
    assert.ok(at > 0);
    const range = toOriginalRange(ft, at, at + 'ab-12345'.length);
    assert.equal(text.slice(range.start, range.end), 'AB-12345');
  });

  test('un document de 2 millions de caractères se replie en une fraction de seconde', () => {
    const unit = 'Âge : 54 ans ; Sexe : féminin ; CRP : 12 mg/L ; antécédents : diabète de type 2, HTA sous traitement. ';
    const text = unit.repeat(Math.ceil(2_000_000 / unit.length));
    const start = performance.now();
    const ft = foldText(text);
    const elapsed = performance.now() - start;
    assert.equal(ft.folded.length, ft.map.length);
    // La version caractère par caractère demandait environ 750 ms ici ; celle-ci quelques dizaines.
    assert.ok(elapsed < 500, `repliage trop lent : ${Math.round(elapsed)} ms`);
  });
});
