/**
 * Relecture : ce qu'un humain décide d'une valeur extraite, et ce que l'outil en garde.
 *
 * - une saisie est contrôlée sans être « corrigée » en douce (12,5 n'est pas un entier) ;
 * - une valeur hors bornes se signale et se confirme, elle ne passe pas en silence ;
 * - vider une valeur est une décision : elle survit à l'extraction suivante ;
 * - confirmer garde la justification, rendre la main autorise l'extraction à rejouer ;
 * - chaque changement est inscrit au journal, chaque passe porte l'empreinte de la fiche ;
 * - le schéma de la base évolue d'une version à l'autre sans rien perdre.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-review-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { SCHEMA } = await import('../src/db/schema.js');
const { migrate, LATEST_VERSION, currentVersion } = await import('../src/db/migrations.js');

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

async function patientWithReport(code: string, text: string): Promise<number> {
  const { data } = await api('POST', '/api/patients', { code });
  const id: number = data.patient.id;
  const form = new FormData();
  form.append('files', new Blob([text]), 'cr.txt');
  const res = await fetch(`${baseUrl}/api/patients/${id}/documents`, { method: 'POST', body: form });
  assert.equal(res.status, 201);
  return id;
}

interface Loaded {
  templateId: number;
  field: (key: string) => { id: number; key: string };
  value: (key: string) => any;
}

async function load(patientId: number): Promise<Loaded> {
  const { data } = await api('GET', `/api/records?patientId=${patientId}`);
  const byKey = new Map<string, { id: number; key: string }>(data.template.fields.map((f: any) => [f.key, f]));
  return {
    templateId: data.template.id,
    field: (key) => {
      const f = byKey.get(key);
      assert.ok(f, `variable ${key} absente`);
      return f;
    },
    value: (key) => data.record.values.find((v: any) => v.fieldId === byKey.get(key)?.id),
  };
}

const put = (templateId: number, patientId: number, values: unknown[], extra: object = {}) =>
  api('PUT', `/api/records/${templateId}/${patientId}/values`, { values, ...extra });

const extract = (patientId: number, extra: object = {}) =>
  api('POST', '/api/records/extraction/run', { patientIds: [patientId], ...extra });

describe('saisie : contrôle sans correction silencieuse', () => {
  let patientId: number;
  let templateId: number;
  let ageId: number;
  let tempId: number;
  let dateId: number;

  before(async () => {
    patientId = await patientWithReport('SAISIE-1', 'Âge : 61 ans\nSexe : Féminin\nTempérature : 37,8 °C');
    await extract(patientId);
    const l = await load(patientId);
    templateId = l.templateId;
    ageId = l.field('age').id;
    tempId = l.field('temperature').id;
    dateId = l.field('date_admission').id;
  });

  test('un entier à virgule est refusé, pas arrondi', async () => {
    const r = await put(templateId, patientId, [{ fieldId: ageId, value: 12.5 }]);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /entier/);
    const again = await load(patientId);
    assert.equal(again.value('age').value, 61, 'la valeur existante ne doit pas avoir bougé');
  });

  test('un nombre s’écrit avec une virgule ou un point, pas en notation scientifique', async () => {
    const withComma = await put(templateId, patientId, [{ fieldId: tempId, value: '38,5' }]);
    assert.equal(withComma.status, 200);
    assert.equal(withComma.data.record.values.find((v: any) => v.fieldId === tempId).value, 38.5);

    for (const bad of ['1e1', '0x20', 'Infinity', '38,5,2', '--3', ' ', 'abc']) {
      const r = await put(templateId, patientId, [{ fieldId: tempId, value: bad }]);
      // « ' ' » équivaut à vide : accepté comme effacement ; les autres sont refusés
      if (bad === ' ') continue;
      assert.equal(r.status, 400, `« ${bad} » aurait dû être refusé`);
    }
  });

  test('un jour qui n’existe pas est refusé', async () => {
    const r = await put(templateId, patientId, [{ fieldId: dateId, value: '2024-02-31' }]);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /calendrier/);
    const ok = await put(templateId, patientId, [{ fieldId: dateId, value: '2024-02-29' }]);
    assert.equal(ok.status, 200);
    const notLeap = await put(templateId, patientId, [{ fieldId: dateId, value: '2023-02-29' }]);
    assert.equal(notLeap.status, 400);
  });

  test('une valeur hors bornes demande confirmation, puis passe', async () => {
    const refused = await put(templateId, patientId, [{ fieldId: ageId, value: 540 }]);
    assert.equal(refused.status, 422);
    assert.equal(refused.data.code, 'out_of_bounds');
    assert.deepEqual(
      refused.data.details.map((d: any) => ({ key: d.key, value: d.value, min: d.min, max: d.max })),
      [{ key: 'age', value: 540, min: 0, max: 120 }],
    );
    assert.equal((await load(patientId)).value('age').value, 61, 'rien n’est enregistré tant que ce n’est pas confirmé');

    const accepted = await put(templateId, patientId, [{ fieldId: ageId, value: 540 }], { acceptOutOfBounds: true });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.record.values.find((v: any) => v.fieldId === ageId).value, 540);
  });

  test('une date avant 1900 ou à plus d’un an d’ici est une faute de frappe probable : à confirmer', async () => {
    for (const typo of ['0024-03-12', '1066-10-14', '2099-12-31']) {
      const r = await put(templateId, patientId, [{ fieldId: dateId, value: typo }]);
      assert.equal(r.status, 422, typo);
      assert.equal(r.data.code, 'out_of_bounds');
      assert.equal(r.data.details[0].value, typo);
      assert.equal(r.data.details[0].min, '1900-01-01');
      assert.match(r.data.error, /hors des bornes attendues/);
    }
    const next = new Date();
    next.setUTCDate(next.getUTCDate() + 30);
    const plausible = next.toISOString().slice(0, 10); // une admission programmée le mois prochain
    assert.equal((await put(templateId, patientId, [{ fieldId: dateId, value: plausible }])).status, 200);
    assert.equal((await put(templateId, patientId, [{ fieldId: dateId, value: '1950-06-15' }])).status, 200);
    const forced = await put(templateId, patientId, [{ fieldId: dateId, value: '1066-10-14' }], { acceptOutOfBounds: true });
    assert.equal(forced.status, 200);
  });

  test('un lot dont une valeur est hors bornes n’est enregistré qu’en entier ou pas du tout', async () => {
    const r = await put(templateId, patientId, [
      { fieldId: tempId, value: 36.6 },
      { fieldId: ageId, value: -5 },
    ]);
    assert.equal(r.status, 422);
    assert.notEqual((await load(patientId)).value('temperature').value, 36.6);
  });
});

describe('relecture : confirmer, vider, rendre la main', () => {
  let patientId: number;
  let templateId: number;
  let ageId: number;
  let sexeId: number;
  let crpId: number;

  before(async () => {
    patientId = await patientWithReport('RELECTURE-1', 'Âge : 44 ans\nSexe : Masculin\nCRP : 28 mg/L');
    await extract(patientId);
    const l = await load(patientId);
    templateId = l.templateId;
    ageId = l.field('age').id;
    sexeId = l.field('sexe').id;
    crpId = l.field('crp').id;
  });

  test('confirmer une valeur la garde telle quelle, avec sa justification et son origine', async () => {
    const before = (await load(patientId)).value('age');
    assert.equal(before.source, 'auto');
    assert.ok(before.evidence?.snippet);

    const r = await put(templateId, patientId, [{ fieldId: ageId, mode: 'confirm' }]);
    assert.equal(r.status, 200);
    const v = r.data.record.values.find((x: any) => x.fieldId === ageId);
    assert.equal(v.value, 44);
    assert.equal(v.source, 'manual');
    assert.deepEqual(v.origin, { source: 'auto', value: 44 });
    assert.ok(v.reviewedAt);
    assert.equal(v.evidence.snippet, before.evidence.snippet, 'la justification reste consultable');
  });

  test('on ne confirme pas une variable sans valeur', async () => {
    const l = await load(patientId);
    const empty = l.field('motif_consultation');
    const r = await put(templateId, patientId, [{ fieldId: empty.id, mode: 'confirm' }]);
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Rien à confirmer/);
  });

  test('corriger garde la proposition de la machine à côté de la valeur retenue', async () => {
    const r = await put(templateId, patientId, [{ fieldId: crpId, value: 82 }]);
    const v = r.data.record.values.find((x: any) => x.fieldId === crpId);
    assert.equal(v.value, 82);
    assert.deepEqual(v.origin, { source: 'auto', value: 28 });

    // Une seconde correction ne fait pas oublier ce que la machine avait proposé.
    const again = await put(templateId, patientId, [{ fieldId: crpId, value: 90 }]);
    const w = again.data.record.values.find((x: any) => x.fieldId === crpId);
    assert.equal(w.value, 90);
    assert.deepEqual(w.origin, { source: 'auto', value: 28 });
  });

  test('vider une valeur est une décision : l’extraction suivante ne la ramène pas', async () => {
    const r = await put(templateId, patientId, [{ fieldId: sexeId, value: null }]);
    const v = r.data.record.values.find((x: any) => x.fieldId === sexeId);
    assert.equal(v.source, 'manual');
    assert.equal(v.value, null);
    assert.deepEqual(v.origin, { source: 'auto', value: 'Masculin' });

    const run = await extract(patientId);
    assert.equal(run.status, 200);
    const after = (await load(patientId)).value('sexe');
    assert.equal(after.source, 'manual', 'la valeur écartée par le relecteur est revenue');
    assert.equal(after.value, null);
  });

  test('rendre la main autorise l’extraction à remplir de nouveau la variable', async () => {
    const released = await put(templateId, patientId, [{ fieldId: sexeId, mode: 'release' }]);
    const v = released.data.record.values.find((x: any) => x.fieldId === sexeId);
    assert.equal(v.source, 'empty');
    assert.equal(v.origin, null);

    await extract(patientId);
    const refilled = (await load(patientId)).value('sexe');
    assert.equal(refilled.source, 'auto');
    assert.equal(refilled.value, 'Masculin');
  });

  test('le journal raconte ce qui s’est passé, dans l’ordre', async () => {
    const { data } = await api('GET', `/api/records/${templateId}/${patientId}/history?fieldId=${sexeId}`);
    const story = data.events
      .slice()
      .reverse()
      .map((e: any) => `${e.action}:${e.oldSource ?? '-'}>${e.newSource ?? '-'}`);
    assert.deepEqual(story, ['extract:->auto', 'clear:auto>manual', 'release:manual>empty', 'extract:empty>auto']);
  });
});

describe('journal des passes d’extraction', () => {
  test('chaque passe consigne l’empreinte de la fiche, le mode, la version et les totaux', async () => {
    const patientId = await patientWithReport('PASSES-1', 'Âge : 30 ans');
    const first = await extract(patientId);
    assert.equal(first.status, 200);
    assert.ok(first.data.runId > 0);
    const second = await extract(patientId);

    const { data } = await api('GET', '/api/records/runs');
    const a = data.runs.find((r: any) => r.id === first.data.runId);
    const b = data.runs.find((r: any) => r.id === second.data.runId);
    assert.ok(a && b);
    assert.match(a.templateFingerprint, /^[0-9a-f]{64}$/);
    assert.equal(a.templateFingerprint, b.templateFingerprint, 'même fiche, même empreinte');
    assert.equal(a.mode, 'rules');
    assert.equal(a.model, null);
    assert.equal(a.status, 'done');
    assert.equal(a.patients, 1);
    assert.equal(a.documents, 1);
    assert.ok(a.extracted >= 1);
    assert.match(a.appVersion, /^\d+\.\d+\.\d+/);
    assert.ok(a.finishedAt);
  });

  test('modifier une règle change l’empreinte ; modifier la description ne la change pas', async () => {
    const patientId = await patientWithReport('PASSES-2', 'Âge : 30 ans');
    const l = await load(patientId);
    const before = await extract(patientId);

    const { data: tpl } = await api('GET', `/api/templates/${l.templateId}`);
    const age = tpl.template.fields.find((f: any) => f.key === 'age');

    const described = await api('PATCH', `/api/templates/fields/${age.id}`, { description: 'Âge à l’admission, en années' });
    assert.equal(described.status, 200);
    const sameFingerprint = await extract(patientId);

    const relabelled = await api('PATCH', `/api/templates/fields/${age.id}`, { label: 'Âge au diagnostic' });
    assert.equal(relabelled.status, 200);
    const changed = await extract(patientId);

    const { data } = await api('GET', '/api/records/runs');
    const fingerprint = (id: number) => data.runs.find((r: any) => r.id === id).templateFingerprint;
    assert.equal(fingerprint(before.data.runId), fingerprint(sameFingerprint.data.runId));
    assert.notEqual(fingerprint(before.data.runId), fingerprint(changed.data.runId));
  });

  test('une passe identique ne réécrit rien : le journal des valeurs reste muet', async () => {
    const patientId = await patientWithReport('PASSES-3', 'Âge : 52 ans\nSexe : Féminin');
    await extract(patientId);
    const l = await load(patientId);
    const countBefore = (await api('GET', `/api/records/${l.templateId}/${patientId}/history`)).data.events.length;
    await extract(patientId);
    await extract(patientId);
    const countAfter = (await api('GET', `/api/records/${l.templateId}/${patientId}/history`)).data.events.length;
    assert.equal(countAfter, countBefore);
  });

  test('une variable qui n’est plus trouvée perd sa valeur automatique, et le journal le dit', async () => {
    const patientId = await patientWithReport('PASSES-4', 'Âge : 52 ans');
    await extract(patientId);
    const l = await load(patientId);
    assert.equal(l.value('age').value, 52);

    // Le document est remplacé par un autre qui ne donne plus l'âge.
    const { data } = await api('GET', `/api/patients/${patientId}`);
    await api('DELETE', `/api/documents/${data.documents[0].id}`);
    const form = new FormData();
    form.append('files', new Blob(['Compte rendu sans âge.']), 'autre.txt');
    await fetch(`${baseUrl}/api/patients/${patientId}/documents`, { method: 'POST', body: form });
    await extract(patientId);

    assert.equal((await load(patientId)).value('age'), undefined);
    const history = (await api('GET', `/api/records/${l.templateId}/${patientId}/history?fieldId=${l.field('age').id}`)).data.events;
    assert.equal(history[0].action, 'unset');
    assert.equal(history[0].oldValue, 52);
  });
});

describe('évolution du schéma de la base', () => {
  const legacy = (): DatabaseSync => {
    const connection = new DatabaseSync(':memory:');
    connection.exec('PRAGMA foreign_keys = ON');
    connection.exec(SCHEMA);
    return connection;
  };

  test('une base d’une version antérieure monte seule, sans perdre ses lignes', () => {
    const connection = legacy();
    connection.exec(`
      INSERT INTO patients (code, created_at, updated_at) VALUES ('P1', 't', 't');
      INSERT INTO templates (name, created_at, updated_at) VALUES ('T', 't', 't');
      INSERT INTO fields (template_id, key, label, type) VALUES (1, 'age', 'Âge', 'integer');
      INSERT INTO records (template_id, patient_id, created_at, updated_at) VALUES (1, 1, 't', 't');
      INSERT INTO record_values (record_id, field_id, value, source, updated_at) VALUES (1, 1, '52', 'manual', 't');
    `);
    assert.equal(currentVersion(connection), 0);

    const result = migrate(connection);
    assert.deepEqual(result, { from: 0, to: LATEST_VERSION });
    assert.equal(currentVersion(connection), LATEST_VERSION);

    const columns = (connection.prepare('PRAGMA table_info(record_values)').all() as { name: string }[]).map((c) => c.name);
    for (const c of ['origin_source', 'origin_value', 'reviewed_at']) assert.ok(columns.includes(c), `colonne ${c} absente`);
    const row = connection.prepare('SELECT value, source, origin_source FROM record_values').get() as any;
    assert.deepEqual({ ...row }, { value: '52', source: 'manual', origin_source: null });
    connection.prepare('INSERT INTO extraction_runs (template_name, template_fingerprint, mode, app_version, started_at) VALUES (?,?,?,?,?)').run('T', 'f', 'rules', '1.0.0', 't');
    connection.close();
  });

  test('relancer les migrations ne change rien', () => {
    const connection = legacy();
    migrate(connection);
    assert.deepEqual(migrate(connection), { from: LATEST_VERSION, to: LATEST_VERSION });
    connection.close();
  });

  test('une base plus récente que l’outil est refusée plutôt qu’abîmée', () => {
    const connection = legacy();
    connection.exec(`PRAGMA user_version = ${LATEST_VERSION + 5}`);
    assert.throws(() => migrate(connection), /plus récente/);
    connection.close();
  });

  test('une migration qui échoue est annulée en bloc', () => {
    const connection = legacy();
    connection.exec('CREATE TABLE extraction_runs (id INTEGER PRIMARY KEY, junk TEXT)'); // collision : l'index sur run_id échouera plus loin
    connection.exec('CREATE TABLE value_events (id INTEGER PRIMARY KEY)');
    assert.throws(() => migrate(connection), /Mise à jour de la base impossible/);
    assert.equal(currentVersion(connection), 0, 'la version ne doit pas avoir avancé');
    const columns = (connection.prepare('PRAGMA table_info(record_values)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(!columns.includes('origin_source'), 'les colonnes ajoutées doivent être annulées avec le reste');
    connection.close();
  });
});

describe('import d’une fiche : tout ou rien', () => {
  const field = (key: string, extra: object = {}) => ({ key, label: key, type: 'text', extraction: { enabled: false, rules: [] }, ...extra });
  const templateCount = async (): Promise<number> => (await api('GET', '/api/templates')).data.templates.length;

  test('deux variables de même clé : refus net, aucune fiche créée', async () => {
    const before = await templateCount();
    const r = await api('POST', '/api/templates/import', { name: 'Doublons', fields: [field('age'), field('sexe'), field('age')] });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /clé « age »/);
    assert.equal(await templateCount(), before, 'aucune fiche amputée dans la liste');
  });

  test('une variable à choix sans option, en fin de fiche : rien n’est créé non plus', async () => {
    const before = await templateCount();
    const r = await api('POST', '/api/templates/import', { name: 'Choix', fields: [field('a'), field('b'), field('c', { type: 'enum' })] });
    assert.equal(r.status, 400);
    assert.equal(await templateCount(), before);
  });

  test('une fiche valide est créée en entier', async () => {
    const before = await templateCount();
    const r = await api('POST', '/api/templates/import', { name: 'Valide', fields: [field('a'), field('b')] });
    assert.equal(r.status, 201);
    assert.equal(r.data.template.fields.length, 2);
    assert.equal(await templateCount(), before + 1);
  });
});

describe('messages de validation en français', () => {
  test('un code trop long, un corps incomplet, un type faux : tout est dit en français', async () => {
    const tooLong = await api('POST', '/api/patients', { code: 'x'.repeat(81) });
    assert.equal(tooLong.status, 400);
    assert.match(JSON.stringify(tooLong.data.details), /80 caractères/);
    assert.doesNotMatch(JSON.stringify(tooLong.data), /String must|character\(s\)/);

    const missing = await api('POST', '/api/patients', {});
    assert.match(JSON.stringify(missing.data.details), /Champ requis/);

    const wrongType = await api('POST', '/api/patients', { code: 12 });
    assert.match(JSON.stringify(wrongType.data.details), /Attendu : un texte\. Reçu : un nombre/);

    const badEnum = await api('POST', '/api/templates/1/fields', { key: 'z', label: 'Z', type: 'inconnu' });
    assert.match(JSON.stringify(badEnum.data.details), /Valeur non reconnue/);
    assert.doesNotMatch(JSON.stringify(badEnum.data), /Invalid enum/);
  });
});
