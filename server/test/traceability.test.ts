/**
 * Traçabilité d'une étude : fiabilité mesurée sur les relectures, rapport « Méthodes », journal d'audit.
 *
 * Le scénario reproduit un travail de relecture : douze dossiers extraits, certaines valeurs confirmées,
 * d'autres corrigées, vidées ou ajoutées — puis on vérifie que les chiffres du rapport sont exactement ceux
 * que ces gestes ont produits.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-trace-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { wilsonInterval } = await import('../src/lib/stats.js');
const { renderMarkdown, renderHtml } = await import('../src/lib/report.js');

let server: Server;
let baseUrl = '';

before(async () => {
  seedIfEmpty();
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
  const { db } = await import('../src/db/index.js');
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function api<T = any>(method: string, route: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

async function text(route: string): Promise<{ status: number; headers: Headers; body: string }> {
  const res = await fetch(`${baseUrl}${route}`);
  return { status: res.status, headers: res.headers, body: await res.text() };
}

describe('intervalle de Wilson', () => {
  test('valeurs de référence', () => {
    // 8 succès sur 10 : [0,490 ; 0,943] (référence classique)
    const ci = wilsonInterval(8, 10)!;
    assert.ok(Math.abs(ci.low - 0.4902) < 0.001 && Math.abs(ci.high - 0.9433) < 0.001, JSON.stringify(ci));
  });

  test('reste dans [0 ; 1] et ne s’effondre pas aux extrêmes, contrairement à Wald', () => {
    const all = wilsonInterval(20, 20)!;
    assert.ok(all.high === 1 && all.low > 0.8 && all.low < 1);
    const none = wilsonInterval(0, 20)!;
    assert.ok(none.low === 0 && none.high > 0.05 && none.high < 0.2);
    assert.equal(wilsonInterval(0, 0), null);
  });
});

describe('rapport sur un corpus relu', () => {
  let templateId: number;
  const ids: Record<string, number> = {};

  before(async () => {
    // Dix dossiers : âge (1 à 10) et sexe, extraits par les règles.
    for (let i = 1; i <= 10; i++) {
      const { data } = await api('POST', '/api/patients', { code: `TRACE-${String(i).padStart(2, '0')}` });
      const patientId = data.patient.id;
      const form = new FormData();
      form.append('files', new Blob([`Âge : ${30 + i} ans\nSexe : ${i % 2 ? 'Féminin' : 'Masculin'}\nCRP : ${10 * i} mg/L`]), 'cr.txt');
      assert.equal((await fetch(`${baseUrl}/api/patients/${patientId}/documents`, { method: 'POST', body: form })).status, 201);
      ids[`p${i}`] = patientId;
    }
    const run = await api('POST', '/api/records/extraction/run', {});
    assert.equal(run.status, 200);
    const { data } = await api('GET', `/api/records?patientId=${ids['p1']}`);
    templateId = data.template.id;
    for (const f of data.template.fields) ids[f.key] = f.id;

    const put = (patient: number, values: unknown[]) =>
      api('PUT', `/api/records/${templateId}/${ids[`p${patient}`]}/values`, { values });

    // Âge : 6 confirmés (p1–p6), 2 corrigés (p7, p8), 1 vidé (p9), p10 laissé tel quel.
    for (let p = 1; p <= 6; p++) assert.equal((await put(p, [{ fieldId: ids['age'], mode: 'confirm' }])).status, 200);
    assert.equal((await put(7, [{ fieldId: ids['age'], value: 99 }])).status, 200);
    assert.equal((await put(8, [{ fieldId: ids['age'], value: 100 }])).status, 200);
    assert.equal((await put(9, [{ fieldId: ids['age'], value: null }])).status, 200);
    // Motif : la machine n'avait rien trouvé ; un relecteur saisit une valeur, un autre confirme qu'il n'y a rien.
    assert.equal((await put(1, [{ fieldId: ids['motif_consultation'], value: 'Douleur thoracique' }])).status, 200);
    assert.equal((await put(2, [{ fieldId: ids['motif_consultation'], value: null }])).status, 200);
    // Sexe : 3 confirmés.
    for (let p = 1; p <= 3; p++) assert.equal((await put(p, [{ fieldId: ids['sexe'], mode: 'confirm' }])).status, 200);
  });

  test('les décisions de relecture se comptent exactement', async () => {
    const { data } = await api('GET', '/api/analytics/quality');
    const q = data.quality;
    const age = q.fields.find((f: any) => f.key === 'age');
    assert.deepEqual(
      { confirmed: age.confirmed, corrected: age.corrected, emptied: age.emptied, unreviewed: age.unreviewed, reviewed: age.reviewed },
      { confirmed: 6, corrected: 2, emptied: 1, unreviewed: 1, reviewed: 9 },
    );
    assert.equal(age.agreement.of, 9);
    assert.ok(Math.abs(age.agreement.value - 6 / 9) < 1e-9);
    assert.ok(age.agreement.low < 6 / 9 && age.agreement.high > 6 / 9);

    const motif = q.fields.find((f: any) => f.key === 'motif_consultation');
    assert.equal(motif.added, 1, 'valeur saisie là où la machine n’avait rien trouvé');
    assert.equal(motif.confirmedEmpty, 1);
    assert.equal(motif.reviewed, 0, 'rien n’avait été proposé : aucune proposition relue');
    assert.equal(motif.agreement, null);

    const sexe = q.fields.find((f: any) => f.key === 'sexe');
    assert.deepEqual({ confirmed: sexe.confirmed, reviewed: sexe.reviewed }, { confirmed: 3, reviewed: 3 });
    assert.equal(sexe.agreement.value, 1);
    assert.ok(sexe.agreement.high === 1 && sexe.agreement.low < 1, 'trois sur trois ne valent pas 100 % certain');
  });

  test('les totaux sont la somme des variables, et le rappel compte les valeurs manquées', async () => {
    const q = (await api('GET', '/api/analytics/quality')).data.quality;
    const sum = (key: string) => q.fields.reduce((t: number, f: any) => t + f[key], 0);
    for (const key of ['confirmed', 'corrected', 'emptied', 'added', 'confirmedEmpty', 'unreviewed']) {
      assert.equal(q.overall[key], sum(key), key);
    }
    assert.equal(q.overall.reviewed, q.overall.confirmed + q.overall.corrected + q.overall.emptied);
    // rappel = confirmées / (confirmées + corrigées + ajoutées) = 9 / (9 + 2 + 1) = 0,75
    assert.equal(q.overall.confirmed, 9);
    assert.ok(Math.abs(q.overall.recall.value - 9 / 12) < 1e-9, String(q.overall.recall.value));
    assert.equal(q.patients, 10);
    assert.equal(q.patientsReviewed, 9, 'p10 n’a rien reçu d’un relecteur');
  });

  test('rendre la main retire une relecture des mesures', async () => {
    await api('PUT', `/api/records/${templateId}/${ids['p6']}/values`, { values: [{ fieldId: ids['age'], mode: 'release' }] });
    const age = (await api('GET', '/api/analytics/quality')).data.quality.fields.find((f: any) => f.key === 'age');
    assert.equal(age.confirmed, 5);
    assert.equal(age.reviewed, 8);
    // ...et l'extraction rejoue
    await api('POST', '/api/records/extraction/run', { patientIds: [ids['p6']] });
    const after = (await api('GET', '/api/analytics/quality')).data.quality.fields.find((f: any) => f.key === 'age');
    assert.equal(after.unreviewed, 2);
  });

  test('le rapport Markdown donne les chiffres de la relecture et un paragraphe prêt à coller', async () => {
    const r = await text(`/api/export/methods?templateId=${templateId}&format=md&lang=fr`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/markdown/);
    assert.match(r.headers.get('content-disposition') ?? '', /methodes-.*\.md/);
    const md = r.body;
    assert.match(md, /^# Méthodes et traçabilité de l’extraction/);
    assert.match(md, /Les données ont été extraites rétrospectivement de 10 documents \(10 dossiers\)/);
    assert.match(md, /empreinte [0-9a-f]{12}\)/);
    assert.match(md, /Propositions relues \| 11 \|/); // âge : 8, sexe : 3
    assert.match(md, /Valeurs saisies là où l’extraction n’avait rien trouvé \| 1 \|/);
    assert.match(md, /IC 95 %/);
    assert.match(md, /Wilson/);
    assert.match(md, /Âge \| 8 \| 5 \| 2 \| 1 \| 0 \|/);
    // Toutes les variables de la fiche figurent dans le tableau des règles.
    for (const key of ['age', 'sexe', 'crp']) assert.match(md, new RegExp(`\\| ${key} \\|`));
  });

  test('le même rapport en anglais, en HTML autonome, et en JSON', async () => {
    const en = await text(`/api/export/methods?templateId=${templateId}&format=md&lang=en`);
    assert.match(en.body, /^# Data extraction methods and traceability/);
    assert.match(en.body, /were retrospectively extracted from 10 documents/);
    assert.match(en.body, /95% CI/);

    const html = await text(`/api/export/methods?templateId=${templateId}&format=html&lang=fr`);
    assert.match(html.headers.get('content-type') ?? '', /text\/html/);
    assert.match(html.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(html.body, /^<!doctype html>/);
    assert.match(html.body, /<html lang="fr">/);
    assert.doesNotMatch(html.body, /<script|src=|href=/i, 'page autonome : ni script ni ressource extérieure');

    const json = await text(`/api/export/methods?templateId=${templateId}&format=json`);
    const data = JSON.parse(json.body);
    assert.equal(data.corpus.patients, 10);
    assert.equal(data.quality.overall.confirmed, 8);
    assert.match(data.template.fingerprint, /^[0-9a-f]{64}$/);
    assert.ok(data.runs.length >= 1);
    assert.ok(data.audit.events > 0);
  });

  test('un texte inséré dans la fiche ne sort pas du rapport HTML', async () => {
    const created = await api('POST', '/api/templates', { name: 'Fiche <img src=x onerror=alert(1)> & "guillemets"' });
    const tid = created.data.template.id;
    const html = await text(`/api/export/methods?templateId=${tid}&format=html`);
    assert.doesNotMatch(html.body, /<img src=x/);
    assert.match(html.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
    const md = await text(`/api/export/methods?templateId=${tid}&format=md`);
    assert.equal(md.status, 200);
  });

  test('le journal d’audit s’exporte dans l’ordre, avec valeur d’avant et d’après', async () => {
    const r = await text(`/api/export/audit.csv?templateId=${templateId}`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/csv/);
    const lines = r.body.replace(/^﻿/, '').trim().split('\r\n');
    assert.equal(lines[0], 'evenement;horodatage;dossier;variable;libelle;action;valeur_avant;origine_avant;valeur_apres;origine_apres;passe');
    const rows = lines.slice(1).map((l) => l.split(';'));
    const ids = rows.map((c) => Number(c[0]));
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), 'ordre chronologique');

    const story = rows.filter((c) => c[2] === 'TRACE-07' && c[3] === 'age').map((c) => `${c[5]}:${c[6]}>${c[8]}`);
    assert.deepEqual(story, ['extract:>37', 'edit:37>99']);

    const cleared = rows.filter((c) => c[2] === 'TRACE-09' && c[3] === 'age').map((c) => c[5]);
    assert.deepEqual(cleared, ['extract', 'clear']);
  });

  test('la fiabilité d’une fiche sans relecture n’est pas inventée', async () => {
    const created = await api('POST', '/api/templates', { name: 'Fiche vide' });
    const q = (await api('GET', `/api/analytics/quality?templateId=${created.data.template.id}`)).data.quality;
    assert.equal(q.overall.reviewed, 0);
    assert.equal(q.overall.agreement, null);
    const md = (await text(`/api/export/methods?templateId=${created.data.template.id}&format=md`)).body;
    assert.match(md, /Aucune valeur n’avait encore été relue/);
    assert.match(md, /Aucune passe d’extraction n’a été lancée/);
  });
});

describe('rapport : une fiche aux nombreuses passes', () => {
  test('le nombre de passes, leurs dates, leurs modes et leurs modèles portent sur TOUTES les passes, pas seulement les 25 dernières', async () => {
    const { startRun, finishRun } = await import('../src/repo/runs.js');
    const { getTemplate } = await import('../src/repo/templates.js');
    const templates = (await api('GET', '/api/templates')).data as { active: { id: number } };
    const template = getTemplate(templates.active.id)!;
    const totals = { patients: 1, documents: 1, extracted: 1, notFound: 0, keptManual: 0, rejected: 0 };
    const before = ((await api('GET', `/api/export/methods?templateId=${template.id}&format=json`)).data as { runSummary: { total: number } }).runSummary.total;

    // Une passe par modèle de langage, puis vingt-neuf passes de règles : la plus ancienne sort des 25 détaillées.
    const old = startRun({ template, mode: 'llm', model: 'claude-essai-1', overwriteManual: false });
    finishRun(old, 'done', totals);
    for (let i = 0; i < 29; i++) finishRun(startRun({ template, mode: 'rules', overwriteManual: false }), 'done', totals);

    const report = (await api('GET', `/api/export/methods?templateId=${template.id}&format=json`)).data as {
      runs: { id: number }[];
      runSummary: { total: number; first: string; last: string; modes: string[]; models: string[] };
      llm: { used: boolean; models: string[] };
    };
    assert.equal(report.runs.length, 25, 'le détail est limité aux 25 plus récentes');
    assert.equal(report.runSummary.total, before + 30);
    assert.ok(!report.runs.some((r) => r.id === old), 'la passe par modèle de langage n’est plus dans le détail');
    assert.deepEqual(report.runSummary.modes, ['llm', 'rules']);
    assert.deepEqual(report.runSummary.models, ['claude-essai-1']);
    assert.ok(report.runSummary.first <= report.runSummary.last);

    const md = (await text(`/api/export/methods?templateId=${template.id}&format=md&lang=fr`)).body;
    assert.match(md, new RegExp(`${before + 30} passe\\(s\\) enregistrée\\(s\\)`));
    assert.match(md, /Les 25 plus récentes sont détaillées ci-dessous\./);
    assert.match(md, /modèle de langage \(claude-essai-1\)/, 'le paragraphe « Méthodes » déclare le modèle, même ancien');
    const en = (await text(`/api/export/methods?templateId=${template.id}&format=md&lang=en`)).body;
    assert.match(en, /The 25 most recent are detailed below\./);
    assert.match(en, /a language model \(claude-essai-1\)/);
  });

  test('le journal est décrit tel qu’il est : aucune fonction ne le modifie, mais il disparaît avec son dossier', async () => {
    const md = (await text(`/api/export/methods?format=md&lang=fr`)).body;
    assert.match(md, /qu’aucune fonction de l’outil ne modifie/);
    assert.doesNotMatch(md, /jamais modifiés ni supprimés/);
    // Et c'est vrai : supprimer un dossier supprime ses événements.
    const { db } = await import('../src/db/index.js');
    const created = (await api('POST', '/api/patients', { code: 'CASCADE-001' })).data as { patient: { id: number } };
    const active = ((await api('GET', '/api/templates')).data as { active: { id: number; fields: { id: number }[] } }).active;
    const form = new FormData();
    form.append('files', new Blob(['Âge : 41 ans']), 'cr.txt');
    assert.equal((await fetch(`${baseUrl}/api/patients/${created.patient.id}/documents`, { method: 'POST', body: form })).status, 201);
    assert.equal((await api('POST', '/api/records/extraction/run', { patientIds: [created.patient.id] })).status, 200);
    const count = () =>
      (db.prepare('SELECT COUNT(*) AS n FROM value_events e JOIN records r ON r.id = e.record_id WHERE r.patient_id = ?').get(created.patient.id) as { n: number }).n;
    assert.ok(count() > 0, 'la passe a consigné au moins un événement');
    assert.equal((await api('DELETE', `/api/patients/${created.patient.id}`)).status, 204);
    const left = (db.prepare('SELECT COUNT(*) AS n FROM value_events WHERE record_id NOT IN (SELECT id FROM records)').get() as { n: number }).n;
    assert.equal(left, 0, 'aucun événement orphelin : ils partent avec le dossier');
    assert.ok(active.id > 0);
  });
});

describe('rendu des blocs', () => {
  test('les barres verticales d’une cellule ne cassent pas le tableau Markdown', () => {
    const md = renderMarkdown([{ type: 'table', head: ['a', 'b'], rows: [['x | y', 'z\nsuite']] }]);
    assert.match(md, /\| x \\\| y \| z suite \|/);
  });

  test('le HTML échappe tout ce qui vient de l’utilisateur', () => {
    const html = renderHtml([{ type: 'p', text: '<script>alert(1)</script>' }], { lang: 'fr', title: '"><script>' });
    assert.doesNotMatch(html, /<script>/);
  });
});
