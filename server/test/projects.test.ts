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

  test('créer un projet : fiche vide par défaut, sans aucun dossier', async () => {
    const { data } = await api<any>('POST', '/api/projects', { name: 'Vide' });
    const tpl = await api<any>('GET', '/api/templates', undefined, data.id);
    assert.equal(tpl.data.templates.length, 1);
    assert.equal(tpl.data.active.fields.length, 0, 'aucune variable');
    assert.equal(data.stats.patients, 0);
    const generale = await api<any>('POST', '/api/projects', { name: 'Avec trame', copyTemplateFrom: 'generale' });
    const tpl2 = await api<any>('GET', '/api/templates', undefined, generale.data.id);
    assert.ok(tpl2.data.active.fields.length > 10, 'trame générale sur demande');
  });

  test('créer un projet : base séparée', async () => {
    await api('POST', '/api/patients', { code: 'P-PRINCIPAL' });
    const { status, data } = await api<any>('POST', '/api/projects', { name: 'Pneumopathies 2024', description: 'Étude rétrospective', copyTemplateFrom: 'generale' });
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

  test('suppression groupée : dossiers et variables, dans le seul projet visé', async () => {
    const ids: number[] = [];
    for (const code of ['B-1', 'B-2', 'B-3']) ids.push((await api<any>('POST', '/api/patients', { code }, second)).data.patient.id);
    const res = await api<any>('POST', '/api/patients/bulk-delete', { ids: ids.slice(0, 2) }, second);
    assert.equal(res.data.deleted, 2);
    const left = JSON.stringify((await api<any>('GET', '/api/patients', undefined, second)).data);
    assert.ok(left.includes('B-3') && !left.includes('B-1') && !left.includes('B-2'));
    assert.equal((await api('POST', '/api/patients/bulk-delete', { ids: [] }, second)).status, 400);

    const tpl = (await api<any>('GET', '/api/templates', undefined, second)).data.active;
    const before = tpl.fields.length;
    const del = await api<any>('POST', '/api/templates/fields/bulk-delete', { ids: tpl.fields.slice(0, 3).map((f: any) => f.id) }, second);
    assert.equal(del.data.deleted, 3);
    assert.equal((await api<any>('GET', '/api/templates', undefined, second)).data.active.fields.length, before - 3);
    // Le projet principal garde sa fiche intacte.
    const main = (await api<any>('GET', '/api/templates')).data.active.fields.length;
    assert.ok(main >= before);
  });

  test('extraction, tableau et tri bibliographique écrivent dans le projet visé, jamais dans le principal', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const count = (dbFile: string, sql: string) => {
      const conn = new DatabaseSync(dbFile, { readOnly: true });
      try {
        return (conn.prepare(sql).get() as { n: number }).n;
      } finally {
        conn.close();
      }
    };
    const mainDb = path.join(tmpDir, 'research-tool.db');
    const projDb = path.join(tmpDir, 'projects', second, 'research-tool.db');
    const before = {
      values: count(mainDb, 'SELECT COUNT(*) AS n FROM record_values'),
      events: count(mainDb, 'SELECT COUNT(*) AS n FROM value_events'),
      runs: count(mainDb, 'SELECT COUNT(*) AS n FROM extraction_runs'),
    };

    // Extraction (les requêtes préparées au chargement des modules visaient le principal : défaut de la 1.7.0).
    const run = await api<any>('POST', '/api/records/extraction/run', { mode: 'rules' }, second);
    assert.equal(run.status, 200, JSON.stringify(run.data));
    assert.ok(run.data.totals.extracted > 0, 'le compte rendu importé donne des valeurs');
    assert.ok(count(projDb, 'SELECT COUNT(*) AS n FROM record_values') > 0, 'valeurs écrites dans le projet');

    // Import d'un tableau de cohorte.
    const csv = 'code;age\nTAB-1;61\nTAB-2;47\n';
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'cohorte.csv');
    const up = await fetch(`${baseUrl}/api/table-imports`, { method: 'POST', body: form, headers: { 'X-Project': second } });
    assert.equal(up.status, 201, await up.clone().text());
    const draft = ((await up.json()) as any).import.id;
    const tpl = (await api<any>('GET', '/api/templates', undefined, second)).data.active;
    const age = tpl.fields.find((f: any) => f.type === 'number' || f.type === 'integer');
    assert.ok(age, 'une variable numérique reste dans la fiche');
    const commit = await api<any>(
      'POST',
      `/api/table-imports/${draft}/commit`,
      { sheet: null, headerRow: 1, codeColumn: 0, mapping: [{ column: 1, fieldId: age.id }], options: { createPatients: true, overwriteExtracted: false, overwriteManual: false } },
      second,
    );
    assert.ok(commit.status < 300, JSON.stringify(commit.data));
    const list = JSON.stringify((await api<any>('GET', '/api/patients', undefined, second)).data);
    assert.ok(list.includes('TAB-1'));

    // Rien de tout cela n'a touché le projet principal.
    assert.deepEqual(
      {
        values: count(mainDb, 'SELECT COUNT(*) AS n FROM record_values'),
        events: count(mainDb, 'SELECT COUNT(*) AS n FROM value_events'),
        runs: count(mainDb, 'SELECT COUNT(*) AS n FROM extraction_runs'),
      },
      before,
    );
    assert.equal(JSON.stringify((await api<any>('GET', '/api/patients')).data).includes('TAB-1'), false);
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
