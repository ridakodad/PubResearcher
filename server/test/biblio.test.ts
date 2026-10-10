/**
 * Revue bibliographique : bibliothèque (dédoublonnage), routes, exports.
 *
 * Les routes parlent à un FAUX serveur Apify local qui rejoue les sorties
 * réelles de `apify-fixtures/` : aucun appel au vrai Apify, aucun crédit
 * dépensé. Le faux serveur vérifie l'en-tête d'autorisation, et chaque test
 * peut lui faire simuler un crédit épuisé, une panne ou une lenteur.
 *
 * Un test vérifie en dernier que le jeton n'a figuré dans AUCUNE réponse de
 * l'API : c'est la propriété qui compte, plus que n'importe quel cas isolé.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-biblio-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

const TOKEN = 'apify_api_SECRET_do_not_leak_123';

const fixture = (name: string): Record<string, unknown>[] =>
  JSON.parse(fs.readFileSync(new URL(`./apify-fixtures/${name}`, import.meta.url), 'utf8'));
const PUBMED = fixture('pubmed-labrat011.json');
const GEORGE = fixture('scholar-george.json');
const JOHNVC = fixture('scholar-johnvc.json');

/* ─────────────────────────────── Faux serveur Apify ──────────────────────── */

interface Call {
  actor: string;
  auth: string | undefined;
  input: Record<string, unknown>;
  limit: string | null;
}
const calls: Call[] = [];
const behaviour = {
  scholarStatus: 200,
  scholarBody: null as unknown,
  delayMs: 0,
};

const ACTOR_OUTPUT: Record<string, Record<string, unknown>[]> = {
  'labrat011~pubmed-scraper': PUBMED,
  'george.the.developer~google-scholar-scraper': GEORGE,
  'johnvc~google-scholar-api': JOHNVC,
};

let fake: Server;
let fakeBase = '';

function startFake(): Promise<void> {
  fake = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      const match = /^\/v2\/acts\/([^/]+)\/run-sync-get-dataset-items$/.exec(url.pathname);
      const actor = match ? decodeURIComponent(match[1] ?? '') : '';
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        /* entrée vide */
      }
      calls.push({ actor, auth: req.headers.authorization, input, limit: url.searchParams.get('limit') });

      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      const respond = () => {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) {
          return send(401, { error: { type: 'token-not-valid', message: 'User was not found or authentication token is not valid' } });
        }
        const items = ACTOR_OUTPUT[actor];
        if (!items) return send(404, { error: { type: 'record-not-found', message: 'Actor was not found' } });
        const isScholar = actor.includes('scholar');
        if (isScholar && behaviour.scholarStatus !== 200) {
          return send(behaviour.scholarStatus, {
            error: { type: 'x', message: 'Insufficient prepaid funds' },
          });
        }
        if (isScholar && behaviour.scholarBody !== null) return send(200, behaviour.scholarBody);
        const limit = Number(url.searchParams.get('limit') ?? items.length);
        return send(200, items.slice(0, limit));
      };
      if (behaviour.delayMs > 0) setTimeout(respond, behaviour.delayMs);
      else respond();
    });
  });
  return new Promise((resolve) => {
    fake.listen(0, '127.0.0.1', () => {
      const address = fake.address();
      fakeBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });
}

/* ─────────────────────────────── Application testée ──────────────────────── */

let server: Server;
let baseUrl = '';
/** Toutes les réponses de l'API, pour vérifier à la fin que le jeton n'y figure jamais. */
const everyResponse: string[] = [];

async function api<T = any>(
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; data: T; text: string; headers: Headers }> {
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // Buffer.toString conserve le BOM ; Response.text() l'écarterait et le test ne verrait plus l'octet qui compte pour Excel.
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  everyResponse.push(text);
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* export texte */
  }
  return { status: res.status, data: data as T, text, headers: res.headers };
}

let db: typeof import('../src/db/index.js').db;
let repo: typeof import('../src/repo/biblio.js');
let apify: typeof import('../src/biblio/apify.js');

before(async () => {
  await startFake();
  process.env.APIFY_TOKEN = TOKEN;
  process.env.APIFY_API_BASE = fakeBase;
  delete process.env.APIFY_PUBMED_ACTOR;
  delete process.env.APIFY_SCHOLAR_ACTOR;

  const { createApp } = await import('../src/app.js');
  ({ db } = await import('../src/db/index.js'));
  repo = await import('../src/repo/biblio.js');
  apify = await import('../src/biblio/apify.js');

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
  await new Promise<void>((resolve) => fake.close(() => resolve()));
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec('DELETE FROM biblio_hits; DELETE FROM biblio_refs; DELETE FROM biblio_searches;');
  calls.length = 0;
  behaviour.scholarStatus = 200;
  behaviour.scholarBody = null;
  behaviour.delayMs = 0;
  process.env.APIFY_TOKEN = TOKEN;
  delete process.env.APIFY_PUBMED_ACTOR;
  delete process.env.APIFY_SCHOLAR_ACTOR;
});

const SEARCH = { query: 'HoLEP versus TURP', sources: ['pubmed', 'scholar'], maxResults: 5 };

/* ───────────────────────── Dédoublonnage de la bibliothèque ──────────────── */

describe('bibliothèque — rapprochement des notices', () => {
  const pubmed = () => apify.adapterFor('pubmed', 'labrat011/pubmed-scraper');
  const george = () => apify.adapterFor('scholar', 'george.the.developer/google-scholar-scraper');

  function newSearch(source: 'pubmed' | 'scholar'): number {
    return repo.createSearch({ source, actor: 'x', query: 'q', yearFrom: null, yearTo: null, maxResults: 5, sort: 'relevance' });
  }

  test('un article rendu par les deux sources devient une seule référence, enrichie', () => {
    const pm = repo.addRefsFromSearch(newSearch('pubmed'), PUBMED.map((i) => pubmed().map(i)!));
    assert.deepEqual(pm, { added: 5, duplicates: 0 });

    // La notice Scholar de l'essai Habib 2022 : DOI lu dans l'adresse de l'éditeur, 41 citations.
    const scholar = george().map({
      title: 'Holmium laser enucleation versus bipolar resection in the management of large-volume benign prostatic hyperplasia: a randomized controlled trial',
      url: 'https://onlinelibrary.wiley.com/doi/10.1111/iju.14737',
      authors: 'E Habib, MF Abdallah',
      year: 2022,
      publicationVenue: 'International Journal of …',
      abstract: 'extrait Scholar',
      citationCount: 41,
      citationUrl: 'https://scholar.google.com/scholar?cites=1',
    })!;
    assert.equal(scholar.doi, '10.1111/iju.14737');
    assert.deepEqual(repo.addRefsFromSearch(newSearch('scholar'), [scholar]), { added: 0, duplicates: 1 });

    const merged = repo.listRefs().refs.find((r) => r.doi === '10.1111/iju.14737')!;
    assert.deepEqual(merged.sources.sort(), ['pubmed', 'scholar']);
    assert.equal(merged.citedBy, 41, 'Scholar apporte le nombre de citations');
    assert.ok(merged.abstract?.startsWith('OBJECTIVES:'), 'le résumé PubMed est conservé, l’extrait Scholar ne le remplace pas');
    assert.equal(merged.snippet, 'extrait Scholar');
    assert.equal(merged.journal, 'International journal of urology : official journal of the Japanese Urological Association');
    assert.equal(merged.authors[0], 'Habib E', 'les auteurs PubMed font foi');
    assert.equal(repo.counts().total, 5);
  });

  describe('notices réelles : PubMed et Scholar se recoupent sans titre ni DOI identiques', () => {
    const lookup = fixture('pubmed-labrat011-lookup.json');

    // Trois articles des cinq résultats Scholar sont aussi dans les cinq notices PubMed. L'un d'eux
    // n'a aucun DOI côté PubMed et ne se rapproche que par l'identifiant PMC lu dans l'adresse Scholar,
    // son titre différant en outre (« 21(st) Century » / « 21st century »).
    for (const order of [['scholar', 'pubmed'], ['pubmed', 'scholar']] as const) {
      test(`${order[0]} puis ${order[1]} : trois fusions, sept références`, () => {
        const feed = {
          scholar: () => GEORGE.map((i) => george().map(i)!),
          pubmed: () => lookup.map((i) => pubmed().map(i)!),
        };
        const first = repo.addRefsFromSearch(newSearch(order[0]), feed[order[0]]());
        const second = repo.addRefsFromSearch(newSearch(order[1]), feed[order[1]]());
        assert.deepEqual(first, { added: 5, duplicates: 0 });
        assert.deepEqual(second, { added: 2, duplicates: 3 });
        assert.equal(repo.counts().total, 7);

        const both = repo.listRefs({ source: 'both' }).refs;
        assert.deepEqual(both.map((r) => r.pmid).sort(), ['16632179', '26069886', '37561537']);

        const gold = both.find((r) => r.pmid === '26069886')!;
        assert.equal(gold.pmcid, 'PMC4446381');
        assert.equal(gold.doi, null, 'aucun DOI des deux côtés : seul l’identifiant PMC les relie');
        assert.equal(gold.citedBy, 239, 'le nombre de citations vient de Scholar');
        assert.ok(gold.abstract?.startsWith('INTRODUCTION:'), 'le résumé vient de PubMed');
        assert.equal(gold.journal, 'American journal of clinical and experimental urology');
        assert.equal(gold.authors[0], 'Michalak J');

        const sage = both.find((r) => r.pmid === '37561537')!;
        assert.equal(sage.doi, '10.1177/03000605231190763', 'DOI lu dans l’adresse de l’éditeur côté Scholar');
        assert.equal(sage.citedBy, 60);
      });
    }
  });

  test('un titre tronqué par Google Scholar se rapproche de la notice complète, sans DOI', () => {
    repo.addRefsFromSearch(newSearch('pubmed'), PUBMED.map((i) => pubmed().map(i)!));
    const truncated = george().map({
      title: 'Holmium laser enucleation versus bipolar resection in the management of large-volume benign prostatic …',
      url: 'https://exemple.org/article-sans-doi',
      authors: 'E Habib',
      year: 2022,
      publicationVenue: 'Int J Urol',
      abstract: 'x',
      citationCount: 3,
    })!;
    assert.equal(truncated.doi, null);
    assert.deepEqual(repo.addRefsFromSearch(newSearch('scholar'), [truncated]), { added: 0, duplicates: 1 });
  });

  test('l’inverse : la notice connue est tronquée, la nouvelle est complète — le titre complet l’emporte', () => {
    const scholar = george().map({
      title: 'Holmium laser enucleation versus bipolar resection in the management of large-volume benign prostatic …',
      url: 'https://exemple.org/a',
      authors: 'E Habib',
      year: 2022,
      citationCount: 3,
    })!;
    repo.addRefsFromSearch(newSearch('scholar'), [scholar]);
    assert.equal(repo.listRefs().refs[0]!.titleTruncated, true);

    repo.addRefsFromSearch(newSearch('pubmed'), PUBMED.map((i) => pubmed().map(i)!));
    const all = repo.listRefs().refs;
    assert.equal(all.length, 5, 'aucune notice en double');
    const habib = all.find((r) => r.pmid === '34788900')!;
    assert.equal(habib.titleTruncated, false);
    assert.ok(habib.title.endsWith('randomized controlled trial'));
    assert.equal(habib.citedBy, 3);
  });

  test('deux articles de même titre à plusieurs années d’écart ne fusionnent pas', () => {
    const a = george().map({ title: 'Editorial comment on holmium laser enucleation outcomes', url: 'https://a.org/1', authors: 'A B', year: 2010 })!;
    const b = george().map({ title: 'Editorial comment on holmium laser enucleation outcomes', url: 'https://b.org/2', authors: 'C D', year: 2021 })!;
    assert.deepEqual(repo.addRefsFromSearch(newSearch('scholar'), [a, b]), { added: 2, duplicates: 0 });
  });

  test('rejouer la même recherche ne crée rien et ne double pas les rattachements', () => {
    const refs = PUBMED.map((i) => pubmed().map(i)!);
    repo.addRefsFromSearch(newSearch('pubmed'), refs);
    const again = repo.addRefsFromSearch(newSearch('pubmed'), refs);
    assert.deepEqual(again, { added: 0, duplicates: 5 });
    assert.equal(repo.counts().total, 5);
    const hits = db.prepare('SELECT COUNT(*) AS n FROM biblio_hits').get() as { n: number };
    assert.equal(hits.n, 10, '5 références × 2 recherches');
  });

  test('le même article deux fois dans une même liste compte comme doublon', () => {
    const one = pubmed().map(PUBMED[0])!;
    assert.deepEqual(repo.addRefsFromSearch(newSearch('pubmed'), [one, one]), { added: 1, duplicates: 1 });
  });

  test('les recherches interrompues par un arrêt du serveur sont closes en erreur', () => {
    newSearch('pubmed');
    assert.equal(repo.recoverInterruptedSearches(), 1);
    assert.equal(repo.listSearches()[0]!.status, 'error');
    assert.match(repo.listSearches()[0]!.error ?? '', /Interrompue/);
    assert.equal(repo.recoverInterruptedSearches(), 0);
  });
});

/* ───────────────────────────────── Routes ───────────────────────────────── */

describe('routes — état et recherche', () => {
  test('l’état dit si Apify est configuré, sans jamais rendre le jeton', async () => {
    const ok = await api('GET', '/api/biblio/status');
    assert.equal(ok.data.configured, true);
    assert.equal(ok.data.sources.pubmed.actor, 'labrat011/pubmed-scraper');
    assert.equal(ok.data.sources.scholar.supported, true);
    assert.ok(!ok.text.includes(TOKEN));

    delete process.env.APIFY_TOKEN;
    assert.equal((await api('GET', '/api/biblio/status')).data.configured, false);
  });

  test('sans jeton, la recherche est refusée avec la marche à suivre — et rien n’est facturé', async () => {
    delete process.env.APIFY_TOKEN;
    const res = await api('POST', '/api/biblio/searches', SEARCH);
    assert.equal(res.status, 409);
    assert.match(res.data.error, /APIFY_TOKEN/);
    assert.equal(calls.length, 0);
    assert.equal(repo.listSearches().length, 0, 'aucune recherche fantôme dans l’historique');
  });

  test('interroge PubMed et Google Scholar, avec le jeton en en-tête et les bons paramètres', async () => {
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, yearFrom: 2000, yearTo: 2025 });
    assert.equal(res.status, 201);
    assert.equal(res.data.searches.length, 2);
    for (const s of res.data.searches) {
      assert.equal(s.status, 'ok');
      assert.equal(s.returned, 5);
      assert.equal(s.added, 5);
      assert.equal(s.duplicates, 0);
      assert.equal(s.query, 'HoLEP versus TURP');
    }
    assert.equal(res.data.counts.total, 10);
    assert.deepEqual(res.data.counts.bySource, { pubmed: 5, scholar: 5, both: 0 });

    const pm = calls.find((c) => c.actor === 'labrat011~pubmed-scraper')!;
    assert.equal(pm.auth, `Bearer ${TOKEN}`, 'le jeton voyage en en-tête, pas dans l’adresse');
    assert.equal(pm.limit, '5');
    assert.deepEqual(pm.input, {
      mode: 'search_articles',
      query: 'HoLEP versus TURP',
      maxResults: 5,
      sort: 'relevance',
      dateFrom: '2000',
      dateTo: '2025',
    });
    const sc = calls.find((c) => c.actor.startsWith('george'))!;
    assert.equal(sc.input.yearFrom, 2000);
    assert.equal(sc.input.maxResults, 5);
  });

  test('une source en échec n’annule pas l’autre : son erreur est enregistrée et expliquée', async () => {
    behaviour.scholarStatus = 402;
    const res = await api('POST', '/api/biblio/searches', SEARCH);
    assert.equal(res.status, 201);
    const [pm, sc] = res.data.searches;
    assert.equal(pm.status, 'ok');
    assert.equal(sc.status, 'error');
    assert.match(sc.error, /Crédit Apify insuffisant/);
    assert.equal(res.data.counts.total, 5, 'les références de PubMed sont versées malgré l’échec de Scholar');

    const history = (await api('GET', '/api/biblio/overview')).data.searches;
    assert.equal(history.length, 2, 'l’échec reste dans l’historique');
    assert.equal(history.find((s: any) => s.source === 'scholar').status, 'error');
  });

  test('un mauvais jeton est dit sans que le jeton soit cité', async () => {
    process.env.APIFY_TOKEN = 'mauvais-jeton-xyz';
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] });
    assert.equal(res.data.searches[0].status, 'error');
    assert.match(res.data.searches[0].error, /Jeton Apify refusé/);
    assert.ok(!res.text.includes('mauvais-jeton-xyz'));
  });

  test('l’acteur qui ne rend que des notices est signalé', async () => {
    behaviour.scholarBody = [{ message: 'Quota mensuel atteint.', free_tier_notice: true }];
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['scholar'] });
    assert.equal(res.data.searches[0].status, 'error');
    assert.match(res.data.searches[0].error, /Quota mensuel atteint/);
  });

  test('un acteur non pris en charge est enregistré en erreur, avec les acteurs possibles', async () => {
    process.env.APIFY_SCHOLAR_ACTOR = 'quelqu-un/autre-acteur';
    const status = (await api('GET', '/api/biblio/status')).data;
    assert.equal(status.sources.scholar.supported, false);
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['scholar'] });
    assert.match(res.data.searches[0].error, /pas pris en charge/);
    assert.equal(calls.length, 0, 'aucun appel facturé pour un acteur inconnu');
  });

  test('l’autre acteur Scholar pris en charge fonctionne sans autre réglage', async () => {
    process.env.APIFY_SCHOLAR_ACTOR = 'johnvc/google-scholar-api';
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['scholar'] });
    assert.equal(res.data.searches[0].status, 'ok');
    assert.equal(res.data.searches[0].actor, 'johnvc/google-scholar-api');
    assert.equal(calls[0]!.input.mode, 'search');
  });

  test('une seule passe à la fois : un double clic ne facture pas deux fois', async () => {
    behaviour.delayMs = 300;
    const [a, b] = await Promise.all([
      api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] }),
      api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    assert.equal(calls.length, 1);
    // Et le verrou se relâche après la passe.
    behaviour.delayMs = 0;
    assert.equal((await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] })).status, 201);
  });

  test('valide la demande : plafond, source, années, équation', async () => {
    const tooMany = await api('POST', '/api/biblio/searches', { ...SEARCH, maxResults: 101 });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.error, /Au plus 100 résultats/);

    const noSource = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: [] });
    assert.equal(noSource.status, 400);
    assert.match(JSON.stringify(noSource.data.details), /au moins une source/);

    const years = await api('POST', '/api/biblio/searches', { ...SEARCH, yearFrom: 2025, yearTo: 2000 });
    assert.equal(years.status, 400);
    assert.match(JSON.stringify(years.data.details), /année de début/);

    assert.equal((await api('POST', '/api/biblio/searches', { ...SEARCH, query: ' ' })).status, 400);
    assert.equal(calls.length, 0);
  });
});

describe('routes — tri, filtres et dénombrement', () => {
  beforeEach(async () => {
    await api('POST', '/api/biblio/searches', SEARCH);
  });

  test('filtre par décision, source et texte', async () => {
    const all = await api('GET', '/api/biblio/refs');
    assert.equal(all.data.total, 10);
    assert.equal((await api('GET', '/api/biblio/refs?source=pubmed')).data.total, 5);
    assert.equal((await api('GET', '/api/biblio/refs?source=scholar')).data.total, 5);
    assert.equal((await api('GET', '/api/biblio/refs?q=aquablation')).data.total, 1);
    assert.equal((await api('GET', '/api/biblio/refs?q=41638951')).data.total, 1, 'recherche par PMID');
    assert.equal((await api('GET', '/api/biblio/refs?q=100%25')).data.total, 0, 'un « % » saisi n’est pas un joker');
    assert.equal((await api('GET', '/api/biblio/refs?decision=pending')).data.total, 10);
    assert.equal((await api('GET', '/api/biblio/refs?decision=include')).data.total, 0);
  });

  test('trie par année et par citations', async () => {
    const recent = (await api('GET', '/api/biblio/refs?sort=recent')).data.refs;
    assert.equal(recent[0].year, 2026);
    const cited = (await api('GET', '/api/biblio/refs?sort=cited')).data.refs;
    assert.equal(cited[0].citedBy, 368);
    assert.equal(cited.at(-1).citedBy, null, 'les références sans citations sont en fin de liste');
  });

  test('une exclusion exige son motif ; une inclusion l’efface', async () => {
    const id = (await api('GET', '/api/biblio/refs')).data.refs[0].id;

    const noReason = await api('PATCH', `/api/biblio/refs/${id}`, { decision: 'exclude' });
    assert.equal(noReason.status, 400);
    assert.match(noReason.data.error, /motif/);

    const bad = await api('PATCH', `/api/biblio/refs/${id}`, { decision: 'exclude', exclusionReason: 'inventé' });
    assert.equal(bad.status, 400);

    const ok = await api('PATCH', `/api/biblio/refs/${id}`, { decision: 'exclude', exclusionReason: 'design', note: 'Série de cas' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ref.decision, 'exclude');
    assert.equal(ok.data.ref.exclusionReason, 'design');
    assert.equal(ok.data.ref.note, 'Série de cas');
    assert.equal(ok.data.counts.exclude, 1);

    const back = await api('PATCH', `/api/biblio/refs/${id}`, { decision: 'include' });
    assert.equal(back.data.ref.exclusionReason, null);
    assert.equal(back.data.ref.note, 'Série de cas', 'la note survit au changement de décision');
    assert.equal(back.data.counts.include, 1);

    assert.equal((await api('PATCH', '/api/biblio/refs/99999', { decision: 'include' })).status, 404);
    assert.equal((await api('PATCH', `/api/biblio/refs/${id}`, { decision: 'peut-être' })).status, 400);
  });

  test('le diagramme de flux se calcule des recherches et des décisions', async () => {
    const refs = (await api('GET', '/api/biblio/refs')).data.refs;
    await api('PATCH', `/api/biblio/refs/${refs[0].id}`, { decision: 'include' });
    await api('PATCH', `/api/biblio/refs/${refs[1].id}`, { decision: 'maybe' });
    await api('PATCH', `/api/biblio/refs/${refs[2].id}`, { decision: 'exclude', exclusionReason: 'population' });
    await api('PATCH', `/api/biblio/refs/${refs[3].id}`, { decision: 'exclude', exclusionReason: 'population' });
    await api('PATCH', `/api/biblio/refs/${refs[4].id}`, { decision: 'exclude', exclusionReason: 'language' });

    const { prisma, counts } = (await api('GET', '/api/biblio/overview')).data;
    assert.equal(prisma.identified, 10);
    assert.deepEqual(prisma.bySource, { pubmed: 5, scholar: 5 });
    assert.equal(prisma.duplicatesRemoved, 0);
    assert.equal(prisma.screened, 10);
    assert.equal(prisma.included, 1);
    assert.equal(prisma.maybe, 1);
    assert.equal(prisma.pending, 5);
    assert.equal(prisma.excluded, 3);
    assert.deepEqual(prisma.excludedByReason, [
      { reason: 'population', count: 2 },
      { reason: 'language', count: 1 },
    ]);
    assert.equal(prisma.included + prisma.maybe + prisma.pending + prisma.excluded, prisma.screened);
    assert.equal(counts.total, 10);

    // Une seconde passe identique ne change que les doublons : identifiées − doublons = à trier.
    await api('POST', '/api/biblio/searches', SEARCH);
    const after = (await api('GET', '/api/biblio/overview')).data.prisma;
    assert.equal(after.identified, 20);
    assert.equal(after.duplicatesRemoved, 10);
    assert.equal(after.identified - after.duplicatesRemoved, after.screened);
  });
});

describe('routes — exports', () => {
  beforeEach(async () => {
    await api('POST', '/api/biblio/searches', SEARCH);
    const refs = (await api('GET', '/api/biblio/refs?source=pubmed')).data.refs;
    await api('PATCH', `/api/biblio/refs/${refs[0].id}`, { decision: 'include', note: 'Essai pivot' });
  });

  test('RIS : lisible par un gestionnaire de références', async () => {
    const res = await api('GET', '/api/biblio/export?format=ris');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="references-toutes-\d{4}-\d{2}-\d{2}\.ris"$/);
    assert.match(res.text, /^TY {2}- JOUR\r\n/);
    assert.match(res.text, /AU {2}- Ritter M\r\n/);
    assert.match(res.text, /DO {2}- 10\.1016\/j\.euf\.2026\.01\.006\r\n/);
    assert.match(res.text, /SP {2}- 266\r\nEP {2}- 274\r\n/);
    assert.match(res.text, /AN {2}- 41638951\r\n/);
    assert.match(res.text, /N1 {2}- Tri : Retenue ; Note : Essai pivot ; Sources : PubMed\r\n/);
    assert.equal((res.text.match(/^ER {2}- $/gm) ?? []).length, 10);
  });

  test('BibTeX : clés uniques, auteurs « Nom, Initiales », caractères spéciaux protégés', async () => {
    const res = await api('GET', '/api/biblio/export?format=bibtex');
    assert.match(res.headers.get('content-disposition') ?? '', /\.bib"$/);
    assert.match(res.text, /@article\{ritter2026,/);
    assert.match(res.text, /author = \{Ritter, M and Stein, J and Barber, N/);
    assert.match(res.text, /title = \{\{WATER III/);
    assert.match(res.text, /pages = \{266--274\}/);
    const keys = [...res.text.matchAll(/@article\{([^,]+),/g)].map((m) => m[1]);
    assert.equal(new Set(keys).size, keys.length, 'chaque clé BibTeX est unique');
    assert.equal(keys.length, 10);
  });

  test('CSV : BOM pour Excel, séparateur point-virgule, filtre par décision', async () => {
    const all = await api('GET', '/api/biblio/export?format=csv');
    assert.ok(all.text.startsWith('﻿Sources;Titre;Auteurs;Année'));
    assert.equal(all.text.trim().split('\r\n').length, 11, 'en-tête + 10 références');

    const kept = await api('GET', '/api/biblio/export?format=csv&decision=include');
    assert.equal(kept.text.trim().split('\r\n').length, 2);
    assert.match(kept.text, /Retenue/);
    assert.match(kept.text, /Essai pivot/);
  });

  test('stratégies de recherche : la chaîne exacte, la date et les effectifs', async () => {
    const res = await api('GET', '/api/biblio/export?format=searches');
    assert.match(res.headers.get('content-disposition') ?? '', /strategies-de-recherche-/);
    assert.match(res.text, /Date de la recherche;Source;Acteur Apify;Équation de recherche/);
    assert.match(res.text, /PubMed;labrat011\/pubmed-scraper;HoLEP versus TURP;;;5;5;5;0;réussie/);
    assert.match(res.text, /Google Scholar;george\.the\.developer\/google-scholar-scraper/);
  });

  test('refuse un format inconnu', async () => {
    assert.equal((await api('GET', '/api/biblio/export?format=docx')).status, 400);
  });
});

describe('confidentialité du jeton', () => {
  test('le jeton n’a figuré dans aucune réponse de l’API', () => {
    assert.ok(everyResponse.length > 40, `${everyResponse.length} réponses examinées`);
    const leaked = everyResponse.filter((body) => body.includes(TOKEN));
    assert.equal(leaked.length, 0);
  });

  test('ni dans le message d’une erreur du client Apify', async () => {
    const cfg = { ...apify.apifyConfig(), token: TOKEN, baseUrl: 'http://127.0.0.1:1' };
    await assert.rejects(
      apify.runActor(cfg, 'labrat011/pubmed-scraper', {}, 5),
      (e: unknown) => e instanceof apify.ApifyError && e.kind === 'network' && !e.message.includes(TOKEN),
    );
  });
});
