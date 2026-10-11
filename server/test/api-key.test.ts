/**
 * La clé d'API Anthropic de l'utilisateur (chacun paie l'IA avec sa propre clé).
 *
 * - Elle est vérifiée auprès d'Anthropic avant d'être enregistrée, dans un fichier à part, lisible du seul compte qui
 *   fait tourner l'outil, hors de la base et hors des sauvegardes.
 * - Elle ne revient jamais vers l'interface : ni dans une réponse, ni dans un message d'erreur.
 * - Elle l'emporte sur la variable d'environnement, qui reprend la main quand on la retire.
 * - C'est bien elle qui part vers Anthropic lors d'une extraction ; un crédit épuisé est expliqué en français.
 *
 * Aucune requête ne part : `fetch` est remplacé par un faux Anthropic.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

const ENV_KEY = 'sk-ant-api03-ENVIRONNEMENT-cle-de-serveur-0000000000';
const APP_KEY = 'sk-ant-api03-UTILISATEUR-cle-personnelle-AbCd1234_xyZW';
const BAD_KEY = 'sk-ant-api03-REFUSEE-par-anthropic-99999999999999999';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-apikey-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';
process.env.ANTHROPIC_API_KEY = ENV_KEY;
delete process.env.LLM_MODEL;

interface Call {
  url: string;
  key: string | null;
  body: string;
}
const calls: Call[] = [];
let anthropicDown = false;
let creditExhausted = false;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  const key = headers.get('x-api-key');
  calls.push({ url: String(url), key, body: typeof init?.body === 'string' ? init.body : '' });
  if (anthropicDown) throw new TypeError('fetch failed');
  if (key === BAD_KEY) {
    // Une passerelle bavarde : le refus répète la clé reçue.
    return json(401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${key}` } });
  }
  if (String(url).includes('/v1/models/')) {
    return json(200, { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z' });
  }
  if (String(url).includes('/v1/messages')) {
    if (creditExhausted) {
      return json(400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' },
      });
    }
    return json(200, {
      id: 'msg_essai', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: JSON.stringify({ fields: {} }) }],
      usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    });
  }
  return json(404, { type: 'error', error: { type: 'not_found_error', message: 'introuvable' } });
}) as typeof fetch;

const { createKeyStore, checkKeyShape, KeyError } = await import('../src/engine/api-key.js');
const { costOf, estimateCost, priceOf } = await import('../src/engine/pricing.js');
const { DEFAULT_MODEL } = await import('../src/engine/llm.js');
const { DEFAULT_CHAT_MODEL } = await import('../src/engine/chat.js');
const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { db } = await import('../src/db/index.js');

const keyFile = path.join(tmpDir, 'anthropic-key.json');

describe('forme d’une clé', () => {
  test('une clé d’API Anthropic est acceptée, espaces autour retirés', () => {
    assert.equal(checkKeyShape(`  ${APP_KEY}\n`), APP_KEY);
  });

  test('vide, coupée, d’administration ou d’un autre service : refusée avec une phrase qui dit quoi faire', () => {
    const cases: [string, RegExp][] = [
      ['', /Collez votre clé/],
      ['sk-ant-api03-abc def-123456789012345678', /ni espace/],
      ['sk-ant-admin01-0123456789abcdefghijklmnop', /clé d’administration/],
      ['sk-proj-0123456789abcdefghijklmnopqrstuv', /commence par « sk-ant- »/],
      ['sk-ant-court', /commence par « sk-ant- »/],
    ];
    for (const [raw, message] of cases) {
      assert.throws(() => checkKeyShape(raw), (error: unknown) => error instanceof KeyError && message.test(error.message), raw);
    }
  });
});

describe('enregistrement local', () => {
  const file = path.join(tmpDir, 'magasin', 'cle.json');
  const env: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: ENV_KEY };
  const accept = async () => {};

  test('sans fichier : la clé de l’environnement sert ; sans rien : aucune', () => {
    assert.deepEqual(createKeyStore(file, env).active(), { key: ENV_KEY, source: 'env' });
    assert.equal(createKeyStore(file, {}).active(), null);
    assert.deepEqual(createKeyStore(file, {}).status(), { source: null, hint: null, savedAt: null });
  });

  test('la clé saisie l’emporte, fichier aux droits restreints, seuls ses quatre derniers caractères affichés', async () => {
    const store = createKeyStore(file, env);
    const status = await store.save(APP_KEY, 'claude-opus-5-5', accept);
    assert.equal(status.source, 'app');
    assert.equal(status.hint, `…${APP_KEY.slice(-4)}`);
    assert.match(status.savedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(store.active(), { key: APP_KEY, source: 'app' });
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    // Une autre instance (redémarrage du serveur) la relit.
    assert.deepEqual(createKeyStore(file, env).active(), { key: APP_KEY, source: 'app' });
  });

  test('refusée par Anthropic : rien n’est écrit', async () => {
    const other = path.join(tmpDir, 'refus', 'cle.json');
    const store = createKeyStore(other, {});
    await assert.rejects(
      store.save(APP_KEY, 'claude-opus-5-5', async () => {
        throw new KeyError('refus', 400);
      }),
      KeyError,
    );
    assert.equal(fs.existsSync(other), false);
    assert.equal(store.active(), null);
  });

  test('retirée : la clé de l’environnement reprend la main', () => {
    const store = createKeyStore(file, env);
    assert.equal(store.remove().source, 'env');
    assert.equal(fs.existsSync(file), false);
    assert.deepEqual(store.active(), { key: ENV_KEY, source: 'env' });
  });

  test('masquage : la clé de l’application comme celle de l’environnement, sous leurs trois formes', async () => {
    const store = createKeyStore(file, env);
    await store.save(APP_KEY, 'claude-opus-5-5', accept);
    const text = `a=${APP_KEY} b=${encodeURIComponent(ENV_KEY)} c=${Buffer.from(APP_KEY).toString('base64')}`;
    const masked = store.redact(text);
    for (const form of [APP_KEY, encodeURIComponent(ENV_KEY), Buffer.from(APP_KEY).toString('base64')]) assert.ok(!masked.includes(form), form);
    store.remove();
  });

  test('un fichier abîmé vaut absence de clé (pas de plantage)', () => {
    const broken = path.join(tmpDir, 'abime.json');
    fs.writeFileSync(broken, '{ pas du json');
    assert.deepEqual(createKeyStore(broken, env).active(), { key: ENV_KEY, source: 'env' });
  });
});

describe('prix d’une passe', () => {
  test('modèle par défaut : Claude Opus 5.5, pour l’extraction comme pour l’assistant, avec un tarif connu', () => {
    assert.equal(DEFAULT_MODEL, 'claude-opus-5-5');
    assert.equal(DEFAULT_CHAT_MODEL, 'claude-opus-5-5');
    assert.deepEqual(priceOf('claude-opus-5-5'), { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  });

  test('coût d’une consommation : entrée, sortie, lecture et écriture du cache', () => {
    // 1 M de jetons de chaque sorte sur Opus 5.5 : 4 + 20 + 0,20 + 5 = 29,20 $.
    assert.equal(costOf('claude-opus-5-5', { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 }), 29.2);
    // Un dossier ordinaire : 10 000 jetons en entrée, 5 000 en sortie ≈ 0,14 $.
    assert.equal(costOf('claude-opus-5-5', { inputTokens: 10_000, outputTokens: 5_000, cacheReadTokens: 0 }), 0.14);
    assert.equal(costOf('modele-inconnu', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }), null, 'pas de montant inventé');
    assert.equal(costOf(null, { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }), null);
  });

  test('estimation : fourchette ordonnée, croissante avec le volume, nulle sans dossier', () => {
    const base = { model: 'claude-opus-5-5', systemChars: 8_000, fieldCount: 30, maxOutputTokens: 16_000 };
    const small = estimateCost({ ...base, charsPerPatient: [20_000] })!;
    const large = estimateCost({ ...base, charsPerPatient: Array.from({ length: 100 }, () => 20_000) })!;
    assert.ok(small.low > 0 && small.low <= small.high);
    assert.ok(large.low > small.low * 50 && large.high > small.high * 50);
    assert.equal(large.patients, 100);
    assert.deepEqual(estimateCost({ ...base, charsPerPatient: [] }), { model: 'claude-opus-5-5', patients: 0, low: 0, high: 0, inputTokens: 0 });
    assert.equal(estimateCost({ ...base, model: 'inconnu', charsPerPatient: [1] }), null);
    // Un dossier ordinaire coûte quelques dizaines de centimes, pas des dollars.
    assert.ok(small.high < 0.5, String(small.high));
  });
});

// ------------------------------------------------------------------------------------------------- par l'API ---

let server: Server;
let base = '';

interface Reply {
  status: number;
  text: string;
  headers: http.IncomingHttpHeaders;
}

function request(method: string, pathname: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<Reply> {
  const url = new URL(base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: pathname,
        agent: false,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...extraHeaders,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Crée un dossier avec un document texte, par l'API (comme l'interface). */
async function patientWithDocument(code: string, text: string): Promise<number> {
  const created = await request('POST', '/api/patients', { code });
  assert.equal(created.status, 201, created.text);
  const patientId = (JSON.parse(created.text) as { patient: { id: number } }).patient.id;
  const boundary = '----rtcle';
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="cr.txt"\r\nContent-Type: text/plain\r\n\r\n${text}\r\n--${boundary}--\r\n`,
  );
  const uploaded = await new Promise<Reply>((resolve, reject) => {
    const url = new URL(base);
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method: 'POST',
        path: `/api/patients/${patientId}/documents`,
        agent: false,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(payload.length) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
  assert.ok(uploaded.status === 200 || uploaded.status === 201, uploaded.text);
  return patientId;
}

function assertNoSecret(reply: Reply, where: string): void {
  const everything = `${reply.text}\n${JSON.stringify(reply.headers)}`;
  for (const key of [APP_KEY, BAD_KEY, ENV_KEY]) {
    for (const form of [key, encodeURIComponent(key), Buffer.from(key).toString('base64')]) {
      assert.ok(!everything.includes(form), `${where} : une clé apparaît dans la réponse`);
    }
  }
}

describe('routes /api/llm', () => {
  before(async () => {
    seedIfEmpty();
    server = await new Promise<Server>((resolve) => {
      const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('état initial : la clé de l’environnement, reconnaissable à ses quatre derniers caractères', async () => {
    const reply = await request('GET', '/api/llm/key');
    assert.equal(reply.status, 200);
    const body = JSON.parse(reply.text) as { source: string; hint: string; model: string; available: boolean };
    assert.equal(body.source, 'env');
    assert.equal(body.hint, `…${ENV_KEY.slice(-4)}`);
    assert.equal(body.model, 'claude-opus-5-5');
    assert.equal(body.available, true);
    assertNoSecret(reply, 'GET /api/llm/key');
  });

  test('clé refusée par Anthropic : 400, phrase en français, clé absente de la réponse, rien d’écrit', async () => {
    const reply = await request('PUT', '/api/llm/key', { key: BAD_KEY });
    assert.equal(reply.status, 400);
    assert.match(JSON.parse(reply.text).error, /Anthropic refuse cette clé/);
    assertNoSecret(reply, 'PUT refusé');
    assert.equal(fs.existsSync(keyFile), false);
  });

  test('Anthropic injoignable : 502, la clé n’est pas enregistrée sans vérification', async () => {
    anthropicDown = true;
    try {
      const reply = await request('PUT', '/api/llm/key', { key: APP_KEY });
      assert.equal(reply.status, 502);
      assert.match(JSON.parse(reply.text).error, /injoignable/);
      assertNoSecret(reply, 'PUT hors ligne');
      assert.equal(fs.existsSync(keyFile), false);
    } finally {
      anthropicDown = false;
    }
  });

  test('forme invalide ou champ en trop : refusé avant tout appel à Anthropic', async () => {
    const before = calls.length;
    assert.equal((await request('PUT', '/api/llm/key', { key: 'pas-une-cle' })).status, 400);
    assert.equal((await request('PUT', '/api/llm/key', { key: APP_KEY, autre: 1 })).status, 400);
    assert.equal(calls.length, before, 'aucune requête vers Anthropic');
  });

  test('une page d’un autre site ne peut pas changer la clé', async () => {
    const reply = await request('PUT', '/api/llm/key', { key: APP_KEY }, { Origin: 'https://site-hostile.example' });
    assert.equal(reply.status, 403);
    assert.equal(fs.existsSync(keyFile), false);
  });

  test('clé valide : vérifiée par la fiche du modèle, enregistrée hors de la base, jamais renvoyée', async () => {
    const reply = await request('PUT', '/api/llm/key', { key: APP_KEY });
    assert.equal(reply.status, 200, reply.text);
    const body = JSON.parse(reply.text) as { source: string; hint: string };
    assert.equal(body.source, 'app');
    assert.equal(body.hint, `…${APP_KEY.slice(-4)}`);
    assertNoSecret(reply, 'PUT accepté');
    const check = calls.at(-1)!;
    assert.match(check.url, /\/v1\/models\/claude-opus-5-5$/);
    assert.equal(check.key, APP_KEY);
    assert.ok(fs.existsSync(keyFile));
    // Ni dans la base, ni dans le dossier des fichiers de dossiers (que les sauvegardes emportent).
    const dbBytes = fs.readFileSync(process.env.DB_PATH!);
    assert.ok(!dbBytes.includes(Buffer.from(APP_KEY)), 'la clé n’est pas dans la base');
    assert.equal(path.dirname(keyFile), tmpDir);
  });

  test('extraction : c’est la clé de l’utilisateur qui part vers Anthropic ; le prix de la passe est donné', async () => {
    const patientId = await patientWithDocument('CLE-001', 'Compte rendu : patient vu en consultation, bilan sans particularité.');

    const estimate = await request('GET', '/api/llm/estimate');
    assert.equal(estimate.status, 200, estimate.text);
    const range = (JSON.parse(estimate.text) as { estimate: { low: number; high: number; patients: number; model: string } }).estimate;
    assert.equal(range.model, 'claude-opus-5-5');
    assert.ok(range.patients >= 1 && range.low > 0 && range.low <= range.high, JSON.stringify(range));

    const run = await request('POST', '/api/records/extraction/run', { mode: 'llm', patientIds: [patientId] });
    assert.equal(run.status, 200, run.text);
    const result = JSON.parse(run.text) as { costUsd: number; model: string; usage: { inputTokens: number } };
    assert.equal(result.model, 'claude-opus-5-5');
    assert.equal(result.usage.inputTokens, 1200);
    // 1 200 jetons en entrée et 300 en sortie à 4 $ et 20 $ le million : 0,0108 $.
    assert.equal(result.costUsd, 0.0108);
    const sent = calls.filter((c) => c.url.includes('/v1/messages'));
    assert.ok(sent.length >= 1);
    assert.ok(sent.every((c) => c.key === APP_KEY), 'la clé de l’utilisateur, pas celle du serveur');
    assert.ok(sent.every((c) => JSON.parse(c.body).model === 'claude-opus-5-5'));
  });

  test('crédit épuisé sur le compte de l’utilisateur : la passe le dit en français', async () => {
    creditExhausted = true;
    try {
      const patientId = await patientWithDocument('CLE-002', 'Compte rendu : bilan normal.');
      const run = await request('POST', '/api/records/extraction/run', { mode: 'llm', patientIds: [patientId] });
      assert.equal(run.status, 200, run.text);
      const result = JSON.parse(run.text) as { errors: { message: string }[] };
      assert.match(result.errors[0]?.message ?? '', /Crédit épuisé sur votre compte Anthropic/);
      assertNoSecret(run, 'passe sans crédit');
    } finally {
      creditExhausted = false;
    }
  });

  test('retirer la clé : la clé du serveur reprend la main ; le fichier disparaît', async () => {
    const reply = await request('DELETE', '/api/llm/key');
    assert.equal(reply.status, 200);
    assert.equal((JSON.parse(reply.text) as { source: string }).source, 'env');
    assert.equal(fs.existsSync(keyFile), false);
    assertNoSecret(reply, 'DELETE');
  });
});
