/**
 * Robustesse de l'import et des erreurs : ce qui reste sur le disque, ce que
 * répond le serveur à une requête mal formée, ce qu'il ne dit pas d'une panne.
 *
 * Limites volontairement basses (posées avant l'import de la configuration)
 * pour provoquer les refus avec de petits fichiers.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-robust-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';
process.env.MAX_UPLOAD_BYTES = '4000';
process.env.MAX_REQUEST_BYTES = '9000';

const { createApp } = await import('../src/app.js');
const { db } = await import('../src/db/index.js');
const { errorMiddleware } = await import('../src/lib/http.js');
const { purgeIncoming } = await import('../src/repo/documents.js');
const { incomingDir, uploadsDir } = await import('../src/config.js');

let server: Server;
let baseUrl = '';

before(async () => {
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM patients');
  fs.rmSync(uploadsDir, { recursive: true, force: true });
  fs.mkdirSync(incomingDir, { recursive: true });
});

async function json(method: string, route: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

async function upload(patientId: number | string, files: { name: string; content: Buffer | string }[]) {
  const form = new FormData();
  for (const f of files) form.append('files', new Blob([f.content]), f.name);
  const res = await fetch(`${baseUrl}/api/patients/${patientId}/documents`, { method: 'POST', body: form });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

const filesIn = (dir: string): string[] =>
  fs.existsSync(dir)
    ? fs.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => path.join(e.parentPath, e.name))
    : [];

const storedFiles = (): string[] => filesIn(uploadsDir).filter((f) => !f.startsWith(incomingDir));

async function newPatient(code = 'PAT-001'): Promise<number> {
  const r = await json('POST', '/api/patients', { code });
  return r.data.patient.id;
}

describe('données de patient : rien ne traîne sur le disque', () => {
  test('supprimer un dossier supprime ses fichiers, pas seulement ses lignes', async () => {
    const id = await newPatient();
    const r = await upload(id, [{ name: 'cr.txt', content: 'Âge : 54 ans' }]);
    assert.equal(r.data.summary.imported, 1);
    assert.equal(storedFiles().length, 1);

    assert.equal((await json('DELETE', `/api/patients/${id}`)).status, 204);
    assert.deepEqual(storedFiles(), [], 'le fichier du patient doit avoir disparu');
    assert.equal(fs.existsSync(path.join(uploadsDir, String(id))), false);
  });

  test('supprimer un document supprime son fichier', async () => {
    const id = await newPatient();
    const r = await upload(id, [{ name: 'a.txt', content: 'un' }, { name: 'b.txt', content: 'deux' }]);
    assert.equal(storedFiles().length, 2);
    const docId = r.data.results[0].documentId;
    assert.equal((await json('DELETE', `/api/documents/${docId}`)).status, 204);
    await new Promise((resolve) => setTimeout(resolve, 50)); // la suppression du fichier est asynchrone
    assert.equal(storedFiles().length, 1);
  });

  test('le dépôt provisoire est vide après un import réussi, un doublon, ou un dossier inconnu', async () => {
    const id = await newPatient();
    await upload(id, [{ name: 'a.txt', content: 'contenu' }]);
    await upload(id, [{ name: 'a-bis.txt', content: 'contenu' }]); // doublon
    assert.deepEqual(filesIn(incomingDir), []);

    const unknown = await upload(99999, [{ name: 'x.txt', content: 'secret' }]);
    assert.equal(unknown.status, 404);
    assert.deepEqual(filesIn(incomingDir), [], 'un envoi refusé ne laisse rien derrière lui');
  });

  test('au démarrage, les fichiers laissés par un arrêt brutal sont effacés', () => {
    fs.writeFileSync(path.join(incomingDir, 'reste-d-un-envoi'), 'données de patient');
    assert.equal(purgeIncoming(), 1);
    assert.deepEqual(filesIn(incomingDir), []);
  });

  test('un doublon n’ajoute ni ligne ni fichier', async () => {
    const id = await newPatient();
    await upload(id, [{ name: 'a.txt', content: 'contenu' }]);
    const again = await upload(id, [{ name: 'copie.txt', content: 'contenu' }]);
    assert.equal(again.data.summary.duplicates, 1);
    assert.equal(storedFiles().length, 1);
  });
});

describe('refus propres : 4xx explicites, jamais « erreur interne »', () => {
  test('un fichier au-delà de la limite est refusé en 413, avec la limite dans le message', async () => {
    const id = await newPatient();
    const r = await upload(id, [{ name: 'gros.txt', content: Buffer.alloc(6000, 97) }]);
    assert.equal(r.status, 413);
    assert.match(r.data.error, /trop volumineux/);
    assert.match(r.data.error, /MAX_UPLOAD_BYTES|MAX_REQUEST_BYTES/, 'le message nomme la variable à relever');
    assert.deepEqual(filesIn(incomingDir), [], 'le fichier partiel est effacé');
    assert.deepEqual(storedFiles(), []);
  });

  test('un envoi dont la taille annoncée dépasse la limite par requête est refusé d’emblée', async () => {
    const id = await newPatient();
    const files = Array.from({ length: 4 }, (_, i) => ({ name: `f${i}.txt`, content: Buffer.alloc(3500, 98 + i) }));
    const r = await upload(id, files);
    assert.equal(r.status, 413);
    assert.match(r.data.error, /plusieurs lots/);
    assert.match(r.data.error, /MAX_REQUEST_BYTES/, 'le message nomme la variable à relever');
  });

  test('un corps JSON de plus de 5 Mo est refusé en 413 avec sa limite fixe ; un encodage inconnu en 415 ; un texte brut en 400', async () => {
    const big = await fetch(`${baseUrl}/api/patients`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'a'.repeat(5_400_000) }) });
    assert.equal(big.status, 413);
    assert.match(((await big.json()) as { error: string }).error, /5 Mo \(limite fixe\)/);

    const latin = await fetch(`${baseUrl}/api/patients`, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=latin1' }, body: '{"code":"x"}' });
    assert.equal(latin.status, 415);
    assert.match(((await latin.json()) as { error: string }).error, /UTF-8/);

    // Un corps qui n'est pas du JSON n'est pas lu : la validation répond 400, pas 415.
    const plain = await fetch(`${baseUrl}/api/patients`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"code":"x"}' });
    assert.equal(plain.status, 400);
  });

  test('trop de fichiers dans un même envoi : 413 et message clair', async () => {
    const id = await newPatient();
    // Plafond du dépôt à 200 fichiers : un envoi de 201 petits fichiers dépasse aussi la taille annoncée,
    // on vérifie donc seulement qu'il est refusé proprement.
    const files = Array.from({ length: 201 }, (_, i) => ({ name: `f${i}.txt`, content: String(i) }));
    const r = await upload(id, files);
    assert.ok([400, 413].includes(r.status), `statut ${r.status}`);
    assert.doesNotMatch(String(r.data.error), /interne/);
  });

  test('un JSON mal formé donne 400, pas 500', async () => {
    const res = await fetch(`${baseUrl}/api/patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"code": "PAT-9",',
    });
    assert.equal(res.status, 400);
    const data = await res.json();
    assert.match(data.error, /JSON/);
    assert.doesNotMatch(JSON.stringify(data), /Unexpected|SyntaxError|at /);
  });

  test('un JSON démesuré donne 413', async () => {
    const res = await fetch(`${baseUrl}/api/patients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: 'X', notes: 'a'.repeat(6 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413);
  });

  test('un identifiant non numérique donne 400', async () => {
    assert.equal((await json('GET', '/api/patients/abc')).status, 400);
    assert.equal((await json('GET', '/api/patients/-4')).status, 400);
    assert.equal((await json('GET', '/api/patients/1.5')).status, 400);
  });
});

describe('une vraie panne ne dit rien de l’intérieur', () => {
  function respond(err: unknown) {
    const out: { status?: number; body?: Record<string, unknown> } = {};
    const res = {
      status(code: number) { out.status = code; return res; },
      json(body: Record<string, unknown>) { out.body = body; return res; },
    };
    const logged: unknown[][] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => { logged.push(args); };
    try {
      errorMiddleware(err, {} as never, res as never, (() => undefined) as never);
    } finally {
      console.error = original;
    }
    return { ...out, logged };
  }

  test('500 : ni message SQL, ni chemin, mais une référence reprise dans le journal', () => {
    const { status, body, logged } = respond(
      new Error('SQLITE_ERROR: no such table: secret_table at /home/user/app/data/research-tool.db'),
    );
    assert.equal(status, 500);
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /SQLITE|secret_table|\/home\//);
    const reference = /référence ([0-9a-f]{8})/.exec(String(body?.error))?.[1];
    assert.ok(reference, 'la réponse porte une référence');
    assert.ok(JSON.stringify(logged).includes(reference!), 'le journal reprend la même référence');
  });

  test('RT_DEBUG=1 rend le détail, pour le diagnostic', () => {
    process.env.RT_DEBUG = '1';
    try {
      const { body } = respond(new Error('détail technique'));
      assert.equal(body?.details, 'détail technique');
    } finally {
      delete process.env.RT_DEBUG;
    }
  });

  test('une contrainte d’unicité reste un 409 lisible, sans la requête SQL', async () => {
    await newPatient('DUP-1');
    const again = await json('POST', '/api/patients', { code: 'DUP-1' });
    assert.equal(again.status, 409);
    assert.doesNotMatch(JSON.stringify(again.data), /constraint|UNIQUE|patients\.code/);
  });
});
