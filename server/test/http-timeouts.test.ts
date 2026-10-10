/**
 * Délais du serveur HTTP : un envoi de 200 Mo sur une liaison lente ne doit pas être coupé au bout de cinq minutes
 * (le défaut de Node), et une connexion qui n'envoie jamais d'en-têtes ne doit pas rester ouverte indéfiniment.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HTTP_TIMEOUTS, applyHttpTimeouts } from '../src/lib/http-timeouts.js';

test('les délais appliqués au serveur sont ceux documentés : 30 min, 60 s, 65 s', () => {
  const server = http.createServer();
  try {
    applyHttpTimeouts(server);
    assert.equal(server.requestTimeout, 30 * 60 * 1000);
    assert.equal(server.headersTimeout, 60 * 1000);
    assert.equal(server.keepAliveTimeout, 65 * 1000);
    assert.deepEqual({ ...HTTP_TIMEOUTS }, { requestTimeout: 1_800_000, headersTimeout: 60_000, keepAliveTimeout: 65_000 });
  } finally {
    server.close();
  }
});

test('les valeurs par défaut de Node, qu’ils remplacent, sont bien plus courtes pour la requête', () => {
  const server = http.createServer();
  try {
    assert.ok(server.requestTimeout < HTTP_TIMEOUTS.requestTimeout, `défaut de Node : ${server.requestTimeout} ms`);
  } finally {
    server.close();
  }
});
