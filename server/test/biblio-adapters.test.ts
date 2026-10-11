/**
 * Adaptateurs d'acteurs Apify : lecture de VRAIES sorties.
 *
 * Les jeux d'essai de `apify-fixtures/` sont des exécutions réelles des acteurs
 * (octobre 2026). Seul Google Scholar passe encore par Apify : PubMed est lu
 * par son API officielle (voir `biblio-eutils.test.ts`). Les tests vérifient qu'on lit ce que les acteurs rendent
 * vraiment — y compris leurs défauts — plutôt que ce que leur documentation
 * laisse espérer. Aucune base, aucun réseau.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { ApifyError, adapterFor, apifyConfig, scholarQuery, searchSource } from '../src/biblio/apify.js';
import {
  authorForBibtex,
  doiFromUrl,
  isTruncated,
  normDoi,
  normTitle,
  pmcFromUrl,
  safeUrl,
  splitAuthors,
} from '../src/biblio/normalize.js';

const fixture = (name: string): Record<string, unknown>[] =>
  JSON.parse(fs.readFileSync(new URL(`./apify-fixtures/${name}`, import.meta.url), 'utf8'));

const GEORGE = fixture('scholar-george.json');
const JOHNVC = fixture('scholar-johnvc.json');

const george = adapterFor('scholar', 'george.the.developer/google-scholar-scraper');
const johnvc = adapterFor('scholar', 'johnvc/google-scholar-api');

describe('Google Scholar — george.the.developer/google-scholar-scraper', () => {
  test('lit un résultat : année et revue déjà séparées', () => {
    const ref = george.map(GEORGE[0])!;
    assert.equal(ref.source, 'scholar');
    assert.equal(ref.title, 'HoLEP: the gold standard for the surgical management of BPH in the 21st century');
    assert.deepEqual(ref.authors, ['J Michalak', 'D Tzou', 'J Funk']);
    assert.equal(ref.year, 2015);
    assert.equal(ref.journal, 'American journal of clinical and …');
    assert.equal(ref.citedBy, 239);
    assert.ok(ref.citedByUrl?.startsWith('https://scholar.google.com/scholar?cites='));
    assert.equal(ref.pmcid, 'PMC4446381', 'l’identifiant PMC se lit dans l’adresse');
    assert.equal(ref.doi, null);
    assert.equal(ref.abstract, null, 'Scholar ne donne qu’un extrait, jamais un résumé');
    assert.ok(ref.snippet?.startsWith('… years, transurethral resection'));
    assert.ok(!ref.snippet?.includes('\n'), 'les retours à la ligne de l’extrait sont aplatis');
  });

  test('écarte le lien de PDF « javascript:void(0) » que l’acteur rend vraiment', () => {
    assert.equal(george.map(GEORGE[0])!.pdfUrl, null);
    assert.equal(george.map(GEORGE[4])!.pdfUrl, null, 'un lien de PDF vide donne null');
  });

  test('lit le DOI porté par l’adresse de l’éditeur', () => {
    assert.equal(george.map(GEORGE[1])!.doi, '10.1177/03000605231190763');
    assert.equal(george.map(GEORGE[4])!.doi, null, 'un identifiant ScienceDirect (pii) n’est pas un DOI');
  });

  test('retire l’ellipse finale de la liste d’auteurs', () => {
    const chen = george.map(GEORGE[1])!;
    assert.equal(chen.authors.length, 4);
    assert.equal(chen.authors.at(-1), 'Y Wang');
    assert.equal(george.map(GEORGE[3])!.authors.at(-1), 'D Wang');
  });

  test('construit l’entrée de l’acteur', () => {
    assert.deepEqual(george.buildInput({ query: 'holep turp', maxResults: 10, sort: 'relevance' }), {
      query: 'holep turp',
      maxResults: 10,
      language: 'en',
      sortBy: 'relevance',
      includeAbstracts: true,
      includeCitations: false,
    });
    const dated = george.buildInput({ query: 'x', maxResults: 3, sort: 'date', yearFrom: 2020, yearTo: 2025 });
    assert.equal(dated.sortBy, 'date');
    assert.equal(dated.yearFrom, 2020);
    assert.equal(dated.yearTo, 2025);
  });
});

describe('Google Scholar — johnvc/google-scholar-api', () => {
  test('lit un résultat : auteurs, année et revue viennent de la ligne de résumé', () => {
    const ref = johnvc.map(JOHNVC[0])!;
    assert.deepEqual(ref.authors, ['J Michalak', 'D Tzou', 'J Funk']);
    assert.equal(ref.year, 2015);
    assert.equal(ref.journal, 'American journal of clinical and …');
    assert.equal(ref.citedBy, 239);
    assert.equal(ref.pdfUrl, 'https://pmc.ncbi.nlm.nih.gov/articles/PMC4446381/pdf/ajceu0003-0036.pdf');
    assert.ok(ref.snippet?.startsWith('… years, transurethral'));
  });

  test('sans lien de PDF, ou avec une revue complète', () => {
    const kuntz = johnvc.map(JOHNVC[4])!;
    assert.equal(kuntz.pdfUrl, null);
    assert.equal(kuntz.year, 2006);
    assert.equal(kuntz.journal, 'European urology');
    assert.deepEqual(kuntz.authors, ['RM Kuntz']);
    assert.equal(johnvc.map(JOHNVC[1])!.doi, '10.1177/03000605231190763');
  });

  test('écarte une ligne de notice sans titre (quota, message)', () => {
    assert.equal(johnvc.map({ free_tier_notice: true, message: 'Quota atteint.' }), null);
  });

  test('construit l’entrée : pages de 20 résultats au plus', () => {
    assert.deepEqual(johnvc.buildInput({ query: 'x', maxResults: 45, sort: 'relevance' }), {
      mode: 'search',
      q: 'x',
      num: 20,
      max_pages: 3,
      scisbd: '0',
    });
    assert.equal(johnvc.buildInput({ query: 'x', maxResults: 5, sort: 'relevance' }).num, 5);
  });
});

describe('recherche d’une source', () => {
  test('un acteur non pris en charge est refusé en le disant', () => {
    assert.throws(
      () => adapterFor('scholar', 'quelqu-un/autre-acteur'),
      (e: unknown) =>
        e instanceof ApifyError && e.kind === 'config' && /pas pris en charge/.test(e.message) && /johnvc/.test(e.message),
    );
  });

  test('sans jeton, aucun appel n’est tenté', async () => {
    const cfg = { ...apifyConfig({}), token: '' };
    let called = false;
    await assert.rejects(
      searchSource(cfg, 'scholar', { query: 'x', maxResults: 5, sort: 'relevance' }, (async () => {
        called = true;
        return new Response('[]');
      }) as typeof fetch),
      (e: unknown) => e instanceof ApifyError && e.kind === 'config' && /APIFY_TOKEN/.test(e.message),
    );
    assert.equal(called, false);
  });

  test('l’acteur qui ne rend que des notices est signalé, pas compté comme « zéro résultat »', async () => {
    const cfg = { ...apifyConfig({}), token: 't' };
    await assert.rejects(
      searchSource(cfg, 'scholar', { query: 'x', maxResults: 5, sort: 'relevance' }, (async () =>
        new Response(JSON.stringify([{ message: 'Quota mensuel atteint.' }]))) as typeof fetch),
      /Quota mensuel atteint/,
    );
  });

  test('le plafond demandé fait foi quand l’acteur rend davantage', async () => {
    const cfg = { ...apifyConfig({}), token: 't' };
    const result = await searchSource(
      cfg,
      'scholar',
      { query: 'x', maxResults: 2, sort: 'relevance' },
      (async () => new Response(JSON.stringify(GEORGE))) as typeof fetch,
    );
    assert.equal(result.refs.length, 2);
  });

  test('une ligne illisible est comptée, pas fatale', async () => {
    const cfg = { ...apifyConfig({}), token: 't' };
    const result = await searchSource(
      cfg,
      'scholar',
      { query: 'x', maxResults: 10, sort: 'relevance' },
      (async () => new Response(JSON.stringify([GEORGE[0], { pmid: '9' }, 12]))) as typeof fetch,
    );
    assert.equal(result.refs.length, 1);
    assert.equal(result.skipped, 2);
  });
});

describe('équation transmise à Google Scholar', () => {
  test('les balises de champ PubMed sont retirées, et dites', () => {
    assert.deepEqual(
      scholarQuery('(appendicitis[MeSH Terms] OR appendicitis[tiab]) AND (antibiotic*[tiab]) AND appendectomy[Title/Abstract]'),
      { query: '(appendicitis OR appendicitis) AND (antibiotic*) AND appendectomy', removed: ['[MeSH Terms]', '[tiab]', '[Title/Abstract]'] },
    );
  });

  test('les bornes de dates en syntaxe PubMed partent avec leurs opérateurs', () => {
    assert.deepEqual(scholarQuery('holep AND 2015:2025[dp]'), { query: 'holep', removed: ['2015:2025[dp]'] });
    assert.equal(scholarQuery('"Appendicitis"[Mesh:NoExp] AND ("2015/01/01"[pdat] : "2025/12/31"[pdat])').query, '"Appendicitis"');
  });

  test('une équation sans balise passe telle quelle', () => {
    assert.deepEqual(scholarQuery('  HoLEP versus TURP '), { query: 'HoLEP versus TURP', removed: [] });
  });
});

describe('normalisation', () => {
  test('adresses : seules http et https passent', () => {
    assert.equal(safeUrl('javascript:void(0)'), null);
    assert.equal(safeUrl('data:text/html,<script>1</script>'), null);
    assert.equal(safeUrl(''), null);
    assert.equal(safeUrl('pas une adresse'), null);
    assert.equal(safeUrl('https://doi.org/10.1/x'), 'https://doi.org/10.1/x');
  });

  test('DOI : préfixe, casse et ponctuation finale', () => {
    assert.equal(normDoi('https://doi.org/10.1002/BJS.5916.'), '10.1002/bjs.5916');
    assert.equal(normDoi('doi: 10.1111/iju.14737)'), '10.1111/iju.14737');
    assert.equal(normDoi('pas de doi'), null);
  });

  test('DOI d’une adresse : seulement quand elle l’annonce', () => {
    assert.equal(doiFromUrl('https://journals.sagepub.com/doi/pdf/10.1177/03000605231190763'), '10.1177/03000605231190763');
    assert.equal(doiFromUrl('https://doi.org/10.1002/bjs.5916'), '10.1002/bjs.5916');
    assert.equal(doiFromUrl('https://www.sciencedirect.com/science/article/pii/S0302283806003575'), null);
    assert.equal(doiFromUrl(null), null);
  });

  test('PMC, ellipses et titres normalisés', () => {
    assert.equal(pmcFromUrl('https://pmc.ncbi.nlm.nih.gov/articles/PMC4446381/'), 'PMC4446381');
    assert.equal(pmcFromUrl('https://example.org/x'), null);
    assert.equal(isTruncated('Un titre trop long …'), true);
    assert.equal(isTruncated('Un titre complet'), false);
    assert.equal(normTitle('  Étude : HoLEP vs. TURP — résultats… '), 'etude holep vs turp resultats');
    // PubMed aplatit les exposants (« 21(st) Century »), Scholar les écrit à plat : même titre.
    assert.equal(
      normTitle('HoLEP: the gold standard for the surgical management of BPH in the 21(st) Century.'),
      normTitle('HoLEP: the gold standard for the surgical management of BPH in the 21st century'),
    );
    assert.equal(normTitle('Effect of CO(2) pneumoperitoneum'), normTitle('Effect of CO2 pneumoperitoneum'));
    // Une parenthèse précédée d'une espace est un sigle, pas un exposant : elle ne se recolle pas.
    assert.equal(normTitle('Benign prostatic hyperplasia (BPH)'), 'benign prostatic hyperplasia bph');
    assert.deepEqual(splitAuthors('A Shvero, B Calio…'), ['A Shvero', 'B Calio']);
  });

  test('auteurs au format BibTeX', () => {
    assert.equal(authorForBibtex('Ritter M'), 'Ritter, M');
    assert.equal(authorForBibtex('J Michalak'), 'Michalak, J');
    assert.equal(authorForBibtex('AK Das'), 'Das, AK');
    assert.equal(authorForBibtex('Organisation mondiale'), 'Organisation mondiale');
  });
});
