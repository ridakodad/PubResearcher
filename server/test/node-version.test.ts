import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_NODE, nodeVersionProblem } from '../src/lib/node-version.js';

describe('version de Node exigée', () => {
  test('les versions qui conviennent passent', () => {
    for (const v of ['22.13.0', '22.13.1', '22.22.2', '22.100.0', '23.4.0', '24.0.0', '30.1.2', 'v22.13.0']) {
      assert.equal(nodeVersionProblem(v), null, v);
    }
  });

  test('les versions trop anciennes sont refusées par une phrase qui dit quoi faire', () => {
    for (const v of ['22.12.9', '22.5.0', '22.0.0', '20.11.0', '18.19.1', 'v21.7.3']) {
      const problem = nodeVersionProblem(v);
      assert.ok(problem, v);
      assert.match(problem, /Node\.js 22\.13\.0 ou plus récent/);
      assert.match(problem, new RegExp(`détectée est ${v.replace(/^v/, '').replace(/\./g, '\\.')}`));
      assert.match(problem, /LTS/);
    }
  });

  test('une version illisible ne bloque pas le démarrage', () => {
    assert.equal(nodeVersionProblem(''), null);
    assert.equal(nodeVersionProblem('inconnue'), null);
  });

  test('la version de Node qui exécute les tests convient', () => {
    assert.equal(nodeVersionProblem(), null, `Node ${process.versions.node} < ${MIN_NODE.join('.')}`);
  });
});
