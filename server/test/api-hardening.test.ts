/**
 * Durcissement de l'API : ce qu'une page tierce ouverte dans le même navigateur, un mauvais réglage ou une
 * saisie hostile ne doivent pas obtenir — et ce que le serveur doit répondre quand on lui envoie n'importe quoi.
 *
 * Les caractères de contrôle sont construits avec `String.fromCodePoint` : écrits en clair dans le source, ils
 * seraient invisibles à la relecture et fragiles à la copie.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Server } from 'node:http';
import JSZip from 'jszip';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-hardening-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';
delete process.env.APIFY_TOKEN;

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { db } = await import('../src/db/index.js');
const { requestGuard } = await import('../src/lib/security.js');
const { readIntEnv } = await import('../src/config.js');
const { DataInUseError, acquireDataLock, processIsAlive } = await import('../src/lib/data-lock.js');
const { ApifyError, redact, runActor } = await import('../src/biblio/apify.js');
const { toBibtex, toRis } = await import('../src/biblio/export.js');
const { makeXlsx, toExcelSerial } = await import('../src/lib/xlsx.js');
const { applyAutomaticValues, applyHumanEdits, ensureRecord, listValues } = await import('../src/repo/records.js');
const { listEventsForRecord } = await import('../src/repo/events.js');
const engine = await import('../src/engine/rules.js');
import type { BiblioRef } from '../src/biblio/types.js';
import type { FieldValue } from '../src/domain/types.js';

/* ───────────────────────────────── Outils ───────────────────────────────── */

const NUL = String.fromCodePoint(0);
const ESC = String.fromCodePoint(27);
const BEL = String.fromCodePoint(7);
const NEL = String.fromCodePoint(0x85);
const APC = String.fromCodePoint(0x9f);

const agent = new http.Agent({ keepAlive: true, maxSockets: 8 });
const servers: Server[] = [];

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function raw(
  base: string,
  method: string,
  pathname: string,
  options: { headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<Reply> {
  const url = new URL(base);
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers['Content-Length'] = String(Buffer.byteLength(options.body));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: url.hostname, port: url.port, method, path: pathname, headers, agent }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

const json = (r: Reply): Record<string, unknown> => JSON.parse(r.text) as Record<string, unknown>;

async function start(options: { password?: string | null; allowedHosts?: string[] | null } = {}): Promise<string> {
  const server = await new Promise<Server>((resolve) => {
    const s = createApp(options).listen(0, '127.0.0.1', () => resolve(s));
  });
  servers.push(server);
  const address = server.address();
  return `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

const asJson = (value: unknown, origin?: string): { headers: Record<string, string>; body: string } => ({
  headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) },
  body: JSON.stringify(value),
});

function multipart(filename: string, content: string): { body: Buffer; type: string } {
  const boundary = `----rt${Math.random().toString(16).slice(2)}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`),
    Buffer.from(content),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

let base = '';
let templateId = 0;
let fieldIds: number[] = [];
let patientId = 0;
let documentId = 0;

before(async () => {
  seedIfEmpty();
  base = await start();
  const templates = json(await raw(base, 'GET', '/api/templates')) as { active: { id: number; fields: { id: number }[] } };
  templateId = templates.active.id;
  fieldIds = templates.active.fields.map((f) => f.id);
  const created = await raw(base, 'POST', '/api/patients', asJson({ code: 'DURCI-001' }));
  assert.equal(created.status, 201);
  patientId = (json(created).patient as { id: number }).id;
  const file = multipart('cr.txt', 'Âge : 54 ans\nSexe : féminin\n');
  const uploaded = await raw(base, 'POST', `/api/patients/${patientId}/documents`, { headers: { 'Content-Type': file.type }, body: file.body });
  assert.equal(uploaded.status, 201, uploaded.text);
  documentId = (json(uploaded).documents as { id: number }[])[0]!.id;
});

after(async () => {
  agent.destroy();
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* ───────────────────── Hôte et origine des requêtes ──────────────────────── */

describe('garde des requêtes : nom d’hôte et origine', () => {
  test('un nom d’hôte inconnu — page tierce qui pointe son domaine vers ce poste — est refusé, lecture comprise', async () => {
    const port = new URL(base).port;
    for (const host of ['evil.example', `evil.example:${port}`, `localhost.evil.example:${port}`, `127.0.0.1.evil.example`]) {
      const res = await raw(base, 'GET', '/api/patients', { headers: { Host: host } });
      assert.equal(res.status, 403, `Host « ${host} »`);
      assert.match(String(json(res).error), /Nom d'hôte non autorisé.*ALLOWED_HOSTS/);
      assert.doesNotMatch(res.text, /DURCI-001/, 'aucune donnée de patient dans le refus');
    }
  });

  test('une requête HTTP/1.0 sans en-tête Host n’échappe pas au contrôle', async () => {
    const url = new URL(base);
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(Number(url.port), url.hostname, () => socket.write('GET /api/patients HTTP/1.0\r\n\r\n'));
      const chunks: Buffer[] = [];
      socket.on('data', (c: Buffer) => chunks.push(c));
      socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      socket.on('error', reject);
    });
    assert.match(answer, /^HTTP\/1\.1 403/);
    assert.match(answer, /Nom d'hôte non autorisé \(absent\)/);
    assert.doesNotMatch(answer, /DURCI-001/);
  });

  test('les noms du poste passent : localhost, 127.0.0.1, [::1], avec ou sans port, quelle que soit la casse', async () => {
    const port = new URL(base).port;
    for (const host of [`localhost:${port}`, `LOCALHOST:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, 'localhost']) {
      const res = await raw(base, 'GET', '/api/patients', { headers: { Host: host } });
      assert.equal(res.status, 200, `Host « ${host} »`);
    }
  });

  test('sans liste de noms (écoute sur le réseau, noms inconnus d’avance), aucun nom n’est refusé', async () => {
    const open = await start({ allowedHosts: null });
    const res = await raw(open, 'GET', '/api/patients', { headers: { Host: 'outil.chu.example' } });
    assert.equal(res.status, 200);
  });

  test('une écriture dont l’origine est un autre site est refusée, et rien n’est écrit', async () => {
    for (const [method, route, body] of [
      ['POST', '/api/patients', { code: 'CSRF-1' }],
      ['POST', '/api/records/extraction/run', {}],
      ['PATCH', `/api/patients/${patientId}`, { label: 'piraté' }],
      ['PUT', `/api/records/${templateId}/${patientId}/values`, { values: [{ fieldId: fieldIds[0], value: 1 }] }],
    ] as const) {
      const res = await raw(base, method, route, asJson(body, 'https://evil.example'));
      assert.equal(res.status, 403, `${method} ${route}`);
      assert.match(String(json(res).error), /autre site/);
    }
    const noBody = await raw(base, 'DELETE', `/api/patients/${patientId}`, { headers: { Origin: 'https://evil.example' } });
    assert.equal(noBody.status, 403);

    const patients = json(await raw(base, 'GET', '/api/patients')).patients as { code: string; label: string | null }[];
    assert.ok(patients.some((p) => p.code === 'DURCI-001' && p.label !== 'piraté'), 'le dossier est intact');
    assert.ok(!patients.some((p) => p.code === 'CSRF-1'));
  });

  test('un envoi de fichiers multipart venu d’ailleurs est refusé avant que le fichier ne soit lu ou rangé', async () => {
    const before = fs.readdirSync(path.join(tmpDir, 'uploads', String(patientId))).length;
    const file = multipart('piege.txt', 'contenu étranger');
    const res = await raw(base, 'POST', `/api/patients/${patientId}/documents`, {
      headers: { 'Content-Type': file.type, Origin: 'https://evil.example' },
      body: file.body,
    });
    assert.equal(res.status, 403);
    assert.equal(fs.readdirSync(path.join(tmpDir, 'uploads', String(patientId))).length, before, 'aucun fichier rangé');
    const docs = (json(await raw(base, 'GET', `/api/patients/${patientId}`)).documents as { filename: string }[]).map((d) => d.filename);
    assert.ok(!docs.includes('piege.txt'));
  });

  test('l’origine opaque « null » (document sandboxé, fichier local) est refusée', async () => {
    const res = await raw(base, 'POST', '/api/patients', asJson({ code: 'NULL-ORIGIN' }, 'null'));
    assert.equal(res.status, 403);
    assert.match(String(json(res).error), /opaque/);
  });

  test('l’origine de l’outil, celle du front de développement et les scripts sans origine écrivent normalement', async () => {
    const own = new URL(base).origin;
    for (const [i, origin] of [own, 'http://localhost:5173', 'http://127.0.0.1:5173', undefined].entries()) {
      const res = await raw(base, 'POST', '/api/patients', asJson({ code: `ORIGINE-${i}` }, origin));
      assert.equal(res.status, 201, `origine ${String(origin)} : ${res.text}`);
    }
  });

  test('les lectures ne dépendent pas de l’origine, mais le navigateur d’un autre site ne peut pas en lire la réponse', async () => {
    const res = await raw(base, 'GET', '/api/patients', { headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'pas d’en-tête CORS pour un site étranger');
  });

  describe('garde isolée (requêtes simulées)', () => {
    type Options = Parameters<typeof requestGuard>[0];
    function ask(options: Options, headers: Record<string, string>, method = 'POST'): { status: number | null; passed: boolean } {
      const out: { status: number | null; passed: boolean } = { status: null, passed: false };
      const res = {
        status(code: number) {
          out.status = code;
          return res;
        },
        json() {
          return res;
        },
      };
      requestGuard(options)({ method, headers } as never, res as never, () => {
        out.passed = true;
      });
      return out;
    }
    const open: Options = { allowedHosts: null, allowedOrigins: [] };

    test('derrière un proxy de confiance, l’hôte annoncé par le proxy est celui du visiteur', () => {
      const headers = { host: 'interne:4000', origin: 'https://outil.chu.example', 'x-forwarded-host': 'outil.chu.example' };
      assert.equal(ask({ ...open, trustForwardedHost: true }, headers).passed, true);
      assert.equal(ask({ ...open, trustForwardedHost: false }, headers).status, 403, 'en-tête ignoré hors proxy de confiance');
    });

    test('ALLOWED_ORIGINS autorise une origine, sans distinguer la casse ni la barre finale', () => {
      const options: Options = { ...open, allowedOrigins: ['https://Outil.CHU.example/'] };
      assert.equal(ask(options, { host: 'interne:4000', origin: 'https://outil.chu.example' }).passed, true);
      assert.equal(ask(options, { host: 'interne:4000', origin: 'https://outil.chu.example.evil.net' }).status, 403);
    });

    test('une origine illisible, ou qui ne diffère que par le schéma ou le port, est refusée', () => {
      assert.equal(ask(open, { host: 'localhost:4000', origin: 'pas une adresse' }).status, 403);
      assert.equal(ask(open, { host: 'localhost:4000', origin: 'http://localhost:4001' }).status, 403, 'port différent');
      assert.equal(ask(open, { host: 'localhost:4000', origin: 'http://localhost:4000' }).passed, true);
    });

    test('lectures et préliminaires CORS passent la garde d’origine', () => {
      for (const method of ['GET', 'HEAD', 'OPTIONS']) {
        assert.equal(ask(open, { host: 'localhost:4000', origin: 'https://evil.example' }, method).passed, true, method);
      }
    });

    test('un nom d’hôte IPv6 se lit entre crochets, port compris', () => {
      const options: Options = { allowedHosts: ['[::1]'], allowedOrigins: [] };
      assert.equal(ask(options, { host: '[::1]:4000' }, 'GET').passed, true);
      assert.equal(ask(options, { host: '[::2]:4000' }, 'GET').status, 403);
    });
  });
});

/* ──────────────────────── Verrou du dossier de données ───────────────────── */

describe('verrou du dossier de données', () => {
  const lockDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-lock-'));
  const writeLock = (dir: string, pid: number, port: number | null = 4000): string => {
    const file = path.join(dir, '.research-tool.lock');
    fs.writeFileSync(file, JSON.stringify({ pid, port, startedAt: '2026-10-08T09:30:00.000Z' }));
    return file;
  };

  test('le verrou porte le numéro du processus et se retire à la fermeture', () => {
    const dir = lockDir();
    try {
      const lock = acquireDataLock(dir, 4000);
      assert.equal((JSON.parse(fs.readFileSync(lock.file, 'utf8')) as { pid: number }).pid, process.pid);
      lock.release();
      assert.equal(fs.existsSync(lock.file), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('un second processus vivant sur les mêmes données est refusé, avec son numéro et son port', () => {
    const dir = lockDir();
    try {
      writeLock(dir, 999_001, 4100);
      assert.throws(
        () => acquireDataLock(dir, 4200, () => true),
        (error: unknown) =>
          error instanceof DataInUseError &&
          error.holder.pid === 999_001 &&
          /processus 999001, port 4100/.test(error.message) &&
          error.lockFile.endsWith('.research-tool.lock'),
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('un verrou laissé par un processus disparu est repris sans intervention', () => {
    const dir = lockDir();
    try {
      writeLock(dir, 999_002);
      const lock = acquireDataLock(dir, 4000, () => false);
      assert.equal((JSON.parse(fs.readFileSync(lock.file, 'utf8')) as { pid: number }).pid, process.pid);
      lock.release();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('un fichier de verrou illisible (écriture interrompue) est tenu pour périmé', () => {
    const dir = lockDir();
    try {
      fs.writeFileSync(path.join(dir, '.research-tool.lock'), '{"pid":');
      assert.doesNotThrow(() => acquireDataLock(dir, 4000, () => true).release());
      fs.writeFileSync(path.join(dir, '.research-tool.lock'), JSON.stringify({ pid: 'abc' }));
      assert.doesNotThrow(() => acquireDataLock(dir, 4000, () => true).release());
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('on ne retire que son propre verrou : celui qu’un autre processus a repris reste', () => {
    const dir = lockDir();
    try {
      const lock = acquireDataLock(dir, 4000);
      writeLock(dir, 999_003);
      lock.release();
      assert.ok(fs.existsSync(lock.file), 'le verrou de l’autre processus est intact');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('la détection d’un processus distingue le vivant du disparu', () => {
    assert.equal(processIsAlive(process.pid), true);
    const child = spawnSync(process.execPath, ['-e', '0']);
    assert.equal(processIsAlive(child.pid ?? 0), false);
  });
});

/* ─────────────────────── Lecture des variables d’environnement ───────────── */

describe('réglages lus dans l’environnement', () => {
  test('absent ou vide : la valeur par défaut', () => {
    assert.equal(readIntEnv('PORT', undefined, 4000, 1, 65535), 4000);
    assert.equal(readIntEnv('PORT', '', 4000, 1, 65535), 4000);
    assert.equal(readIntEnv('PORT', '   ', 4000, 1, 65535), 4000);
  });

  test('un entier dans les bornes passe, espaces autour compris', () => {
    assert.equal(readIntEnv('PORT', '8080', 4000, 1, 65535), 8080);
    assert.equal(readIntEnv('PORT', ' 8080 ', 4000, 1, 65535), 8080);
    assert.equal(readIntEnv('PORT', '65535', 4000, 1, 65535), 65535);
  });

  test('tout le reste arrête le démarrage avec le nom du réglage et la plage attendue', () => {
    for (const bad of ['abc', '1.5', '-1', '0', '65536', '1e3', '0x1F90', 'Infinity', 'NaN', '8 080', '99999999999999999999', '８０８０']) {
      assert.throws(
        () => readIntEnv('PORT', bad, 4000, 1, 65535),
        (error: unknown) => error instanceof Error && /^PORT=.*n'est pas valide.*entre 1 et 65535/.test(error.message),
        `« ${bad} » aurait dû être refusé`,
      );
    }
  });
});

/* ───────────────────────────── Jeton Apify ──────────────────────────────── */

describe('le jeton Apify ne sort jamais', () => {
  const token = 'apify_api_Zq81+/Xc9TOKEN-secret';
  const cfg = {
    token,
    baseUrl: 'https://api.apify.test',
    pubmedActor: 'a/pubmed',
    scholarActor: 'a/scholar',
    timeoutMs: 5000,
    maxResultsCap: 50,
  };
  const forms = [token, encodeURIComponent(token), Buffer.from(token).toString('base64')];

  test('masquage sous les trois formes : brute, encodée dans une adresse, base64', () => {
    const text = `Authorization: Bearer ${token} ; GET /x?token=${encodeURIComponent(token)} ; ${Buffer.from(token).toString('base64')}`;
    const out = redact(text, token);
    for (const form of forms) assert.ok(!out.includes(form), `la forme « ${form} » subsiste`);
    assert.equal((out.match(/\[jeton masqué\]/g) ?? []).length, 3);
  });

  test('jeton vide ou trop court : le texte est rendu tel quel, sans masquer la moitié des mots', () => {
    assert.equal(redact('texte ordinaire', ''), 'texte ordinaire');
    assert.equal(redact('texte ordinaire', 'te'), 'texte ordinaire');
  });

  test('un acteur qui répète ses en-têtes dans son message d’erreur ne les fait pas parvenir à l’interface', async () => {
    const echo = `Requête rejetée. Authorization: Bearer ${token}. Adresse : ?token=${encodeURIComponent(token)}`;
    for (const status of [403, 500, 502]) {
      const fetchImpl = (async () => new Response(JSON.stringify({ error: { type: 'x', message: echo } }), { status })) as typeof fetch;
      await assert.rejects(runActor(cfg, 'a/pubmed', {}, 10, fetchImpl), (error: unknown) => {
        assert.ok(error instanceof ApifyError);
        for (const form of forms) assert.ok(!error.message.includes(form), `HTTP ${status} : « ${form} » dans « ${error.message} »`);
        return true;
      });
    }
  });

  test('un message d’erreur démesuré est borné', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { message: 'x'.repeat(50_000) } }), { status: 500 })) as typeof fetch;
    await assert.rejects(runActor(cfg, 'a/pubmed', {}, 10, fetchImpl), (error: unknown) => error instanceof ApifyError && error.message.length < 500);
  });

  test('une panne réseau qui cite le jeton dans son texte est elle aussi masquée', async () => {
    const fetchImpl = (async () => {
      throw new Error(`connect ECONNREFUSED https://api.apify.test/v2?token=${token}`);
    }) as typeof fetch;
    await assert.rejects(runActor(cfg, 'a/pubmed', {}, 10, fetchImpl), (error: unknown) => {
      assert.ok(error instanceof ApifyError);
      assert.equal(error.kind, 'network');
      assert.ok(!error.message.includes(token));
      return true;
    });
  });

  test('le jeton voyage en en-tête, jamais dans l’adresse appelée', async () => {
    let calledUrl = '';
    let authorization = '';
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = String(url);
      authorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response('[]', { status: 200 });
    }) as typeof fetch;
    await runActor(cfg, 'a/pubmed', {}, 10, fetchImpl);
    assert.ok(!calledUrl.includes(token) && !calledUrl.includes(encodeURIComponent(token)));
    assert.equal(authorization, `Bearer ${token}`);
  });
});

/* ───────────────────────────── Exports RIS / BibTeX ──────────────────────── */

describe('exports bibliographiques : aucun caractère de contrôle, aucune structure injectée', () => {
  const ref = (over: Partial<BiblioRef> = {}): BiblioRef => ({
    id: 1,
    sources: ['pubmed'],
    titleTruncated: false,
    decision: 'pending',
    exclusionReason: null,
    note: null,
    firstSearchId: 1,
    createdAt: 't',
    updatedAt: 't',
    title: 'Titre',
    authors: [],
    year: 2020,
    journal: null,
    volume: null,
    issue: null,
    pages: null,
    doi: null,
    pmid: null,
    pmcid: null,
    url: null,
    pdfUrl: null,
    abstract: null,
    snippet: null,
    keywords: [],
    meshTerms: [],
    publicationTypes: [],
    citedBy: null,
    citedByUrl: null,
    ...over,
  });

  const hostile = ref({
    id: 7,
    title: `Étude${NUL} sur${ESC}[31m le${BEL} cœur${NEL} fin${APC}`,
    authors: [`Ritter${NUL} M`, `J${ESC} Michalak`],
    journal: `Revue${BEL}`,
    abstract: 'Ligne 1\r\nER  - \r\nTY  - JOUR\r\nTI  - Faux\r\n@article{injecte, title={x}}',
    keywords: [`mot${NUL}clé`],
    note: `note${ESC}\nsur deux lignes`,
  });

  test('RIS : pas de caractère de contrôle, et un seul enregistrement par référence', () => {
    const ris = toRis([hostile, ref({ id: 8, title: 'Autre' })]);
    assert.doesNotMatch(ris.replace(/[\r\n]/g, ''), /\p{Cc}/u);
    const lines = ris.split('\r\n').filter((l) => l !== '');
    assert.ok(lines.every((l) => /^[A-Z][A-Z0-9] {2}- /.test(l)), 'chaque ligne commence par une balise RIS');
    assert.equal(lines.filter((l) => l.startsWith('TY  - ')).length, 2);
    assert.equal(lines.filter((l) => l.startsWith('ER  - ')).length, 2, 'le « ER » du résumé n’a pas fermé la notice');
  });

  test('BibTeX : pas de caractère de contrôle, accolades échappées, une entrée par référence', () => {
    const bib = toBibtex([hostile, ref({ id: 8, title: 'Autre' })]);
    assert.doesNotMatch(bib.replace(/\n/g, ''), /\p{Cc}/u);
    assert.equal((bib.match(/^@article\{/gm) ?? []).length, 2, 'le « @article » du résumé n’a pas ouvert une entrée');
    assert.ok(bib.includes('\\{injecte'), 'les accolades du résumé sont échappées');
  });
});

/* ──────────────────────────── Dates et cellules Excel ────────────────────── */

describe('classeur Excel : dates exactes, cellules bornées', () => {
  test('une date qui n’existe pas n’est pas convertie en une autre', () => {
    for (const impossible of ['2024-02-30', '2023-02-29', '2024-13-01', '2024-00-10', '2024-04-31', '2024-01-00']) {
      assert.equal(toExcelSerial(impossible), null, impossible);
    }
    assert.notEqual(toExcelSerial('2024-02-29'), null, '2024 est bissextile');
  });

  test('numéros de série connus', () => {
    assert.equal(toExcelSerial('2024-01-01'), 45292);
    assert.equal(toExcelSerial('2000-01-01'), 36526);
    assert.equal(toExcelSerial('1900-03-01'), 61);
    assert.equal(toExcelSerial(' 2024-01-01 '), 45292, 'les espaces autour sont ignorés');
  });

  test('avant le 1er mars 1900, Excel se trompe d’un jour : la date reste du texte', () => {
    for (const early of ['1900-01-01', '1900-02-28', '1899-12-31', '1850-06-15', '0024-05-05']) {
      assert.equal(toExcelSerial(early), null, early);
    }
  });

  test('une date écrite dans une colonne de dates mais impossible reste lisible comme texte dans la cellule', async () => {
    const buffer = makeXlsx([{ name: 'D', columns: [{ header: 'Naissance', type: 'date' }], rows: [['2024-02-30'], ['1899-05-05'], ['2024-02-29']] }]);
    const sheet = await (await JSZip.loadAsync(buffer)).file('xl/worksheets/sheet1.xml')!.async('string');
    assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">2024-02-30</);
    assert.match(sheet, /t="inlineStr"><is><t xml:space="preserve">1899-05-05</);
    assert.match(sheet, /<c r="A4" s="2"><v>45351<\/v>/);
  });

  test('une cellule plus longue que la limite d’Excel est tronquée en le disant', async () => {
    const buffer = makeXlsx([{ name: 'T', columns: [{ header: 'Texte' }], rows: [['é'.repeat(100_000)]] }]);
    const sheet = await (await JSZip.loadAsync(buffer)).file('xl/worksheets/sheet1.xml')!.async('string');
    const cell = /<c r="A2"[^>]*><is><t[^>]*>([^<]*)<\/t>/.exec(sheet)?.[1] ?? '';
    assert.ok(cell.length < 32_767, `${cell.length} caractères`);
    assert.match(cell, /tronqué : 68000 caractères de plus/);
  });
});

/* ───────────────────────── Écritures : tout ou rien ─────────────────────── */

describe('écritures de valeurs : une passe interrompue ne laisse rien derrière elle', () => {
  const unserializable = 10n as unknown as FieldValue; // JSON.stringify lève une exception sur un BigInt

  async function freshRecord(code: string): Promise<{ id: number; patient: number }> {
    const created = json(await raw(base, 'POST', '/api/patients', asJson({ code }))).patient as { id: number };
    return { id: ensureRecord(templateId, created.id).id, patient: created.id };
  }

  test('extraction : la valeur valide qui précède celle qui échoue n’est pas conservée', async () => {
    const { id } = await freshRecord('ATOMIC-AUTO');
    assert.throws(
      () =>
        applyAutomaticValues(
          id,
          [
            { fieldId: fieldIds[0]!, value: 54, source: 'auto' },
            { fieldId: fieldIds[1]!, value: unserializable, source: 'auto' },
          ],
          { markExtracted: true },
        ),
      TypeError,
    );
    assert.deepEqual(listValues(id), []);
    assert.deepEqual(listEventsForRecord(id, null), []);
    const row = db.prepare('SELECT last_extraction_at FROM records WHERE id = ?').get(id) as { last_extraction_at: string | null };
    assert.equal(row.last_extraction_at, null, 'la fiche n’est pas datée d’une passe qui n’a pas eu lieu');

    applyAutomaticValues(id, [{ fieldId: fieldIds[0]!, value: 54, source: 'auto' }], { markExtracted: true });
    assert.equal(listValues(id).length, 1, 'la base reste utilisable après l’échec');
  });

  test('relecture : des corrections lancées ensemble s’enregistrent toutes ou aucune', async () => {
    const { id } = await freshRecord('ATOMIC-HUMAN');
    applyAutomaticValues(id, [{ fieldId: fieldIds[0]!, value: 54, source: 'auto' }]);
    const eventsBefore = listEventsForRecord(id, null).length;

    assert.throws(
      () =>
        applyHumanEdits(id, [
          { fieldId: fieldIds[0]!, value: 99, mode: 'set' },
          { fieldId: fieldIds[1]!, value: unserializable, mode: 'set' },
        ]),
      TypeError,
    );
    const stored = listValues(id).find((v) => v.fieldId === fieldIds[0]);
    assert.equal(stored?.value, 54);
    assert.equal(stored?.source, 'auto', 'la valeur proposée par la machine n’a pas été remplacée');
    assert.equal(listEventsForRecord(id, null).length, eventsBefore);
  });
});

/* ───────────────────── Règles d'extraction démesurées ────────────────────── */

describe('règles d’extraction démesurées : écartées en le disant, jamais une panne', () => {
  const { extractFieldDetailed } = engine;

  const field = (rules: unknown[]): never =>
    ({
      id: 1,
      templateId: 1,
      key: 'age',
      label: 'Âge',
      type: 'integer',
      section: 'Général',
      unit: 'ans',
      description: null,
      required: false,
      options: [],
      position: 0,
      extraction: { enabled: true, rules },
    }) as never;
  const doc = { id: 1, name: 'cr.txt', kind: 'text', text: 'Âge : 54 ans', dicomTags: {} } as never;

  test('un libellé de 100 000 caractères (déjà en base, avant la limite) ne fait pas échouer la passe : la règle suivante répond', () => {
    const result = extractFieldDetailed(field([{ kind: 'label', labels: ['A'.repeat(100_000)] }, { kind: 'label', labels: ['Âge'] }]), [doc]);
    assert.equal(result.hit?.value, 54);
  });

  test('sans règle de repli, la règle inapplicable est consignée avec sa raison', () => {
    const result = extractFieldDetailed(field([{ kind: 'label', labels: ['A'.repeat(100_000)] }]), [doc]);
    assert.equal(result.hit, null);
    assert.match(result.rejected[0]?.reason ?? '', /trop long ou trop complexe/);
  });

  test('à l’enregistrement, un libellé, un mot-clé ou un terme d’exclusion de plus de 200 caractères est refusé', async () => {
    const long = 'a'.repeat(201);
    const rules: unknown[] = [
      { kind: 'label', labels: [long] },
      { kind: 'keyword', any: [long], emit: true },
      { kind: 'keyword', any: ['x'], none: [long], emit: true },
      { kind: 'keyword', any: ['x'], skip: [long], emit: true },
      { kind: 'label', labels: Array.from({ length: 51 }, (_, i) => `l${i}`) },
    ];
    for (const rule of rules) {
      const res = await raw(base, 'POST', `/api/templates/${templateId}/fields`, asJson({ key: 'trop_long', label: 'x', type: 'text', extraction: { enabled: true, rules: [rule] } }));
      assert.equal(res.status, 400, JSON.stringify(rule).slice(0, 80));
    }
    const exact = await raw(base, 'POST', `/api/templates/${templateId}/fields`, asJson({ key: 'limite_ok', label: 'x', type: 'text', extraction: { enabled: true, rules: [{ kind: 'label', labels: ['a'.repeat(200)] }] } }));
    assert.equal(exact.status, 201, exact.text);
  });
});

/* ───────────────────────── Renommage d'un document ───────────────────────── */

describe('renommer un document : le nom change, pas la nature du fichier', () => {
  let docId = 0;
  const rename = async (filename: string) => raw(base, 'PATCH', `/api/documents/${docId}`, asJson({ filename }));
  const nameOf = (r: Reply): string => (json(r).document as { filename: string }).filename;

  before(async () => {
    const file = multipart('depart.txt', 'Poids : 71 kg');
    const up = await raw(base, 'POST', `/api/patients/${patientId}/documents`, { headers: { 'Content-Type': file.type }, body: file.body });
    docId = (json(up).documents as { id: number; filename: string }[]).find((d) => d.filename === 'depart.txt')!.id;
  });

  test('un nom sans extension reprend celle du fichier', async () => {
    assert.equal(nameOf(await rename('Compte rendu d’admission')), 'Compte rendu d’admission.txt');
    assert.equal(nameOf(await rename('résumé.')), 'résumé.txt');
    assert.equal(nameOf(await rename('Dr. Martin')), 'Dr. Martin.txt');
    assert.equal(nameOf(await rename('v2.1 final')), 'v2.1 final.txt');
  });

  test('la même extension, quelle que soit sa casse, est acceptée telle quelle', async () => {
    assert.equal(nameOf(await rename('Bilan.TXT')), 'Bilan.TXT');
  });

  test('une autre extension est refusée, avec ce qu’il faut faire', async () => {
    for (const bad of ['bilan.pdf', 'bilan.docx', 'bilan.exe']) {
      const res = await rename(bad);
      assert.equal(res.status, 400, bad);
      assert.match(String(json(res).error), /extension d’un document ne change pas \(\.txt\)/i);
    }
    assert.equal(nameOf(await rename('Bilan biologique.txt')), 'Bilan biologique.txt');
  });

  test('un séparateur de chemin est toujours refusé', async () => {
    assert.equal((await rename('../../etc/passwd')).status, 400);
    assert.equal((await rename('a\\b.txt')).status, 400);
  });
});

/* ──────────────────────── Identifiants et bornes ─────────────────────────── */

describe('identifiants et positions hors limites : refus net, la fiche reste lisible', () => {
  const stillReadable = async (): Promise<void> => {
    const res = await raw(base, 'GET', `/api/templates/${templateId}`);
    assert.equal(res.status, 200);
    assert.equal((json(res).template as { fields: unknown[] }).fields.length >= fieldIds.length, true);
  };

  test('position de variable : négative, décimale, au-delà de la borne ou de 2^31', async () => {
    for (const position of [-1, 1.5, 100_001, 2 ** 31, 2 ** 53, 1e300]) {
      const res = await raw(base, 'POST', `/api/templates/${templateId}/fields`, asJson({ key: 'hors_borne', label: 'x', type: 'text', position }));
      assert.equal(res.status, 400, `position ${position}`);
    }
    await stillReadable();
  });

  test('identifiant de variable dans une valeur ou un ordre : refusé s’il dépasse 2^31', async () => {
    for (const fieldId of [2 ** 31, 2 ** 53, 1e300, 0, -3, 1.5]) {
      const res = await raw(base, 'PUT', `/api/records/${templateId}/${patientId}/values`, asJson({ values: [{ fieldId, value: 1 }] }));
      assert.equal(res.status, 400, `fieldId ${fieldId}`);
    }
    const reorder = await raw(base, 'POST', `/api/templates/${templateId}/fields/reorder`, asJson({ fieldIds: [2 ** 31] }));
    assert.equal(reorder.status, 400);
    const run = await raw(base, 'POST', '/api/records/extraction/run', asJson({ patientIds: [2 ** 31] }));
    assert.equal(run.status, 400);
    await stillReadable();
  });

  test('dossier inexistant dans une passe : 404 qui nomme le dossier, pas 500', async () => {
    const res = await raw(base, 'POST', '/api/records/extraction/run', asJson({ patientIds: [987_654] }));
    assert.equal(res.status, 404);
    assert.match(String(json(res).error), /987654/);
  });

  test('identifiants en chemin : seules les écritures décimales strictes désignent une ligne', async () => {
    const aliases = ['0', '-1', '1.5', '5.0', '+1', '01', '1e3', '0x10', ' 1', '1 ', 'abc', '9007199254740993', '99999999999999999999', '1%2F2', '%00', '..', fullwidth(12), 'x'.repeat(5000)];
    const routes: [string, (id: string) => string][] = [
      ['GET', (id) => `/api/patients/${id}`],
      ['PATCH', (id) => `/api/patients/${id}`],
      ['DELETE', (id) => `/api/patients/${id}`],
      ['GET', (id) => `/api/templates/${id}`],
      ['PATCH', (id) => `/api/templates/${id}`],
      ['DELETE', (id) => `/api/templates/${id}`],
      ['POST', (id) => `/api/templates/${id}/activate`],
      ['POST', (id) => `/api/templates/${id}/duplicate`],
      ['POST', (id) => `/api/templates/${id}/fields`],
      ['POST', (id) => `/api/templates/${id}/fields/reorder`],
      ['PATCH', (id) => `/api/templates/fields/${id}`],
      ['DELETE', (id) => `/api/templates/fields/${id}`],
      ['GET', (id) => `/api/documents/${id}`],
      ['GET', (id) => `/api/documents/${id}/text`],
      ['GET', (id) => `/api/documents/${id}/file`],
      ['PATCH', (id) => `/api/documents/${id}`],
      ['DELETE', (id) => `/api/documents/${id}`],
      ['POST', (id) => `/api/documents/${id}/reparse`],
      ['GET', (id) => `/api/records/${id}/${patientId}/history`],
      ['GET', (id) => `/api/records/${templateId}/${id}/history`],
      ['PUT', (id) => `/api/records/${id}/${patientId}/values`],
      ['PUT', (id) => `/api/records/${templateId}/${id}/values`],
      ['PATCH', (id) => `/api/biblio/refs/${id}`],
    ];
    for (const [method, route] of routes) {
      for (const id of aliases) {
        const res = await raw(base, method, route(encodeURI(id).replace(/%25/g, '%')), {
          ...(method === 'GET' || method === 'DELETE' ? {} : asJson({ label: 'x', filename: 'x.txt', values: [{ fieldId: fieldIds[0], value: 1 }], fieldIds: [] })),
        });
        assert.ok(res.status === 400 || res.status === 404, `${method} ${route(id).slice(0, 80)} -> ${res.status}`);
      }
    }
    // Rien n'a été supprimé ni modifié par ces appels.
    assert.equal((await raw(base, 'GET', `/api/patients/${patientId}`)).status, 200);
    assert.equal((await raw(base, 'GET', `/api/documents/${documentId}`)).status, 200);
    await stillReadable();
  });

  test('paramètres de requête numériques : mêmes règles', async () => {
    for (const query of ['patientId=abc', 'patientId=0', 'patientId=1e3', 'patientId=-4', 'patientId=0x1', 'patientId=1.5', 'patientId[]=1', 'patientId[a]=1']) {
      const res = await raw(base, 'GET', `/api/records?${query}`);
      assert.equal(res.status, 400, query);
    }
    for (const query of ['limit=0', 'limit=-1', 'limit=abc', 'limit=1e9x']) {
      assert.equal((await raw(base, 'GET', `/api/records/runs?${query}`)).status, 400, query);
    }
  });
});

function fullwidth(n: number): string {
  return [...String(n)].map((d) => String.fromCodePoint(0xff10 + Number(d))).join('');
}

/* ──────────────────── Corps de requête de toute forme ────────────────────── */

describe('corps de requête de toute forme : jamais d’erreur 500, jamais de fuite, la base reste saine', () => {
  const HOSTILE: unknown[] = [
    null,
    'x',
    '',
    ' ',
    0,
    -1,
    1.5,
    2 ** 31,
    2 ** 53,
    1e308,
    true,
    false,
    [],
    [null],
    [[[]]],
    {},
    { a: 1 },
    { __proto__: null },
    "'; DROP TABLE patients; --",
    '../../etc/passwd',
    '<script>alert(1)</script>',
    '${7*7}',
    `${NUL}x`,
    'é'.repeat(300),
    'A'.repeat(100_000),
  ];
  const DELETE_KEY = Symbol('supprimer la clé');

  interface Target {
    method: 'POST' | 'PUT' | 'PATCH';
    path: string;
    body: Record<string, unknown>;
    /** Réponse de l'appel non altéré : l'échantillon doit être valable pour que les altérations soient parlantes. */
    expect: number[];
    stream?: boolean;
  }

  const targets = (): Target[] => [
    { method: 'POST', path: '/api/patients', body: { code: 'FUZZ-1', label: 'x', notes: 'y' }, expect: [201, 409] },
    { method: 'POST', path: '/api/patients/ensure', body: { code: 'FUZZ-2' }, expect: [200] },
    { method: 'PATCH', path: `/api/patients/${patientId}`, body: { label: 'Étiquette', notes: 'n' }, expect: [200] },
    { method: 'PATCH', path: `/api/documents/${documentId}`, body: { filename: 'cr.txt' }, expect: [200] },
    { method: 'PUT', path: `/api/records/${templateId}/${patientId}/values`, body: { values: [{ fieldId: fieldIds[0], value: 54, mode: 'set' }], acceptOutOfBounds: true }, expect: [200] },
    { method: 'POST', path: '/api/records/extraction/run', body: { templateId, patientIds: [patientId], overwriteManual: false, mode: 'rules' }, expect: [200] },
    { method: 'POST', path: '/api/templates', body: { name: 'Fiche fuzz', description: 'x', isActive: false }, expect: [201] },
    { method: 'PATCH', path: `/api/templates/${templateId}`, body: { name: 'Fiche', description: 'x' }, expect: [200] },
    { method: 'POST', path: `/api/templates/${templateId}/duplicate`, body: { name: 'Copie' }, expect: [201] },
    { method: 'POST', path: '/api/templates/import', body: { name: 'Importée', description: null, fields: [{ key: 'a', label: 'A', type: 'text' }] }, expect: [201] },
    {
      method: 'POST',
      path: `/api/templates/${templateId}/fields`,
      body: { key: 'fuzz_champ', label: 'Champ', type: 'text', options: ['a'], extraction: { enabled: true, rules: [{ kind: 'label', labels: ['x'] }] } },
      expect: [201, 400],
    },
    {
      method: 'PATCH',
      path: `/api/templates/fields/${fieldIds[3] ?? fieldIds[0]}`,
      body: { label: 'Libellé', position: 3, extraction: { enabled: true, rules: [{ kind: 'regex', pattern: '(\\d+)', group: 1 }] } },
      expect: [200],
    },
    { method: 'POST', path: `/api/templates/${templateId}/fields/reorder`, body: { fieldIds }, expect: [200] },
    {
      method: 'POST',
      path: '/api/templates/fields/test',
      body: { field: { key: 'k', label: 'K', type: 'integer', extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Âge'] }] } }, sampleText: 'Âge : 54 ans' },
      expect: [200],
    },
    { method: 'POST', path: '/api/biblio/searches', body: { query: 'asthme', sources: ['pubmed'], maxResults: 5, sort: 'relevance' }, expect: [409] },
    { method: 'PATCH', path: '/api/biblio/refs/1', body: { decision: 'include', note: 'x' }, expect: [404] },
    { method: 'POST', path: '/api/redaction/message', body: { templateId, messages: [{ role: 'user', content: 'Bonjour' }] }, expect: [200], stream: true },
  ];

  function replaceAt(root: unknown, where: (string | number)[], value: unknown): unknown {
    if (where.length === 0) return value;
    const copy = Array.isArray(root) ? [...root] : { ...(root as Record<string, unknown>) };
    const [head, ...rest] = where as [string | number, ...(string | number)[]];
    const child = (copy as Record<string | number, unknown>)[head];
    if (rest.length === 0 && value === DELETE_KEY) {
      if (Array.isArray(copy)) copy.splice(Number(head), 1);
      else delete (copy as Record<string, unknown>)[String(head)];
    } else {
      (copy as Record<string | number, unknown>)[head] = replaceAt(child, rest, value);
    }
    return copy;
  }

  function* mutations(body: unknown): Generator<{ where: (string | number)[]; body: unknown }> {
    function* walk(node: unknown, where: (string | number)[]): Generator<{ where: (string | number)[]; body: unknown }> {
      if (where.length > 0) {
        for (const value of [...HOSTILE, DELETE_KEY]) yield { where, body: replaceAt(body, where, value) };
      }
      if (Array.isArray(node)) {
        for (const [i, child] of node.entries()) yield* walk(child, [...where, i]);
      } else if (node && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) yield* walk(child, [...where, key]);
      }
    }
    yield* walk(body, []);
  }

  const LEAKS = /node_modules|SQLITE_|sqlite|\bat .*\(.*:\d+:\d+\)|\/tmp\/|pubresearcher-hardening|\.ts:\d+/i;

  function check(label: string, res: Reply, stream = false): void {
    assert.ok(res.status < 500, `${label} -> ${res.status} : ${res.text.slice(0, 300)}`);
    assert.doesNotMatch(res.text.slice(0, 5000), LEAKS, `${label} : fuite d'un détail technique`);
    if (!stream && res.status >= 400) {
      assert.match(res.headers['content-type'] ?? '', /json/, label);
      assert.equal(typeof json(res).error, 'string', `${label} : message d'erreur absent`);
    }
  }

  test('les appels non altérés répondent comme prévu : les altérations qui suivent sont donc parlantes', async () => {
    for (const t of targets()) {
      const res = await raw(base, t.method, t.path, asJson(t.body));
      assert.ok(t.expect.includes(res.status), `${t.method} ${t.path} -> ${res.status} (attendu ${t.expect.join('/')}) : ${res.text.slice(0, 200)}`);
    }
  });

  test('chaque valeur de chaque clé de chaque corps, remplacée par une valeur hostile', async () => {
    let sent = 0;
    for (const t of targets()) {
      for (const m of mutations(t.body)) {
        const res = await raw(base, t.method, t.path, asJson(m.body));
        check(`${t.method} ${t.path} [${m.where.join('.')}]`, res, t.stream);
        sent++;
      }
    }
    assert.ok(sent > 2000, `${sent} requêtes envoyées`);
  });

  const RAW_BODIES: [string, string, string][] = [
    ['null', 'application/json', 'null'],
    ['chaîne', 'application/json', '"x"'],
    ['nombre', 'application/json', '42'],
    ['booléen', 'application/json', 'true'],
    ['tableau vide', 'application/json', '[]'],
    ['tableau de nombres', 'application/json', '[1,2,3]'],
    ['objet vide', 'application/json', '{}'],
    ['corps vide', 'application/json', ''],
    ['JSON tronqué', 'application/json', '{"code":'],
    ['JSON suivi de déchets', 'application/json', '{"code":"A"}xyz'],
    ['octet nul', 'application/json', `{"code":"A${NUL}"}`],
    ['texte brut', 'text/plain', 'code=A'],
    ['formulaire', 'application/x-www-form-urlencoded', 'code=A&code=B'],
    ['type inconnu', 'application/octet-stream', 'xx'],
    ['multipart sans délimiteur', 'multipart/form-data', 'x'],
    ['imbrication de 20 000 niveaux', 'application/json', '['.repeat(20_000) + ']'.repeat(20_000)],
    ['clés de prototype', 'application/json', '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}}}'],
  ];

  test('corps de forme quelconque (type de contenu, JSON invalide, imbrication extrême, pollution de prototype)', async () => {
    for (const t of targets()) {
      for (const [label, type, body] of RAW_BODIES) {
        const res = await raw(base, t.method, t.path, { headers: { 'Content-Type': type }, body });
        check(`${t.method} ${t.path} <${label}>`, res, t.stream);
      }
    }
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined, 'Object.prototype intact');
    assert.equal(({} as Record<string, unknown>)['polluted2'], undefined);
  });

  test('requêtes de lecture avec des paramètres de requête hostiles', async () => {
    const gets = [
      '/api/records',
      '/api/records/runs',
      `/api/records/${templateId}/${patientId}/history`,
      '/api/analytics/dataset',
      '/api/analytics/stats',
      '/api/analytics/extraction',
      '/api/analytics/completeness',
      '/api/analytics/quality',
      '/api/export/csv',
      '/api/export/dictionary.csv',
      '/api/export/template.json',
      '/api/export/xlsx',
      '/api/export/pptx',
      '/api/export/methods',
      '/api/export/audit.csv',
      '/api/biblio/refs',
      '/api/biblio/export',
      '/api/biblio/overview',
      '/api/patients',
      '/api/templates',
    ];
    const queries = [
      'templateId=abc',
      'templateId=0',
      'templateId=-1',
      'templateId=1e3',
      'templateId=99999999999999999999',
      'templateId[]=1',
      'templateId[a]=1',
      `templateId=${templateId}&patientId=${patientId}&fieldId=zz&limit=-5`,
      'limit=1e9',
      'offset=-1',
      'decimal=%00&delimiter=%00&labels=%00&lang=%00&format=%00',
      `q=${'a'.repeat(10_000)}`,
      'decision=nimporte&source=quoi&sort=comment',
      'format=xlsx&lang=zz',
    ];
    for (const route of gets) {
      for (const query of queries) {
        const res = await raw(base, 'GET', `${route}?${query}`);
        check(`GET ${route}?${query.slice(0, 60)}`, res, true);
      }
    }
  });

  test('après tout cela : le serveur répond vite, la base est intègre, aucune clé étrangère ne pend', async () => {
    const started = Date.now();
    assert.equal((await raw(base, 'GET', '/api/health')).status, 200);
    assert.ok(Date.now() - started < 1000, 'le serveur n’est pas resté occupé');
    assert.equal((await raw(base, 'GET', '/api/patients')).status, 200);
    assert.equal((await raw(base, 'GET', '/api/templates')).status, 200);
    assert.equal((db.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check, 'ok');
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
});
