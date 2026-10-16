/**
 * Import d'une fiche d'exploitation existante (Word, Excel, CSV) : l'analyse par règles des mises en page usuelles,
 * la voie Claude (simulée : aucun appel réseau) et son repli, puis la création de la fiche dans le seul projet visé.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import JSZip from 'jszip';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-tplimport-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { makeXlsx } = await import('../src/lib/xlsx.js');
const { makeDocx } = await import('./fixtures.js');
const { parseFormText, slugKey, uniqueKeys } = await import('../src/engine/form-parser.js');
const { setFormModelCaller } = await import('../src/routes/template-import.js');

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
  setFormModelCaller(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { shutdownParsers } = await import('../src/extract/isolation.js');
  await shutdownParsers();
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

async function analyse(buffer: Buffer | string, name: string, options: { useClaude?: boolean; project?: string } = {}) {
  const form = new FormData();
  form.append('file', new Blob([typeof buffer === 'string' ? buffer : new Uint8Array(buffer)]), name);
  if (options.useClaude) form.append('useClaude', '1');
  const res = await fetch(`${baseUrl}/api/templates/import-document`, {
    method: 'POST',
    body: form,
    headers: options.project ? { 'X-Project': options.project } : {},
  });
  return { status: res.status, data: (await res.json()) as any };
}

/** .docx avec un tableau à n colonnes (les fixtures communes n'en font que deux). */
async function docxTable(rows: string[][], before: string[] = []): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder('_rels')!.file('.rels', `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const p = (t: string) => `<w:p><w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p>`;
  const body = rows.map((r) => `<w:tr>${r.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`).join('');
  zip.folder('word')!.file('document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${before.map(p).join('')}<w:tbl>${body}</w:tbl></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

const byLabel = (fields: any[], label: string) => {
  const f = fields.find((x) => x.label === label);
  assert.ok(f, `variable « ${label} » absente : ${fields.map((x) => x.label).join(', ')}`);
  return f;
};

describe('analyse par règles du texte d’une fiche', () => {
  test('libellés, cases à cocher, sections, unités, obligatoires', () => {
    const { fields, warnings } = parseFormText(
      [
        "FICHE D'EXPLOITATION",
        'IDENTIFICATION',
        'Âge : ____ ans',
        'Sexe : ☐ Homme ☐ Femme',
        'Date de naissance : __/__/____',
        'Date d’admission : le __/__/____',
        'Poids : ________ kg',
        'Service* : ...............',
        '2. ANTÉCÉDENTS',
        'Tabagisme : ☐ Oui ☐ Non',
        'Diabète : [ ] oui [ ] non',
        'HTA : Oui / Non',
        'Allergie (obligatoire) : O/N',
        'Comorbidités (plusieurs réponses possibles) : □ BPCO □ Insuffisance rénale □ Cancer',
        'Groupe : ☐ A ☐ B ☐ C',
        'III. BIOLOGIE',
        'CRP (mg/L) : ______',
        'Hb (g/dL) :',
        'Score de Glasgow : ____',
        'Durée d’hospitalisation : ____ jours',
      ].join('\n'),
    );
    assert.deepEqual(warnings, []);
    assert.equal(byLabel(fields, 'Âge').type, 'integer');
    assert.equal(byLabel(fields, 'Âge').unit, 'ans');
    assert.equal(byLabel(fields, 'Âge').section, 'IDENTIFICATION');
    assert.deepEqual(byLabel(fields, 'Sexe'), { label: 'Sexe', key: 'sexe', type: 'enum', section: 'IDENTIFICATION', unit: null, options: ['Homme', 'Femme'], required: false, description: null });
    assert.equal(byLabel(fields, 'Date de naissance').type, 'date');
    assert.equal(byLabel(fields, 'Date d’admission').type, 'date');
    assert.equal(byLabel(fields, 'Poids').type, 'number');
    assert.equal(byLabel(fields, 'Poids').unit, 'kg');
    assert.equal(byLabel(fields, 'Service').required, true);
    assert.equal(byLabel(fields, 'Service').type, 'text');
    for (const label of ['Tabagisme', 'Diabète', 'HTA', 'Allergie']) {
      assert.equal(byLabel(fields, label).type, 'boolean', label);
      assert.equal(byLabel(fields, label).section, 'ANTÉCÉDENTS');
    }
    assert.equal(byLabel(fields, 'Allergie').required, true);
    const como = byLabel(fields, 'Comorbidités');
    assert.equal(como.type, 'multi');
    assert.deepEqual(como.options, ['BPCO', 'Insuffisance rénale', 'Cancer']);
    assert.deepEqual(byLabel(fields, 'Groupe').options, ['A', 'B', 'C']);
    const crp = byLabel(fields, 'CRP');
    assert.equal(crp.type, 'number');
    assert.equal(crp.unit, 'mg/L');
    assert.equal(crp.section, 'BIOLOGIE');
    assert.equal(byLabel(fields, 'Hb').unit, 'g/dL');
    assert.equal(byLabel(fields, 'Score de Glasgow').type, 'integer');
    assert.equal(byLabel(fields, 'Durée d’hospitalisation').type, 'integer');
    assert.ok(!fields.some((f) => /FICHE/.test(f.label)), 'le titre n’est pas une variable');
  });

  test('libellé seul suivi de cases sur la ligne suivante, et ligne incomprise signalée', () => {
    const { fields, warnings } = parseFormText(
      ['Mode de sortie :', '☐ Domicile ☐ Transfert ☐ Décès', 'Observations', 'Ceci est une longue phrase explicative qui ne décrit aucune variable de la fiche, sans deux-points.'].join('\n'),
    );
    assert.deepEqual(byLabel(fields, 'Mode de sortie').options, ['Domicile', 'Transfert', 'Décès']);
    assert.ok(warnings.length >= 1);
    assert.match(warnings.join('\n'), /Ligne non interprétée/);
  });

  test('clés : ASCII, snake_case, uniques', () => {
    assert.equal(slugKey('Âge du patient (ans)'), 'age_du_patient_ans');
    assert.equal(slugKey('1er épisode'), 'v_1er_episode');
    assert.deepEqual(uniqueKeys([{ label: 'Poids' }, { label: 'poids' }, { label: 'POIDS' }]), ['poids', 'poids_2', 'poids_3']);
  });
});

describe('import d’une fiche par l’API', () => {
  test('Word : paragraphes', async () => {
    const docx = await makeDocx(['DONNÉES CLINIQUES', 'Âge : ____ ans', 'Sexe : ☐ M ☐ F', 'Fièvre : ☐ Oui ☐ Non', 'CRP (mg/L) : ......']);
    const { status, data } = await analyse(docx, 'Fiche pneumonie.docx');
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.name, 'Fiche pneumonie');
    assert.equal(data.method, 'rules');
    assert.equal(byLabel(data.fields, 'Âge').type, 'integer');
    assert.deepEqual(byLabel(data.fields, 'Sexe').options, ['M', 'F']);
    assert.equal(byLabel(data.fields, 'Fièvre').type, 'boolean');
    assert.equal(byLabel(data.fields, 'CRP').section, 'DONNÉES CLINIQUES');
  });

  test('Word : tableaux « Variable | Valeur » et « Variable | Oui | Non »', async () => {
    const docx = await docxTable(
      [
        ['Variable', 'Valeur'],
        ['Poids (kg)', ''],
        ['Date d’intervention', '__/__/____'],
        ['Complications', 'Oui', 'Non'],
        ['Infection du site', '', ''],
        ['Reprise chirurgicale', '', ''],
      ],
      ['FICHE CHIRURGIE'],
    );
    const { status, data } = await analyse(docx, 'chir.docx');
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(byLabel(data.fields, 'Poids').unit, 'kg');
    assert.equal(byLabel(data.fields, 'Poids').type, 'number');
    assert.equal(byLabel(data.fields, 'Date d’intervention').type, 'date');
    assert.equal(byLabel(data.fields, 'Infection du site').type, 'boolean');
    assert.equal(byLabel(data.fields, 'Reprise chirurgicale').type, 'boolean');
    assert.ok(!data.fields.some((f: any) => f.label === 'Variable'));
  });

  test('Excel : dictionnaire de données (en-têtes sans accents ni casse imposés)', async () => {
    const xlsx = makeXlsx([
      {
        name: 'Dictionnaire',
        columns: [{ header: 'NOM' }, { header: 'Libelle' }, { header: 'Type' }, { header: 'Modalités' }, { header: 'Unité' }, { header: 'Rubrique' }, { header: 'Obligatoire' }],
        rows: [
          ['age', 'Âge', 'Entier', '', 'ans', 'Patient', 'oui'],
          ['sexe', 'Sexe', 'Liste', 'Homme; Femme', '', 'Patient', 'oui'],
          ['atcd', 'Antécédents', 'Choix multiple', 'HTA | Diabète | BPCO', '', 'Patient', ''],
          ['crp', 'CRP', 'Numérique', '', 'mg/L', 'Biologie', 'non'],
          ['fievre', 'Fièvre', 'Oui/Non', '', '', 'Clinique', ''],
          ['dsortie', 'Date de sortie', 'Date', '', '', 'Clinique', ''],
        ],
      },
    ]);
    const { status, data } = await analyse(xlsx, 'dictionnaire.xlsx');
    assert.equal(status, 200, JSON.stringify(data));
    assert.equal(data.fields.length, 6);
    const sexe = byLabel(data.fields, 'Sexe');
    assert.deepEqual([sexe.key, sexe.type, sexe.section, sexe.required], ['sexe', 'enum', 'Patient', true]);
    assert.deepEqual(sexe.options, ['Homme', 'Femme']);
    assert.equal(byLabel(data.fields, 'Antécédents').type, 'multi');
    assert.deepEqual(byLabel(data.fields, 'Antécédents').options, ['HTA', 'Diabète', 'BPCO']);
    assert.equal(byLabel(data.fields, 'CRP').unit, 'mg/L');
    assert.equal(byLabel(data.fields, 'CRP').type, 'number');
    assert.equal(byLabel(data.fields, 'Fièvre').type, 'boolean');
    assert.equal(byLabel(data.fields, 'Date de sortie').type, 'date');
    assert.equal(byLabel(data.fields, 'Âge').type, 'integer');
    assert.equal(byLabel(data.fields, 'Date de sortie').key, 'dsortie');
  });

  test('CSV : feuille de saisie vierge (en-têtes) avec exemples', async () => {
    const csv = 'Code;Âge (ans);Sexe;Date admission;Fumeur;Poids\nP1;54;M;2024-01-03;oui;72,5\nP2;61;F;2024-02-11;non;80\nP3;70;M;2024-03-02;non;65,2\n';
    const { status, data } = await analyse(Buffer.from(csv, 'utf8'), 'saisie.csv');
    assert.equal(status, 200, JSON.stringify(data));
    assert.deepEqual(data.fields.map((f: any) => f.label), ['Code', 'Âge', 'Sexe', 'Date admission', 'Fumeur', 'Poids']);
    assert.equal(byLabel(data.fields, 'Âge').type, 'integer');
    assert.equal(byLabel(data.fields, 'Âge').unit, 'ans');
    assert.equal(byLabel(data.fields, 'Sexe').type, 'enum');
    assert.equal(byLabel(data.fields, 'Fumeur').type, 'boolean');
    assert.equal(byLabel(data.fields, 'Poids').type, 'number');
    assert.equal(byLabel(data.fields, 'Date admission').type, 'date');
  });

  test('formats refusés', async () => {
    assert.equal((await analyse('x', 'fiche.pdf')).status, 400);
    assert.match((await analyse('x', 'fiche.doc')).data.error, /\.docx/);
    const xls = Buffer.alloc(16);
    xls.writeUInt32BE(0xd0cf11e0, 0);
    xls.writeUInt32BE(0xa1b11ae1, 4);
    const r = await analyse(xls, 'vieux.xls');
    assert.equal(r.status, 422);
    assert.match(r.data.error, /\.xlsx/);
  });

  test('Claude demandé sans clé : analyse par règles, avec avertissement', async () => {
    const { data } = await analyse(await makeDocx(['Âge : ____']), 'f.docx', { useClaude: true });
    assert.equal(data.method, 'rules');
    assert.match(data.warnings.join('\n'), /Claude n’est pas activé/);
  });

  test('Claude simulé : réponse validée et normalisée, document pseudonymisé', async () => {
    let sent = '';
    setFormModelCaller(async (_system, user) => {
      sent = user;
      return JSON.stringify({
        fields: [
          { label: 'Âge', key: 'age', type: 'integer', section: 'Patient', unit: 'ans', options: [], required: true, description: null },
          { label: 'Fièvre', key: 'age', type: 'enum', section: '', unit: null, options: ['Oui', 'Non'], required: false, description: null },
        ],
        warnings: [],
      });
    });
    try {
      const { data } = await analyse(await makeDocx(['Nom : DUPONT Jean', 'Âge : ____']), 'f.docx', { useClaude: true });
      assert.equal(data.method, 'claude');
      assert.equal(data.fields.length, 2);
      assert.equal(data.fields[1].type, 'boolean', 'Oui/Non devient un booléen');
      assert.equal(data.fields[1].key, 'age_2', 'clés dédoublonnées');
      assert.equal(data.fields[1].section, 'Général');
      assert.ok(!sent.includes('DUPONT'), 'le nom ne part pas vers le modèle');
    } finally {
      setFormModelCaller(null);
    }
  });

  test('Claude simulé : réponse invalide ou erreur → repli sur les règles', async () => {
    for (const caller of [async () => '{"fields": [{"label": "x", "type": "inconnu"}]}', async () => 'pas du JSON', async () => { throw new Error('panne'); }]) {
      setFormModelCaller(caller);
      try {
        const { data } = await analyse(await makeDocx(['Âge : ____ ans']), 'f.docx', { useClaude: true });
        assert.equal(data.method, 'rules');
        assert.equal(byLabel(data.fields, 'Âge').type, 'integer');
        assert.match(data.warnings.join('\n'), /Claude n’a pas pu analyser/);
      } finally {
        setFormModelCaller(null);
      }
    }
  });

  test('création : fiche utilisable dans le projet de la requête, sans toucher au principal', async () => {
    const project = (await api<any>('POST', '/api/projects', { name: 'Import fiche' })).data.id as string;
    const mainBefore = (await api<any>('GET', '/api/templates')).data.templates.length;

    const { data: draft } = await analyse(await makeDocx(['Âge : ____ ans', 'Sexe : ☐ Homme ☐ Femme', 'Tabac : ☐ Oui ☐ Non']), 'Ma fiche.docx', { project });
    const fields = [...draft.fields, { label: 'Âge', type: 'integer', section: '', options: ['parasite'] }];
    const { status, data } = await api<any>('POST', '/api/templates/import-document/commit', { name: draft.name, fields, activate: true }, project);
    assert.equal(status, 201, JSON.stringify(data));
    const tpl = data.template;
    assert.equal(tpl.name, 'Ma fiche');
    assert.equal(tpl.isActive, true);
    assert.deepEqual(tpl.fields.map((f: any) => f.key), ['age', 'sexe', 'tabac', 'age_2']);
    assert.deepEqual(tpl.fields[3].options, [], 'pas d’options pour un entier');
    assert.equal(tpl.fields[3].section, 'Général');
    assert.deepEqual(tpl.fields[1].options, ['Homme', 'Femme']);
    assert.equal(tpl.fields[0].extraction.enabled, true);
    assert.ok(Array.isArray(tpl.fields[0].extraction.rules));

    const inProject = await api<any>('GET', '/api/templates', undefined, project);
    assert.equal(inProject.data.active.id, tpl.id);
    assert.equal((await api<any>('GET', '/api/templates')).data.templates.length, mainBefore, 'projet principal intact');

    assert.equal((await api('POST', '/api/templates/import-document/commit', { name: 'x', fields: [] }, project)).status, 400);
    assert.equal((await api('POST', '/api/templates/import-document/commit', { name: 'x', fields: [{ label: 'a', type: 'nope' }] }, project)).status, 400);
  });
});
