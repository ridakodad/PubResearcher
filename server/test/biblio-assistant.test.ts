/**
 * Recherche en langage naturel : de la question à l'équation PubMed, vérifiée sur de vrais nombres (ici, un faux
 * E-utilities : aucun appel au NCBI ni à Claude).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-biblio-assistant-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';
delete process.env.ANTHROPIC_API_KEY;

const qb = await import('../src/biblio/query-builder.js');
const { createApp } = await import('../src/app.js');
const { MIGRATIONS, migrate } = await import('../src/db/migrations.js');
const { SCHEMA } = await import('../src/db/schema.js');
const { searchesToCsv } = await import('../src/biblio/export.js');
const { createFakeEutils, syntheticRecord } = await import('./eutils-fake.js');

type Counter = import('../src/biblio/query-builder.js').PubmedCounter;

/** Faux compteur : une fonction équation → nombre ; il garde les équations demandées. */
function counterOf(count: (term: string) => number): Counter & { terms: string[] } {
  const terms: string[] = [];
  const fn = (async (term: string) => {
    terms.push(term);
    return { count: count(term), warnings: [] };
  }) as Counter & { terms: string[] };
  fn.terms = terms;
  return fn;
}

const balanced = (s: string) => {
  let depth = 0;
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth < 0) return false;
  }
  return depth === 0 && (s.match(/"/g) ?? []).length % 2 === 0;
};

describe('mode sans clé (règles)', () => {
  before(() => qb.setQueryModelCaller(null));

  test('pneumopathie communautaire, antibiothérapie courte, essais randomisés', async () => {
    const counter = counterOf(() => 120);
    const s = await qb.buildStrategy(
      {
        question:
          "Chez l'adulte avec une pneumopathie communautaire, une antibiothérapie courte (≤ 5 jours) est-elle aussi efficace qu'une antibiothérapie longue ? Essais randomisés.",
      },
      counter,
    );
    assert.equal(s.method, 'rules');
    assert.equal(s.model, null);
    assert.match(s.equation, /"Community-Acquired Infections"\[Mesh\]/);
    assert.match(s.equation, /"community-acquired pneumonia"\[tiab\]/);
    assert.match(s.equation, /antibiotic\*\[tiab\]/);
    assert.match(s.equation, /randomized controlled trial\[pt\]/, 'filtre Cochrane des essais randomisés');
    assert.deepEqual(s.filters, ['Essais randomisés']);
    assert.ok(!/Treatment Outcome/.test(s.equation), 'le critère de jugement reste hors de l’équation');
    assert.ok(!/\b20\d\d\b/.test(s.equation), 'pas de dates dans l’équation');
    assert.ok(balanced(s.equation));
    assert.ok(s.warnings.some((w) => /par règles/.test(w)));
    assert.equal(s.counts.total, 120);
    assert.ok(s.counts.perConcept.length >= 2);
    assert.match(s.pico.population, /Pneumopathie communautaire/);
  });

  for (const [question, expected] of [
    ['Metformine et mortalité chez les personnes âgées diabétiques de type 2', /"Diabetes Mellitus, Type 2"\[Mesh\].*AND.*metformin/],
    ['Les corticoïdes réduisent-ils la mortalité du choc septique ? Méta-analyses', /Shock, Septic.*AND.*corticosteroid\*\[tiab\].*systematic\[sb\]/],
    ["Appendicectomie par cœlioscopie chez l'enfant : complications", /Appendectomy.*AND.*Laparoscopy/],
  ] as const) {
    test(`équation sensée : « ${question} »`, async () => {
      const s = await qb.buildStrategy({ question }, counterOf(() => 50));
      assert.match(s.equation, expected);
      assert.ok(balanced(s.equation), s.equation);
      assert.ok(s.concepts.every((c) => c.block.length > 0));
    });
  }

  test('anglais : les mots non reconnus deviennent du texte libre', async () => {
    const s = await qb.buildStrategy({ question: 'Does tranexamic acid reduce bleeding in hip fracture surgery?' }, counterOf(() => 30));
    assert.match(s.equation, /"Hip Fractures"\[Mesh\]/);
    assert.match(s.equation, /tranexamic/);
  });

  test('une question sans notion reconnue le dit', async () => {
    const s = await qb.buildStrategy({ question: 'Quelque chose de très vague à propos de rien' }, counterOf(() => 0));
    assert.equal(s.equation, '');
    assert.ok(s.warnings.some((w) => /Aucune notion reconnue/.test(w)));
  });
});

describe('boucle de vérification', () => {
  test('MeSH inexistant → texte libre ; zéro résultat → concept accessoire retiré', async () => {
    const counter = counterOf((term) => {
      if (term === '"Adult"[Mesh]') return 0; // descripteur réputé introuvable
      if (term.includes(' AND ') && term.includes('adult')) return 0; // l'équation complète ne rend rien
      if (term.includes(' AND ')) return 42;
      return 1000;
    });
    const s = await qb.buildStrategy({ question: "Chez l'adulte avec un asthme, les corticoïdes" }, counter);
    assert.ok(s.warnings.some((w) => /« Adult » introuvable/.test(w)));
    assert.ok(s.warnings.some((w) => /« Adulte » a été retiré/.test(w)), s.warnings.join('\n'));
    assert.ok(!s.concepts.some((c) => c.name === 'Adulte'));
    assert.equal(s.counts.total, 42);
    assert.ok(counter.terms.filter((t) => t.includes(' AND ')).length <= qb.MAX_ROUNDS);
  });

  test('beaucoup de résultats → avertissement et piste pour resserrer', async () => {
    const s = await qb.buildStrategy({ question: 'Diabète et activité physique' }, counterOf(() => 250_000));
    assert.ok(s.warnings.some((w) => /beaucoup pour une question ciblée/.test(w)));
  });

  test('les années passent à PubMed, pas dans l’équation', async () => {
    const seen: unknown[] = [];
    const counter: Counter = async (_t, years) => {
      seen.push(years);
      return { count: 10, warnings: [] };
    };
    const s = await qb.buildStrategy({ question: 'Asthme et corticoïdes', yearFrom: 2015, yearTo: 2024 }, counter);
    assert.ok(!/2015|2024/.test(s.equation));
    assert.ok(seen.some((y) => (y as { yearFrom?: number }).yearFrom === 2015));
  });

  test('client E-utilities réel sur un faux NCBI', async () => {
    const records = [1, 2, 3].map((n) => syntheticRecord(n, { y: 2020, m: 1, d: 1 }));
    const fake = createFakeEutils(records);
    const { EutilsClient, eutilsConfig } = await import('../src/biblio/eutils.js');
    const client = new EutilsClient(eutilsConfig(), { fetchImpl: fake.fetchImpl, limiter: async () => {} });
    const s = await qb.buildStrategy({ question: 'Appendicite et antibiotiques' }, qb.pubmedCounter(client));
    assert.equal(s.counts.total, 3);
    assert.ok(fake.calls.every((c) => c.endpoint === 'esearch'));
  });
});

describe('mode modèle de langage (simulé)', () => {
  after(() => qb.setQueryModelCaller(null));

  test('réponse JSON validée, termes nettoyés, question pseudonymisée', async () => {
    let sentUser = '';
    qb.setQueryModelCaller(async (_system, user, schema) => {
      sentUser = user;
      assert.equal((schema as { type: string }).type, 'object');
      return JSON.stringify({
        pico: { population: 'adultes, PAC', intervention: 'antibiothérapie courte', comparison: 'longue', outcome: 'guérison', studyDesign: 'ECR' },
        concepts: [
          { name: 'Pneumonie communautaire', role: 'population', importance: 1, mesh: ['Community-Acquired Infections', '"Pneumonia"[Mesh]'], freeText: ['community-acquired pneumonia', 'CAP'] },
          { name: 'Durée courte', role: 'intervention', importance: 1, mesh: ['Drug Administration Schedule'], freeText: ['short course', 'short-course', 'duration'] },
        ],
        rationale: 'P et I seulement.',
        warnings: [],
      });
    });
    const s = await qb.buildStrategy(
      { question: 'Patient Jean Dupont, né le 12/03/1950 : pneumopathie communautaire, antibiothérapie courte, essais randomisés', studyTypes: ['rct'] },
      counterOf(() => 300),
    );
    assert.equal(s.method, 'llm');
    assert.equal(s.model, 'modèle de test');
    assert.match(s.equation, /^\("Community-Acquired Infections"\[Mesh\] OR "Pneumonia"\[Mesh\] OR "community-acquired pneumonia"\[tiab\] OR CAP\[tiab\]\) AND \(/);
    assert.match(s.equation, /randomized controlled trial\[pt\]/);
    assert.ok(!sentUser.includes('12/03/1950'), 'date de naissance masquée');
    assert.equal(s.rationale, 'P et I seulement.');
  });

  test('réponse non conforme → repli sur les règles, avec avertissement', async () => {
    qb.setQueryModelCaller(async () => '{"pas":"le bon format"}');
    const s = await qb.buildStrategy({ question: 'Asthme de l’enfant et corticoïdes' }, counterOf(() => 10));
    assert.equal(s.method, 'rules');
    assert.ok(s.warnings.some((w) => /non conforme/.test(w)));
  });
});

describe('migrations successives sur une base en version 3', () => {
  test('ajoute question, stratégie et traçabilité PubDaily sans rien perdre', () => {
    const conn = new DatabaseSync(':memory:');
    conn.exec(SCHEMA);
    for (const m of MIGRATIONS.filter((m) => m.version <= 3)) m.up(conn);
    conn.exec('PRAGMA user_version = 3');
    conn.prepare("INSERT INTO biblio_searches (source, actor, query, max_results, queried_at) VALUES ('pubmed', 'x', 'asthma', 0, '2026-01-01')").run();
    const r = migrate(conn);
    assert.equal(r.from, 3);
    assert.ok(r.to >= 4);
    const row = conn.prepare('SELECT query, nl_question, strategy FROM biblio_searches').get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { query: 'asthma', nl_question: null, strategy: null });
    // v5 : les colonnes de traçabilité PubDaily sont ajoutées, vides.
    const cols = (conn.prepare('PRAGMA table_info(biblio_searches)').all() as { name: string }[]).map((c) => c.name);
    assert.ok(cols.includes('pubdaily_topic'));
    assert.ok(cols.includes('pubdaily_specialty'));
    assert.ok(cols.includes('pubdaily_page'));
    conn.close();
  });
});

describe('routes', () => {
  let server: Server;
  let fakeServer: Server;
  let base = '';
  before(async () => {
    const records = [1, 2, 3, 4].map((n) => syntheticRecord(n, { y: 2021, m: 2, d: 3 }));
    const fake = createFakeEutils(records);
    fakeServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://x');
        const endpoint = /\/(\w+)\.fcgi$/.exec(url.pathname)?.[1] ?? '';
        const out = fake.handle(endpoint, new URLSearchParams(Buffer.concat(chunks).toString('utf8') || url.search));
        res.writeHead(out.status, { 'Content-Type': 'application/json', ...(out.headers ?? {}) });
        res.end(out.body);
      });
    });
    await new Promise<void>((r) => fakeServer.listen(0, '127.0.0.1', r));
    process.env.NCBI_EUTILS_BASE = `http://127.0.0.1:${(fakeServer.address() as { port: number }).port}/entrez/eutils`;
    await new Promise<void>((r) => {
      server = createApp().listen(0, () => r());
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  after(async () => {
    await new Promise((r) => server.close(r));
    await new Promise((r) => fakeServer.close(r));
    const { db } = await import('../src/db/index.js');
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  const post = async (route: string, body: unknown) => {
    const res = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: (await res.json()) as Record<string, any> };
  };

  test('build puis count puis lancement : la question et la stratégie entrent au journal', async () => {
    const built = await post('/api/biblio/assistant/build', { question: 'Appendicite et antibiotiques chez l’enfant', yearFrom: 2010 });
    assert.equal(built.status, 200);
    assert.equal(built.data.method, 'rules');
    assert.equal(built.data.counts.total, 4);

    const counted = await post('/api/biblio/assistant/count', { equation: built.data.equation, blocks: [{ name: 'A', block: 'appendicitis[tiab]' }] });
    assert.equal(counted.status, 200);
    assert.equal(counted.data.total, 4);
    assert.equal(counted.data.perConcept[0].count, 4);

    const launched = await post('/api/biblio/searches', {
      query: built.data.equation,
      sources: ['pubmed'],
      question: built.data.question,
      strategy: built.data,
    });
    assert.equal(launched.status, 201, JSON.stringify(launched.data));
    const search = launched.data.searches[0];
    assert.equal(search.question, 'Appendicite et antibiotiques chez l’enfant');
    assert.equal(search.strategy.method, 'rules');
    const csv = searchesToCsv([search]);
    assert.match(csv, /Question en langage naturel/);
    assert.match(csv, /générée à partir de la question par règles.*validée par l’utilisateur/);
  });

  test('une recherche saisie à la main garde des colonnes vides', async () => {
    const launched = await post('/api/biblio/searches', { query: 'appendicitis', sources: ['pubmed'] });
    assert.equal(launched.status, 201);
    assert.equal(launched.data.searches[0].question, null);
    assert.equal(launched.data.searches[0].strategy, null);
  });

  test('refuse une question vide et une stratégie mal formée', async () => {
    assert.equal((await post('/api/biblio/assistant/build', { question: '' })).status, 400);
    assert.equal((await post('/api/biblio/searches', { query: 'x y', sources: ['pubmed'], strategy: { method: 'magic' } })).status, 400);
  });
});

/* ─────────────────── Enrichissement PubDaily (feature 2) ───────────────── */

const { enrichWithPubdaily, pubdailyCandidate } = qb;
const pdMod = await import('../src/biblio/pubdaily.js');

/** Faux client PubDaily minimal — on couvre `findTrend` et `searchPapers`. */
function fakePubdailyClient(opts: { topic?: string | null; papers?: { title: string; pmid: string }[]; delayMs?: number; throws?: boolean }) {
  const client: Partial<InstanceType<typeof pdMod.PubdailyClient>> = {
    async findTrend(_q: string) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throws) throw new pdMod.PubdailyError('tool', 'boum');
      return opts.topic
        ? { found: true, topic: { topic: opts.topic, trend_score: 42, pubmed_search: 'https://pubmed.ncbi.nlm.nih.gov/?term=x', growth_vs_previous_12_months_pct: 50, page: 'https://pubdaily.app/trends/x/' }, specialty: 'Cardiology' }
        : { found: false, topic: null, specialty: null };
    },
    async searchPapers(_q: string, _o: object) {
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.throws) throw new pdMod.PubdailyError('tool', 'boum');
      return {
        papers: (opts.papers ?? []).map((p) => ({ title: p.title, pmid: p.pmid, journal: 'NEJM', published: '2025', type: null, specialty: null, pubdaily_score: 7, pubmed: null, summary: null, page: null })),
      };
    },
  };
  return client as InstanceType<typeof pdMod.PubdailyClient>;
}

describe('enrichissement PubDaily (query-builder)', () => {
  test('pubdailyCandidate garde une séquence courte', () => {
    const c = pubdailyCandidate('Chez l’adulte diabétique, metformine et mortalité ?');
    assert.ok(c.length > 0);
    assert.ok(c.split(/\s+/).length <= 6);
  });

  test('surface les champs pubdaily et pubdaily_papers quand le client répond', async () => {
    const client = fakePubdailyClient({ topic: 'Tirzepatide', papers: [{ title: 'Trial', pmid: '42' }] });
    const r = await enrichWithPubdaily('tirzepatide cardiovascular', 1000, client);
    assert.equal(r.pubdaily?.topic, 'Tirzepatide');
    assert.equal(r.pubdaily?.growthPct, 50);
    assert.equal(r.pubdaily_papers?.length, 1);
    assert.equal(r.pubdaily_papers?.[0]?.pmid, '42');
  });

  test('erreur silencieuse — pas d’exception, un warning dans la stratégie', async () => {
    const client = fakePubdailyClient({ throws: true });
    const r = await enrichWithPubdaily('question', 1000, client);
    assert.equal(r.pubdaily, undefined);
  });

  test('respect du budget : dépassement → avertissement, pas de pubdaily', async () => {
    const client = fakePubdailyClient({ delayMs: 200, topic: 'Trop lent' });
    const r = await enrichWithPubdaily('question', 50, client);
    assert.equal(r.pubdaily, undefined);
    assert.ok(r.warnings.length >= 1);
  });

  test('repli règles : par défaut, aucun appel PubDaily (sauf flag d’opt-in)', async () => {
    // On vérifie en remplaçant le client partagé par un espion.
    let called = 0;
    const spy = {
      findTrend: async () => {
        called++;
        return { found: false, topic: null, specialty: null };
      },
      searchPapers: async () => {
        called++;
        return { papers: [] };
      },
    } as unknown as InstanceType<typeof pdMod.PubdailyClient>;
    pdMod.setPubdailyClient(spy);
    qb.setQueryModelCaller(null); // repli règles
    delete process.env.PUBDAILY_ENABLE_RULES_FALLBACK;
    const s = await qb.buildStrategy({ question: "Chez l'adulte diabétique, metformine et mortalité" }, async () => ({ count: 10, warnings: [] }));
    assert.equal(s.method, 'rules');
    assert.equal(called, 0, 'aucun appel PubDaily depuis le repli règles');
    assert.equal(s.pubdaily, undefined);

    // Avec le flag opt-in : les appels passent (question avec concepts reconnus par les règles).
    process.env.PUBDAILY_ENABLE_RULES_FALLBACK = '1';
    await qb.buildStrategy({ question: "Chez l'adulte diabétique, metformine et mortalité" }, async () => ({ count: 10, warnings: [] }));
    assert.ok(called >= 1, `attendu >=1 appels, obtenu ${called}`);
    delete process.env.PUBDAILY_ENABLE_RULES_FALLBACK;
    pdMod.setPubdailyClient(null);
  });
});
