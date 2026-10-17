/**
 * Routes de l'onglet « Veille PubDaily » : lecture publique du MCP PubDaily
 * (via un faux serveur Streamable HTTP), détail d'un sujet (via un faux EUtils),
 * import projet-scopé, dédoublonnage et persistance du champ `pubdaily`.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-biblio-pubdaily-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';
delete process.env.ANTHROPIC_API_KEY;

const { createApp } = await import('../src/app.js');
const { PubdailyClient, pubdailyConfig, setPubdailyClient } = await import('../src/biblio/pubdaily.js');
const { createFakeEutils, syntheticRecord } = await import('./eutils-fake.js');

/* ---- Faux serveur MCP PubDaily (minimal) --------------------------------- */
function createFakeMcp(): { server: Server; url: () => string } {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> };
      };
      res.setHeader('Content-Type', 'application/json');
      if (body.method === 'initialize') {
        res.setHeader('Mcp-Session-Id', 'session-fake');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } } }));
        return;
      }
      if (body.method === 'notifications/initialized') { res.end(''); return; }
      if (body.method === 'tools/call') {
        const name = body.params?.name;
        let structured: unknown = {};
        if (name === 'list_specialties') structured = { specialties: [{ name: 'Cardiology', topicCount: 1 }] };
        else if (name === 'get_research_trends') structured = {
          specialty: 'Cardiology',
          topics: [{
            topic: 'Tirzepatide',
            trend_score: 91,
            papers_last_12_months: 385,
            growth_vs_previous_12_months_pct: 87,
            new_trials_last_12_months: 41,
            pubmed_search: 'https://pubmed.ncbi.nlm.nih.gov/?term=tirzepatide%5Btiab%5D',
            page: 'https://pubdaily.app/trends/tirzepatide-cardiovascular/',
          }],
        };
        else if (name === 'find_trend') structured = { found: true, specialty: 'Cardiology', topic: { topic: 'Tirzepatide', trend_score: 91 } };
        else if (name === 'search_papers') structured = { papers: [{ title: 'A trial', journal: 'NEJM', pmid: '2' }] };
        else if (name === 'get_top_papers') structured = { specialty: 'Cardiology', papers: [{ title: 'Top', journal: 'JAMA', pmid: '3' }] };
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { structuredContent: structured, content: [{ type: 'text', text: JSON.stringify(structured) }] } }));
        return;
      }
      res.writeHead(400); res.end();
    });
  });
  return { server, url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` };
}

let server: Server;
let fakeEutils: Server;
let fakeMcp: ReturnType<typeof createFakeMcp>;
let base = '';

before(async () => {
  const records = [1, 2, 3].map((n) => syntheticRecord(n, { y: 2024, m: 6, d: 1 }));
  const fake = createFakeEutils(records);
  fakeEutils = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const endpoint = /\/(\w+)\.fcgi$/.exec(url.pathname)?.[1] ?? '';
      const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8') || url.search);
      const out = fake.handle(endpoint, params);
      res.writeHead(out.status, { 'Content-Type': endpoint === 'esearch' ? 'application/json' : 'application/xml', ...(out.headers ?? {}) });
      res.end(out.body);
    });
  });
  await new Promise<void>((r) => fakeEutils.listen(0, '127.0.0.1', r));
  process.env.NCBI_EUTILS_BASE = `http://127.0.0.1:${(fakeEutils.address() as { port: number }).port}/entrez/eutils`;

  fakeMcp = createFakeMcp();
  await new Promise<void>((r) => fakeMcp.server.listen(0, '127.0.0.1', r));
  setPubdailyClient(new PubdailyClient({ ...pubdailyConfig(), baseUrl: fakeMcp.url(), disabled: false }));

  await new Promise<void>((r) => {
    server = createApp().listen(0, () => r());
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  await new Promise((r) => fakeEutils.close(r));
  await new Promise((r) => fakeMcp.server.close(r));
  setPubdailyClient(null);
  const { db } = await import('../src/db/index.js');
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const get = async (route: string, project?: string) => {
  const headers: Record<string, string> = {};
  if (project) headers['X-Project'] = project;
  const res = await fetch(`${base}${route}`, { headers });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};
const post = async (route: string, body: unknown, project?: string) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (project) headers['X-Project'] = project;
  const res = await fetch(`${base}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, data: (await res.json()) as Record<string, any> };
};

describe('routes PubDaily (lecture publique)', () => {
  test('GET /specialties', async () => {
    const r = await get('/api/biblio/pubdaily/specialties');
    assert.equal(r.status, 200);
    assert.equal(r.data.specialties.length, 1);
    assert.equal(r.data.specialties[0].name, 'Cardiology');
  });

  test('GET /trends', async () => {
    const r = await get('/api/biblio/pubdaily/trends?specialty=Cardiology');
    assert.equal(r.status, 200);
    assert.equal(r.data.topics.length, 1);
    assert.equal(r.data.topics[0].topic, 'Tirzepatide');
  });

  test('GET /find-trend', async () => {
    const r = await get('/api/biblio/pubdaily/find-trend?q=tirzepatide');
    assert.equal(r.status, 200);
    assert.equal(r.data.found, true);
  });

  test('GET /papers', async () => {
    const r = await get('/api/biblio/pubdaily/papers?specialty=Cardiology&limit=5');
    assert.equal(r.status, 200);
    assert.ok(r.data.papers.length >= 1);
  });

  test('GET /search-papers', async () => {
    const r = await get('/api/biblio/pubdaily/search-papers?q=tirzepatide');
    assert.equal(r.status, 200);
    assert.ok(r.data.papers.length >= 1);
  });
});

describe('routes PubDaily (projet-scopées)', () => {
  test('GET /topics/:slug/papers lit le ?term= puis interroge PubMed', async () => {
    const url = '/api/biblio/pubdaily/topics/tirzepatide-cardiovascular/papers?pubmed_search=' + encodeURIComponent('https://pubmed.ncbi.nlm.nih.gov/?term=tirzepatide');
    const r = await get(url);
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.data.pmids));
    assert.ok(r.data.papers.length >= 1);
    // Flag déjà-importé : rien n'est importé pour l'instant → false partout.
    assert.ok(r.data.papers.every((p: { alreadyImported: boolean }) => p.alreadyImported === false));
  });

  test('POST /import importe les PMIDs sélectionnés, enregistre la source pubdaily et la traçabilité', async () => {
    // Récupère un PMID du faux PubMed.
    const topic = await get('/api/biblio/pubdaily/topics/x/papers?pubmed_search=' + encodeURIComponent('https://pubmed.ncbi.nlm.nih.gov/?term=tirzepatide'));
    const pmid = topic.data.pmids[0] as string;
    const r = await post('/api/biblio/pubdaily/import', {
      specialty: 'Cardiology',
      topic: 'Tirzepatide',
      page: 'https://pubdaily.app/trends/tirzepatide-cardiovascular/',
      pmids: [pmid],
    });
    assert.equal(r.status, 201);
    assert.ok(r.data.imported >= 1);
    assert.equal(r.data.search.source, 'pubdaily');
    assert.equal(r.data.search.pubdailyTopic, 'Tirzepatide');
    assert.equal(r.data.search.pubdailySpecialty, 'Cardiology');
    assert.equal(r.data.search.pubdailyPage, 'https://pubdaily.app/trends/tirzepatide-cardiovascular/');

    // Dédoublonnage : un deuxième appel renvoie la référence comme déjà connue.
    const topic2 = await get('/api/biblio/pubdaily/topics/x/papers?pubmed_search=' + encodeURIComponent('https://pubmed.ncbi.nlm.nih.gov/?term=tirzepatide'));
    const already = topic2.data.papers.find((p: { pmid: string | null; alreadyImported: boolean }) => p.pmid === pmid);
    assert.ok(already, 'PMID retrouvé');
    assert.equal(already.alreadyImported, true);

    // La référence apparaît avec source 'pubdaily'.
    const refs = await get('/api/biblio/refs');
    assert.ok(refs.data.refs.some((ref: { pmid: string | null; sources: string[] }) => ref.pmid === pmid && ref.sources.includes('pubdaily')));
  });
});
