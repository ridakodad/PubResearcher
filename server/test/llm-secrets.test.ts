/**
 * La clé d'API Anthropic ne sort jamais de la machine vers l'interface.
 *
 * Même exigence que pour le jeton Apify (`api-hardening.test.ts`) : ni dans une réponse de l'API, ni dans un message
 * d'erreur — y compris quand une passerelle ou un mandataire répète les en-têtes de la requête dans son refus.
 * Les appels réseau sont remplacés ici par un faux `fetch` ; aucune requête ne part. Le même faux `fetch` garde le corps de
 * chaque requête : on y vérifie aussi ce qui PART vers l'API (ni code de dossier, ni nom de fichier, ni valeur de texte libre).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

const KEY = 'sk-ant-api03-ESSAI-clé-factice-Zq81+/Xc9';
const FORMS = [KEY, encodeURIComponent(KEY), Buffer.from(KEY).toString('base64')];

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-secrets-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';
process.env.ANTHROPIC_API_KEY = KEY;

interface Call {
  url: string;
  headers: Headers;
  body: string;
}
const calls: Call[] = [];
let behaviour: 'echo' | 'refuse' | 'answer' | 'nothing' = 'echo';

// Le SDK lit `globalThis.fetch` à la création du client, qui a lieu au premier appel : on le remplace avant.
globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
  const headers = new Headers(init?.headers);
  calls.push({ url: String(url), headers, body: typeof init?.body === 'string' ? init.body : '' });
  if (behaviour === 'nothing') {
    // Le modèle répond, correctement, qu'il ne trouve rien.
    return new Response(
      JSON.stringify({
        id: 'msg_vide', type: 'message', role: 'assistant', model: 'claude-essai', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify({ fields: {} }) }],
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (behaviour === 'answer') {
    // Une réponse bien formée, qui désigne le document par son alias et recopie la citation.
    const answer = {
      fields: {
        age: { value: '54', quote: 'Âge : 54 ans', document: 'Document 1' },
        // Une variable que les règles ne savent pas retrouver (aucun libellé « CRP » dans le texte).
        crp: { value: '12', quote: 'bilan sans particularité', document: 'Document 1' },
      },
    };
    return new Response(
      JSON.stringify({
        id: 'msg_essai', type: 'message', role: 'assistant', model: 'claude-essai', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: JSON.stringify(answer) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (behaviour === 'refuse') {
    return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }
  // Une passerelle qui répète les en-têtes reçus dans son message d'erreur.
  const echoed = `en-têtes reçus — x-api-key: ${headers.get('x-api-key')} ; authorization: ${headers.get('authorization')} ; adresse ?key=${encodeURIComponent(KEY)} ; base64 ${Buffer.from(KEY).toString('base64')}`;
  return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: echoed } }), {
    status: 422,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { db } = await import('../src/db/index.js');

let server: Server;
let base = '';
let patientId = 0;

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
}

function request(method: string, pathname: string, body?: unknown): Promise<Reply> {
  const url = new URL(base);
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        method,
        path: pathname,
        agent: false,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assertNoKey(reply: Reply, where: string): void {
  const everything = `${reply.text}\n${JSON.stringify(reply.headers)}`;
  for (const form of FORMS) assert.ok(!everything.includes(form), `${where} : « ${form} » dans la réponse`);
}

before(async () => {
  seedIfEmpty();
  server = await new Promise<Server>((resolve) => {
    const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const created = await request('POST', '/api/patients', { code: 'SECRET-001' });
  assert.equal(created.status, 201, created.text);
  patientId = (JSON.parse(created.text) as { patient: { id: number } }).patient.id;
  const boundary = '----rtsecret';
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="DUPONT_Jean_1962.txt"\r\nContent-Type: text/plain\r\n\r\nÂge : 54 ans\r\nSexe : féminin\r\nBiologie : bilan sans particularité.\r\n--${boundary}--\r\n`,
  );
  const uploaded = await new Promise<Reply>((resolve, reject) => {
    const url = new URL(base);
    const req = http.request(
      { host: url.hostname, port: url.port, method: 'POST', path: `/api/patients/${patientId}/documents`, agent: false,
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(body.length) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
  assert.equal(uploaded.status, 201, uploaded.text);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('la clé Anthropic ne sort jamais', () => {
  test('les écrans d’état disent que Claude est disponible sans jamais nommer la clé', async () => {
    for (const route of ['/api/config', '/api/redaction/status', '/api/health']) {
      const reply = await request('GET', route);
      assert.ok(reply.status === 200 || reply.status === 404, `${route} : ${reply.status}`);
      assertNoKey(reply, route);
    }
    const status = await request('GET', '/api/redaction/status');
    assert.deepEqual(JSON.parse(status.text), { available: true });
  });

  test('extraction par Claude : une passerelle qui répète les en-têtes ne les fait pas parvenir à l’interface', async () => {
    behaviour = 'echo';
    const before = calls.length;
    const reply = await request('POST', '/api/records/extraction/run', { mode: 'llm', patientIds: [patientId] });
    assert.equal(reply.status, 200, reply.text);
    assert.ok(calls.length > before, 'le faux fetch a bien été appelé');
    assertNoKey(reply, 'extraction');
    const run = JSON.parse(reply.text) as { errors: { patientCode: string; message: string }[] };
    assert.equal(run.errors.length, 1, reply.text);
    assert.match(run.errors[0]!.message, /Erreur API 422/);
    assert.match(run.errors[0]!.message, /\[clé masquée\]/, 'la clé est remplacée, pas simplement tronquée');
  });

  test('rédaction : l’erreur diffusée dans le flux est elle aussi masquée', async () => {
    behaviour = 'echo';
    const reply = await request('POST', '/api/redaction/message', { messages: [{ role: 'user', content: 'Rédige la section Résultats.' }] });
    assert.equal(reply.status, 200);
    assertNoKey(reply, 'rédaction');
    assert.match(reply.text, /event: error/);
    assert.match(reply.text, /\[clé masquée\]/);
  });

  test('un refus de la clé (401) ne cite que le nom de la variable, jamais sa valeur', async () => {
    behaviour = 'refuse';
    const extraction = await request('POST', '/api/records/extraction/run', { mode: 'llm', patientIds: [patientId] });
    assertNoKey(extraction, 'extraction 401');
    assert.match(extraction.text, /Clé API refusée\. Vérifiez ANTHROPIC_API_KEY/);
    const chat = await request('POST', '/api/redaction/message', { messages: [{ role: 'user', content: 'Bonjour' }] });
    assertNoKey(chat, 'rédaction 401');
    assert.match(chat.text, /Clé API refusée\. Vérifiez ANTHROPIC_API_KEY/);
  });

  test('ce qui part vers l’API pour l’extraction : le texte des documents, sous un alias — ni le code du dossier, ni le nom du fichier', async () => {
    behaviour = 'refuse';
    const start = calls.length;
    await request('POST', '/api/records/extraction/run', { mode: 'llm', patientIds: [patientId] });
    const sent = calls.slice(start).map((c) => c.body).join('\n');
    assert.ok(sent.length > 0, 'une requête est partie');
    assert.match(sent, /Documents d'un patient/);
    assert.match(sent, /<document nom=\\"Document 1\\">/, 'le document est présenté sous un alias');
    assert.match(sent, /Âge : 54 ans/, 'le texte du document, lui, est transmis : c’est le principe de ce mode');
    assert.doesNotMatch(sent, /SECRET-001/, 'le code du dossier ne part pas');
    assert.doesNotMatch(sent, /DUPONT|1962|\.txt/, 'le nom du fichier ne part pas');
  });

  test('ce qui part vers l’API pour la rédaction : des agrégats, jamais un code de dossier, un nom de fichier ou une valeur de texte libre', async () => {
    behaviour = 'refuse';
    const start = calls.length;
    await request('POST', '/api/redaction/message', { messages: [{ role: 'user', content: 'Décris la cohorte.' }] });
    const sent = calls.slice(start).map((c) => c.body).join('\n');
    assert.ok(sent.length > 0, 'une requête est partie');
    assert.match(sent, /Effectif : 1 dossiers/);
    assert.doesNotMatch(sent, /SECRET-001|DUPONT|1962|Âge : 54 ans|\.txt/);
    assert.match(sent, /valeurs non transmises/, 'les variables en texte libre ne donnent que leurs effectifs');
  });

  test('la réponse du modèle, qui désigne les documents par leur alias, est retraduite : la valeur est retenue avec le vrai nom du fichier', async () => {
    behaviour = 'answer';
    const reply = await request('POST', '/api/records/extraction/run', { mode: 'llm', patientIds: [patientId] });
    assert.equal(reply.status, 200, reply.text);
    const run = JSON.parse(reply.text) as { errors: unknown[]; totals: { extracted: number } };
    assert.deepEqual(run.errors, []);
    assert.ok(run.totals.extracted >= 1, reply.text);

    const record = JSON.parse((await request('GET', `/api/records?patientId=${patientId}`)).text) as {
      template: { fields: { id: number; key: string }[] };
      record: { values: { fieldId: number; value: unknown; source: string; confidence: number | null; evidence: { documentName: string; snippet: string } | null }[] };
    };
    const ageId = record.template.fields.find((f) => f.key === 'age')!.id;
    const age = record.record.values.find((v) => v.fieldId === ageId)!;
    assert.equal(age.value, 54);
    assert.equal(age.source, 'llm');
    assert.equal(age.confidence, 0.9, 'la citation recopiée est retrouvée telle quelle');
    assert.equal(age.evidence?.documentName, 'DUPONT_Jean_1962.txt', 'le vrai nom du fichier est rétabli dans le dossier, sur la machine');
    assert.match(age.evidence?.snippet ?? '', /Âge : 54 ans/);
  });

  describe('une passe ne retire que ce qu’elle a pu produire', () => {
    const valueOf = async (key: string): Promise<{ source: string; value: unknown } | undefined> => {
      const record = JSON.parse((await request('GET', `/api/records?patientId=${patientId}`)).text) as {
        template: { id: number; fields: { id: number; key: string }[] };
        record: { values: { fieldId: number; value: unknown; source: string }[] };
      };
      const id = record.template.fields.find((f) => f.key === key)!.id;
      return record.record.values.find((v) => v.fieldId === id);
    };
    const historyOf = async (key: string): Promise<string[]> => {
      const record = JSON.parse((await request('GET', `/api/records?patientId=${patientId}`)).text) as {
        template: { id: number; fields: { id: number; key: string }[] };
      };
      const id = record.template.fields.find((f) => f.key === key)!.id;
      const history = JSON.parse((await request('GET', `/api/records/${record.template.id}/${patientId}/history?fieldId=${id}&limit=500`)).text) as {
        events: { action: string }[];
      };
      return history.events.map((e) => e.action);
    };

    test('une passe de règles garde la valeur de Claude que les règles ne retrouvent pas, et remplace celle qu’elles retrouvent', async () => {
      behaviour = 'answer';
      await request('POST', '/api/records/extraction/run', { mode: 'llm', patientIds: [patientId] });
      assert.deepEqual(await valueOf('crp'), { ...(await valueOf('crp')), source: 'llm', value: 12 });

      const rules = await request('POST', '/api/records/extraction/run', { mode: 'rules', patientIds: [patientId] });
      assert.equal(rules.status, 200, rules.text);
      const crp = await valueOf('crp');
      assert.equal(crp?.source, 'llm', 'la valeur payante de Claude n’est pas effacée par une passe qui ne sait pas la produire');
      assert.equal(crp?.value, 12);
      assert.ok(!(await historyOf('crp')).includes('unset'), 'aucun retrait consigné');
      assert.equal((await valueOf('age'))?.source, 'auto', 'une valeur que les règles retrouvent reste remplacée par la règle');
    });

    test('un appel au modèle en échec n’efface rien', async () => {
      behaviour = 'refuse';
      const reply = await request('POST', '/api/records/extraction/run', { mode: 'llm', patientIds: [patientId] });
      assert.equal(reply.status, 200, reply.text);
      assert.equal(JSON.parse(reply.text).errors.length, 1, 'l’échec est signalé');
      assert.equal((await valueOf('crp'))?.source, 'llm');
      assert.ok(!(await historyOf('crp')).includes('unset'));

      // Même chose en mode « règles puis Claude » : les règles s'appliquent, le modèle échoue, la valeur de Claude reste.
      const hybrid = await request('POST', '/api/records/extraction/run', { mode: 'hybrid', patientIds: [patientId] });
      assert.equal(hybrid.status, 200, hybrid.text);
      assert.equal((await valueOf('crp'))?.source, 'llm');
    });

    test('un modèle qui répond « rien trouvé » retire ses anciennes valeurs, avec l’événement « unset »', async () => {
      behaviour = 'nothing';
      const reply = await request('POST', '/api/records/extraction/run', { mode: 'llm', patientIds: [patientId] });
      assert.equal(reply.status, 200, reply.text);
      assert.equal(await valueOf('crp'), undefined);
      assert.ok((await historyOf('crp')).includes('unset'), 'le retrait est consigné');
    });
  });

  test('la clé voyage en en-tête vers l’API, jamais dans l’adresse appelée', () => {
    assert.ok(calls.length >= 3);
    for (const call of calls) {
      assert.equal(call.headers.get('x-api-key'), KEY);
      for (const form of FORMS) assert.ok(!call.url.includes(form), `adresse : ${call.url}`);
      assert.match(call.url, /^https:\/\/api\.anthropic\.com\//);
    }
  });
});
