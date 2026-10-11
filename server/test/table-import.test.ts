/**
 * Import d'un tableau de cohorte, de bout en bout par l'API : réception, colonnes et propositions, simulation,
 * écriture — et ce que l'écriture ne doit jamais faire (écraser une décision de relecteur, se faire défaire par une
 * passe d'extraction, passer pour une valeur relue dans les mesures de fiabilité).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-table-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { makeXlsx } = await import('../src/lib/xlsx.js');
const { db } = await import('../src/db/index.js');
const { purgeStaleImportDrafts } = await import('../src/repo/imports.js');

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
  const { shutdownParsers } = await import('../src/extract/isolation.js');
  await shutdownParsers();
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

async function uploadTable(buffer: Buffer, name: string): Promise<{ status: number; data: any }> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buffer)]), name);
  const res = await fetch(`${baseUrl}/api/table-imports`, { method: 'POST', body: form });
  return { status: res.status, data: await res.json() };
}

async function uploadDocument(patientId: number, buffer: Buffer, name: string): Promise<any> {
  const form = new FormData();
  form.append('files', new Blob([new Uint8Array(buffer)], { type: 'text/plain' }), name);
  const res = await fetch(`${baseUrl}/api/patients/${patientId}/documents`, { method: 'POST', body: form });
  return res.json();
}

let template: { id: number; fields: { id: number; key: string; label: string }[] };
const fieldId = (key: string) => template.fields.find((f) => f.key === key)!.id;

/** Cohorte de trente patients, telle qu'une équipe la tient : un titre, une ligne vide, puis le tableau. */
function cohortWorkbook(): Buffer {
  const rows: (string | number | boolean | null)[][] = [];
  for (let i = 1; i <= 30; i++) {
    rows.push([
      `COH-${String(i).padStart(3, '0')}`,
      40 + i,
      i % 2 ? 'F' : 'Masculin',
      i === 7 ? '< 5' : Number((i * 1.5).toFixed(1)),
      `2024-0${(i % 9) + 1}-1${i % 10}`,
      i % 3 === 0 ? 'oui' : 'non',
      i === 12 ? 'Inconnu' : 'Favorable',
      `note ${i}`,
    ]);
  }
  rows[29]![1] = 130; // hors des bornes de l'âge (0–120)
  return makeXlsx([
    {
      name: 'Inclusions',
      columns: [
        { header: 'Code patient' },
        { header: 'Âge (ans)', type: 'number' },
        { header: 'Sexe' },
        { header: 'CRP (mg/L)', type: 'number' },
        { header: "Date d'admission", type: 'date' },
        { header: 'Diabète' },
        { header: 'Évolution' },
        { header: 'Commentaire' },
      ],
      rows,
    },
    { name: 'Notes', columns: [{ header: 'Remarque' }], rows: [['Feuille sans données de patients']] },
  ]);
}

describe('import d’un tableau de cohorte', () => {
  let importId: number;
  let body: Record<string, unknown>;
  let manualPatientId: number;

  before(async () => {
    template = (await api('GET', '/api/templates')).data.active;
    // Un dossier existe déjà, avec une valeur relue (saisie à la main) et une valeur extraite par une règle.
    manualPatientId = (await api('POST', '/api/patients', { code: 'coh-003' })).data.patient.id;
    await uploadDocument(manualPatientId, Buffer.from('Diabète : oui\nÉvolution : Défavorable'), 'cr.txt');
    await api('POST', '/api/records/extraction/run', { templateId: template.id, patientIds: [manualPatientId] });
    await api('PUT', `/api/records/${template.id}/${manualPatientId}/values`, { values: [{ fieldId: fieldId('age'), value: 99, mode: 'set' }] });
  });

  test('réception : fichier conservé, feuilles décrites, ligne d’en-tête proposée', async () => {
    const r = await uploadTable(cohortWorkbook(), 'cohorte 2024.xlsx');
    assert.equal(r.status, 201, JSON.stringify(r.data));
    importId = r.data.import.id;
    assert.equal(r.data.import.status, 'draft');
    assert.equal(r.data.import.format, 'xlsx');
    assert.match(r.data.import.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.data.workbook.sheets.map((s: any) => s.name), ['Inclusions', 'Notes']);
    assert.equal(r.data.workbook.sheets[0].rows, 31);
    assert.equal(r.data.workbook.sheets[0].suggestedHeaderRow, 1);
    assert.equal(r.data.workbook.sheets[0].preview[1][0], 'COH-001');
    assert.deepEqual(r.data.previousImports, []);
    const stored = fs.readdirSync(path.join(tmpDir, 'uploads', 'imports'));
    assert.equal(stored.length, 1, 'le fichier est conservé');
    assert.deepEqual(fs.readdirSync(path.join(tmpDir, 'uploads', '.incoming')), [], 'rien ne reste dans le dépôt provisoire');
    const { parserStats } = await import('../src/extract/isolation.js');
    assert.ok((parserStats()?.served ?? 0) >= 1, 'le classeur a été lu dans un fil d’analyse isolé');
  });

  test('colonnes : codes reconnus, correspondances proposées, commentaire laissé de côté', async () => {
    const r = await api('POST', `/api/table-imports/${importId}/columns`, { sheet: 'Inclusions', headerRow: 1 });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.dataRows, 30);
    assert.equal(r.data.suggestion.codeColumn, 0);
    const mapped = Object.fromEntries(r.data.suggestion.mapping.map((m: any) => [m.column, m.fieldId]));
    assert.deepEqual(mapped, { 1: fieldId('age'), 2: fieldId('sexe'), 3: fieldId('crp'), 4: fieldId('date_admission'), 5: fieldId('diabete'), 6: fieldId('evolution') });
    body = { sheet: 'Inclusions', headerRow: 1, codeColumn: 0, mapping: r.data.suggestion.mapping.map((m: any) => ({ column: m.column, fieldId: m.fieldId })) };
  });

  test('simulation : dossiers créés ou existants, valeurs refusées avec leur motif, conflits gardés — rien n’est écrit', async () => {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM record_values').get() as { n: number }).n;
    const r = await api('POST', `/api/table-imports/${importId}/dry-run`, body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const report = r.data.report;
    assert.equal(report.dataRows, 30);
    assert.deepEqual(report.rows, { used: 30, empty: 0, skipped: 0 });
    assert.equal(report.patients.created, 29);
    assert.equal(report.patients.existing, 1, '« coh-003 » est le dossier « COH-003 » (les majuscules ne comptent pas)');
    const reasons = report.rejected.map((x: any) => `${x.cell}:${x.reason}`);
    assert.ok(reasons.some((x: string) => /^D8:valeur seuil/.test(x)), reasons.join('\n'));
    assert.ok(reasons.some((x: string) => /^B31:valeur 130 au-dessus du maximum 120/.test(x)), reasons.join('\n'));
    assert.ok(reasons.some((x: string) => /^G13:« Inconnu » ne correspond à aucune option/.test(x)), reasons.join('\n'));
    assert.equal(report.values.rejected, 3);
    // COH-003 : âge saisi à la main (99 ≠ 43), diabète extrait (« oui » = oui : inchangé), évolution extraite (Défavorable ≠ Favorable).
    const conflicts = report.conflicts.map((c: any) => `${c.code}/${c.cell}/${c.currentSource}/${c.resolution}`).sort();
    assert.deepEqual(conflicts, ['COH-003/B4/manual/kept', 'COH-003/G4/auto/kept']);
    assert.equal(report.values.conflicts, 2);
    assert.equal(report.values.unchanged, 1);
    assert.equal(report.values.write, 30 * 6 - 3 - 2 - 1);
    assert.match(report.planHash, /^[0-9a-f]{32}$/);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM record_values').get() as { n: number }).n;
    assert.equal(after, before, 'la simulation n’écrit rien');
    assert.equal((await api('GET', '/api/patients')).data.patients.length, 1, 'aucun dossier créé');
    body = { ...body, expectedPlan: report.planHash };
  });

  test('erreurs de saisie de l’appel : messages clairs, rien n’est écrit', async () => {
    const twice = await api('POST', `/api/table-imports/${importId}/dry-run`, { ...body, mapping: [{ column: 1, fieldId: fieldId('age') }, { column: 2, fieldId: fieldId('age') }] });
    assert.equal(twice.status, 400);
    assert.match(twice.data.error, /associée à deux colonnes/);
    const header = await api('POST', `/api/table-imports/${importId}/dry-run`, { ...body, headerRow: 99 });
    assert.equal(header.status, 400);
    assert.match(header.data.error, /hors du tableau/);
    const unknownField = await api('POST', `/api/table-imports/${importId}/dry-run`, { ...body, mapping: [{ column: 1, fieldId: 999_999 }] });
    assert.equal(unknownField.status, 400);
    assert.match(unknownField.data.error, /absente de la fiche/);
    const sheet = await api('POST', `/api/table-imports/${importId}/columns`, { sheet: 'Inexistante', headerRow: 1 });
    assert.equal(sheet.status, 400);
    const none = await api('POST', `/api/table-imports/${importId}/dry-run`, { ...body, mapping: [] });
    assert.equal(none.status, 400);
    assert.match(none.data.error, /au moins une colonne/);
    const invalid = await api('POST', `/api/table-imports/${importId}/dry-run`, { ...body, headerRow: 'un' });
    assert.equal(invalid.status, 400);
    assert.equal((await api('POST', '/api/table-imports/999999/dry-run', body)).status, 404);
  });

  test('écriture refusée si l’état a changé depuis la simulation', async () => {
    const r = await api('POST', `/api/table-imports/${importId}/commit`, { ...body, expectedPlan: '0'.repeat(32) });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /relancez la simulation/);
    assert.equal((await api('GET', '/api/patients')).data.patients.length, 1);
  });

  test('écriture : source « import », cellule citée, journal rattaché à l’import, décision du relecteur intacte', async () => {
    const r = await api('POST', `/api/table-imports/${importId}/commit`, body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.import.status, 'done');
    assert.equal(r.data.import.written, 30 * 6 - 6);
    assert.equal(r.data.import.patientsCreated, 29);
    assert.equal(r.data.import.sheet, 'Inclusions');

    const patients = (await api('GET', '/api/patients')).data.patients;
    assert.equal(patients.length, 30);
    const p12 = patients.find((p: any) => p.code === 'COH-012');
    const record = (await api('GET', `/api/records?patientId=${p12.id}`)).data.record;
    const age = record.values.find((v: any) => v.fieldId === fieldId('age'));
    assert.equal(age.value, 52);
    assert.equal(age.source, 'import');
    assert.equal(age.confidence, null);
    assert.deepEqual(age.evidence, {
      kind: 'import',
      importId,
      fileName: 'cohorte 2024.xlsx',
      sha256: r.data.import.sha256,
      sheet: 'Inclusions',
      cell: 'B13',
      header: 'Âge (ans)',
      raw: '52',
    });
    const date = record.values.find((v: any) => v.fieldId === fieldId('date_admission'));
    assert.equal(date.value, '2024-04-12');
    assert.match(date.evidence.raw, /^2024-04-12 \(date Excel n° \d+\)$/);
    assert.equal(record.values.find((v: any) => v.fieldId === fieldId('sexe')).value, 'Masculin');
    assert.equal(record.values.find((v: any) => v.fieldId === fieldId('diabete')).value, true);
    assert.equal(record.values.find((v: any) => v.fieldId === fieldId('evolution')), undefined, 'valeur refusée : rien n’est écrit');

    const kept = (await api('GET', `/api/records?patientId=${manualPatientId}`)).data.record.values;
    const keptAge = kept.find((v: any) => v.fieldId === fieldId('age'));
    assert.deepEqual([keptAge.value, keptAge.source], [99, 'manual'], 'la saisie du relecteur n’est jamais écrasée par défaut');
    assert.equal(kept.find((v: any) => v.fieldId === fieldId('evolution')).source, 'auto', 'valeur extraite différente : gardée, signalée');

    const events = db.prepare(`SELECT action, new_source, import_id FROM value_events WHERE import_id = ?`).all(importId) as any[];
    assert.equal(events.length, 30 * 6 - 6);
    assert.ok(events.every((e) => e.action === 'import' && e.new_source === 'import'));

    const again = await api('POST', `/api/table-imports/${importId}/commit`, body);
    assert.equal(again.status, 409, 'un import ne s’écrit qu’une fois');
    assert.equal((await api('DELETE', `/api/table-imports/${importId}`)).status, 409, 'un import confirmé ne se supprime pas');
  });

  test('le fichier d’origine se télécharge, avec son nom', async () => {
    const res = await fetch(`${baseUrl}/api/table-imports/${importId}/file`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename\*=UTF-8''cohorte%202024\.xlsx/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), cohortWorkbook());
  });

  test('une passe d’extraction ne retire ni ne remplace une valeur importée', async () => {
    const patients = (await api('GET', '/api/patients')).data.patients;
    const p5 = patients.find((p: any) => p.code === 'COH-005');
    await uploadDocument(p5.id, Buffer.from('Âge : 70 ans\nCRP : 99 mg/L'), 'cr.txt');
    const run = await api('POST', '/api/records/extraction/run', { templateId: template.id });
    assert.equal(run.status, 200);
    const values = (await api('GET', `/api/records?patientId=${p5.id}`)).data.record.values;
    const age = values.find((v: any) => v.fieldId === fieldId('age'));
    assert.deepEqual([age.value, age.source], [45, 'import']);
    const imported = (db.prepare(`SELECT COUNT(*) AS n FROM record_values WHERE source = 'import'`).get() as { n: number }).n;
    assert.equal(imported, 30 * 6 - 6, 'aucune valeur importée retirée par la passe');
  });

  test('un relecteur peut confirmer ou corriger une valeur importée ; la fiabilité de l’extraction n’en est pas changée', async () => {
    const quality = async () => (await api('GET', `/api/analytics/quality?templateId=${template.id}`)).data.quality.overall;
    const before = await quality();
    const p1 = (await api('GET', '/api/patients')).data.patients.find((p: any) => p.code === 'COH-001');
    const confirm = await api('PUT', `/api/records/${template.id}/${p1.id}/values`, { values: [{ fieldId: fieldId('age'), mode: 'confirm' }] });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
    const age = confirm.data.record.values.find((v: any) => v.fieldId === fieldId('age'));
    assert.deepEqual([age.source, age.origin], ['manual', { source: 'import', value: 41 }]);
    await api('PUT', `/api/records/${template.id}/${p1.id}/values`, { values: [{ fieldId: fieldId('crp'), value: 2, mode: 'set' }] });
    const after = await quality();
    assert.deepEqual(
      [after.confirmed, after.corrected, after.added, after.unreviewed],
      [before.confirmed, before.corrected, before.added, before.unreviewed],
      'ni confirmée, ni corrigée, ni ajoutée au sens de la fiabilité de l’extraction',
    );
  });

  test('résultats, complétude et rapport « Méthodes » distinguent les valeurs importées', async () => {
    const completeness = (await api('GET', `/api/analytics/completeness?templateId=${template.id}`)).data.fields;
    const age = completeness.find((f: any) => f.key === 'age');
    assert.equal(age.imported, 27, '30 lignes, moins une hors bornes, la saisie gardée de COH-003 et la confirmation de COH-001');
    const extraction = (await api('GET', `/api/analytics/extraction?templateId=${template.id}`)).data.rows;
    const row = extraction.find((r: any) => r.patientCode === 'COH-010');
    assert.equal(row.bySource.import, 6);
    assert.equal(row.sansJustification, 0, 'une valeur importée est justifiée par sa cellule');

    const md = await (await fetch(`${baseUrl}/api/export/methods?templateId=${template.id}&format=md`)).text();
    assert.match(md, /valeur\(s\) ont été importées de 1 tableau\(x\)/);
    assert.match(md, /« cohorte 2024\.xlsx », feuille « Inclusions », empreinte SHA-256 [0-9a-f]{12}…/);
    assert.match(md, /Tableaux importés/);
    assert.match(md, /Import de tableau \(non relues\)/);
    assert.match(md, /valeurs posées par un import de tableau/);

    const audit = await (await fetch(`${baseUrl}/api/export/audit.csv?templateId=${template.id}`)).text();
    const lines = audit.replace(/^﻿/, '').trim().split('\r\n');
    assert.match(lines[0]!, /;passe;import$/);
    assert.ok(lines.some((l) => l.includes(';import;') && l.endsWith(`;${importId}`)));

    const list = await api('GET', `/api/table-imports?templateId=${template.id}`);
    assert.deepEqual(list.data.imports.map((i: any) => i.id), [importId]);
  });

  test('le même fichier réimporté est signalé ; options d’écrasement explicites', async () => {
    const r = await uploadTable(cohortWorkbook(), 'copie.xlsx');
    assert.equal(r.status, 201);
    assert.equal(r.data.previousImports.length, 1);
    const id = r.data.import.id;
    const plain = (await api('POST', `/api/table-imports/${id}/dry-run`, { ...body, expectedPlan: undefined })).data.report;
    assert.equal(plain.values.write, 0, 'tout est déjà en place');
    assert.equal(plain.patients.created, 0);

    const forced = (
      await api('POST', `/api/table-imports/${id}/dry-run`, { ...body, expectedPlan: undefined, options: { overwriteExtracted: true, overwriteManual: true } })
    ).data.report;
    // COH-003 : âge et évolution ; COH-001 : âge confirmé (inchangé) et CRP corrigée.
    assert.equal(forced.values.replaceManual, 2);
    assert.equal(forced.values.replaceExtracted, 1);
    const committed = await api('POST', `/api/table-imports/${id}/commit`, { ...body, expectedPlan: forced.planHash, options: { overwriteExtracted: true, overwriteManual: true } });
    assert.equal(committed.status, 200);
    const values = (await api('GET', `/api/records?patientId=${manualPatientId}`)).data.record.values;
    assert.deepEqual(
      [values.find((v: any) => v.fieldId === fieldId('age')).value, values.find((v: any) => v.fieldId === fieldId('age')).source],
      [43, 'import'],
    );
  });

  test('brouillon abandonné : supprimé avec son fichier ; brouillons oubliés effacés au démarrage', async () => {
    const r = await uploadTable(Buffer.from('Code;Âge\nX1;30\n'), 'brouillon.csv');
    assert.equal(r.status, 201);
    const count = () => fs.readdirSync(path.join(tmpDir, 'uploads', 'imports')).length;
    const before = count();
    assert.equal((await api('DELETE', `/api/table-imports/${r.data.import.id}`)).status, 204);
    assert.equal(count(), before - 1);
    assert.equal((await api('GET', `/api/table-imports/${r.data.import.id}`)).status, 404);

    const stale = await uploadTable(Buffer.from('Code;Âge\nX2;30\n'), 'oublié.csv');
    db.prepare(`UPDATE table_imports SET created_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`).run(stale.data.import.id);
    assert.equal(purgeStaleImportDrafts(), 1);
    assert.equal(count(), before - 1);
  });
});

describe('import d’un CSV', () => {
  test('séparateur, encodage Windows-1252, lignes sans code, codes en double, dossiers inconnus', async () => {
    const csv = Buffer.from(
      'Code;Âge;CRP (g/L);Sexe\r\n' +
        'CSV-1;30;1,2;F\r\n' +
        ';31;;\r\n' + // pas de code
        'CSV-2;32;;M\r\n' +
        'csv-2;33;;F\r\n' + // doublon (les majuscules ne comptent pas)
        ';;;\r\n' + // ligne vide
        '"  CSV-3 ";34;;Féminin\r\n', // espaces autour du code : retirées, comme pour un nom de dossier
      'latin1',
    );
    const up = await uploadTable(csv, 'cohorte.csv');
    assert.equal(up.status, 201, JSON.stringify(up.data));
    assert.equal(up.data.workbook.charset, 'windows-1252');
    assert.equal(up.data.workbook.delimiter, ';');
    const id = up.data.import.id;
    const cols = (await api('POST', `/api/table-imports/${id}/columns`, { headerRow: 1 })).data;
    assert.equal(cols.columns[1].text, 'Âge');
    const crp = cols.suggestion.mapping.find((m: any) => m.column === 2);
    assert.match(crp.unitWarning, /« g\/L ».*« mg\/L »/);

    const mapping = cols.suggestion.mapping.map((m: any) => ({ column: m.column, fieldId: m.fieldId }));
    const report = (await api('POST', `/api/table-imports/${id}/dry-run`, { headerRow: 1, codeColumn: 0, mapping, options: { createPatients: false } })).data.report;
    assert.deepEqual(report.rows, { used: 0, empty: 1, skipped: 5 });
    const issues = report.rowIssues.map((i: any) => `${i.row}:${i.reason}`);
    assert.ok(issues.some((i: string) => /^3:pas de code dossier/.test(i)), issues.join('\n'));
    assert.ok(issues.some((i: string) => /^4:code présent sur plusieurs lignes \(4, 5\)/.test(i)), issues.join('\n'));
    assert.ok(issues.some((i: string) => /^2:aucun dossier de ce code \(création de dossiers désactivée\)/.test(i)), issues.join('\n'));

    const created = (await api('POST', `/api/table-imports/${id}/dry-run`, { headerRow: 1, codeColumn: 0, mapping })).data.report;
    assert.deepEqual(created.patients.createdCodes, ['CSV-1', 'CSV-3']);
    const unit = created.rejected.find((x: any) => x.cell === 'C2');
    assert.match(unit.reason, /unité « g\/L » différente de « mg\/L »/);
    assert.equal(unit.raw, '1,2');
    const commit = await api('POST', `/api/table-imports/${id}/commit`, { headerRow: 1, codeColumn: 0, mapping, expectedPlan: created.planHash });
    assert.equal(commit.status, 200);
    const p3 = (await api('GET', '/api/patients')).data.patients.find((p: any) => p.code === 'CSV-3');
    const values = (await api('GET', `/api/records?patientId=${p3.id}`)).data.record.values;
    assert.equal(values.find((v: any) => v.fieldId === fieldId('age')).evidence.sheet, null);
    assert.equal(values.find((v: any) => v.fieldId === fieldId('age')).evidence.cell, 'B7');
  });

  test('fichiers refusés à la réception : format, tableau vide, aucun fichier', async () => {
    const xls = await uploadTable(Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(600)]), 'ancien.xls');
    assert.equal(xls.status, 422);
    assert.match(xls.data.error, /Ancien format Excel/);
    const pdf = await uploadTable(Buffer.from('%PDF-1.4'), 'compte-rendu.pdf');
    assert.equal(pdf.status, 422);
    assert.match(pdf.data.error, /Format non reconnu/);
    const empty = await uploadTable(Buffer.from('\r\n\r\n'), 'vide.csv');
    assert.equal(empty.status, 422);
    const res = await fetch(`${baseUrl}/api/table-imports`, { method: 'POST', body: new FormData() });
    assert.equal(res.status, 400);
    assert.deepEqual(fs.readdirSync(path.join(tmpDir, 'uploads', '.incoming')), []);
  });
});

describe('import de documents : un tableau n’y entre plus en douce', () => {
  test('CSV et classeur déposés avec les comptes rendus : refusés, l’import de tableau est indiqué', async () => {
    const patient = (await api('POST', '/api/patients', { code: 'DOC-1' })).data.patient;
    const form = new FormData();
    form.append('files', new Blob([new TextEncoder().encode('Code;Âge\nP1;54\n')], { type: 'text/csv' }), 'cohorte.csv');
    form.append('files', new Blob([new Uint8Array(cohortWorkbook())]), 'cohorte.xlsx');
    form.append('files', new Blob([new TextEncoder().encode('Âge : 54 ans')], { type: 'text/plain' }), 'cr.txt');
    const r = await (await fetch(`${baseUrl}/api/patients/${patient.id}/documents`, { method: 'POST', body: form })).json();
    assert.deepEqual(r.results.map((x: any) => x.status), ['error', 'error', 'imported']);
    assert.match(r.results[0].message, /Importer un tableau \(Excel, CSV\).*renommez-le en \.txt/);
    assert.match(r.results[1].message, /Importer un tableau \(Excel, CSV\)/);
    assert.equal(r.documents.length, 1, 'seul le compte rendu est rangé');
  });
});
