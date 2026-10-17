/**
 * Client MCP PubDaily : faux serveur Streamable HTTP (initialize → tools/call),
 * cache mémoire, validation des sorties, refus des URLs non https, délai.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Server } from 'node:http';

const { PubdailyClient, PubdailyError, pubdailyConfig, extractEsearchTerm } = await import(
  '../src/biblio/pubdaily.js'
);

interface FakeState {
  sessionsIssued: number;
  calls: { tool: string; args: unknown; sessionId: string | null }[];
  nextSessionId: string | null; // null => stateless mode
  specialties: { name: string; topicCount?: number | null }[];
  topics: Record<string, unknown[]>;
  failNext404: boolean;
  responseDelayMs: number;
  callError?: { code: number; message: string };
}

function createFakeMcp(): { server: Server; state: FakeState; url: () => string } {
  const state: FakeState = {
    sessionsIssued: 0,
    calls: [],
    nextSessionId: 'sess-1',
    specialties: [{ name: 'Cardiology', topicCount: 12 }, { name: 'Oncology', topicCount: 8 }],
    topics: {
      Cardiology: [{ topic: 'Tirzepatide', trend_score: 91, papers_last_12_months: 385, pubmed_search: 'https://pubmed.ncbi.nlm.nih.gov/?term=tirzepatide' }],
    },
    failNext404: false,
    responseDelayMs: 0,
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      if (state.responseDelayMs > 0) await new Promise((r) => setTimeout(r, state.responseDelayMs));
      const text = Buffer.concat(chunks).toString('utf8');
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text);
      } catch {
        res.writeHead(400); res.end('bad json'); return;
      }
      const sessionId = (req.headers['mcp-session-id'] as string | undefined) ?? null;
      if (state.failNext404 && body.method === 'tools/call') {
        state.failNext404 = false;
        res.writeHead(404); res.end('session gone'); return;
      }
      const method = body.method as string;
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (method === 'initialize' && state.nextSessionId) {
        state.sessionsIssued++;
        headers['Mcp-Session-Id'] = state.nextSessionId;
      }
      res.writeHead(200, headers);
      if (method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake' } } }));
        return;
      }
      if (method === 'notifications/initialized') {
        res.end('');
        return;
      }
      if (method === 'tools/call') {
        const params = body.params as { name: string; arguments: Record<string, unknown> };
        state.calls.push({ tool: params.name, args: params.arguments, sessionId });
        if (state.callError) {
          res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: state.callError }));
          return;
        }
        let structured: unknown = {};
        if (params.name === 'list_specialties') structured = { specialties: state.specialties };
        else if (params.name === 'get_research_trends') {
          const spec = String(params.arguments.specialty);
          structured = { specialty: spec, topics: state.topics[spec] ?? [] };
        } else if (params.name === 'find_trend') {
          structured = { found: true, specialty: 'Cardiology', topic: { topic: 'Tirzepatide', trend_score: 91, pubmed_search: 'https://pubmed.ncbi.nlm.nih.gov/?term=tirzepatide' } };
        } else if (params.name === 'search_papers') {
          structured = {
            papers: [
              { title: 'A trial', journal: 'NEJM', published: '2025', pubmed: 'https://pubmed.ncbi.nlm.nih.gov/40123456/', pmid: 40123456 },
            ],
          };
        } else if (params.name === 'get_top_papers') {
          structured = {
            specialty: params.arguments.specialty,
            papers: [{ title: 'Top', journal: 'JAMA', pubmed: '40000001' }],
          };
        }
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(structured) }],
            structuredContent: structured,
          },
        }));
        return;
      }
      res.writeHead(400); res.end('unknown method');
    });
  });
  return {
    server,
    state,
    url: () => `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`,
  };
}

let fake: ReturnType<typeof createFakeMcp>;

before(async () => {
  fake = createFakeMcp();
  await new Promise<void>((r) => fake.server.listen(0, '127.0.0.1', r));
});
after(async () => {
  await new Promise((r) => fake.server.close(r));
});

describe('PubdailyClient', () => {
  test('refuse une URL non https (hors loopback)', () => {
    assert.throws(() => pubdailyConfig({ PUBDAILY_MCP_URL: 'http://pubdaily.app/api/mcp' } as NodeJS.ProcessEnv), /refusée|invalide/);
  });

  test('accepte http://127.0.0.1 (loopback)', () => {
    const cfg = pubdailyConfig({ PUBDAILY_MCP_URL: 'http://127.0.0.1:1234/mcp' } as NodeJS.ProcessEnv);
    assert.match(cfg.baseUrl, /127\.0\.0\.1/);
  });

  test('réutilise la session puis la recrée sur 404', async () => {
    fake.state.sessionsIssued = 0;
    fake.state.calls = [];
    const client = new PubdailyClient({ ...pubdailyConfig(), baseUrl: fake.url(), disabled: false });
    const a = await client.listSpecialties();
    assert.equal(a.specialties.length, 2);
    assert.equal(fake.state.sessionsIssued, 1);
    // Deuxième appel : session réutilisée, le cache sert si la clé matche — ici args différents.
    await client.getResearchTrends('Cardiology');
    assert.equal(fake.state.sessionsIssued, 1, 'session réutilisée');
    // Perte de session côté serveur → le client en recrée une.
    fake.state.failNext404 = true;
    client.reset();
    const spec = await client.listSpecialties();
    assert.equal(spec.specialties.length, 2);
  });

  test('cache mémoire : deux appels identiques → une seule requête', async () => {
    fake.state.calls = [];
    const client = new PubdailyClient({ ...pubdailyConfig(), baseUrl: fake.url(), disabled: false });
    await client.listSpecialties();
    await client.listSpecialties();
    const toolCalls = fake.state.calls.filter((c) => c.tool === 'list_specialties');
    assert.equal(toolCalls.length, 1, 'deuxième appel servi par le cache');
    assert.equal(client.cacheSize(), 1);
  });

  test('valide le schéma de sortie : un topic sans `topic` est rejeté', async () => {
    fake.state.topics.Oncology = [{ not_a_topic: 'x' } as unknown as object];
    const client = new PubdailyClient({ ...pubdailyConfig(), baseUrl: fake.url(), disabled: false });
    await assert.rejects(() => client.getResearchTrends('Oncology'), (e) => e instanceof PubdailyError && e.kind === 'parse');
  });

  test('coupe au délai imparti', async () => {
    fake.state.responseDelayMs = 300;
    const client = new PubdailyClient({ ...pubdailyConfig(), baseUrl: fake.url(), disabled: false, timeoutMs: 80 });
    await assert.rejects(() => client.listSpecialties(), (e) => e instanceof PubdailyError && e.kind === 'timeout');
    fake.state.responseDelayMs = 0;
  });

  test('propage une erreur de l’outil', async () => {
    fake.state.callError = { code: -32000, message: 'tool failed' };
    const client = new PubdailyClient({ ...pubdailyConfig(), baseUrl: fake.url(), disabled: false });
    await assert.rejects(() => client.listSpecialties(), (e) => e instanceof PubdailyError && e.kind === 'tool');
    fake.state.callError = undefined;
  });

  test('mode désactivé : refuse tout appel', async () => {
    const client = new PubdailyClient({ ...pubdailyConfig(), baseUrl: fake.url(), disabled: true });
    await assert.rejects(() => client.listSpecialties(), (e) => e instanceof PubdailyError && e.kind === 'config');
  });

  test('fonctionne aussi en mode sans session (serveur stateless)', async () => {
    fake.state.nextSessionId = null;
    const client = new PubdailyClient({ ...pubdailyConfig(), baseUrl: fake.url(), disabled: false });
    const r = await client.listSpecialties();
    assert.equal(r.specialties.length, 2);
    fake.state.nextSessionId = 'sess-1';
  });

  test('normalise le PMID d’un article (chaîne, nombre, URL)', async () => {
    const client = new PubdailyClient({ ...pubdailyConfig(), baseUrl: fake.url(), disabled: false });
    const r = await client.searchPapers('tirzepatide');
    assert.equal(r.papers[0]?.pmid, '40123456');
  });
});

describe('extractEsearchTerm', () => {
  test('lit le ?term=', () => {
    assert.equal(
      extractEsearchTerm('https://pubmed.ncbi.nlm.nih.gov/?term=tirzepatide%5Btiab%5D'),
      'tirzepatide[tiab]',
    );
    assert.equal(extractEsearchTerm(null), null);
    assert.equal(extractEsearchTerm('not a url'), null);
  });
});
