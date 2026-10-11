/**
 * Faux service E-utilities, pour les tests : aucun appel au vrai NCBI.
 *
 * Il rejoue des notices réelles (`eutils-fixtures/`, enregistrées en octobre
 * 2026 puis allégées) ou des notices fabriquées en nombre, et se comporte
 * comme le vrai sur ce qui compte : `Count`, historique (WebEnv), pagination
 * par `retstart`/`retmax`, fenêtre de 9 999 résultats, filtre de dates.
 */
import fs from 'node:fs';

export const fixtureText = (name: string): string =>
  fs.readFileSync(new URL(`./eutils-fixtures/${name}`, import.meta.url), 'utf8');

/** Les notices d'un fichier `efetch`, une chaîne XML chacune. */
export function splitRecords(xml: string): string[] {
  return xml.match(/<Pubmed(?:Book)?Article>[\s\S]*?<\/Pubmed(?:Book)?Article>/g) ?? [];
}

export const wrapRecords = (records: string[]): string =>
  `<?xml version="1.0" ?>\n<!DOCTYPE PubmedArticleSet PUBLIC "-//NLM//DTD PubMedArticle, 1st January 2025//EN" "https://dtd.nlm.nih.gov/ncbi/pubmed/out/pubmed_250101.dtd">\n<PubmedArticleSet>\n${records.join('\n')}\n</PubmedArticleSet>`;

/** Une notice fabriquée : PMID, titre et date de publication suffisent aux tests de pagination. */
export function syntheticRecord(pmid: number, date: { y: number; m: number; d: number }): string {
  return `<PubmedArticle><MedlineCitation><PMID Version="1">${pmid}</PMID><Article><Journal><JournalIssue><PubDate><Year>${date.y}</Year><Month>${date.m}</Month><Day>${date.d}</Day></PubDate></JournalIssue><Title>Journal ${pmid % 7}</Title></Journal><ArticleTitle>Synthetic record number ${pmid} about appendicitis.</ArticleTitle><AuthorList><Author><LastName>Auteur${pmid}</LastName><Initials>A</Initials></Author></AuthorList></Article></MedlineCitation><PubmedData><ArticleIdList><ArticleId IdType="pubmed">${pmid}</ArticleId></ArticleIdList></PubmedData></PubmedArticle>`;
}

interface FakeRecord {
  xml: string;
  /** Date de publication, en jours depuis l'époque (UTC). */
  day: number | null;
}

const dayOf = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);

function parseBound(raw: string | null, end: boolean): number | null {
  if (!raw) return null;
  const [y, m, d] = raw.split('/').map(Number);
  if (!y) return null;
  if (m && d) return dayOf(y, m, d);
  if (m) return end ? dayOf(y, m + 1, 1) - 1 : dayOf(y, m, 1);
  return end ? dayOf(y, 12, 31) : dayOf(y, 1, 1);
}

function recordDay(xml: string): number | null {
  const pub = /<PubDate>([\s\S]*?)<\/PubDate>/.exec(xml)?.[1] ?? '';
  const y = Number(/<Year>(\d{4})<\/Year>/.exec(pub)?.[1]);
  if (!y) return null;
  const monthRaw = /<Month>([^<]+)<\/Month>/.exec(pub)?.[1] ?? '1';
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const m = Number(monthRaw) || months.indexOf(monthRaw.slice(0, 3).toLowerCase()) + 1 || 1;
  const d = Number(/<Day>(\d+)<\/Day>/.exec(pub)?.[1]) || 1;
  return dayOf(y, m, d);
}

export interface FakeCall {
  endpoint: string;
  params: URLSearchParams;
}

export interface FakeEutilsOptions {
  /** Notices rendues pour une équation ; par défaut, toutes. */
  recordsFor?: (term: string) => string[];
  /** Réponse forcée pour un appel (statut, corps, en-têtes) : panne, 429… */
  intercept?: (call: FakeCall, index: number) => { status: number; body: string; headers?: Record<string, string> } | null;
  queryTranslation?: (term: string) => string;
}

/**
 * Le cœur du faux service : une fonction (endpoint, paramètres) → réponse.
 * Elle sert à la fois de `fetch` injecté (tests du client) et de serveur HTTP (tests des routes).
 */
export function createFakeEutils(allRecords: string[], options: FakeEutilsOptions = {}) {
  const calls: FakeCall[] = [];
  const histories = new Map<string, FakeRecord[]>();
  const toFake = (xml: string): FakeRecord => ({ xml, day: recordDay(xml) });
  const cache = new Map<string[], FakeRecord[]>();
  const recordsFor = (term: string): FakeRecord[] => {
    const list = options.recordsFor ? options.recordsFor(term) : allRecords;
    let mapped = cache.get(list);
    if (!mapped) {
      mapped = list.map(toFake);
      cache.set(list, mapped);
    }
    return mapped;
  };

  function handle(endpoint: string, params: URLSearchParams): { status: number; body: string; headers?: Record<string, string> } {
    const call = { endpoint, params };
    calls.push(call);
    const forced = options.intercept?.(call, calls.length - 1);
    if (forced) return forced;

    if (endpoint === 'esearch') {
      const term = params.get('term') ?? '';
      const from = parseBound(params.get('mindate'), false);
      const to = parseBound(params.get('maxdate'), true);
      const matching = recordsFor(term).filter(
        (r) => (from === null || (r.day !== null && r.day >= from)) && (to === null || (r.day !== null && r.day <= to)),
      );
      const webenv = `MCID_fake_${histories.size + 1}`;
      histories.set(webenv, matching);
      return {
        status: 200,
        body: JSON.stringify({
          header: { type: 'esearch', version: '0.3' },
          esearchresult: {
            count: String(matching.length),
            retmax: '0',
            retstart: '0',
            querykey: '1',
            webenv,
            idlist: [],
            translationset: [],
            querytranslation: options.queryTranslation?.(term) ?? `${term}[All Fields]`,
          },
        }),
      };
    }
    if (endpoint === 'efetch') {
      const records = histories.get(params.get('WebEnv') ?? '');
      if (!records) return { status: 200, body: '<eFetchResult><ERROR>Unable to obtain query #1</ERROR></eFetchResult>' };
      const start = Number(params.get('retstart') ?? 0);
      const max = Number(params.get('retmax') ?? 20);
      // Comme le vrai : au-delà du 9 999e résultat d'un historique, plus rien.
      if (start > 9998) return { status: 200, body: '<eFetchResult><ERROR>Search Backend failed: retstart too large</ERROR></eFetchResult>' };
      const slice = records.slice(start, Math.min(start + max, 9999));
      return { status: 200, body: wrapRecords(slice.map((r) => r.xml)) };
    }
    return { status: 404, body: '{"error":"unknown endpoint"}' };
  }

  /** `fetch` de remplacement, pour le client. */
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const endpoint = /\/(\w+)\.fcgi$/.exec(url.pathname)?.[1] ?? '';
    const params = new URLSearchParams(typeof init?.body === 'string' ? init.body : url.search);
    const res = handle(endpoint, params);
    return new Response(res.body, { status: res.status, headers: res.headers });
  }) as typeof fetch;

  return { calls, handle, fetchImpl };
}

/** Horloge factice : les attentes sont notées et le temps avance d'autant, sans dormir. */
export function fakeClock() {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}
