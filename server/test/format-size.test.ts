import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatSize } from '../src/lib/size.js';

const MB = 1024 * 1024;

describe('formatSize : les tailles des messages d’erreur', () => {
  it('reste lisible pour une limite réglée petite (jamais « 0 Mo »)', () => {
    assert.equal(formatSize(0), '0 o');
    assert.equal(formatSize(500), '500 o');
    assert.equal(formatSize(2048), '2 ko');
    assert.equal(formatSize(20_000), '20 ko');
    assert.equal(formatSize(MB - 1), '1024 ko');
  });

  it('donne un chiffre après la virgule sous 10 Mo, puis des Mo entiers', () => {
    assert.equal(formatSize(MB), '1,0 Mo');
    assert.equal(formatSize(1.5 * MB), '1,5 Mo');
    assert.equal(formatSize(9.96 * MB), '10 Mo');
    assert.equal(formatSize(74 * MB), '74 Mo');
    assert.equal(formatSize(200 * MB), '200 Mo');
  });
});
