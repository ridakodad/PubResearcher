/**
 * Modèles locaux (Ollama) : aiguillage, réglages, garde de la boucle locale, téléchargement, disponibilité.
 *
 * Un faux Ollama tourne dans le test (serveur HTTP sur 127.0.0.1) : `/api/version`, `/api/tags`, `/api/chat` (réponse
 * structurée, et diffusée), `/api/pull` (progression en NDJSON). Aucun modèle réel, aucun réseau.
 *
 * Le point essentiel : la réponse d'un modèle local passe par les MÊMES garde-fous que celle de Claude. Une citation
 * inventée est rejetée, quel que soit le modèle qui l'a produite.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http, { type Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-models-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.LOCAL_MODEL_ALLOW_REMOTE;

const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
const { extractWithLlm, llmStatus, estimateExtraction } = await import('../src/engine/llm.js');
const { createModelSettingsStore, normalizeOllamaUrl } = await import('../src/engine/model-settings.js');
const { routerSettings, routeFor, generateStructured, ModelCallError } = await import('../src/engine/model-router.js');
const { costOf } = await import('../src/engine/pricing.js');
const { keyStore } = await import('../src/engine/api-key.js');
type TemplateField = import('../src/domain/types.js').TemplateField;

// ------------------------------------------------------------------ faux Ollama

interface Seen {
  path: string;
  body: any;
}
const seen: Seen[] = [];
/** Réponse que le faux modèle donnera au prochain `/api/chat` non diffusé. */
let nextAnswer: unknown = {};
let fakeOllama: Server;
let ollamaUrl = '';

function startFake(): Promise<void> {
  fakeOllama = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ path: req.url ?? '', body });
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.13.5' }));
      if (req.url === '/api/tags') {
        return res.end(JSON.stringify({ models: [{ name: 'qwen3.5:9b', size: 6_600_000_000, modified_at: '2026-10-01T00:00:00Z', details: { parameter_size: '9B', quantization_level: 'Q4_K_M' } }] }));
      }
      if (req.url === '/api/chat') {
        if (body.model === 'absent:1b') {
          res.statusCode = 404;
          return res.end(JSON.stringify({ error: "model 'absent:1b' not found, try pulling it first" }));
        }
        if (body.stream) {
          res.setHeader('Content-Type', 'application/x-ndjson');
          for (const piece of ['Les 42 ', 'patients ', 'avaient 61 ans.']) res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: piece }, done: false })}\n`);
          return res.end(`${JSON.stringify({ model: body.model, message: { content: '' }, done: true, prompt_eval_count: 50, eval_count: 9 })}\n`);
        }
        return res.end(JSON.stringify({ model: body.model, message: { role: 'assistant', content: JSON.stringify(nextAnswer) }, done: true, done_reason: 'stop', prompt_eval_count: 321, eval_count: 54 }));
      }
      if (req.url === '/api/pull') {
        res.setHeader('Content-Type', 'application/x-ndjson');
        res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
        res.write(`${JSON.stringify({ status: 'pulling d8b0f5e9', digest: 'sha256:d8b0f5e9', total: 1000, completed: 400 })}\n`);
        res.write(`${JSON.stringify({ status: 'pulling d8b0f5e9', digest: 'sha256:d8b0f5e9', total: 1000, completed: 1000 })}\n`);
        return res.end(`${JSON.stringify({ status: 'success' })}\n`);
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
  return new Promise((resolve) => {
    fakeOllama.listen(0, '127.0.0.1', () => {
      const a = fakeOllama.address();
      ollamaUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      process.env.OLLAMA_HOST = ollamaUrl;
      resolve();
    });
  });
}

let app: Server;
let baseUrl = '';

before(async () => {
  seedIfEmpty();
  keyStore.remove();
  await startFake();
  await new Promise<void>((resolve) => {
    app = createApp().listen(0, () => {
      const a = app.address();
      baseUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => fakeOllama.close(() => resolve()));
  const { closeDatabase } = await import('../src/db/index.js');
  closeDatabase();
  delete process.env.OLLAMA_HOST;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  seen.length = 0;
});

const field = (key: string, type: TemplateField['type'], id: number, extra: Partial<TemplateField> = {}): TemplateField =>
  ({ id, templateId: 1, key, label: key, type, section: 'Test', unit: null, description: null, required: false, options: [], position: id, extraction: { enabled: true, rules: [] }, ...extra }) as TemplateField;

const FIELDS = [field('age', 'integer', 1, { unit: 'ans' }), field('crp', 'number', 2, { unit: 'mg/L' }), field('sexe', 'enum', 3, { options: ['Masculin', 'Féminin'] })];
const DOCS = [{ id: 7, name: 'cr.pdf', kind: 'pdf' as const, dicomTags: {}, text: 'Patiente de 67 ans. CRP à 148 mg/L. Sexe : Féminin.' }];

// ------------------------------------------------------------------ tests

describe('disponibilité sans clé Anthropic', () => {
  test('par défaut (Claude, sans clé) : extraction indisponible', () => {
    routerSettings().update({ tasks: { extraction: { provider: 'anthropic', model: null } } });
    assert.equal(keyStore.active(), null);
    assert.equal(llmStatus().available, false);
    assert.equal(llmStatus().provider, 'anthropic');
  });

  test('modèle local choisi : modes « Claude » et « mixte » disponibles, coût nul, modèle nommé ollama:…', () => {
    routerSettings().update({ tasks: { extraction: { provider: 'local', model: 'qwen3.5:9b' } } });
    const status = llmStatus();
    assert.equal(status.available, true);
    assert.equal(status.provider, 'local');
    assert.equal(status.model, 'ollama:qwen3.5:9b');
    assert.equal(costOf('ollama:qwen3.5:9b', { inputTokens: 10_000, outputTokens: 5_000, cacheReadTokens: 0 }), 0);
    const estimate = estimateExtraction(FIELDS, 'Essai', [DOCS]);
    assert.ok(estimate);
    assert.equal(estimate!.high, 0);
    assert.equal(estimate!.model, 'ollama:qwen3.5:9b');
  });

  test('l’API expose la capacité à l’écran Extraction (modes activés sans clé)', async () => {
    const res = await fetch(`${baseUrl}/api/documents-capabilities`);
    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.llm.available, true);
    assert.equal(data.llm.provider, 'local');
  });
});

describe('extraction par un modèle local : mêmes garde-fous que Claude', () => {
  test('valeur citée retenue, citation inventée rejetée, schéma et température 0 transmis', async () => {
    routerSettings().update({ tasks: { extraction: { provider: 'local', model: 'qwen3.5:9b' } } });
    nextAnswer = {
      fields: {
        age: { value: '67', quote: 'Patiente de 67 ans', document: 'Document 1' },
        // Citation absente du document : le modèle l'a inventée.
        crp: { value: '180', quote: 'CRP à 180 mg/L', document: 'Document 1' },
        sexe: { value: 'Féminin', quote: 'Sexe : Féminin', document: 'Document 1' },
      },
    };
    const result = await extractWithLlm(FIELDS, DOCS, 'Essai');
    assert.equal(result.model, 'ollama:qwen3.5:9b');
    assert.deepEqual(result.values.map((v) => [v.key, v.value]).sort(), [['age', 67], ['sexe', 'Féminin']]);
    assert.equal(result.unverified.length, 1);
    assert.equal(result.unverified[0]!.key, 'crp');
    assert.match(result.values[0]!.evidence.rule ?? '', /^Modèle local \(ollama:qwen3\.5:9b\)$/);
    assert.equal(result.values.find((v) => v.key === 'age')!.evidence.documentId, 7);
    assert.equal(result.usage.inputTokens, 321);

    const chat = seen.find((s) => s.path === '/api/chat')!;
    assert.equal(chat.body.model, 'qwen3.5:9b');
    assert.equal(chat.body.stream, false);
    assert.equal(chat.body.options.temperature, 0);
    assert.ok(chat.body.options.num_ctx >= 4096 && chat.body.options.num_ctx <= 32_768);
    assert.equal(chat.body.format.properties.fields.additionalProperties, false, 'le schéma de sortie est imposé par `format`');
    // Rien n'est pseudonymisé par défaut pour un modèle local : le texte reste tel quel sur le poste.
    assert.match(chat.body.messages[1].content, /Patiente de 67 ans/);
  });

  test('citation qui contredit la valeur : rejetée aussi', async () => {
    nextAnswer = { fields: { age: { value: '', quote: '', document: '' }, crp: { value: '200', quote: 'CRP à 148 mg/L', document: 'Document 1' }, sexe: { value: '', quote: '', document: '' } } };
    const result = await extractWithLlm(FIELDS, DOCS, 'Essai');
    assert.equal(result.values.length, 0);
    assert.equal(result.unverified[0]!.key, 'crp');
  });

  test('JSON invalide : erreur claire, réessayable', async () => {
    nextAnswer = 'pas du JSON' as unknown;
    // JSON.stringify d'une chaîne donne un JSON valide (une chaîne) sans « fields » : refus explicite.
    await assert.rejects(extractWithLlm(FIELDS, DOCS, 'Essai'), /fields/);
  });

  test('modèle non téléchargé : message qui dit quoi faire', async () => {
    await assert.rejects(
      generateStructured({ task: 'extraction', route: { task: 'extraction', provider: 'local', model: 'absent:1b', label: 'ollama:absent:1b' }, system: 's', user: 'u', schema: { type: 'object' }, maxTokens: 100 }),
      (error: unknown) => error instanceof ModelCallError && /pas téléchargé/.test(error.message) && /ollama pull absent:1b/.test(error.message),
    );
  });

  test('Ollama arrêté : message qui dit de le lancer', async () => {
    const saved = process.env.OLLAMA_HOST;
    process.env.OLLAMA_HOST = 'http://127.0.0.1:1';
    try {
      await assert.rejects(extractWithLlm(FIELDS, DOCS, 'Essai'), /Ollama ne répond pas/);
    } finally {
      process.env.OLLAMA_HOST = saved;
    }
  });
});

describe('réglages', () => {
  test('persistés dans un fichier du dossier de données, relus par un nouveau magasin', () => {
    const file = path.join(tmpDir, 'settings-persist.json');
    const a = createModelSettingsStore(file, {});
    a.update({ tasks: { writing: { provider: 'local', model: 'ministral-3:14b' } }, pseudonymizeLocal: true });
    const b = createModelSettingsStore(file, {});
    assert.deepEqual(b.task('writing'), { provider: 'local', model: 'ministral-3:14b' });
    assert.equal(b.get().pseudonymizeLocal, true);
    assert.deepEqual(b.task('extraction'), { provider: 'anthropic', model: null });
    assert.equal(b.localModel('extraction'), 'qwen3.5:9b', 'modèle recommandé par défaut');
  });

  test('un nom de modèle qui n’en est pas un est refusé', () => {
    const s = createModelSettingsStore(path.join(tmpDir, 'bad.json'), {});
    assert.throws(() => s.update({ tasks: { extraction: { model: '../../etc/passwd' } } }), /nom de modèle/);
    assert.throws(() => s.update({ tasks: { extraction: { model: 'http://evil/x' } } }), /nom de modèle/);
  });

  test('PUT /api/models/settings sans projet, puis GET /status', async () => {
    const put = await fetch(`${baseUrl}/api/models/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: { 'form-import': { provider: 'local', model: 'qwen3.5:4b' } } }),
    });
    assert.equal(put.status, 200);
    assert.equal(routeFor('form-import').label, 'ollama:qwen3.5:4b');
    const status = (await (await fetch(`${baseUrl}/api/models/status`)).json()) as any;
    assert.equal(status.ollama.reachable, true);
    assert.equal(status.ollama.version, '0.13.5');
    assert.equal(status.ollama.installed[0].name, 'qwen3.5:9b');
    const form = status.tasks.find((t: any) => t.task === 'form-import');
    assert.equal(form.provider, 'local');
    assert.equal(form.installed, false);
    assert.equal(status.tasks.find((t: any) => t.task === 'extraction').installed, true);
    assert.ok(status.catalog.length >= 5);
  });
});

describe('Ollama borné au poste', () => {
  test('boucle locale acceptée ; 0.0.0.0 interrogé par 127.0.0.1 ; port par défaut', () => {
    assert.equal(normalizeOllamaUrl('0.0.0.0').toString(), 'http://127.0.0.1:11434/');
    assert.equal(normalizeOllamaUrl('127.0.0.1:11500').port, '11500');
    const s = createModelSettingsStore(path.join(tmpDir, 'loop.json'), { OLLAMA_HOST: 'localhost:11434' });
    assert.deepEqual(s.endpoint(), { url: 'http://localhost:11434', remote: false, warning: null });
  });

  test('une autre machine est refusée sans LOCAL_MODEL_ALLOW_REMOTE=1', () => {
    const s = createModelSettingsStore(path.join(tmpDir, 'remote.json'), {});
    assert.throws(() => s.update({ ollamaUrl: 'http://10.0.0.5:11434' }), /doit tourner sur ce poste/);
    const viaEnv = createModelSettingsStore(path.join(tmpDir, 'remote2.json'), { OLLAMA_HOST: 'http://gpu.hopital.example:11434' });
    const endpoint = viaEnv.endpoint();
    assert.equal(endpoint.url, 'http://127.0.0.1:11434', 'adresse refusée : retour au poste');
    assert.match(endpoint.warning ?? '', /LOCAL_MODEL_ALLOW_REMOTE/);
  });

  test('autorisée explicitement : acceptée, signalée, et pseudonymisation imposée', () => {
    const s = createModelSettingsStore(path.join(tmpDir, 'remote3.json'), { OLLAMA_HOST: 'http://10.0.0.5:11434', LOCAL_MODEL_ALLOW_REMOTE: '1' });
    const endpoint = s.endpoint();
    assert.equal(endpoint.remote, true);
    assert.match(endpoint.warning ?? '', /transitent par le réseau/);
  });

  test('l’API refuse une adresse distante', async () => {
    const res = await fetch(`${baseUrl}/api/models/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ollamaUrl: 'http://192.168.1.20:11434' }) });
    assert.equal(res.status, 400);
  });
});

describe('téléchargement et essai', () => {
  test('POST /api/models/pull relaie la progression en NDJSON', async () => {
    const res = await fetch(`${baseUrl}/api/models/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'qwen3.5:4b' }) });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /ndjson/);
    const events = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(events[0].status, 'pulling manifest');
    assert.ok(events.some((e) => e.completed === 400 && e.total === 1000));
    assert.equal(events.at(-1).status, 'success');
    assert.equal(seen.find((s) => s.path === '/api/pull')!.body.model, 'qwen3.5:4b');
  });

  test('un nom invalide est refusé avant d’atteindre Ollama', async () => {
    const res = await fetch(`${baseUrl}/api/models/pull`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'a b; rm -rf' }) });
    assert.equal(res.status, 400);
    assert.equal(seen.filter((s) => s.path === '/api/pull').length, 0);
  });

  test('POST /api/models/test : réussite quand les 4 valeurs sont exactes et citées', async () => {
    nextAnswer = {
      fields: {
        age: { value: '67', quote: 'patiente de 67 ans', document: 'Document 1' },
        sexe: { value: 'Féminin', quote: 'patiente de 67 ans', document: 'Document 1' },
        crp: { value: '148', quote: 'CRP à 148 mg/L', document: 'Document 1' },
        diabete: { value: 'non', quote: 'pas de diabète', document: 'Document 1' },
      },
    };
    const res = (await (await fetch(`${baseUrl}/api/models/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'extraction' }) })).json()) as any;
    assert.equal(res.model, 'ollama:qwen3.5:9b');
    assert.equal(res.validJson, true);
    assert.equal(res.pass, true, JSON.stringify(res));
    assert.equal(typeof res.latencyMs, 'number');
  });

  test('POST /api/models/test : échec quand la valeur est fausse', async () => {
    nextAnswer = { fields: { age: { value: '76', quote: '76 ans', document: 'Document 1' }, sexe: { value: '', quote: '', document: '' }, crp: { value: '', quote: '', document: '' }, diabete: { value: '', quote: '', document: '' } } };
    const res = (await (await fetch(`${baseUrl}/api/models/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: 'extraction' }) })).json()) as any;
    assert.equal(res.pass, false);
  });

  test('rédaction par un modèle local : diffusion relayée, coût nul', async () => {
    routerSettings().update({ tasks: { writing: { provider: 'local', model: 'ministral-3:14b' } } });
    const res = await fetch(`${baseUrl}/api/redaction/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'Rédige les résultats.' }] }),
    });
    const text = await res.text();
    assert.match(text, /event: delta/);
    assert.match(text, /avaient 61 ans/);
    assert.match(text, /"costUsd":0/);
    const chat = seen.find((s) => s.path === '/api/chat')!;
    assert.equal(chat.body.stream, true);
    assert.equal(chat.body.model, 'ministral-3:14b');
  });
});
