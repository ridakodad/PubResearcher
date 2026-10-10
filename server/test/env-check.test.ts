/**
 * Contrôle des réglages numériques de l'environnement.
 *
 * Un plafond mal écrit ne doit jamais se changer en silence en valeur par défaut — ni en NaN, qui rend faux toute
 * comparaison et désactive le plafond (« longueur > NaN » : plus aucune troncature du texte transmis à Anthropic).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CHOICE_SETTINGS, NUMERIC_SETTINGS, environmentProblems, numberOr, readNumericEnv } from '../src/lib/env-check.js';

const names = Object.keys(NUMERIC_SETTINGS) as (keyof typeof NUMERIC_SETTINGS)[];

describe('réglages numériques : bornes', () => {
  test('un environnement vide, ou des valeurs vides, ne pose aucun problème', () => {
    assert.deepEqual(environmentProblems({}), []);
    assert.deepEqual(environmentProblems(Object.fromEntries(names.map((n) => [n, '  ']))), []);
  });

  test('chaque réglage accepte ses deux bornes et refuse ce qui les dépasse d’une unité', () => {
    for (const name of names) {
      const { min, max } = NUMERIC_SETTINGS[name];
      assert.deepEqual(environmentProblems({ [name]: String(min) }), [], `${name} = ${min}`);
      assert.deepEqual(environmentProblems({ [name]: String(max) }), [], `${name} = ${max}`);
      assert.equal(environmentProblems({ [name]: String(max + 1) }).length, 1, `${name} = ${max + 1}`);
      if (min > 0) assert.equal(environmentProblems({ [name]: String(min - 1) }).length, 1, `${name} = ${min - 1}`);
      assert.equal(environmentProblems({ [name]: '-1' }).length, 1, `${name} = -1`);
    }
  });

  test('ce qui n’est pas un entier décimal est refusé : texte, millier espacé, notation scientifique, hexadécimal, décimale', () => {
    for (const bad of ['abc', '60 000', '1e3', '0x20', '12abc', '1,5', 'NaN', 'Infinity', '--5']) {
      const problems = environmentProblems({ PDF_MAX_PAGES: bad, PARSE_WORKER_MB: bad });
      assert.equal(problems.length, 2, `« ${bad} »`);
      assert.match(problems[0]!, new RegExp(`^PDF_MAX_PAGES=« ${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} » n'est pas valide : un entier entre 1 et 1000000 est attendu\\.$`));
    }
    assert.equal(environmentProblems({ PDF_MAX_PAGES: '2.5' }).length, 1, 'pas de décimale pour un nombre de pages');
  });

  test('OCR_PDF_SCALE accepte une décimale entre 1 et 4', () => {
    assert.deepEqual(environmentProblems({ OCR_PDF_SCALE: '2.5' }), []);
    assert.deepEqual(environmentProblems({ OCR_PDF_SCALE: '3' }), []);
    assert.equal(environmentProblems({ OCR_PDF_SCALE: '4.1' }).length, 1);
    assert.equal(environmentProblems({ OCR_PDF_SCALE: '0.5' }).length, 1);
    assert.equal(environmentProblems({ OCR_PDF_SCALE: '2,5' }).length, 1);
  });

  test('OCR_MAX_PAGES=0 (jamais d’OCR) est une valeur valide', () => {
    assert.deepEqual(environmentProblems({ OCR_MAX_PAGES: '0' }), []);
  });

  test('plusieurs réglages invalides sont tous annoncés d’un coup, chacun avec son nom', () => {
    const problems = environmentProblems({ PORT: 'abc', PARSE_WORKER_MB: '64', LLM_MAX_CHARS_PER_DOC: '60 000', PDF_MAX_PAGES: '1500' });
    assert.equal(problems.length, 3);
    assert.match(problems.join('\n'), /PORT=« abc »/);
    assert.match(problems.join('\n'), /PARSE_WORKER_MB=« 64 » .* entre 128 et 1048576/);
    assert.match(problems.join('\n'), /LLM_MAX_CHARS_PER_DOC=« 60 000 »/);
  });

  test('LLM_EFFORT n’accepte que les niveaux connus', () => {
    for (const level of CHOICE_SETTINGS.LLM_EFFORT) assert.deepEqual(environmentProblems({ LLM_EFFORT: level }), [], level);
    const problems = environmentProblems({ LLM_EFFORT: 'hgih' });
    assert.equal(problems.length, 1);
    assert.match(problems[0]!, /LLM_EFFORT=« hgih » n'est pas valide : « low », « medium », « high », « xhigh », « max » sont attendus/);
  });

  test('la table couvre chaque réglage numérique du guide de l’administrateur', () => {
    const documented = [
      'PORT', 'MAX_UPLOAD_BYTES', 'MAX_REQUEST_BYTES', 'MAX_TEXT_CHARS', 'PDF_MAX_PAGES', 'PDF_PARSE_TIMEOUT_MS', 'DOCX_MAX_XML_MB',
      'DOCX_MAX_TOTAL_MB', 'IMAGE_MAX_MEGAPIXELS', 'PARSE_CONCURRENCY', 'PARSE_HARD_TIMEOUT_MS', 'PARSE_WORKER_MB',
      'PARSE_MAX_GROWTH_MB', 'REGEX_BUDGET_MS', 'OCR_MAX_PAGES', 'OCR_PDF_SCALE', 'LLM_MAX_CHARS_PER_DOC', 'LLM_MAX_TOKENS',
      'CHAT_MAX_TOKENS', 'BIBLIO_MAX_RESULTS', 'APIFY_TIMEOUT_MS',
    ];
    assert.deepEqual([...names].sort(), [...documented].sort());
  });
});

describe('lecture d’un réglage', () => {
  test('readNumericEnv rend le défaut pour une valeur absente ou vide, la valeur sinon', () => {
    assert.equal(readNumericEnv('X', undefined, 7, { min: 1, max: 9 }), 7);
    assert.equal(readNumericEnv('X', ' ', 7, { min: 1, max: 9 }), 7);
    assert.equal(readNumericEnv('X', ' 3 ', 7, { min: 1, max: 9 }), 3);
    assert.throws(() => readNumericEnv('X', '10', 7, { min: 1, max: 9 }), /X=« 10 » n'est pas valide : un entier entre 1 et 9 est attendu\./);
  });

  test('numberOr ne rend jamais NaN : une valeur illisible ou trop petite donne le défaut', () => {
    assert.equal(numberOr(undefined, 60_000, 1000), 60_000);
    assert.equal(numberOr('', 60_000, 1000), 60_000);
    assert.equal(numberOr('abc', 60_000, 1000), 60_000);
    assert.equal(numberOr('60 000', 60_000, 1000), 60_000);
    assert.equal(numberOr('999', 60_000, 1000), 60_000);
    assert.equal(numberOr('1500', 60_000, 1000), 1500);
    assert.equal(numberOr('1500.9', 60_000, 1000), 1500);
    // La comparaison que « NaN » rendait toujours fausse.
    assert.ok('x'.repeat(70_000).length > numberOr('abc', 60_000, 1000));
  });
});
