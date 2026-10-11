/**
 * Revue bibliographique : bibliothèque (dédoublonnage), routes, exports.
 *
 * Les routes parlent à un FAUX serveur local qui joue deux rôles : les
 * E-utilities du NCBI (PubMed, notices réelles de `eutils-fixtures/`) et Apify
 * (Google Scholar, sorties réelles de `apify-fixtures/`). Aucun appel au vrai
 * NCBI ni au vrai Apify, aucun crédit dépensé. Chaque test peut lui faire
 * simuler un crédit épuisé, une panne ou une lenteur.
 *
 * Un test vérifie en dernier que ni le jeton Apify ni la clé NCBI n'ont figuré
 * dans AUCUNE réponse de l'API : c'est la propriété qui compte, plus que
 * n'importe quel cas isolé.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Server } from 'node:http';
import { createFakeEutils, fixtureText, splitRecords } from './eutils-fake.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-biblio-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

const TOKEN = 'apify_api_SECRET_do_not_leak_123';
const NCBI_KEY = 'ncbi_key_SECRET_do_not_leak_789';

const fixture = (name: string): Record<string, unknown>[] =>
  JSON.parse(fs.readFileSync(new URL(`./apify-fixtures/${name}`, import.meta.url), 'utf8'));
const GEORGE = fixture('scholar-george.json');
const JOHNVC = fixture('scholar-johnvc.json');
const HOLEP = splitRecords(fixtureText('efetch-holep.xml'));
const LOOKUP_XML = fixtureText('efetch-holep-lookup.xml');

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
  /** Statut forcé pour toutes les réponses du faux NCBI (panne). */
  eutilsStatus: 200,
};

/** Le faux NCBI : les cinq notices réelles de la recherche HoLEP, quelle que soit l'équation. */
const eutils = createFakeEutils(HOLEP, {
  intercept: () => (behaviour.eutilsStatus !== 200 ? { status: behaviour.eutilsStatus, body: 'Service Unavailable' } : null),
  queryTranslation: (term) => `"${term}"[All Fields]`,
});

const ACTOR_OUTPUT: Record<string, Record<string, unknown>[]> = {
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
      const ncbi = /^\/entrez\/eutils\/(\w+)\.fcgi$/.exec(url.pathname);
      if (ncbi) {
        const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8') || url.search);
        const reply = () => {
          const out = eutils.handle(ncbi[1] ?? '', params);
          res.writeHead(out.status, { 'Content-Type': ncbi[1] === 'esearch' ? 'application/json' : 'text/xml' });
          res.end(out.body);
        };
        if (behaviour.delayMs > 0) setTimeout(reply, behaviour.delayMs);
        else reply();
        return;
      }
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
let ncbi: typeof import('../src/biblio/eutils.js');

before(async () => {
  await startFake();
  process.env.APIFY_TOKEN = TOKEN;
  process.env.APIFY_API_BASE = fakeBase;
  process.env.NCBI_EUTILS_BASE = `${fakeBase}/entrez/eutils`;
  // Avec une clé, le débit permis est de 10 requêtes par seconde : les tests vont plus vite, et vérifient qu'elle ne fuit pas.
  process.env.NCBI_API_KEY = NCBI_KEY;
  process.env.NCBI_EMAIL = 'revue@chu.example';
  delete process.env.APIFY_SCHOLAR_ACTOR;

  const { createApp } = await import('../src/app.js');
  ({ db } = await import('../src/db/index.js'));
  repo = await import('../src/repo/biblio.js');
  apify = await import('../src/biblio/apify.js');
  ncbi = await import('../src/biblio/eutils.js');

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
  eutils.calls.length = 0;
  behaviour.scholarStatus = 200;
  behaviour.scholarBody = null;
  behaviour.delayMs = 0;
  behaviour.eutilsStatus = 200;
  process.env.APIFY_TOKEN = TOKEN;
  delete process.env.APIFY_SCHOLAR_ACTOR;
});

const SEARCH = { query: 'HoLEP versus TURP', sources: ['pubmed', 'scholar'], maxResults: 5 };

/* ───────────────────────── Dédoublonnage de la bibliothèque ──────────────── */

describe('bibliothèque — rapprochement des notices', () => {
  const pubmedRefs = () => ncbi.parsePubmedXml(HOLEP.join('')).refs;
  const george = () => apify.adapterFor('scholar', 'george.the.developer/google-scholar-scraper');

  function newSearch(source: 'pubmed' | 'scholar'): number {
    return repo.createSearch({ source, actor: 'x', query: 'q', yearFrom: null, yearTo: null, maxResults: 5, sort: 'relevance' });
  }

  test('un article rendu par les deux sources devient une seule référence, enrichie', () => {
    const pm = repo.addRefsFromSearch(newSearch('pubmed'), pubmedRefs());
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

    // Trois articles des cinq résultats Scholar sont aussi dans les cinq notices PubMed. L'un d'eux
    // n'a aucun DOI côté PubMed et ne se rapproche que par l'identifiant PMC lu dans l'adresse Scholar,
    // son titre différant en outre (« 21(st) Century » / « 21st century »).
    for (const order of [['scholar', 'pubmed'], ['pubmed', 'scholar']] as const) {
      test(`${order[0]} puis ${order[1]} : trois fusions, sept références`, () => {
        const feed = {
          scholar: () => GEORGE.map((i) => george().map(i)!),
          pubmed: () => ncbi.parsePubmedXml(LOOKUP_XML).refs,
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
    repo.addRefsFromSearch(newSearch('pubmed'), pubmedRefs());
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

    repo.addRefsFromSearch(newSearch('pubmed'), pubmedRefs());
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
    const refs = pubmedRefs();
    repo.addRefsFromSearch(newSearch('pubmed'), refs);
    const again = repo.addRefsFromSearch(newSearch('pubmed'), refs);
    assert.deepEqual(again, { added: 0, duplicates: 5 });
    assert.equal(repo.counts().total, 5);
    const hits = db.prepare('SELECT COUNT(*) AS n FROM biblio_hits').get() as { n: number };
    assert.equal(hits.n, 10, '5 références × 2 recherches');
  });

  test('le même article deux fois dans une même liste compte comme doublon — et deux fois comme notice identifiée', () => {
    const one = pubmedRefs()[0]!;
    const id = newSearch('pubmed');
    assert.deepEqual(repo.addRefsFromSearch(id, [one, one]), { added: 1, duplicates: 1 });
    repo.finishSearch(id, { status: 'ok', returned: 2, skipped: 0, added: 1, duplicates: 1, durationMs: 1 });
    const hit = db.prepare('SELECT copies FROM biblio_hits').get() as { copies: number };
    assert.equal(hit.copies, 2);
    const flow = repo.prisma();
    assert.equal(flow.identified, 2);
    assert.equal(flow.duplicatesRemoved, 1);
    assert.equal(flow.screened, 1);
  });

  test('des identifiants différents l’emportent sur un titre ou un DOI communs (cas réels de PubMed)', () => {
    const base = pubmedRefs()[0]!;
    const letter = (pmid: string, doi: string | null) => ({
      ...base,
      title: 'Duration of antibiotics in complicated appendicitis',
      year: 2023,
      pmid,
      pmcid: null,
      doi,
    });
    // Quatre lettres au Lancet : même titre, PMID et DOI différents.
    const lancet = [
      letter('37838436', '10.1016/s0140-6736(23)01567-2'),
      letter('37838434', '10.1016/s0140-6736(23)01565-9'),
      letter('37838433', '10.1016/s0140-6736(23)01566-0'),
    ];
    assert.deepEqual(repo.addRefsFromSearch(newSearch('pubmed'), lancet), { added: 3, duplicates: 0 });
    // Correspondance du NEJM : cinq PMID publiés sous un même DOI.
    const nejm = ['33657306', '33657305'].map((pmid) => ({ ...letter(pmid, '10.1056/nejmc2035865'), title: `NEJM letter ${pmid}` }));
    assert.deepEqual(repo.addRefsFromSearch(newSearch('pubmed'), nejm), { added: 2, duplicates: 0 });
    // Une notice Embase sans PMID, au même DOI qu'une lettre : c'est bien la même.
    const embase = { ...letter('', '10.1016/s0140-6736(23)01565-9'), pmid: null, source: 'embase' as const };
    assert.deepEqual(repo.addRefsFromSearch(newSearch('pubmed'), [embase]), { added: 0, duplicates: 1 });
    assert.equal(repo.counts().total, 5);
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

/** Envoie un fichier à importer, comme le fait le formulaire de la page. */
async function importFile(content: string | Buffer, name: string, fields: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set('file', new Blob([content]), name);
  const res = await fetch(`${baseUrl}/api/biblio/imports`, { method: 'POST', body: form });
  const text = await res.text();
  everyResponse.push(text);
  return { status: res.status, data: JSON.parse(text) as any };
}

describe('routes — état et recherche', () => {
  test('l’état dit ce qui marche : PubMed sans rien, Scholar avec Apify — sans jamais rendre le jeton ni la clé', async () => {
    const ok = await api('GET', '/api/biblio/status');
    assert.equal(ok.data.configured, true);
    assert.equal(ok.data.sources.pubmed.actor, 'NCBI E-utilities');
    assert.equal(ok.data.sources.pubmed.available, true);
    assert.equal(ok.data.pubmed.apiKey, true);
    assert.equal(ok.data.pubmed.maxRecords, 10_000);
    assert.equal(ok.data.sources.scholar.available, true);
    assert.ok(ok.data.importSources.some((s: any) => s.id === 'embase' && s.category === 'database'));
    assert.ok(ok.data.importSources.some((s: any) => s.id === 'scholar' && s.category === 'other'));
    assert.ok(!ok.text.includes(TOKEN) && !ok.text.includes(NCBI_KEY));

    delete process.env.APIFY_TOKEN;
    const off = (await api('GET', '/api/biblio/status')).data;
    assert.equal(off.configured, false);
    assert.equal(off.sources.scholar.available, false);
    assert.equal(off.sources.pubmed.available, true, 'PubMed ne dépend pas d’Apify');
  });

  test('sans jeton Apify, PubMed fonctionne ; Google Scholar est refusé avec la marche à suivre, sans rien facturer', async () => {
    delete process.env.APIFY_TOKEN;
    const pubmed = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] });
    assert.equal(pubmed.status, 201);
    assert.equal(pubmed.data.searches[0].status, 'ok');

    const scholar = await api('POST', '/api/biblio/searches', SEARCH);
    assert.equal(scholar.status, 409);
    assert.match(scholar.data.error, /APIFY_TOKEN/);
    assert.match(scholar.data.error, /PubMed, lui, fonctionne sans jeton/);
    assert.equal(calls.length, 0);
    assert.equal(repo.listSearches().length, 1, 'aucune recherche fantôme dans l’historique');
  });

  test('interroge PubMed (E-utilities) et Google Scholar, avec les bons paramètres', async () => {
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, yearFrom: 2000, yearTo: 2026 });
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
    assert.deepEqual(res.data.counts.bySource, { pubmed: 5, scholar: 5 });

    const pm = res.data.searches.find((s: any) => s.source === 'pubmed');
    assert.equal(pm.actor, 'NCBI E-utilities');
    assert.equal(pm.totalCount, 5, 'le nombre total annoncé par PubMed est consigné');
    assert.equal(pm.queryTranslation, '"HoLEP versus TURP"[All Fields]');
    assert.equal(pm.maxResults, 0, '0 : tout récupérer');

    const search = eutils.calls.find((c) => c.endpoint === 'esearch')!;
    assert.equal(search.params.get('term'), 'HoLEP versus TURP');
    assert.equal(search.params.get('tool'), 'PubResearcher');
    assert.equal(search.params.get('email'), 'revue@chu.example');
    assert.equal(search.params.get('mindate'), '2000');
    assert.equal(search.params.get('maxdate'), '2026');
    assert.equal(search.params.get('datetype'), 'pdat');
    const fetches = eutils.calls.filter((c) => c.endpoint === 'efetch');
    assert.equal(fetches.length, 1);
    assert.equal(fetches[0]!.params.get('retmax'), '5');

    const sc = calls.find((c) => c.actor.startsWith('george'))!;
    assert.equal(sc.auth, `Bearer ${TOKEN}`, 'le jeton voyage en en-tête, pas dans l’adresse');
    assert.equal(sc.input.yearFrom, 2000);
    assert.equal(sc.input.maxResults, 5);
  });

  test('PubMed en exploration : les N premiers seulement', async () => {
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'], pubmedMax: 2 });
    const [pm] = res.data.searches;
    assert.equal(pm.returned, 2);
    assert.equal(pm.totalCount, 5);
    assert.equal(pm.maxResults, 2);
    assert.match(pm.warnings.join(' '), /Exploration : 2 premiers résultats sur 5/);
  });

  test('les balises PubMed ne partent pas chez Scholar : retirées, et consignées', async () => {
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, query: 'holep[tiab] AND turp[MeSH Terms]' });
    const sc = res.data.searches.find((s: any) => s.source === 'scholar');
    assert.equal(sc.query, 'holep[tiab] AND turp[MeSH Terms]', 'l’équation saisie reste celle de l’historique');
    assert.equal(sc.sentQuery, 'holep AND turp');
    assert.match(sc.warnings[0], /Balises de champ PubMed retirées pour Google Scholar, qui ne les comprend pas \(\[tiab\], \[MeSH Terms\]\)/);
    assert.equal(calls.find((c) => c.actor.startsWith('george'))!.input.query, 'holep AND turp');
    const pm = res.data.searches.find((s: any) => s.source === 'pubmed');
    assert.equal(pm.sentQuery, null, 'PubMed reçoit l’équation telle quelle');
    assert.equal(eutils.calls[0]!.params.get('term'), 'holep[tiab] AND turp[MeSH Terms]');
  });

  test('une source en échec n’annule pas l’autre : son erreur est enregistrée et expliquée (201)', async () => {
    behaviour.scholarStatus = 402;
    const res = await api('POST', '/api/biblio/searches', SEARCH);
    assert.equal(res.status, 201);
    const pm = res.data.searches.find((s: any) => s.source === 'pubmed');
    const sc = res.data.searches.find((s: any) => s.source === 'scholar');
    assert.equal(pm.status, 'ok');
    assert.equal(sc.status, 'error');
    assert.match(sc.error, /Crédit Apify insuffisant/);
    assert.equal(res.data.counts.total, 5, 'les références de PubMed sont versées malgré l’échec de Scholar');

    const history = (await api('GET', '/api/biblio/overview')).data.searches;
    assert.equal(history.length, 2, 'l’échec reste dans l’historique');
    assert.equal(history.find((s: any) => s.source === 'scholar').status, 'error');
  });

  test('toutes les sources en échec : réponse en erreur (502), passes consignées quand même', async () => {
    behaviour.scholarStatus = 402;
    behaviour.eutilsStatus = 503;
    const res = await api('POST', '/api/biblio/searches', SEARCH);
    assert.equal(res.status, 502);
    assert.equal(res.data.code, 'all_sources_failed');
    assert.match(res.data.error, /^La recherche a échoué\. PubMed : Le service E-utilities de PubMed est indisponible \(erreur 503\)/);
    assert.match(res.data.error, /Google Scholar : Crédit Apify insuffisant/);
    assert.equal(res.data.details.searches.length, 2);
    assert.equal(repo.listSearches().filter((s) => s.status === 'error').length, 2);
    assert.equal(eutils.calls.length, 4, 'PubMed a été retenté avant d’abandonner');
  });

  test('PubMed au-delà du plafond : échec consigné avec le nombre total, rien d’importé', async () => {
    process.env.BIBLIO_PUBMED_MAX = '3';
    try {
      const res = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] });
      assert.equal(res.status, 502);
      assert.match(res.data.error, /5 résultats dans PubMed, au-delà du plafond de 3 notices/);
      const [search] = repo.listSearches();
      assert.equal(search!.status, 'error');
      assert.equal(search!.totalCount, 5);
      assert.equal(repo.counts().total, 0);
    } finally {
      delete process.env.BIBLIO_PUBMED_MAX;
    }
  });

  test('un mauvais jeton est dit sans que le jeton soit cité', async () => {
    process.env.APIFY_TOKEN = 'mauvais-jeton-xyz';
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['scholar'] });
    assert.equal(res.status, 502);
    assert.equal(res.data.details.searches[0].status, 'error');
    assert.match(res.data.details.searches[0].error, /Jeton Apify refusé/);
    assert.ok(!res.text.includes('mauvais-jeton-xyz'));
  });

  test('l’acteur qui ne rend que des notices est signalé', async () => {
    behaviour.scholarBody = [{ message: 'Quota mensuel atteint.', free_tier_notice: true }];
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['scholar'] });
    assert.equal(res.data.details.searches[0].status, 'error');
    assert.match(res.data.error, /Quota mensuel atteint/);
  });

  test('un acteur non pris en charge est enregistré en erreur, avec les acteurs possibles', async () => {
    process.env.APIFY_SCHOLAR_ACTOR = 'quelqu-un/autre-acteur';
    const status = (await api('GET', '/api/biblio/status')).data;
    assert.equal(status.sources.scholar.supported, false);
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['scholar'] });
    assert.match(res.data.details.searches[0].error, /pas pris en charge/);
    assert.equal(calls.length, 0, 'aucun appel facturé pour un acteur inconnu');
  });

  test('l’autre acteur Scholar pris en charge fonctionne sans autre réglage', async () => {
    process.env.APIFY_SCHOLAR_ACTOR = 'johnvc/google-scholar-api';
    const res = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['scholar'] });
    assert.equal(res.data.searches[0].status, 'ok');
    assert.equal(res.data.searches[0].actor, 'johnvc/google-scholar-api');
    assert.equal(calls[0]!.input.mode, 'search');
  });

  test('une seule passe à la fois : un double clic ne lance pas deux récupérations', async () => {
    behaviour.delayMs = 300;
    const [a, b] = await Promise.all([
      api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] }),
      api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] }),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [201, 409]);
    assert.equal(eutils.calls.filter((c) => c.endpoint === 'esearch').length, 1);
    // Et le verrou se relâche après la passe.
    behaviour.delayMs = 0;
    assert.equal((await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] })).status, 201);
  });

  test('valide la demande : plafond Scholar, source, années, équation, exploration PubMed', async () => {
    const tooMany = await api('POST', '/api/biblio/searches', { ...SEARCH, maxResults: 101 });
    assert.equal(tooMany.status, 400);
    assert.match(tooMany.data.error, /Au plus 100 résultats Google Scholar/);

    const noSource = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: [] });
    assert.equal(noSource.status, 400);
    assert.match(JSON.stringify(noSource.data.details), /au moins une source/);

    const imported = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['embase'] });
    assert.equal(imported.status, 400, 'Embase s’importe, il ne s’interroge pas d’ici');

    const years = await api('POST', '/api/biblio/searches', { ...SEARCH, yearFrom: 2025, yearTo: 2000 });
    assert.equal(years.status, 400);
    assert.match(JSON.stringify(years.data.details), /année de début/);

    const window = await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'], pubmedMax: 10_000 });
    assert.equal(window.status, 400);

    assert.equal((await api('POST', '/api/biblio/searches', { ...SEARCH, query: ' ' })).status, 400);
    assert.equal(calls.length + eutils.calls.length, 0);
  });
});

describe('routes — import de fichiers', () => {
  const RIS = [
    'TY  - JOUR',
    // Même article que la notice PubMed 34788900 (DOI identique) : un doublon entre bases.
    'TI  - Holmium laser enucleation versus bipolar resection in the management of large-volume benign prostatic hyperplasia: A randomized controlled trial.',
    'AU  - Habib, Emad',
    'PY  - 2022',
    'T2  - International Journal of Urology',
    'DO  - 10.1111/iju.14737',
    'ER  - ',
    'TY  - CONF',
    'TI  - Aquablation in large prostates: early results',
    'AU  - Martin, P.',
    'PY  - 2024',
    'T2  - Congrès de l’AFU',
    'ER  - ',
    'TY  - JOUR',
    'TI  - Aquablation in large prostates: early results',
    'AU  - Martin, P.',
    'PY  - 2024',
    'ER  - ',
  ].join('\r\n');

  test('un export Embase : consigné comme une recherche, dédoublonné, compté sous sa base', async () => {
    await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] });
    const res = await importFile(RIS, 'embase-2026-10-11.ris', { source: 'embase' });
    assert.equal(res.status, 201);
    const s = res.data.search;
    assert.equal(s.kind, 'import');
    assert.equal(s.source, 'embase');
    assert.equal(s.fileName, 'embase-2026-10-11.ris');
    assert.equal(s.actor, 'RIS');
    assert.equal(s.returned, 3);
    assert.equal(s.added, 1, 'la communication, une fois');
    assert.equal(s.duplicates, 2, 'l’article déjà trouvé par PubMed, et le doublon interne du fichier');

    const flow = res.data.prisma;
    assert.equal(flow.identified, 8, '5 PubMed + 3 notices du fichier');
    assert.equal(flow.identifiedDatabases, 8);
    assert.deepEqual(
      flow.bySource.map((r: any) => [r.source, r.category, r.count]),
      [['pubmed', 'database', 5], ['embase', 'database', 3]],
    );
    assert.equal(flow.duplicatesRemoved, 2);
    assert.equal(flow.screened, 6);
    assert.equal(flow.identified - flow.duplicatesRemoved, flow.screened);

    const merged = (await api('GET', '/api/biblio/refs?q=iju.14737')).data.refs[0];
    assert.deepEqual(merged.sources, ['pubmed', 'embase']);
    assert.equal(merged.authors[0], 'Habib E', 'les auteurs PubMed font foi');
    const conf = (await api('GET', '/api/biblio/refs?q=aquablation%20early')).data.refs[0];
    assert.equal(conf.refType, 'CONF');
  });

  test('un export .nbib de PubMed, puis la même recherche lancée d’ici : aucune notice comptée deux fois pour PubMed', async () => {
    const nbib = [
      'PMID- 34788900',
      'TI  - Holmium laser enucleation versus bipolar resection in the management of',
      '      large-volume benign prostatic hyperplasia: A randomized controlled trial.',
      'AU  - Habib E',
      'DP  - 2022 Feb',
      'LID - 10.1111/iju.14737 [doi]',
      '',
    ].join('\n');
    const res = await importFile(nbib, 'pubmed-2026.nbib', { source: 'pubmed' });
    assert.equal(res.status, 201);
    assert.equal(res.data.search.actor, 'MEDLINE (.nbib)');
    await api('POST', '/api/biblio/searches', { ...SEARCH, sources: ['pubmed'] });
    const flow = (await api('GET', '/api/biblio/overview')).data.prisma;
    assert.equal(flow.identified, 5, 'PubMed : 5 notices distinctes, import et recherche confondus');
    assert.equal(flow.duplicatesRemoved, 0);
    assert.equal(flow.screened, 5);
  });

  test('« Autre » avec un nom libre : rangé sous « autres méthodes », le nom repris dans le diagramme', async () => {
    const bib = '@article{a, title={Recherche manuelle de citations}, author={Durand, Marie}, year={2023}}';
    const res = await importFile(bib, 'citations.bib', { source: 'other', sourceLabel: 'Recherche de citations' });
    assert.equal(res.status, 201);
    assert.equal(res.data.search.sourceLabel, 'Recherche de citations');
    assert.deepEqual(res.data.prisma.bySource[0], {
      source: 'other',
      label: 'Autre (citations, sites, experts…) : Recherche de citations',
      category: 'other',
      count: 1,
    });
    assert.equal(res.data.prisma.identifiedOther, 1);
  });

  test('fichiers refusés : illisible (422, rien de consigné), sans fichier, base inconnue, trop gros', async () => {
    const unreadable = await importFile('Bonjour : ceci n’est pas un export.', 'lettre.txt', { source: 'embase' });
    assert.equal(unreadable.status, 422);
    assert.match(unreadable.data.error, /^lettre\.txt : Format non reconnu/);

    const empty = await importFile('TY  - JOUR\r\nAU  - Sans, Titre\r\nER  - \r\n', 'vide.ris', { source: 'embase' });
    assert.equal(empty.status, 422);
    assert.match(empty.data.error, /aucune référence lisible/);
    assert.equal(repo.listSearches().length, 0, 'un fichier illisible n’a rien identifié');

    const form = new FormData();
    form.set('source', 'embase');
    const noFile = await fetch(`${baseUrl}/api/biblio/imports`, { method: 'POST', body: form });
    assert.equal(noFile.status, 400);

    const badSource = await importFile('TY  - JOUR\r\nTI  - x\r\nER  - ', 'a.ris', { source: 'medline-pirate' });
    assert.equal(badSource.status, 400);
    assert.match(JSON.stringify(badSource.data), /Choisissez la base/);

    process.env.BIBLIO_IMPORT_MAX_MB = '1';
    try {
      const big = await importFile(Buffer.alloc(1024 * 1024 + 10, 0x41), 'gros.ris', { source: 'embase' });
      assert.equal(big.status, 413);
      assert.match(big.data.error, /au plus 1 Mo par import \(BIBLIO_IMPORT_MAX_MB\)/);
    } finally {
      delete process.env.BIBLIO_IMPORT_MAX_MB;
    }
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
    assert.equal((await api('GET', '/api/biblio/refs?source=both')).data.total, 0);
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

  test('au tri sur titre et résumé, le motif d’exclusion est facultatif ; une inclusion l’efface', async () => {
    const id = (await api('GET', '/api/biblio/refs')).data.refs[0].id;

    const noReason = await api('PATCH', `/api/biblio/refs/${id}`, { decision: 'exclude' });
    assert.equal(noReason.status, 200, 'PRISMA 2020 n’exige pas de motif à ce stade');
    assert.equal(noReason.data.ref.exclusionReason, null);
    assert.deepEqual(noReason.data.prisma.excludedByReason, [{ reason: 'unspecified', count: 1 }]);

    const bad = await api('PATCH', `/api/biblio/refs/${id}`, { decision: 'exclude', exclusionReason: 'inventé' });
    assert.equal(bad.status, 400);

    const ok = await api('PATCH', `/api/biblio/refs/${id}`, { decision: 'exclude', exclusionReason: 'design', note: 'Série de cas' });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ref.decision, 'exclude');
    assert.equal(ok.data.ref.exclusionReason, 'design');
    assert.equal(ok.data.ref.note, 'Série de cas');
    assert.equal(ok.data.counts.exclude, 1);

    const cleared = await api('PATCH', `/api/biblio/refs/${id}`, { exclusionReason: null });
    assert.equal(cleared.data.ref.exclusionReason, null, 'le motif se retire');
    assert.equal(cleared.data.ref.decision, 'exclude');

    const back = await api('PATCH', `/api/biblio/refs/${id}`, { decision: 'include' });
    assert.equal(back.data.ref.exclusionReason, null);
    assert.equal(back.data.ref.note, 'Série de cas', 'la note survit au changement de décision');
    assert.equal(back.data.counts.include, 1);

    assert.equal((await api('PATCH', '/api/biblio/refs/99999', { decision: 'include' })).status, 404);
    assert.equal((await api('PATCH', `/api/biblio/refs/${id}`, { decision: 'peut-être' })).status, 400);
  });

  test('le diagramme de flux se calcule des recherches et des décisions ; Scholar compte sous « autres méthodes »', async () => {
    const refs = (await api('GET', '/api/biblio/refs')).data.refs;
    await api('PATCH', `/api/biblio/refs/${refs[0].id}`, { decision: 'include' });
    await api('PATCH', `/api/biblio/refs/${refs[1].id}`, { decision: 'maybe' });
    await api('PATCH', `/api/biblio/refs/${refs[2].id}`, { decision: 'exclude', exclusionReason: 'population' });
    await api('PATCH', `/api/biblio/refs/${refs[3].id}`, { decision: 'exclude', exclusionReason: 'population' });
    await api('PATCH', `/api/biblio/refs/${refs[4].id}`, { decision: 'exclude', exclusionReason: 'language' });

    const { prisma, counts } = (await api('GET', '/api/biblio/overview')).data;
    assert.equal(prisma.identified, 10);
    assert.equal(prisma.identifiedDatabases, 5);
    assert.equal(prisma.identifiedRegisters, 0);
    assert.equal(prisma.identifiedOther, 5, 'Google Scholar est un moteur de recherche : « autres méthodes »');
    assert.deepEqual(
      prisma.bySource.map((r: any) => [r.source, r.category, r.count]).sort(),
      [['pubmed', 'database', 5], ['scholar', 'other', 5]],
    );
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

    // Relancer la même passe, deux fois, ne gonfle ni les notices identifiées ni les doublons.
    await api('POST', '/api/biblio/searches', SEARCH);
    await api('POST', '/api/biblio/searches', SEARCH);
    const after = (await api('GET', '/api/biblio/overview')).data;
    assert.equal(after.prisma.identified, 10);
    assert.equal(after.prisma.duplicatesRemoved, 0);
    assert.equal(after.prisma.screened, 10);
    assert.equal(after.searches.length, 6, 'chaque passe reste dans l’historique');
    assert.deepEqual(
      after.searches.slice(0, 2).map((s: any) => [s.added, s.duplicates]),
      [[0, 5], [0, 5]],
      'l’historique dit que la passe relancée n’a rien apporté',
    );
  });
});

describe('routes — exports', () => {
  beforeEach(async () => {
    await api('POST', '/api/biblio/searches', SEARCH);
    const refs = (await api('GET', '/api/biblio/refs?source=pubmed')).data.refs;
    await api('PATCH', `/api/biblio/refs/${refs[0].id}`, { decision: 'include', note: 'Essai pivot' });
  });

  test('RIS : lisible par un gestionnaire de références, type et PMCID compris', async () => {
    const res = await api('GET', '/api/biblio/export?format=ris');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /^attachment; filename="references-toutes-\d{4}-\d{2}-\d{2}\.ris"$/);
    assert.match(res.text, /^TY {2}- JOUR\r\n/);
    assert.match(res.text, /AU {2}- Ritter M\r\n/);
    assert.match(res.text, /DO {2}- 10\.1016\/j\.euf\.2026\.01\.006\r\n/);
    assert.match(res.text, /SP {2}- 266\r\nEP {2}- 274\r\n/);
    assert.match(res.text, /AN {2}- 41638951\r\n/);
    assert.match(res.text, /AN {2}- 30985725\r\nC2 {2}- PMC6485898\r\n/, 'le PMCID part dans C2');
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
    assert.match(res.text, /pmcid = \{PMC6485898\}/);
    const keys = [...res.text.matchAll(/@\w+\{([^,]+),/g)].map((m) => m[1]);
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

  test('journal de recherche (PRISMA-S) : chaîne exacte, traduction PubMed, total annoncé, notices récupérées', async () => {
    const res = await api('GET', '/api/biblio/export?format=searches');
    assert.match(res.headers.get('content-disposition') ?? '', /strategies-de-recherche-/);
    assert.match(res.text, /Date;Type;Source;Service ou format;Équation de recherche;Équation envoyée;Traduction par PubMed;Fichier importé/);
    assert.match(res.text, /;recherche;PubMed;NCBI E-utilities;HoLEP versus TURP;;"""HoLEP versus TURP""\[All Fields\]";;;;5;5;5;0;réussie;;/);
    assert.match(res.text, /;recherche;Google Scholar;george\.the\.developer\/google-scholar-scraper;HoLEP versus TURP;/);
  });

  test('refuse un format inconnu', async () => {
    assert.equal((await api('GET', '/api/biblio/export?format=docx')).status, 400);
  });
});

describe('confidentialité du jeton et de la clé', () => {
  test('ni le jeton Apify ni la clé NCBI n’ont figuré dans une réponse de l’API', () => {
    assert.ok(everyResponse.length > 40, `${everyResponse.length} réponses examinées`);
    const leaked = everyResponse.filter((body) => body.includes(TOKEN) || body.includes(NCBI_KEY));
    assert.equal(leaked.length, 0);
  });

  test('ni dans le message d’une erreur du client Apify', async () => {
    const cfg = { ...apify.apifyConfig(), token: TOKEN, baseUrl: 'http://127.0.0.1:1' };
    await assert.rejects(
      apify.runActor(cfg, 'george.the.developer/google-scholar-scraper', {}, 5),
      (e: unknown) => e instanceof apify.ApifyError && e.kind === 'network' && !e.message.includes(TOKEN),
    );
  });
});
