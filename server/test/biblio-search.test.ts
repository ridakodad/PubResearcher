/**
 * Recherche dans la bibliothèque d'une revue : plusieurs mots, sans égard aux accents ni à la casse,
 * expressions entre guillemets. Un chercheur retape « etude enfants diabete » sans accents ni ordre.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-biblio-search-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';

const { addRefsFromSearch, createSearch, listAllRefs, listRefs, searchTerms } = await import('../src/repo/biblio.js');
const { createApp } = await import('../src/app.js');
import type { BiblioRefInput } from '../src/biblio/types.js';

const ref = (over: Partial<BiblioRefInput>): BiblioRefInput => ({
  source: 'pubmed',
  title: 'Titre',
  authors: [],
  year: null,
  journal: null,
  volume: null,
  issue: null,
  pages: null,
  doi: null,
  pmid: null,
  pmcid: null,
  url: null,
  pdfUrl: null,
  abstract: null,
  snippet: null,
  keywords: [],
  meshTerms: [],
  publicationTypes: [],
  citedBy: null,
  citedByUrl: null,
  ...over,
});

before(() => {
  const searchId = createSearch({ source: 'pubmed', actor: 'a/b', query: 'x', yearFrom: null, yearTo: null, maxResults: 10, sort: 'relevance' });
  addRefsFromSearch(searchId, [
    ref({
      title: 'Étude du diabète de type 2 chez l’enfant',
      authors: ['Müller K', 'Lefèvre A'],
      journal: 'Archives de Pédiatrie',
      year: 2021,
      pmid: '33445566',
      doi: '10.1000/abc_100%',
      abstract: 'Une cohorte rétrospective de 120 enfants suivis à l’hôpital.',
      meshTerms: ['Diabetes Mellitus, Type 2', 'Child'],
    }),
    ref({
      title: 'Diabetes in adults: a randomised trial',
      authors: ['Smith J'],
      journal: 'The Lancet',
      year: 2019,
      pmid: '11112222',
      abstract: 'Adults with type 2 diabetes were randomised.',
    }),
    ref({
      title: 'Asthme de l’enfant et pollution',
      authors: ['Durand P'],
      journal: 'Revue des Maladies Respiratoires',
      year: 2022,
      keywords: ['asthme', 'pollution'],
      abstract: 'Étude cas-témoins.',
    }),
  ]);
});

after(async () => {
  const { db } = await import('../src/db/index.js');
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const titles = (q: string): string[] => listRefs({ q, sort: 'added' }).refs.map((r) => r.title);

describe('termes de recherche', () => {
  test('des mots, ou des expressions entre guillemets ; accents et casse repliés', () => {
    assert.deepEqual(searchTerms('Diabète  ENFANT'), ['diabete', 'enfant']);
    assert.deepEqual(searchTerms('"type 2" diabète'), ['type 2', 'diabete']);
    assert.deepEqual(searchTerms('  ,; '), []);
    assert.deepEqual(searchTerms('a, b; c'), ['a', 'b', 'c']);
  });

  test('douze termes au plus : une requête démesurée ne coûte pas davantage', () => {
    assert.equal(searchTerms(Array.from({ length: 50 }, (_, i) => `mot${i}`).join(' ')).length, 12);
  });
});

describe('recherche dans la bibliothèque', () => {
  test('tous les mots doivent figurer, dans n’importe quel champ et n’importe quel ordre', () => {
    assert.deepEqual(titles('diabète enfant'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('enfant diabète'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('lancet adults'), ['Diabetes in adults: a randomised trial']);
  });

  test('sans accents, en majuscules, avec des lettres non ASCII que SQLite ne replie pas', () => {
    assert.deepEqual(titles('etude diabete'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('ÉTUDE DIABÈTE'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('muller lefevre'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('pediatrie'), ['Étude du diabète de type 2 chez l’enfant']);
  });

  test('un mot partiel convient', () => {
    assert.equal(titles('diab').length, 2);
    assert.deepEqual(titles('asth'), ['Asthme de l’enfant et pollution']);
  });

  test('une expression entre guillemets se cherche telle quelle', () => {
    assert.deepEqual(titles('"type 2 diabetes"').sort(), ['Diabetes in adults: a randomised trial']);
    assert.deepEqual(titles('"type 2" enfant'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('"enfant diabète"'), [], 'l’ordre compte dans une expression');
  });

  test('résumé, mots-clés, MeSH, identifiants et année sont interrogeables', () => {
    assert.deepEqual(titles('cohorte retrospective'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('pollution'), ['Asthme de l’enfant et pollution']);
    assert.deepEqual(titles('"Diabetes Mellitus"'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('33445566'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('10.1000/abc'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('2022'), ['Asthme de l’enfant et pollution']);
  });

  test('% et _ sont des caractères comme les autres, pas des jokers', () => {
    assert.deepEqual(titles('100%'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('abc_100'), ['Étude du diabète de type 2 chez l’enfant']);
    assert.deepEqual(titles('%'), ['Étude du diabète de type 2 chez l’enfant'], 'un « % » ne convient pas à tout');
    assert.deepEqual(titles('_'), ['Étude du diabète de type 2 chez l’enfant']);
  });

  test('aucune correspondance : liste vide et total à zéro', () => {
    const none = listRefs({ q: 'inexistant' });
    assert.deepEqual(none, { refs: [], total: 0 });
  });

  test('la recherche se combine aux filtres et se pagine sur le résultat filtré', () => {
    assert.equal(listRefs({ q: 'enfant', decision: 'include' }).total, 0);
    assert.equal(listRefs({ q: 'enfant', decision: 'pending' }).total, 2);
    const page = listRefs({ q: 'enfant', limit: 1, offset: 1, sort: 'added' });
    assert.equal(page.total, 2);
    assert.equal(page.refs.length, 1);
    assert.equal(page.refs[0]?.title, 'Asthme de l’enfant et pollution');
  });

  test('sans terme de recherche, la liste complète', () => {
    assert.equal(listRefs({}).total, 3);
    assert.equal(listRefs({ q: '   ' }).total, 3);
  });
});

describe('exports : complets et nommés d’après leur contenu', () => {
  let server: Server;
  let base = '';

  before(async () => {
    // 1 200 notices de plus : au-delà du plafond d'une page de liste (1 000).
    const searchId = createSearch({ source: 'pubmed', actor: 'a/b', query: 'volume', yearFrom: null, yearTo: null, maxResults: 100, sort: 'relevance' });
    addRefsFromSearch(
      searchId,
      Array.from({ length: 1200 }, (_, i) => ref({ title: `Notice de volume numéro ${i + 1} sur un sujet particulier ${i * 7}`, year: 2000 + (i % 20), pmid: String(70000000 + i) })),
    );
    await new Promise<void>((resolve) => {
      server = createApp({ password: null }).listen(0, '127.0.0.1', () => {
        const address = server.address();
        base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('une bibliothèque de plus de 1 000 notices s’exporte entière, en RIS comme en CSV', async () => {
    assert.equal(listAllRefs().length, 1203);
    const ris = await (await fetch(`${base}/api/biblio/export?format=ris&decision=all`)).text();
    assert.equal((ris.match(/^TY {2}- JOUR/gm) ?? []).length, 1203);
    const bib = await (await fetch(`${base}/api/biblio/export?format=bibtex&decision=all`)).text();
    assert.equal((bib.match(/^@article\{/gm) ?? []).length, 1203);
    const csv = await (await fetch(`${base}/api/biblio/export?format=csv&decision=all`)).text();
    assert.equal(csv.trim().split('\r\n').length, 1203 + 1, 'une ligne par notice plus l’en-tête');
  });

  test('le nom du fichier dit ce qu’il contient', async () => {
    const names: Record<string, string> = {};
    for (const decision of ['all', 'include', 'maybe', 'exclude', 'pending']) {
      const res = await fetch(`${base}/api/biblio/export?format=ris&decision=${decision}`);
      names[decision] = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? '';
    }
    assert.match(names['all']!, /^references-toutes-\d{4}-\d{2}-\d{2}\.ris$/);
    assert.match(names['include']!, /^references-retenues-/);
    assert.match(names['maybe']!, /^references-a-voir-/);
    assert.match(names['exclude']!, /^references-exclues-/);
    assert.match(names['pending']!, /^references-a-trier-/);
    const searches = await fetch(`${base}/api/biblio/export?format=searches`);
    assert.match(searches.headers.get('content-disposition') ?? '', /strategies-de-recherche-\d{4}/);
  });
});
