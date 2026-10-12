/**
 * Projets de recherche : chaque étude a sa base et ses fichiers, et rien ne passe de l'une à l'autre — y compris
 * par l'import de fichiers, dont la lecture se termine hors du contexte de la requête.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-projects-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'research-tool.db');
process.env.OCR_ENABLED = '0';

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { setProjectInitializer } = await import('../src/projects.js');
const { makeDocx } = await import('./fixtures.js');

let server: Server;
let baseUrl: string;

before(async () => {
  setProjectInitializer(seedIfEmpty);
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
  const { closeDatabase } = await import('../src/db/index.js');
  closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function api<T = any>(method: string, url: string, body?: unknown, project?: string): Promise<{ status: number; data: T }> {
  const res = await fetch(baseUrl + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(project ? { 'X-Project': project } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : (undefined as T) };
}

describe('projets de recherche', () => {
  let second = '';

  test('le projet principal existe d’emblée et ne se supprime pas', async () => {
    const { data } = await api<any[]>('GET', '/api/projects');
    assert.equal(data.length, 1);
    assert.equal(data[0].id, 'principal');
    assert.equal(data[0].isMain, true);
    const del = await api('DELETE', '/api/projects/principal', { confirmName: data[0].name });
    assert.equal(del.status, 400);
  });

  test('créer un projet : base séparée, fiche générale par défaut', async () => {
    await api('POST', '/api/patients', { code: 'P-PRINCIPAL' });
    const { status, data } = await api<any>('POST', '/api/projects', { name: 'Pneumopathies 2024', description: 'Étude rétrospective' });
    assert.equal(status, 201);
    assert.equal(data.id, 'pneumopathies-2024');
    assert.equal(data.stats.patients, 0);
    assert.ok(data.stats.template, 'la fiche par défaut est créée');
    second = data.id;
    assert.ok(fs.existsSync(path.join(tmpDir, 'projects', second, 'research-tool.db')));

    const inSecond = await api<any>('GET', '/api/patients', undefined, second);
    assert.equal(JSON.stringify(inSecond.data).includes('P-PRINCIPAL'), false);
  });

  test('un fichier importé dans un projet y reste (base et dossier)', async () => {
    const created = await api<any>('POST', '/api/patients', { code: 'P-SECOND' }, second);
    assert.equal(created.status, 201);
    const patientId = created.data.patient.id;
    const form = new FormData();
    form.append('files', new Blob([await makeDocx(['Patient de 60 ans. Diabète de type 2.'])]), 'cr.docx');
    // Un gros fichier arrive en plusieurs paquets réseau : la fin de la lecture tombe hors du contexte de la requête.
    form.append('files', new Blob([`Compte rendu.\n${'Texte de remplissage. '.repeat(400_000)}`], { type: 'text/plain' }), 'long.txt');
    form.append('anonymised', 'true');
    const res = await fetch(`${baseUrl}/api/patients/${patientId}/documents`, { method: 'POST', body: form, headers: { 'X-Project': second } });
    assert.ok(res.status < 300, `import refusé : ${res.status} ${await res.text()}`);

    const docsSecond = await api<any>('GET', `/api/patients/${patientId}`, undefined, second);
    assert.equal(JSON.stringify(docsSecond.data).includes('P-SECOND'), true);
    assert.ok(fs.readdirSync(path.join(tmpDir, 'projects', second, 'uploads', String(patientId))).length >= 1);
    assert.equal(fs.existsSync(path.join(tmpDir, 'uploads', String(patientId))), false, 'rien dans les fichiers du projet principal');

    const list = await api<any[]>('GET', '/api/projects');
    const stats = Object.fromEntries(list.data.map((p) => [p.id, p.stats]));
    assert.equal(stats[second].patients, 1);
    assert.equal(stats[second].documents, 2);
    assert.equal(stats.principal.patients, 1);
    assert.equal(stats.principal.documents, 0);
  });

  test('copier la fiche d’un projet dans un nouveau projet', async () => {
    const tpl = await api<any>('GET', '/api/templates', undefined, second);
    const fieldCount = tpl.data.active.fields.length;
    const { data } = await api<any>('POST', '/api/projects', { name: 'Suite', copyTemplateFrom: second });
    const copied = await api<any>('GET', '/api/templates', undefined, data.id);
    assert.equal(copied.data.active.fields.length, fieldCount);
    assert.equal(copied.data.templates.length, 1, 'pas de seconde fiche par défaut ajoutée à la copie');
  });

  test('projet inconnu : refus explicite, pas de repli silencieux sur le principal', async () => {
    const res = await api<any>('GET', '/api/patients', undefined, 'nexiste-pas');
    assert.equal(res.status, 404);
    assert.equal(res.data.code, 'PROJECT_NOT_FOUND');
  });

  test('renommer, puis supprimer avec le nom exact', async () => {
    const renamed = await api<any>('PATCH', `/api/projects/${second}`, { name: 'Pneumo 2024' });
    assert.equal(renamed.data.name, 'Pneumo 2024');
    assert.equal((await api('DELETE', `/api/projects/${second}`, { confirmName: 'Pneumopathies 2024' })).status, 400);
    assert.equal((await api('DELETE', `/api/projects/${second}`, { confirmName: 'Pneumo 2024' })).status, 204);
    assert.equal(fs.existsSync(path.join(tmpDir, 'projects', second)), false);
    assert.equal((await api('GET', '/api/patients', undefined, second)).status, 404);
  });
});
