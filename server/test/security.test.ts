/**
 * Exposition de l'outil : en-têtes de sécurité, mot de passe d'accès, sonde de santé.
 * Les comptes rendus de patients ne doivent ni se mettre en cache, ni s'afficher dans un cadre
 * étranger, ni se lire sans le mot de passe quand il y en a un.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-security-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { sameSecret, isLoopback } = await import('../src/lib/security.js');
const { LATEST_VERSION } = await import('../src/db/migrations.js');

const servers: Server[] = [];

async function start(password: string | null | undefined): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = createApp(password === undefined ? {} : { password }).listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

before(() => seedIfEmpty());

after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  const { db } = await import('../src/db/index.js');
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const basic = (password: string, user = 'chercheur'): Record<string, string> => ({
  Authorization: `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`,
});

describe('en-têtes de sécurité', () => {
  test('toute réponse interdit le sniffing, le cadrage étranger et l’envoi du référent', async () => {
    const base = await start(null);
    const res = await fetch(`${base}/api/patients`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.match(res.headers.get('permissions-policy') ?? '', /camera=\(\)/);
    assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(res.headers.get('x-powered-by'), null, 'la technologie du serveur ne se publie pas');
  });

  test('les données de l’API ne se mettent en cache nulle part', async () => {
    const base = await start(null);
    for (const route of ['/api/patients', '/api/templates', '/api/health', '/api/inconnu']) {
      const res = await fetch(`${base}${route}`);
      assert.equal(res.headers.get('cache-control'), 'no-store', route);
    }
  });
});

describe('sonde de santé', () => {
  test('elle interroge la base et donne la version, sans donnée de patient', async () => {
    const base = await start(null);
    const res = await fetch(`${base}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['status'], 'ok');
    assert.match(String(body['version']), /^\d+\.\d+\.\d+/);
    assert.equal(body['schemaVersion'], LATEST_VERSION);
    assert.ok(Number(body['uptimeSeconds']) >= 0);
    assert.deepEqual(Object.keys(body).sort(), ['schemaVersion', 'status', 'time', 'uptimeSeconds', 'version']);
  });
});

describe('mot de passe d’accès', () => {
  test('sans mot de passe défini, tout est ouvert (usage sur le poste)', async () => {
    const base = await start(null);
    assert.equal((await fetch(`${base}/api/patients`)).status, 200);
  });

  test('avec un mot de passe, rien ne se lit sans lui, et le navigateur sait quoi demander', async () => {
    const base = await start('correct-horse');
    const refused = await fetch(`${base}/api/patients`);
    assert.equal(refused.status, 401);
    assert.match(refused.headers.get('www-authenticate') ?? '', /^Basic realm="PubResearcher"/);
    assert.doesNotMatch(await refused.text(), /patients|code/i, 'la réponse ne donne rien');

    for (const route of ['/api/templates', '/api/export/csv', '/api/documents/1/file', '/api/biblio/overview']) {
      assert.equal((await fetch(`${base}${route}`)).status, 401, route);
    }
  });

  test('le bon mot de passe ouvre, quel que soit le nom d’utilisateur', async () => {
    const base = await start('correct-horse');
    for (const user of ['chercheur', '', 'x']) {
      const res = await fetch(`${base}/api/patients`, { headers: basic('correct-horse', user) });
      assert.equal(res.status, 200, `utilisateur « ${user} »`);
    }
    // Un mot de passe qui contient des deux-points reste lisible en entier.
    const base2 = await start('a:b:c');
    assert.equal((await fetch(`${base2}/api/patients`, { headers: basic('a:b:c') })).status, 200);
  });

  test('un mauvais mot de passe, un préfixe ou un ajout ne passent pas', async () => {
    const base = await start('correct-horse');
    for (const wrong of ['', 'correct', 'correct-horse2', 'CORRECT-HORSE', 'wrong']) {
      const res = await fetch(`${base}/api/patients`, { headers: basic(wrong) });
      assert.equal(res.status, 401, `« ${wrong} » aurait dû être refusé`);
    }
    const garbage = await fetch(`${base}/api/patients`, { headers: { Authorization: 'Basic !!!pas-du-base64' } });
    assert.equal(garbage.status, 401);
    const bearer = await fetch(`${base}/api/patients`, { headers: { Authorization: 'Bearer correct-horse' } });
    assert.equal(bearer.status, 401);
  });

  test('la sonde de santé reste ouverte pour la supervision', async () => {
    const base = await start('correct-horse');
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  });

  test('dix essais ratés ferment la porte, même au bon mot de passe, pendant le délai', async () => {
    const base = await start('correct-horse');
    for (let i = 0; i < 10; i++) {
      assert.equal((await fetch(`${base}/api/patients`, { headers: basic(`faux-${i}`) })).status, 401);
    }
    const locked = await fetch(`${base}/api/patients`, { headers: basic('correct-horse') });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
  });

  test('les requêtes sans identifiants (premier appel du navigateur) ne comptent pas comme des essais', async () => {
    const base = await start('correct-horse');
    for (let i = 0; i < 25; i++) assert.equal((await fetch(`${base}/api/patients`)).status, 401);
    assert.equal((await fetch(`${base}/api/patients`, { headers: basic('correct-horse') })).status, 200);
  });

  test('un succès remet le compteur à zéro', async () => {
    const base = await start('correct-horse');
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 8; i++) await fetch(`${base}/api/patients`, { headers: basic('faux') });
      assert.equal((await fetch(`${base}/api/patients`, { headers: basic('correct-horse') })).status, 200);
    }
  });
});

describe('utilitaires', () => {
  test('la comparaison de secrets ne dépend pas de la longueur ni de la casse', () => {
    assert.equal(sameSecret('abc', 'abc'), true);
    assert.equal(sameSecret('abc', 'abcd'), false);
    assert.equal(sameSecret('', 'x'), false);
    assert.equal(sameSecret('é', 'é'), true);
  });

  test('seules les adresses du poste sont tenues pour locales', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1']) assert.equal(isLoopback(h), true, h);
    for (const h of ['0.0.0.0', '192.168.1.10', '::', '10.0.0.5', 'hopital.example']) assert.equal(isLoopback(h), false, h);
  });
});
