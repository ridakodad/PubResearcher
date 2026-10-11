/**
 * PubMed par les E-utilities du NCBI : lecture des notices, débit, pagination,
 * découpage par dates au-delà de 9 999 résultats, nouvelles tentatives et
 * messages d'erreur.
 *
 * Aucun appel réseau : les notices de `eutils-fixtures/` sont de vraies
 * réponses d'`efetch` et d'`esearch` (octobre 2026, allégées des affiliations
 * et de l'historique), rejouées par un faux service (`eutils-fake.ts`).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ESEARCH_WINDOW,
  EutilsClient,
  EutilsError,
  createRateLimiter,
  eutilsConfig,
  parseEsearch,
  parsePubmedXml,
  searchPubmed,
  type EutilsConfig,
} from '../src/biblio/eutils.js';
import { parseXml, textOf, descendantsOf } from '../src/lib/xml.js';
import { createFakeEutils, fakeClock, fixtureText, splitRecords, syntheticRecord, wrapRecords } from './eutils-fake.js';

const cfg = (over: Partial<EutilsConfig> = {}): EutilsConfig => ({
  ...eutilsConfig({}),
  baseUrl: 'http://eutils.test/entrez/eutils',
  ...over,
});
const noWait = async () => undefined;

describe('lecteur XML', () => {
  test('entités, CDATA, commentaires, DOCTYPE, balises de mise en forme', () => {
    const root = parseXml(
      '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x "y">]><a><!-- note --><t>CO<sub>2</sub> &#x2265; 5 &amp; &lt;b&gt; &#160;fin</t><c><![CDATA[<brut> & tel quel]]></c><e attr="1 &gt; 0"/></a>',
    );
    const [t] = descendantsOf(root, 't');
    assert.equal(textOf(t), 'CO2 ≥ 5 & <b> fin');
    assert.equal(textOf(descendantsOf(root, 'c')[0]), '<brut> & tel quel');
    assert.equal(descendantsOf(root, 'e')[0]?.attrs.attr, '1 > 0');
  });

  test('tolérant : fermeture orpheline, document tronqué, entité inconnue', () => {
    const root = parseXml('<a><b>un</x></b><c>deux &foo; <d>trois');
    assert.equal(textOf(descendantsOf(root, 'b')[0]), 'un');
    assert.equal(textOf(descendantsOf(root, 'c')[0]), 'deux &foo; trois');
  });
});

describe('notices PubMed (efetch, XML réel)', () => {
  const holep = parsePubmedXml(fixtureText('efetch-holep.xml'));
  const byPmid = (pmid: string) => holep.refs.find((r) => r.pmid === pmid)!;

  test('lit les cinq articles, sans en écarter', () => {
    assert.equal(holep.refs.length, 5);
    assert.equal(holep.skipped, 0);
    assert.deepEqual(holep.pmids, ['41638951', '17729384', '35867143', '34788900', '30985725']);
  });

  test('article complet : titre sans point final, auteurs, revue, pages, DOI, résumé structuré, MeSH, types', () => {
    const ref = byPmid('41638951');
    assert.equal(
      ref.title,
      'WATER III: A Prospective, Partially Randomized Trial of Aquablation Therapy Versus Transurethral Laser Enucleation of the Prostate for Treatment of Lower Urinary Tract Symptoms',
    );
    assert.equal(ref.source, 'pubmed');
    assert.equal(ref.authors.length, 12);
    assert.equal(ref.authors[0], 'Ritter M');
    assert.equal(ref.year, 2026);
    assert.equal(ref.journal, 'European urology focus');
    assert.equal(ref.volume, '12');
    assert.equal(ref.issue, '2');
    assert.equal(ref.pages, '266-274');
    assert.equal(ref.doi, '10.1016/j.euf.2026.01.006');
    assert.equal(ref.url, 'https://pubmed.ncbi.nlm.nih.gov/41638951/');
    assert.ok(ref.abstract?.startsWith('BACKGROUND AND OBJECTIVE: Aquablation'));
    assert.match(ref.abstract ?? '', / METHODS: WATER III is/, 'chaque section garde son intitulé');
    assert.match(ref.abstract ?? '', /\(80-180 ml\)\. .* grade ≥2/, 'entités numériques décodées, espaces insécables resserrés');
    assert.equal(ref.keywords.length, 5);
    assert.ok(ref.meshTerms.includes('Prostatic Hyperplasia'));
    assert.ok(ref.publicationTypes.includes('Randomized Controlled Trial'));
    assert.equal(ref.refType, 'JOUR');
    assert.equal(ref.citedBy, null);
    assert.equal(ref.snippet, null);
  });

  test('PMCID et DOI viennent de la notice elle-même, jamais de sa liste de références citées', () => {
    const bai = byPmid('30985725');
    assert.equal(bai.pmcid, 'PMC6485898');
    assert.equal(bai.doi, '10.1097/md.0000000000015223');
    // 35867143 cite d'autres articles (PMID 28646935…) : ils ne doivent pas lui être attribués.
    const durant = byPmid('35867143');
    assert.equal(durant.pmid, '35867143');
    assert.equal(durant.pmcid, null);
    assert.equal(durant.doi, '10.1007/s00345-022-04098-w');
  });

  test('livre et chapitre (PubmedBookArticle)', () => {
    const books = parsePubmedXml(fixtureText('efetch-books.xml'));
    assert.equal(books.refs.length, 2);
    const [book, chapter] = books.refs;
    assert.equal(book!.refType, 'BOOK');
    assert.equal(book!.title, 'GeneReviews®');
    assert.equal(book!.authors[0], 'Adam MP', 'un livre sans auteurs est cité par ses directeurs');
    assert.equal(chapter!.refType, 'CHAP');
    assert.equal(chapter!.title, 'Gaucher Disease');
    assert.equal(chapter!.journal, 'GeneReviews®', 'le titre du livre tient lieu de revue');
    assert.deepEqual(chapter!.authors, ['Hughes DA', 'Pastores GM']);
    assert.equal(chapter!.year, 2000);
    assert.ok(chapter!.abstract?.startsWith('CLINICAL CHARACTERISTICS:'));
    assert.equal(new Set(chapter!.keywords).size, chapter!.keywords.length, 'mots-clés sans doublon');
  });

  test('cas limites : date MEDLINE, auteur collectif, titre traduit, titre absent, congrès', () => {
    const xml = wrapRecords([
      '<PubmedArticle><MedlineCitation><PMID>1</PMID><Article><Journal><JournalIssue><PubDate><MedlineDate>2015 Nov-Dec</MedlineDate></PubDate></JournalIssue><Title>Revue</Title></Journal><ArticleTitle>[Appendicite de l’enfant : <i>étude</i> rétrospective].</ArticleTitle><AuthorList><Author><CollectiveName>Groupe francophone d’hépatologie</CollectiveName></Author><Author><LastName>Dupont</LastName><Initials>JP</Initials></Author></AuthorList><PublicationTypeList><PublicationType>Congress</PublicationType></PublicationTypeList></Article></MedlineCitation></PubmedArticle>',
      '<PubmedArticle><MedlineCitation><PMID>2</PMID><Article><ArticleTitle></ArticleTitle></Article></MedlineCitation></PubmedArticle>',
      '<PubmedArticle><MedlineCitation><PMID>3</PMID><Article><ArticleTitle/><VernacularTitle>Titre en français.</VernacularTitle><Abstract><AbstractText Label="UNLABELLED">Texte.</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>',
    ]);
    const { refs, skipped, pmids } = parsePubmedXml(xml);
    assert.equal(skipped, 1);
    assert.deepEqual(pmids, ['1', '2', '3']);
    assert.equal(refs[0]!.title, 'Appendicite de l’enfant : étude rétrospective');
    assert.equal(refs[0]!.year, 2015);
    assert.deepEqual(refs[0]!.authors, ['Groupe francophone d’hépatologie', 'Dupont JP']);
    assert.equal(refs[0]!.refType, 'CONF');
    assert.equal(refs[1]!.title, 'Titre en français');
    assert.equal(refs[1]!.abstract, 'Texte.');
  });
});

describe('esearch', () => {
  test('nombre total, historique et traduction de l’équation (réponse réelle)', () => {
    const r = parseEsearch(fixtureText('esearch-appendicitis.json'));
    assert.equal(r.count, 712);
    assert.match(r.webenv, /^MCID_/);
    assert.equal(r.querykey, '1');
    assert.match(r.queryTranslation ?? '', /"appendicitis"\[MeSH Terms\]/);
    assert.match(r.queryTranslation ?? '', /2015\/01\/01:2025\/12\/31\[Date - Publication\]/);
    assert.deepEqual(r.warnings, []);
  });

  test('termes introuvables : signalés en français, la recherche reste valable (0 résultat)', () => {
    const r = parseEsearch(fixtureText('esearch-empty.json'));
    assert.equal(r.count, 0);
    assert.deepEqual(r.warnings, ['Termes introuvables dans PubMed, ignorés : zzqxqzz.']);
  });

  test('erreur de syntaxe ou réponse illisible : une erreur en français', () => {
    assert.throws(() => parseEsearch('{"esearchresult":{"ERROR":"Invalid query"}}'), (e: unknown) => e instanceof EutilsError && e.kind === 'query' && /refusé l’équation : Invalid query/.test(e.message));
    assert.throws(() => parseEsearch('<html>'), (e: unknown) => e instanceof EutilsError && /illisible/.test(e.message));
  });
});

describe('débit limité', () => {
  test('3 requêtes par seconde sans clé, 10 avec, dans l’ordre d’arrivée', async () => {
    const clock = fakeClock();
    let rps = 3;
    const acquire = createRateLimiter(() => rps, clock);
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await acquire();
      starts.push(clock.now());
    }
    // 1000/3 × 1,1 ≈ 367 ms entre deux requêtes : jamais plus de 3 dans une même seconde.
    assert.deepEqual(starts, [0, 367, 734, 1101]);
    rps = 10;
    clock.advance(5000);
    const t0 = clock.now();
    await acquire();
    await acquire();
    assert.equal(clock.now() - t0, 110);
  });

  test('deux appels simultanés se partagent le débit au lieu de le doubler', async () => {
    // Horloge arrêtée : chaque appel réserve son créneau avant que le précédent n'ait fini d'attendre.
    const sleeps: number[] = [];
    const acquire = createRateLimiter(() => 3, { now: () => 0, sleep: async (ms) => void sleeps.push(ms) });
    await Promise.all([acquire(), acquire(), acquire()]);
    assert.deepEqual(sleeps, [367, 734]);
  });
});

describe('client : paramètres, nouvelles tentatives, erreurs', () => {
  const records = splitRecords(fixtureText('efetch-holep.xml'));

  test('envoie tool, email et clé dans le corps (POST), jamais dans l’adresse', async () => {
    let calledUrl = '';
    let body = '';
    const fake = createFakeEutils(records);
    const client = new EutilsClient(cfg({ apiKey: 'CLE-SECRETE-123', email: 'equipe@chu.fr' }), {
      fetchImpl: (async (url: string, init: RequestInit) => {
        calledUrl = String(url);
        body = String(init.body);
        return fake.fetchImpl(url, init);
      }) as typeof fetch,
      limiter: noWait,
    });
    await client.esearch('holep', { mindate: '2015', maxdate: '2025', sort: 'date' });
    assert.equal(calledUrl, 'http://eutils.test/entrez/eutils/esearch.fcgi');
    const params = new URLSearchParams(body);
    assert.equal(params.get('tool'), 'PubResearcher');
    assert.equal(params.get('email'), 'equipe@chu.fr');
    assert.equal(params.get('api_key'), 'CLE-SECRETE-123');
    assert.equal(params.get('usehistory'), 'y');
    assert.equal(params.get('datetype'), 'pdat');
    assert.equal(params.get('mindate'), '2015');
    assert.equal(params.get('maxdate'), '2025');
    assert.equal(params.get('sort'), 'pub_date');
  });

  test('429 puis 503 : nouvelles tentatives espacées (Retry-After respecté), puis succès', async () => {
    const clock = fakeClock();
    const fake = createFakeEutils(records, {
      intercept: (_call, i) =>
        i === 0
          ? { status: 429, body: '{"error":"API rate limit exceeded","count":"4","limit":"3"}', headers: { 'Retry-After': '3' } }
          : i === 1
            ? { status: 503, body: 'Service Unavailable' }
            : null,
    });
    const client = new EutilsClient(cfg(), { fetchImpl: fake.fetchImpl, clock, limiter: noWait });
    const r = await client.esearch('holep', {});
    assert.equal(r.count, 5);
    assert.deepEqual(clock.sleeps, [3000, 2000]);
    assert.equal(client.requests, 3);
  });

  test('panne persistante : message en français après quatre tentatives', async () => {
    const clock = fakeClock();
    const fake = createFakeEutils(records, { intercept: () => ({ status: 502, body: 'Bad Gateway' }) });
    const client = new EutilsClient(cfg(), { fetchImpl: fake.fetchImpl, clock, limiter: noWait });
    await assert.rejects(client.esearch('holep', {}), (e: unknown) => e instanceof EutilsError && e.kind === 'server' && /indisponible \(erreur 502\)/.test(e.message));
    assert.equal(fake.calls.length, 4);
    assert.deepEqual(clock.sleeps, [1000, 2000, 4000]);
  });

  test('429 persistant : le message dit d’attendre et parle de la clé NCBI', async () => {
    const fake = createFakeEutils(records, { intercept: () => ({ status: 429, body: '{"error":"API rate limit exceeded"}' }) });
    const client = new EutilsClient(cfg(), { fetchImpl: fake.fetchImpl, clock: fakeClock(), limiter: noWait });
    await assert.rejects(client.esearch('x', {}), (e: unknown) => e instanceof EutilsError && e.kind === 'rate' && /NCBI_API_KEY/.test(e.message));
  });

  test('400 : pas de nouvelle tentative ; clé refusée : message dédié', async () => {
    const bad = createFakeEutils(records, { intercept: () => ({ status: 400, body: '{"error":"Invalid term"}' }) });
    const client = new EutilsClient(cfg(), { fetchImpl: bad.fetchImpl, clock: fakeClock(), limiter: noWait });
    await assert.rejects(client.esearch('x', {}), /PubMed a refusé la requête \(erreur 400\) : Invalid term/);
    assert.equal(bad.calls.length, 1);

    const key = createFakeEutils(records, { intercept: () => ({ status: 400, body: '{"error":"API key invalid","api-key":"CLE-X"}' }) });
    const keyed = new EutilsClient(cfg({ apiKey: 'CLE-X-123456' }), { fetchImpl: key.fetchImpl, clock: fakeClock(), limiter: noWait });
    await assert.rejects(keyed.esearch('x', {}), (e: unknown) => e instanceof EutilsError && e.kind === 'auth' && /NCBI_API_KEY refusée/.test(e.message));
  });

  test('réseau coupé : message en français, sans la clé', async () => {
    const client = new EutilsClient(cfg({ apiKey: 'CLE-SECRETE-456' }), {
      fetchImpl: (async () => {
        throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND eutils.test (clé CLE-SECRETE-456)') });
      }) as typeof fetch,
      clock: fakeClock(),
      limiter: noWait,
    });
    await assert.rejects(client.esearch('x', {}), (e: unknown) => {
      assert.ok(e instanceof EutilsError);
      assert.equal(e.kind, 'network');
      assert.match(e.message, /PubMed est injoignable \(eutils\.test\)/);
      assert.ok(!e.message.includes('CLE-SECRETE-456'), e.message);
      return true;
    });
  });

  test('délai dépassé : message en français', async () => {
    const client = new EutilsClient(cfg({ timeoutMs: 1000, retries: 0 }), {
      fetchImpl: (async () => {
        throw new DOMException('signal timed out', 'TimeoutError');
      }) as typeof fetch,
      clock: fakeClock(),
      limiter: noWait,
    });
    await assert.rejects(client.esearch('x', {}), /PubMed n’a pas répondu en 1 s/);
  });
});

describe('recherche complète : pagination, plafond, découpage par dates', () => {
  /** `n` notices réparties de 2000 à 2024, un jour différent chacune ou presque. */
  function synthetic(n: number): string[] {
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const day = Math.floor((i * 9131) / n); // 25 ans ≈ 9 131 jours
      const date = new Date(Date.UTC(2000, 0, 1) + day * 86_400_000);
      out.push(syntheticRecord(100_000 + i, { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() }));
    }
    return out;
  }

  test('tout récupérer : lots de 500 lus dans l’historique, total et traduction consignés', async () => {
    const fake = createFakeEutils(synthetic(1234), { queryTranslation: () => '"appendicitis"[MeSH Terms]' });
    const result = await searchPubmed(cfg(), { query: 'appendicitis', sort: 'relevance', limit: null }, { fetchImpl: fake.fetchImpl, limiter: noWait });
    assert.equal(result.totalCount, 1234);
    assert.equal(result.refs.length, 1234);
    assert.equal(result.queryTranslation, '"appendicitis"[MeSH Terms]');
    const fetches = fake.calls.filter((c) => c.endpoint === 'efetch');
    assert.deepEqual(fetches.map((c) => [c.params.get('retstart'), c.params.get('retmax')]), [['0', '500'], ['500', '500'], ['1000', '234']]);
    assert.ok(fetches.every((c) => c.params.get('WebEnv') === 'MCID_fake_1' && c.params.get('query_key') === '1'));
    assert.equal(result.slices, 1);
  });

  test('exploration : les N premiers seulement, et l’avertissement le dit', async () => {
    const fake = createFakeEutils(synthetic(300));
    const result = await searchPubmed(cfg(), { query: 'x', sort: 'date', limit: 40 }, { fetchImpl: fake.fetchImpl, limiter: noWait });
    assert.equal(result.totalCount, 300);
    assert.equal(result.refs.length, 40);
    assert.match(result.warnings.join(' '), /Exploration : 40 premiers résultats sur 300 \(les plus récents\)/);
  });

  test('au-delà de 9 999 : découpage par dates, tout est récupéré, rien en double, aucune page hors fenêtre', async () => {
    const records = synthetic(23_456);
    const fake = createFakeEutils(records);
    const result = await searchPubmed(cfg({ maxRecords: 50_000 }), { query: 'x', sort: 'relevance', limit: null, yearFrom: 2000, yearTo: 2024 }, { fetchImpl: fake.fetchImpl, limiter: noWait });
    assert.equal(result.totalCount, 23_456);
    assert.equal(result.refs.length, 23_456);
    assert.equal(new Set(result.refs.map((r) => r.pmid)).size, 23_456);
    assert.ok(result.slices >= 3, `${result.slices} tranches`);
    const efetches = fake.calls.filter((c) => c.endpoint === 'efetch');
    assert.ok(efetches.every((c) => Number(c.params.get('retstart')) + Number(c.params.get('retmax')) <= ESEARCH_WINDOW));
    const slicing = fake.calls.filter((c) => c.endpoint === 'esearch' && /^\d{4}\/\d{2}\/\d{2}$/.test(c.params.get('mindate') ?? ''));
    assert.ok(slicing.length >= 3);
    assert.match(result.warnings.join(' '), /découpée en \d+ tranches de dates de publication/);
  });

  test('au-delà du plafond : rien n’est importé, le total est gardé pour le journal', async () => {
    const fake = createFakeEutils(synthetic(1500));
    await assert.rejects(
      searchPubmed(cfg({ maxRecords: 1000 }), { query: 'appendicitis', sort: 'relevance', limit: null }, { fetchImpl: fake.fetchImpl, limiter: noWait }),
      (e: unknown) => {
        assert.ok(e instanceof EutilsError);
        assert.equal(e.kind, 'cap');
        assert.match(e.message, /1\u202f500 résultats dans PubMed, au-delà du plafond de 1\u202f000 notices par passe \(BIBLIO_PUBMED_MAX\)/);
        assert.equal(e.context.totalCount, 1500);
        return true;
      },
    );
    assert.equal(fake.calls.filter((c) => c.endpoint === 'efetch').length, 0, 'aucune notice téléchargée');
  });

  test('zéro résultat : une recherche valable, sans efetch', async () => {
    const fake = createFakeEutils([]);
    const result = await searchPubmed(cfg(), { query: 'zzqxqzz', sort: 'relevance', limit: null }, { fetchImpl: fake.fetchImpl, limiter: noWait });
    assert.equal(result.totalCount, 0);
    assert.equal(result.refs.length, 0);
    assert.equal(fake.calls.length, 1);
  });

  test('une page illisible en cours de route : tout ou rien, avec le total déjà connu', async () => {
    const fake = createFakeEutils(synthetic(800), {
      intercept: (call) => (call.endpoint === 'efetch' && call.params.get('retstart') === '500' ? { status: 200, body: '<eFetchResult><ERROR>Unable to obtain query #1</ERROR></eFetchResult>' } : null),
    });
    await assert.rejects(searchPubmed(cfg(), { query: 'x', sort: 'relevance', limit: null }, { fetchImpl: fake.fetchImpl, limiter: noWait }), (e: unknown) => {
      assert.ok(e instanceof EutilsError);
      assert.match(e.message, /page de notices illisible \(Unable to obtain query #1\)/);
      assert.equal(e.context.totalCount, 800);
      return true;
    });
  });
});
