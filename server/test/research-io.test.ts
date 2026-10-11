/**
 * Entrées et sorties d'un jeu de données de recherche :
 * - les codes de dossier sont des clés, comparées sans majuscules ni caractères invisibles ;
 * - le CSV s'ouvre juste là où on l'envoie (virgule décimale pour Excel français, nombres négatifs
 *   intacts, formules neutralisées dans les seuls textes) ;
 * - un envoi de fichier illisible est une erreur du client (400), pas une panne du serveur.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-io-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { toCsv, formatValue } = await import('../src/lib/csv.js');
const { normalizePatientCode } = await import('../src/lib/patient-code.js');


// Caractères invisibles ou trompeurs, construits plutôt qu'écrits : ils ne doivent pas se cacher dans le source.
const ZWSP = String.fromCodePoint(0x200b); // espace de largeur nulle
const ZWNJ = String.fromCodePoint(0x200c);
const NBSP = String.fromCodePoint(0xa0); // espace insécable
const RLO = String.fromCodePoint(0x202e); // forçage de sens d'écriture droite-gauche
const LRI = String.fromCodePoint(0x2066); // isolat gauche-droite
const BOM = String.fromCodePoint(0xfeff); // marque d'ordre des octets
const ACUTE = String.fromCodePoint(0x301); // accent aigu combinant
const stripBom = (text: string): string => (text.startsWith(BOM) ? text.slice(1) : text);

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

describe('codes de dossier', () => {
  test('la forme canonique retire les invisibles et unifie les espaces', () => {
    assert.equal(normalizePatientCode('  PAT-001  '), 'PAT-001');
    assert.equal(normalizePatientCode('PAT-0' + ZWSP + '01'), 'PAT-001', 'espace de largeur nulle');
    assert.equal(normalizePatientCode('PAT' + NBSP + '001'), 'PAT 001', 'espace insécable');
    assert.equal(normalizePatientCode('PAT' + RLO + '-001' + LRI), 'PAT-001', 'marques de sens d’écriture');
    assert.equal(normalizePatientCode('A\u0000B\u007fC'), 'A B C', 'caractères de contrôle');
    assert.equal(normalizePatientCode('Cafe' + ACUTE), 'Café', 'composition Unicode');
    assert.equal(normalizePatientCode(BOM + 'X1'), 'X1', 'marque d’ordre des octets');
    assert.equal(normalizePatientCode(ZWSP + ZWNJ), '');
  });

  test('deux codes qui ne diffèrent que par la casse ou un caractère invisible sont le même dossier', async () => {
    const first = await api('POST', '/api/patients', { code: 'PAT-001' });
    assert.equal(first.status, 201);

    for (const variant of ['pat-001', 'Pat-001', ' PAT-001 ', 'PAT-0' + ZWSP + '01', BOM + 'PAT-001']) {
      const r = await api('POST', '/api/patients', { code: variant });
      assert.equal(r.status, 409, `« ${JSON.stringify(variant)} » aurait dû être refusé`);
      assert.match(r.data.error, /existe déjà/);
    }
    const { data } = await api('GET', '/api/patients');
    assert.equal(data.patients.filter((p: any) => /pat-001/i.test(p.code)).length, 1);
  });

  test('l’import par dossier réunit les variantes au lieu de créer un doublon', async () => {
    const a = await api('POST', '/api/patients/ensure', { code: 'PAT-007' });
    const b = await api('POST', '/api/patients/ensure', { code: 'pat-007' });
    const c = await api('POST', '/api/patients/ensure', { code: 'PAT-0' + ZWSP + '07' });
    assert.equal(a.data.patient.id, b.data.patient.id);
    assert.equal(a.data.patient.id, c.data.patient.id);
    assert.equal(c.data.patient.code, 'PAT-007', 'le code enregistré est celui du premier import');
  });

  test('un code vide après nettoyage est refusé', async () => {
    const r = await api('POST', '/api/patients', { code: ZWSP + ' ' + NBSP });
    assert.equal(r.status, 400);
  });

  test('renommer un dossier vers le code d’un autre est refusé, renommer vers soi-même passe', async () => {
    const a = await api('POST', '/api/patients', { code: 'REN-A' });
    const b = await api('POST', '/api/patients', { code: 'REN-B' });
    const clash = await api('PATCH', `/api/patients/${b.data.patient.id}`, { code: 'ren-a' });
    assert.equal(clash.status, 409);
    const self = await api('PATCH', `/api/patients/${a.data.patient.id}`, { code: 'ren-A' });
    assert.equal(self.status, 200, 'changer la casse de son propre code est permis');
    assert.equal(self.data.patient.code, 'ren-A');
  });
});

describe('ordre des dossiers', () => {
  test('ordre naturel : P-2 avant P-10, accents et casse sans effet sur le rang', async () => {
    for (const code of ['ORD-10', 'ORD-2', 'ord-1', 'ORD-1b', 'ÉORD-1', 'ORD-100']) {
      const r = await api('POST', '/api/patients', { code });
      assert.equal(r.status, 201, code);
    }
    const { data } = await api('GET', '/api/patients');
    const order = data.patients.map((p: any) => p.code).filter((c: string) => /ord/i.test(c));
    assert.deepEqual(order, ['ÉORD-1', 'ord-1', 'ORD-1b', 'ORD-2', 'ORD-10', 'ORD-100']); // É se range avec E, avant O
  });
});

describe('export CSV', () => {
  test('« ; » va avec la virgule décimale, « , » avec le point', () => {
    const rows = [['a', 36.7, -3.2]];
    const semi = toCsv(['c', 'x', 'y'], rows, { delimiter: ';', decimal: ',' });
    assert.match(semi, /a;36,7;-3,2\r\n/);
    const comma = toCsv(['c', 'x', 'y'], rows, { delimiter: ',', decimal: '.' });
    assert.match(comma, /a,36\.7,-3\.2\r\n/);
    // Choix croisé : la virgule décimale dans un fichier à virgules se met entre guillemets.
    const odd = toCsv(['c', 'x'], [['a', 1.5]], { delimiter: ',', decimal: ',' });
    assert.match(odd, /a,"1,5"\r\n/);
  });

  test('un nombre négatif reste un nombre ; un texte qui ressemble à une formule est neutralisé', () => {
    const csv = toCsv(['t', 'n', 'f'], [['=SOMME(A1)', -3, '@cmd'], ['-5 kg', 0, '+1']], { delimiter: ';' });
    const lines = stripBom(csv).trim().split('\r\n');
    assert.equal(lines[1], "'=SOMME(A1);-3;'@cmd", 'le -3 numérique ne doit pas devenir « \'-3 »');
    assert.equal(lines[2], "'-5 kg;0;'+1");
  });

  test('booléens et choix multiples sont inchangés', () => {
    assert.equal(formatValue(true), '1');
    assert.equal(formatValue(false, { booleanAsText: true }), 'Non');
    assert.equal(formatValue(['a', 'b']), 'a|b');
    assert.equal(formatValue(null), '');
  });

  test('par l’API : décimales françaises par défaut avec « ; », en-têtes en clair complets', async () => {
    const { data: created } = await api('POST', '/api/patients', { code: 'CSV-1' });
    const { data: rec } = await api('GET', `/api/records?patientId=${created.patient.id}`);
    const field = rec.template.fields.find((f: any) => f.key === 'temperature');
    const put = await api('PUT', `/api/records/${rec.template.id}/${created.patient.id}/values`, {
      values: [{ fieldId: field.id, value: 36.7 }],
    });
    assert.equal(put.status, 200);

    const fetchCsv = async (query: string) =>
      stripBom(await (await fetch(`${baseUrl}/api/export/csv?templateId=${rec.template.id}${query}`)).text());
    const column = (csv: string, delimiter: string, name: string): string => {
      const [header, ...lines] = csv.trim().split('\r\n');
      const index = header!.split(delimiter).indexOf(name);
      const line = lines.find((l) => l.startsWith('CSV-1'));
      return line!.split(delimiter)[index]!;
    };

    // Clés techniques : des noms de colonne valides pour R, Stata ou SPSS, sans l'unité (elle est dans le dictionnaire).
    assert.equal(column(await fetchCsv(''), ';', 'temperature'), '36,7');
    assert.equal(column(await fetchCsv('&delimiter=,'), ',', 'temperature'), '36.7');
    assert.equal(column(await fetchCsv('&decimal=.'), ';', 'temperature'), '36.7', 'le choix explicite l’emporte');
    assert.doesNotMatch((await fetchCsv('')).split('\r\n')[0]!, /\(/, 'aucune unité dans les clés techniques');

    const labelled = await fetchCsv('&labels=1');
    assert.match(labelled.split('\r\n')[0]!, /^Code dossier;Libellé du dossier;Nombre de documents;/);
    assert.equal(column(labelled, ';', 'Température (°C)'), '36,7', 'les en-têtes en clair gardent l’unité');

    // Sans le libellé libre des dossiers : le fichier se partage.
    const shared = await fetchCsv('&deidentify=1');
    assert.match(shared.split('\r\n')[0]!, /^patient_code;nb_documents;/);
  });
});

describe('envoi de fichiers illisible', () => {
  async function rawUpload(patientId: number, contentType: string, body: string | Buffer) {
    const res = await fetch(`${baseUrl}/api/patients/${patientId}/documents`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body,
    });
    const text = await res.text();
    return { status: res.status, data: text ? JSON.parse(text) : null };
  }

  test('un corps multipart tronqué ou mal formé est une erreur 400, jamais une panne', async () => {
    const { data } = await api('POST', '/api/patients', { code: 'MP-1' });
    const id = data.patient.id;

    const cases: [string, string, string][] = [
      ['entête de partie mal formé', 'multipart/form-data; boundary=XX', '--XX\r\nContent-Disposition form-data; name=files\r\n\r\ndata\r\n--XX--\r\n'],
      ['corps coupé net', 'multipart/form-data; boundary=XX', '--XX\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\n\r\nbonjour'],
      ['délimiteur absent', 'multipart/form-data', '--XX\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\n\r\nx\r\n--XX--\r\n'],
    ];
    for (const [label, type, body] of cases) {
      const r = await rawUpload(id, type, body);
      assert.equal(r.status, 400, `${label} : ${r.status} ${JSON.stringify(r.data)}`);
      assert.match(r.data.error, /illisible|incomplet|Champ|Import refusé/, label);
      assert.doesNotMatch(JSON.stringify(r.data), /référence/, `${label} : ne doit pas être présenté comme une panne`);
    }
    // Le serveur répond encore.
    assert.equal((await api('GET', '/api/health')).status, 200);
  });
});
