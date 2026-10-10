/**
 * Test d'intégration : import réel de fichiers, extraction, résultats, export.
 *
 * Tourne sur une base et un répertoire de données temporaires, détruits en fin
 * de suite. Les fichiers utilisés sont de vrais PDF, DOCX et DICOM construits
 * par `fixtures.ts`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-test-'));
// La configuration est lue à l'import : ces variables doivent être posées avant.
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
// L'OCR n'est pas nécessaire ici et ralentirait la suite.
process.env.OCR_ENABLED = '0';

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { makePdf, makeDocx, makeDocxTable, makeDicom } = await import('./fixtures.js');

let server: Server;
let baseUrl: string;

before(async () => {
  seedIfEmpty();
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
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

async function api<T = any>(
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

/** Décompresse une archive ZIP en mémoire : { chemin -> contenu }. */
function readZip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressed = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    const body = buffer.subarray(start, start + compressed);
    files.set(name, method === 0 ? body : zlib.inflateRawSync(body));
    offset = start + compressed;
  }
  return files;
}

async function uploadFiles(
  patientId: number,
  files: { name: string; buffer: Buffer; type: string }[],
): Promise<any> {
  const form = new FormData();
  for (const f of files) {
    form.append('files', new Blob([new Uint8Array(f.buffer)], { type: f.type }), f.name);
  }
  const res = await fetch(`${baseUrl}/api/patients/${patientId}/documents`, {
    method: 'POST',
    body: form,
  });
  return res.json();
}

// --------------------------------------------------------------------------

describe('fiche livrée par défaut', () => {
  test('une fiche active existe au premier démarrage', async () => {
    const { data } = await api('GET', '/api/templates');
    assert.ok(data.active, 'aucune fiche active');
    assert.ok(data.active.fields.length > 10, 'la fiche par défaut doit être fournie');
    assert.ok(data.active.fields.some((f: any) => f.key === 'age'));
  });
});

describe('import de documents', () => {
  let patientId: number;

  before(async () => {
    const { data } = await api('POST', '/api/patients', { code: 'PAT-001', label: 'Dossier test' });
    patientId = data.patient.id;
  });

  test('un PDF est importé et son texte extrait', async () => {
    const pdf = makePdf([
      'COMPTE RENDU D HOSPITALISATION',
      'Age : 54 ans',
      'Sexe : Masculin',
      'Antecedents : patient diabetique, hypertendu',
      'Temperature : 38,7 C',
      'Hemoglobine : 11,2 g/dL',
      'CRP : 145 mg/L',
      'Duree d hospitalisation : 12 jours',
      'Evolution : favorable',
    ]);
    const result = await uploadFiles(patientId, [
      { name: 'cr-hospitalisation.pdf', buffer: pdf, type: 'application/pdf' },
    ]);

    assert.equal(result.summary.imported, 1);
    assert.equal(result.results[0].kind, 'pdf');
    assert.ok(result.results[0].textLength > 50, 'le texte doit être extrait');
  });

  test('le texte extrait est consultable', async () => {
    const { data: patient } = await api('GET', `/api/patients/${patientId}`);
    const docId = patient.documents[0].id;
    const { data } = await api('GET', `/api/documents/${docId}/text`);
    assert.match(data.text, /Age : 54 ans/);
  });

  test('un DOCX est importé et son texte extrait', async () => {
    const docx = await makeDocx([
      "Motif d'hospitalisation : douleurs abdominales",
      'Délai de consultation : 3 jours',
    ]);
    const result = await uploadFiles(patientId, [
      {
        name: 'observation.docx',
        buffer: docx,
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ]);
    assert.equal(result.summary.imported, 1);
    assert.equal(result.results[0].kind, 'docx');
  });

  test('un tableau Word devient exploitable par les règles « libellé : valeur »', async () => {
    const docx = await makeDocxTable([
      ['Globules blancs', '14,5'],
      ['Créatinine', '9,8'],
    ]);
    const result = await uploadFiles(patientId, [
      {
        name: 'biologie.docx',
        buffer: docx,
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
    ]);
    assert.equal(result.summary.imported, 1);

    const { data: patient } = await api('GET', `/api/patients/${patientId}`);
    const bio = patient.documents.find((d: any) => d.filename === 'biologie.docx');
    const { data } = await api('GET', `/api/documents/${bio.id}/text`);
    // Le séparateur inséré entre cellules permet à la règle de fonctionner.
    assert.match(data.text, /Globules blancs\s*:\s*14,5/);
  });

  test('un DICOM est importé et ses tags lus', async () => {
    const dicom = makeDicom({ patientAge: '054Y', modality: 'CT', studyDate: '20240315' });
    const result = await uploadFiles(patientId, [
      { name: 'coupe-001.dcm', buffer: dicom, type: 'application/dicom' },
    ]);
    assert.equal(result.summary.imported, 1);
    assert.equal(result.results[0].kind, 'dicom');

    const { data: patient } = await api('GET', `/api/patients/${patientId}`);
    const dcm = patient.documents.find((d: any) => d.filename === 'coupe-001.dcm');
    assert.equal(dcm.metadata.modality, 'CT');
    assert.equal(dcm.metadata.studyDate, '2024-03-15');
  });

  test('un DICOM sans extension est reconnu par son préambule', async () => {
    const dicom = makeDicom({ patientId: 'AUTRE-ID', modality: 'MR' });
    const result = await uploadFiles(patientId, [
      { name: 'IM000001', buffer: dicom, type: 'application/octet-stream' },
    ]);
    assert.equal(result.results[0].kind, 'dicom');
  });

  test('un fichier déjà importé est signalé comme doublon', async () => {
    const pdf = makePdf(['Document identique']);
    const first = await uploadFiles(patientId, [
      { name: 'doublon.pdf', buffer: pdf, type: 'application/pdf' },
    ]);
    assert.equal(first.summary.imported, 1);

    const second = await uploadFiles(patientId, [
      { name: 'doublon-renomme.pdf', buffer: pdf, type: 'application/pdf' },
    ]);
    assert.equal(second.summary.duplicates, 1);
    assert.equal(second.summary.imported, 0);
  });

  test('un format non pris en charge est signalé sans bloquer l’import', async () => {
    const result = await uploadFiles(patientId, [
      { name: 'archive.zip', buffer: Buffer.from('PKrien'), type: 'application/zip' },
    ]);
    // Le document est conservé, mais marqué en erreur.
    assert.equal(result.summary.imported, 1);
    const doc = result.documents.find((d: any) => d.filename === 'archive.zip');
    assert.equal(doc.parseStatus, 'error');
    assert.match(doc.parseError, /non pris en charge/i);
  });
});

describe('extraction automatique', () => {
  let patientId: number;

  before(async () => {
    const { data } = await api('POST', '/api/patients', { code: 'PAT-002' });
    patientId = data.patient.id;

    await uploadFiles(patientId, [
      {
        name: 'cr.pdf',
        buffer: makePdf([
          'Age : 61 ans',
          'Sexe : Feminin',
          'Antecedents : patiente diabetique',
          'Pas de tabagisme',
          'Temperature : 39,1 C',
          'Hemoglobine : 9,4 g/dL',
          'CRP : 220 mg/L',
          'Duree d hospitalisation : 8 jours',
          'Evolution : favorable',
        ]),
        type: 'application/pdf',
      },
      {
        name: 'scanner.dcm',
        buffer: makeDicom({ modality: 'CT', studyDate: '20240402', patientAge: '061Y' }),
        type: 'application/dicom',
      },
    ]);
  });

  test('la passe d’extraction renseigne les variables', async () => {
    const { data } = await api('POST', '/api/records/extraction/run', { patientIds: [patientId] });
    assert.equal(data.patientsProcessed, 1);
    assert.ok(data.totals.extracted > 5, `trop peu de variables extraites : ${data.totals.extracted}`);
  });

  test('les valeurs extraites sont correctement typées', async () => {
    const { data } = await api('GET', `/api/records?patientId=${patientId}`);
    const byKey = new Map(
      data.record.values.map((v: any) => [
        data.template.fields.find((f: any) => f.id === v.fieldId)?.key,
        v,
      ]),
    );

    assert.equal((byKey.get('age') as any)?.value, 61);
    assert.equal((byKey.get('sexe') as any)?.value, 'Féminin');
    assert.equal((byKey.get('diabete') as any)?.value, true);
    assert.equal((byKey.get('temperature') as any)?.value, 39.1);
    assert.equal((byKey.get('hemoglobine') as any)?.value, 9.4);
    assert.equal((byKey.get('duree_hospitalisation') as any)?.value, 8);
    assert.equal((byKey.get('evolution') as any)?.value, 'Favorable');
  });

  test('la modalité DICOM est traduite en libellé de la fiche', async () => {
    const { data } = await api('GET', `/api/records?patientId=${patientId}`);
    const field = data.template.fields.find((f: any) => f.key === 'modalite_imagerie');
    const value = data.record.values.find((v: any) => v.fieldId === field.id);
    assert.deepEqual(value.value, ['Scanner']);
  });

  test('chaque valeur automatique cite sa source', async () => {
    const { data } = await api('GET', `/api/records?patientId=${patientId}`);
    const field = data.template.fields.find((f: any) => f.key === 'age');
    const value = data.record.values.find((v: any) => v.fieldId === field.id);
    assert.equal(value.source, 'auto');
    assert.ok(value.evidence, 'la justification doit être enregistrée');
    assert.equal(value.evidence.documentName, 'cr.pdf');
    assert.match(value.evidence.snippet, /61/);
    assert.ok(value.confidence > 0 && value.confidence <= 1);
  });

  test('la négation évite le faux positif sur le tabagisme', async () => {
    const { data } = await api('GET', `/api/records?patientId=${patientId}`);
    const field = data.template.fields.find((f: any) => f.key === 'tabagisme');
    const value = data.record.values.find((v: any) => v.fieldId === field.id);
    assert.ok(value === undefined || value.value !== true, '« Pas de tabagisme » ne doit pas valoir Oui');
  });
});

describe('correction manuelle', () => {
  let patientId: number;
  let templateId: number;
  let ageFieldId: number;

  before(async () => {
    const { data } = await api('POST', '/api/patients', { code: 'PAT-003' });
    patientId = data.patient.id;
    await uploadFiles(patientId, [
      { name: 'cr.pdf', buffer: makePdf(['Age : 30 ans', 'Sexe : Masculin']), type: 'application/pdf' },
    ]);
    await api('POST', '/api/records/extraction/run', { patientIds: [patientId] });

    const { data: rec } = await api('GET', `/api/records?patientId=${patientId}`);
    templateId = rec.template.id;
    ageFieldId = rec.template.fields.find((f: any) => f.key === 'age').id;
  });

  test('une valeur corrigée est enregistrée comme manuelle', async () => {
    const { status, data } = await api('PUT', `/api/records/${templateId}/${patientId}/values`, {
      values: [{ fieldId: ageFieldId, value: 31 }],
    });
    assert.equal(status, 200);
    const value = data.record.values.find((v: any) => v.fieldId === ageFieldId);
    assert.equal(value.value, 31);
    assert.equal(value.source, 'manual');
  });

  test('une nouvelle extraction préserve la correction', async () => {
    await api('POST', '/api/records/extraction/run', { patientIds: [patientId] });
    const { data } = await api('GET', `/api/records?patientId=${patientId}`);
    const value = data.record.values.find((v: any) => v.fieldId === ageFieldId);
    assert.equal(value.value, 31, 'la correction manuelle a été écrasée');
    assert.equal(value.source, 'manual');
  });

  test('l’écrasement forcé rétablit la valeur automatique', async () => {
    await api('POST', '/api/records/extraction/run', {
      patientIds: [patientId],
      overwriteManual: true,
    });
    const { data } = await api('GET', `/api/records?patientId=${patientId}`);
    const value = data.record.values.find((v: any) => v.fieldId === ageFieldId);
    assert.equal(value.value, 30);
    assert.equal(value.source, 'auto');
  });

  test('une valeur incompatible avec le type est refusée', async () => {
    const { status, data } = await api('PUT', `/api/records/${templateId}/${patientId}/values`, {
      values: [{ fieldId: ageFieldId, value: 'quarante' }],
    });
    assert.equal(status, 400);
    assert.match(data.error, /nombre/i);
  });

  test('une option hors liste est refusée', async () => {
    const { data: rec } = await api('GET', `/api/records?patientId=${patientId}`);
    const sexeId = rec.template.fields.find((f: any) => f.key === 'sexe').id;
    const { status } = await api('PUT', `/api/records/${templateId}/${patientId}/values`, {
      values: [{ fieldId: sexeId, value: 'Inconnu' }],
    });
    assert.equal(status, 400);
  });
});

describe('paramétrage de la fiche', () => {
  let templateId: number;

  before(async () => {
    const { data } = await api('POST', '/api/templates', { name: 'Fiche de test' });
    templateId = data.template.id;
  });

  test('une variable peut être ajoutée avec ses règles', async () => {
    const { status, data } = await api('POST', `/api/templates/${templateId}/fields`, {
      key: 'score_glasgow',
      label: 'Score de Glasgow',
      type: 'integer',
      section: 'Clinique',
      extraction: {
        enabled: true,
        rules: [{ kind: 'label', labels: ['Glasgow', 'GCS'] }],
        postProcess: { min: 3, max: 15 },
      },
    });
    assert.equal(status, 201);
    assert.equal(data.field.key, 'score_glasgow');
  });

  test('une clé invalide est refusée', async () => {
    const { status } = await api('POST', `/api/templates/${templateId}/fields`, {
      key: 'Score Glasgow',
      label: 'Score',
      type: 'integer',
    });
    assert.equal(status, 400);
  });

  test('une expression régulière invalide est refusée à l’enregistrement', async () => {
    const { status } = await api('POST', `/api/templates/${templateId}/fields`, {
      key: 'mauvaise_regle',
      label: 'Mauvaise règle',
      type: 'text',
      extraction: { enabled: true, rules: [{ kind: 'regex', pattern: '([' }] },
    });
    assert.equal(status, 400);
  });

  test('une variable à choix impose des options', async () => {
    const { status, data } = await api('POST', `/api/templates/${templateId}/fields`, {
      key: 'stade',
      label: 'Stade',
      type: 'enum',
      options: [],
    });
    assert.equal(status, 400);
    assert.match(data.error, /option/i);
  });

  test('le banc d’essai évalue une règle sans rien enregistrer', async () => {
    const { status, data } = await api('POST', '/api/templates/fields/test', {
      field: {
        key: 'glasgow',
        label: 'Glasgow',
        type: 'integer',
        extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Glasgow', 'GCS'] }] },
      },
      sampleText: 'Examen neurologique : GCS : 14/15, pupilles symétriques.',
    });
    assert.equal(status, 200);
    assert.equal(data.found, true);
    assert.equal(data.value, 14);
    assert.ok(data.evidence.snippet.includes('GCS'));
  });

  test('le banc d’essai applique le contrôle d’unité comme une passe : « 85 µmol/L » pour une variable en mg/L est écarté, avec sa raison', async () => {
    const probe = (unit: string | null) => ({
      key: 'crp_banc',
      label: 'CRP',
      type: 'number',
      unit,
      extraction: { enabled: true, rules: [{ kind: 'label', labels: ['CRP'] }] },
    });
    const sampleText = 'Biologie : CRP : 85 µmol/L, créatinine 70.';

    const mismatch = (await api('POST', '/api/templates/fields/test', { field: probe('mg/L'), sampleText })).data;
    assert.equal(mismatch.found, false);
    assert.equal(mismatch.rejected.length, 1);
    assert.match(mismatch.rejected[0].reason, /unité « µmol\/L » différente de « mg\/L »/);

    // Même texte, même unité que la valeur : lue. Sans unité déclarée, il n'y a rien à comparer.
    const matching = (await api('POST', '/api/templates/fields/test', { field: probe('µmol/L'), sampleText })).data;
    assert.equal(matching.value, 85);
    const undeclared = (await api('POST', '/api/templates/fields/test', { field: probe(null), sampleText })).data;
    assert.equal(undeclared.value, 85);
  });

  test('la fiche s’exporte et se réimporte à l’identique', async () => {
    const res = await fetch(`${baseUrl}/api/export/template.json?templateId=${templateId}`);
    const exported = await res.json();
    assert.ok(exported.fields.length > 0);

    const { status, data } = await api('POST', '/api/templates/import', {
      ...exported,
      name: 'Fiche réimportée',
    });
    assert.equal(status, 201);
    assert.equal(data.template.fields.length, exported.fields.length);
    assert.deepEqual(
      data.template.fields.map((f: any) => f.key),
      exported.fields.map((f: any) => f.key),
    );
  });
});

describe('résultats et export', () => {
  test('le jeu de données contient une ligne par dossier', async () => {
    const { data } = await api('GET', '/api/analytics/dataset');
    const { data: patients } = await api('GET', '/api/patients');
    assert.equal(data.rows.length, patients.patients.length);
    assert.ok(data.summary.completeness >= 0 && data.summary.completeness <= 100);
  });

  test('les statistiques choisissent le bon type de graphique', async () => {
    const { data } = await api('GET', '/api/analytics/stats');
    const age = data.stats.find((s: any) => s.key === 'age');
    assert.equal(age.chart, 'histogram');
    assert.ok(age.summary, 'un résumé numérique est attendu');
    assert.ok(Array.isArray(age.bins));

    const sexe = data.stats.find((s: any) => s.key === 'sexe');
    assert.equal(sexe.chart, 'categories');
    assert.ok(Array.isArray(sexe.categories));
  });

  test('l’export CSV contient les colonnes et les lignes attendues', async () => {
    const res = await fetch(`${baseUrl}/api/export/csv`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);

    // Le BOM se vérifie sur les octets : `Response.text()` le retire au décodage.
    const bytes = Buffer.from(await res.clone().arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM UTF-8 attendu pour Excel');

    const csv = await res.text();
    const lines = csv.replace(/^﻿/, '').trim().split('\r\n');
    assert.match(lines[0]!, /patient_code/);
    assert.match(lines[0]!, /age/);

    const { data } = await api('GET', '/api/patients');
    assert.equal(lines.length - 1, data.patients.length);
  });

  test('le séparateur et le format booléen sont paramétrables', async () => {
    const res = await fetch(`${baseUrl}/api/export/csv?delimiter=,&booleans=text`);
    const csv = await res.text();
    const header = csv.replace(/^﻿/, '').split('\r\n')[0]!;
    assert.ok(header.includes(','));
    assert.ok(!header.includes(';'));
  });

  test('le dictionnaire des variables est exportable', async () => {
    const res = await fetch(`${baseUrl}/api/export/dictionary.csv`);
    const csv = await res.text();
    assert.match(csv, /cle;libelle;section;type/);
    // La clé technique du type reste (import automatique) ; sa lecture pour un humain s'y ajoute en dernière colonne.
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    assert.match(lines[0]!, /;type_libelle$/);
    const age = lines.find((l) => l.startsWith('age;'));
    assert.ok(age, 'la variable « age » figure au dictionnaire');
    assert.match(age!, /;integer;/);
    assert.match(age!, /;Nombre entier$/);
  });
});

describe('service du fichier d’origine', () => {
  let patientId: number;

  before(async () => {
    const { data } = await api<any>('POST', '/api/patients', { code: 'PAT-FICHIER' });
    patientId = data.patient.id;
  });

  test('un PDF est servi avec son type, affichable dans la page', async () => {
    // Le type déclaré à l'import est délibérément inutilisable : c'est le cas
    // d'un import par script, et de navigateurs qui ne reconnaissent pas
    // l'extension. Le lecteur intégré du navigateur refuserait alors
    // d'afficher un PDF pourtant valide.
    const up = await uploadFiles(patientId, [
      { name: 'cr.pdf', buffer: makePdf(['Compte rendu.']), type: 'application/octet-stream' },
    ]);
    const id = up.results[0].documentId;

    const res = await fetch(`${baseUrl}/api/documents/${id}/file`);
    assert.match(res.headers.get('content-type') ?? '', /application\/pdf/);
    assert.match(res.headers.get('content-disposition') ?? '', /^inline/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    await res.arrayBuffer();
  });

  test('un format exécutable n’est jamais rendu dans la page', async () => {
    // Un SVG servi en ligne s'exécuterait dans l'origine de l'application,
    // où se trouvent les données de l'étude : il part en téléchargement.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      'utf8',
    );
    const up = await uploadFiles(patientId, [
      { name: 'piege.svg', buffer: svg, type: 'image/svg+xml' },
    ]);
    const id = up.results[0].documentId;

    const res = await fetch(`${baseUrl}/api/documents/${id}/file`);
    assert.match(res.headers.get('content-type') ?? '', /application\/octet-stream/);
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment/);
    await res.arrayBuffer();
  });
});

describe('export au format classeur', () => {
  test('le classeur produit est une archive lisible, typée et complète', async () => {
    const res = await fetch(`${baseUrl}/api/export/xlsx`);
    assert.equal(res.status, 200);
    assert.match(
      res.headers.get('content-type') ?? '',
      /spreadsheetml\.sheet/,
      'le type doit être celui d’un classeur',
    );

    const buffer = Buffer.from(await res.arrayBuffer());
    // Signature ZIP : un classeur illisible échouerait dès l'ouverture.
    assert.deepEqual([...buffer.subarray(0, 2)], [0x50, 0x4b]);

    const files = readZip(buffer);
    for (const required of [
      '[Content_Types].xml',
      'xl/workbook.xml',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ]) {
      assert.ok(files.has(required), `partie manquante : ${required}`);
    }

    const classeur = files.get('xl/workbook.xml')!.toString('utf8');
    for (const feuille of ['Données', 'Dictionnaire', 'Synthèse']) {
      assert.ok(classeur.includes(feuille), `feuille absente : ${feuille}`);
    }

    const feuille1 = files.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    // En-tête figé et filtre : le jeu de données doit être exploitable dès
    // l'ouverture, sans manipulation.
    assert.match(feuille1, /state="frozen"/);
    assert.match(feuille1, /<autoFilter/);
    // Un nombre est écrit comme nombre, jamais comme chaîne : c'est tout
    // l'intérêt du classeur face au CSV. La feuille de synthèse en porte
    // toujours (effectifs, complétude), quel que soit le jeu de données.
    const synthese = files.get('xl/worksheets/sheet3.xml')!.toString('utf8');
    assert.match(synthese, /<c r="C2"><v>\d+<\/v><\/c>/);
  });

  test('dictionnaire et synthèse du classeur nomment les types en français, comme l’écran', async () => {
    const res = await fetch(`${baseUrl}/api/export/xlsx`);
    const files = readZip(Buffer.from(await res.arrayBuffer()));
    for (const part of ['xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml']) {
      const sheet = files.get(part)!.toString('utf8');
      assert.match(sheet, />Nombre entier</, part);
      assert.match(sheet, />Oui \/ Non</, part);
      assert.doesNotMatch(sheet, />(integer|boolean|enum|multi)</, `${part} : clé technique laissée à l'affichage`);
    }
  });

  test('les chiffres écrits dans le diaporama portent la virgule décimale', async () => {
    const { formatBound } = await import('../src/routes/export.js');
    assert.equal(formatBound(54.25), '54,25');
    assert.equal(formatBound(0.5), '0,5');
    assert.equal(formatBound(10), '10');
    assert.equal(formatBound(10.001), '10');
    assert.equal(formatBound(Number.NaN), '—');
    const res = await fetch(`${baseUrl}/api/export/pptx`);
    const files = readZip(Buffer.from(await res.arrayBuffer()));
    const texts = [...files.entries()].filter(([name]) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).map(([, buf]) => buf.toString('utf8')).join('\n');
    assert.doesNotMatch(texts, /(Moyenne|médiane|extrêmes) -?\d+\.\d/, 'point décimal dans un texte français');
  });

  test('les caractères réservés du XML ne cassent pas le classeur', async () => {
    // Un compte rendu contient « < », « & », des guillemets. Mal échappés, le
    // tableur refuse d'ouvrir le fichier.
    const { data } = await api<any>('POST', '/api/patients', {
      code: 'PAT-<&"XML>',
      label: "L'étude « pilote » & suite",
    });
    assert.equal(data.patient.id > 0, true);

    const res = await fetch(`${baseUrl}/api/export/xlsx`);
    const files = readZip(Buffer.from(await res.arrayBuffer()));
    const feuille1 = files.get('xl/worksheets/sheet1.xml')!.toString('utf8');
    assert.ok(feuille1.includes('PAT-&lt;&amp;&quot;XML&gt;'), 'le code doit être échappé');
    // Aucune esperluette laissée nue : c'est la faute qui rend un classeur
    // impossible à ouvrir, et celle qu'un simple `includes` ne verrait pas.
    const nue = /&(?!(amp|lt|gt|quot|apos|#\d+);)/.exec(feuille1);
    assert.equal(nue, null, `esperluette non échappée : ${nue?.input.slice(nue.index, nue.index + 40)}`);
  });

  test('le diaporama produit est une archive lisible et numérotée', async () => {
    const res = await fetch(`${baseUrl}/api/export/pptx`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /presentationml\.presentation/);

    const files = readZip(Buffer.from(await res.arrayBuffer()));
    for (const required of [
      '[Content_Types].xml',
      'ppt/presentation.xml',
      'ppt/theme/theme1.xml',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/slides/slide1.xml',
    ]) {
      assert.ok(files.has(required), `partie manquante : ${required}`);
    }

    // Chaque planche déclarée dans la présentation doit exister et être reliée
    // à une disposition : c'est ce qui manque le plus souvent dans un .pptx
    // écrit à la main, et PowerPoint refuse alors le fichier entier.
    const presentation = files.get('ppt/presentation.xml')!.toString('utf8');
    const declarees = [...presentation.matchAll(/r:id="rIdSlide(\d+)"/g)].map((m) => m[1]);
    assert.ok(declarees.length > 1, 'la couverture et au moins une figure');
    for (const n of declarees) {
      assert.ok(files.has(`ppt/slides/slide${n}.xml`), `planche ${n} absente`);
      assert.ok(files.has(`ppt/slides/_rels/slide${n}.xml.rels`), `relations ${n} absentes`);
    }

    // Une figure porte son numéro : c'est ce qui la rend citable dans un texte.
    const figure = files.get('ppt/slides/slide2.xml')!.toString('utf8');
    assert.match(figure, /Figure 1/);

    const nue = /&(?!(amp|lt|gt|quot|apos|#\d+);)/.exec(figure);
    assert.equal(nue, null, 'esperluette non échappée dans une planche');
  });
});

describe('assistant de rédaction', () => {
  test('l’assistant se déclare indisponible sans clé API', async () => {
    const { data } = await api<any>('GET', '/api/redaction/status');
    assert.equal(data.available, false);
  });

  test('le flux livre son erreur au client au lieu de rester vide', async () => {
    // L'en-tête part avant que l'erreur ne survienne : elle ne peut donc plus
    // être un code HTTP, elle voyage dans le flux. Une écoute mal placée —
    // « close » sur la requête plutôt que sur la réponse — ferait partir un
    // flux vide avec un HTTP 200, sans le moindre message visible.
    const res = await fetch(`${baseUrl}/api/redaction/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Décris la population.' }] }),
    });

    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    const flux = await res.text();
    assert.ok(flux.length > 0, 'le flux ne doit pas être vide');
    assert.match(flux, /^event: error$/m);
    assert.match(flux, /ANTHROPIC_API_KEY/);
  });

  test('une conversation vide est refusée', async () => {
    const { status } = await api('POST', '/api/redaction/message', { messages: [] });
    assert.equal(status, 400);
  });
});

describe('robustesse de l’API', () => {
  test('un identifiant inexistant renvoie 404', async () => {
    const { status } = await api('GET', '/api/patients/999999');
    assert.equal(status, 404);
  });

  test('un identifiant non numérique renvoie 400', async () => {
    const { status } = await api('GET', '/api/patients/abc');
    assert.equal(status, 400);
  });

  test('un code patient dupliqué renvoie 409', async () => {
    await api('POST', '/api/patients', { code: 'DOUBLON' });
    const { status } = await api('POST', '/api/patients', { code: 'DOUBLON' });
    assert.equal(status, 409);
  });

  test('une route inconnue renvoie 404 en JSON', async () => {
    const { status, data } = await api('GET', '/api/inexistant');
    assert.equal(status, 404);
    assert.ok(data.error);
  });

  test('la suppression d’un dossier retire ses documents', async () => {
    const { data: created } = await api('POST', '/api/patients', { code: 'A-SUPPRIMER' });
    const id = created.patient.id;
    await uploadFiles(id, [
      { name: 'x.pdf', buffer: makePdf(['test']), type: 'application/pdf' },
    ]);
    const { status } = await api('DELETE', `/api/patients/${id}`);
    assert.equal(status, 204);
    const { status: after } = await api('GET', `/api/patients/${id}`);
    assert.equal(after, 404);
  });
});
