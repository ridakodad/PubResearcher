/**
 * PubMed par l'API officielle du NCBI : les E-utilities.
 *
 * Gratuites, sans jeton : c'est la source par défaut de la revue
 * bibliographique. Trois appels suffisent à une recherche complète :
 *
 * 1. `esearch` (avec `usehistory=y`) donne le nombre TOTAL de résultats
 *    (`Count`) et la traduction de l'équation par PubMed (`QueryTranslation`,
 *    termes MeSH développés compris) — les deux pièces du journal de recherche
 *    que PRISMA-S demande ;
 * 2. `efetch` rend les notices complètes en XML, par lots, à partir de
 *    l'historique du serveur (WebEnv) ;
 * 3. au-delà de 9 999 résultats, `esearch` ne pagine plus : la recherche est
 *    découpée par tranches de dates de publication, chacune sous la limite.
 *
 * Le NCBI demande trois choses à ses clients, toutes tenues ici : au plus
 * 3 requêtes par seconde (10 avec une clé `NCBI_API_KEY`), le paramètre
 * `tool` et, si possible, une adresse `email` (`NCBI_EMAIL`).
 *
 * La clé d'API ne quitte jamais ce module : elle n'est ni journalisée, ni
 * rendue dans une erreur, ni transmise à l'interface.
 */

import { readNumericEnv, type NumericSetting } from '../lib/env-check.js';
import { redactSecret } from '../lib/redact.js';
import { childOf, childrenOf, descendantsOf, parseXml, pathOf, textOf, type XmlElement } from '../lib/xml.js';
import { normDoi } from './normalize.js';
import type { BiblioRefInput, RefType, SearchSort } from './types.js';

/* ───────────────────────────── Configuration ───────────────────────────── */

export const EUTILS_SERVICE = 'NCBI E-utilities';
export const TOOL_NAME = 'PubResearcher';

/** `esearch` ne rend jamais au-delà du 9 999e résultat d'une même requête (limite du NCBI depuis 2022). */
export const ESEARCH_WINDOW = 9_999;

export interface EutilsConfig {
  baseUrl: string;
  apiKey: string;
  email: string;
  timeoutMs: number;
  /** Plafond de notices récupérées en une passe « tout récupérer ». */
  maxRecords: number;
  /** Notices par appel à `efetch`. */
  batchSize: number;
  /** Nouvelles tentatives après un 429, une erreur 5xx ou une coupure réseau. */
  retries: number;
}

/**
 * Bornes des réglages de PubMed. Une valeur hors bornes ou illisible donne le
 * défaut : la passe ne doit pas tomber pour un réglage mal écrit.
 */
export const EUTILS_SETTINGS = {
  BIBLIO_PUBMED_MAX: { min: 1, max: 200_000 },
  NCBI_TIMEOUT_MS: { min: 1000, max: 600_000 },
} as const satisfies Record<string, NumericSetting>;

/** Lue à chaque passe : la clé et l'adresse se posent dans l'environnement, jamais dans le code. */
export function eutilsConfig(env: NodeJS.ProcessEnv = process.env): EutilsConfig {
  const num = (name: keyof typeof EUTILS_SETTINGS, fallback: number) => {
    try {
      return readNumericEnv(name, env[name], fallback, EUTILS_SETTINGS[name]);
    } catch {
      return fallback;
    }
  };
  return {
    baseUrl: (env.NCBI_EUTILS_BASE ?? 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils').trim().replace(/\/+$/, ''),
    apiKey: (env.NCBI_API_KEY ?? '').trim(),
    email: (env.NCBI_EMAIL ?? '').trim(),
    timeoutMs: num('NCBI_TIMEOUT_MS', 60_000),
    maxRecords: num('BIBLIO_PUBMED_MAX', 10_000),
    batchSize: 500,
    retries: 3,
  };
}

/* ───────────────────────────────── Erreurs ──────────────────────────────── */

export type EutilsErrorKind = 'query' | 'auth' | 'rate' | 'timeout' | 'network' | 'server' | 'cap' | 'parse';

export class EutilsError extends Error {
  constructor(
    readonly kind: EutilsErrorKind,
    message: string,
    /** Ce que la passe avait appris avant d'échouer : le journal de recherche le garde. */
    readonly context: { totalCount?: number; queryTranslation?: string | null } = {},
  ) {
    super(message);
    this.name = 'EutilsError';
  }
}

/* ─────────────────────────────── Débit limité ───────────────────────────── */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Espace les requêtes : au plus `rps()` par seconde, dans l'ordre d'arrivée.
 *
 * Chaque appel réserve le prochain créneau libre puis attend son heure ; deux
 * passes simultanées (ce que le verrou des routes empêche, mais un test ou un
 * script pourrait le faire) se partagent donc le même débit au lieu de le
 * doubler. Une marge de 10 % absorbe la gigue des horloges.
 */
export function createRateLimiter(rps: () => number, clock: Clock = realClock): () => Promise<void> {
  let nextSlot = 0;
  return async () => {
    const interval = Math.ceil(1100 / Math.max(1, rps()));
    const now = clock.now();
    const slot = Math.max(now, nextSlot);
    nextSlot = slot + interval;
    if (slot > now) await clock.sleep(slot - now);
  };
}

/** Limiteur partagé par tout le serveur : le NCBI compte les requêtes par adresse IP, pas par passe. */
let sharedLimiter: { key: boolean; acquire: () => Promise<void> } | null = null;
function limiterFor(cfg: EutilsConfig): () => Promise<void> {
  const key = cfg.apiKey.length > 0;
  if (!sharedLimiter || sharedLimiter.key !== key) {
    sharedLimiter = { key, acquire: createRateLimiter(() => (key ? 10 : 3)) };
  }
  return sharedLimiter.acquire;
}

/* ─────────────────────────────── Client HTTP ────────────────────────────── */

export interface EutilsDeps {
  fetchImpl?: typeof fetch;
  clock?: Clock;
  /** Limiteur de débit ; par défaut celui, partagé, du serveur. */
  limiter?: () => Promise<void>;
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_DETAIL = 200;

function httpFailure(status: number, body: string): EutilsError {
  let detail = '';
  try {
    const parsed = JSON.parse(body) as { error?: unknown; ERROR?: unknown };
    detail = String(parsed.error ?? parsed.ERROR ?? '');
  } catch {
    detail = /<ERROR>([\s\S]*?)<\/ERROR>/i.exec(body)?.[1] ?? '';
  }
  detail = detail.replace(/\s+/g, ' ').trim().slice(0, MAX_DETAIL);
  if (/api[ _-]?key/i.test(detail) && status !== 429) {
    return new EutilsError('auth', 'Clé NCBI_API_KEY refusée par le NCBI : vérifiez-la, ou retirez-la (PubMed fonctionne sans clé, à 3 requêtes par seconde).');
  }
  if (status === 429) {
    return new EutilsError(
      'rate',
      'PubMed limite le débit (429) : trop de requêtes par seconde depuis ce poste. Réessayez dans une minute ; une clé NCBI_API_KEY relève la limite de 3 à 10 requêtes par seconde.',
    );
  }
  if (status >= 500) {
    return new EutilsError('server', `Le service E-utilities de PubMed est indisponible (erreur ${status}). Réessayez plus tard.`);
  }
  return new EutilsError('query', `PubMed a refusé la requête (erreur ${status})${detail ? ` : ${detail}` : '.'} Vérifiez la syntaxe de l’équation.`);
}

/** Délai demandé par l'en-tête `Retry-After`, en millisecondes, borné à une minute. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 60_000) : null;
}

export class EutilsClient {
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly limiter: () => Promise<void>;
  /** Requêtes envoyées, nouvelles tentatives comprises : pour les tests et le journal. */
  requests = 0;

  constructor(
    readonly cfg: EutilsConfig,
    deps: EutilsDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.clock = deps.clock ?? realClock;
    this.limiter = deps.limiter ?? limiterFor(cfg);
  }

  private redact(text: string): string {
    return redactSecret(text, this.cfg.apiKey, '[clé masquée]');
  }

  /** Un appel, avec débit limité, délai, et nouvelles tentatives espacées (1 s, 2 s, 4 s) sur 429, 5xx et coupure. */
  async call(endpoint: 'esearch' | 'efetch', params: Record<string, string | number | undefined>): Promise<string> {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== '') query.set(key, String(value));
    query.set('tool', TOOL_NAME);
    if (this.cfg.email) query.set('email', this.cfg.email);
    if (this.cfg.apiKey) query.set('api_key', this.cfg.apiKey);
    const url = `${this.cfg.baseUrl}/${endpoint}.fcgi`;

    let lastError: EutilsError | null = null;
    /** Attente demandée par le serveur (`Retry-After`), sinon 1 s, 2 s, 4 s. */
    let askedWait: number | null = null;
    for (let attempt = 0; attempt <= this.cfg.retries; attempt++) {
      if (attempt > 0) await this.clock.sleep(askedWait ?? 1000 * 2 ** (attempt - 1));
      askedWait = null;
      await this.limiter();
      this.requests++;
      let res: Response;
      try {
        // POST : l'équation et la clé voyagent dans le corps, pas dans une adresse que les journaux conservent.
        res = await this.fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: endpoint === 'esearch' ? 'application/json' : 'application/xml' },
          body: query.toString(),
          signal: AbortSignal.timeout(this.cfg.timeoutMs),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        lastError = timedOut
          ? new EutilsError('timeout', `PubMed n’a pas répondu en ${Math.round(this.cfg.timeoutMs / 1000)} s (${attempt + 1} tentative${attempt > 0 ? 's' : ''}). Réessayez plus tard.`)
          : new EutilsError(
              'network',
              this.redact(
                `PubMed est injoignable (${new URL(url).host}) : vérifiez la connexion du serveur à Internet, ou son proxy. Détail : ${
                  error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error)
                }`.slice(0, 400),
              ),
            );
        continue;
      }
      const body = await res.text();
      if (res.ok) return body;
      const failure = httpFailure(res.status, body);
      failure.message = this.redact(failure.message);
      if (!RETRYABLE.has(res.status)) throw failure;
      askedWait = retryAfterMs(res);
      lastError = failure;
    }
    throw lastError ?? new EutilsError('network', 'PubMed est injoignable.');
  }

  /** `esearch` : nombre total, traduction, et une entrée dans l'historique du serveur pour `efetch`. */
  async esearch(term: string, opts: { mindate?: string; maxdate?: string; sort?: SearchSort; retmax?: number }): Promise<EsearchResult> {
    const body = await this.call('esearch', {
      db: 'pubmed',
      term,
      usehistory: 'y',
      retmode: 'json',
      retmax: opts.retmax ?? 0,
      sort: opts.sort === 'date' ? 'pub_date' : undefined,
      datetype: opts.mindate || opts.maxdate ? 'pdat' : undefined,
      // Le NCBI exige les deux bornes ensemble.
      mindate: opts.mindate || opts.maxdate ? (opts.mindate ?? '1000') : undefined,
      maxdate: opts.mindate || opts.maxdate ? (opts.maxdate ?? '3000') : undefined,
    });
    return parseEsearch(body);
  }

  /** `efetch` : un lot de notices XML, lu dans l'historique du serveur. */
  async efetch(history: { webenv: string; querykey: string }, retstart: number, retmax: number): Promise<ParsedBatch> {
    const body = await this.call('efetch', {
      db: 'pubmed',
      WebEnv: history.webenv,
      query_key: history.querykey,
      retstart,
      retmax,
      retmode: 'xml',
    });
    if (!/<PubmedArticleSet|<PubmedBookArticle|<PubmedArticle/.test(body)) {
      const detail = /<ERROR>([\s\S]*?)<\/ERROR>/i.exec(body)?.[1]?.trim();
      // Une page vide au milieu d'une récupération : l'historique a expiré, ou le service a coupé court.
      throw new EutilsError('server', `PubMed a rendu une page de notices illisible${detail ? ` (${detail.slice(0, MAX_DETAIL)})` : ''}. Relancez la recherche.`);
    }
    return parsePubmedXml(body);
  }
}

/* ──────────────────────────────── esearch ───────────────────────────────── */

export interface EsearchResult {
  count: number;
  webenv: string;
  querykey: string;
  queryTranslation: string | null;
  ids: string[];
  warnings: string[];
}

export function parseEsearch(body: string): EsearchResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new EutilsError('parse', 'Réponse illisible de PubMed (esearch) : du JSON était attendu.');
  }
  const root = (parsed ?? {}) as { esearchresult?: Record<string, unknown>; error?: unknown };
  const result = root.esearchresult;
  if (!result) {
    throw new EutilsError('query', `PubMed a refusé l’équation${root.error ? ` : ${String(root.error).slice(0, MAX_DETAIL)}` : '.'}`);
  }
  if (typeof result.ERROR === 'string' && result.ERROR) {
    throw new EutilsError('query', `PubMed a refusé l’équation : ${result.ERROR.slice(0, MAX_DETAIL)}`);
  }
  const count = Number(result.count);
  if (!Number.isInteger(count) || count < 0) throw new EutilsError('parse', 'Réponse inattendue de PubMed : nombre de résultats absent.');

  const warnings: string[] = [];
  const errorlist = (result.errorlist ?? {}) as { phrasesnotfound?: unknown; fieldsnotfound?: unknown };
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
  const notFound = list(errorlist.phrasesnotfound);
  if (notFound.length > 0) warnings.push(`Termes introuvables dans PubMed, ignorés : ${notFound.join(', ')}.`);
  const badFields = list(errorlist.fieldsnotfound);
  if (badFields.length > 0) warnings.push(`Champs inconnus de PubMed, ignorés : ${badFields.join(', ')}.`);
  const warninglist = (result.warninglist ?? {}) as { phrasesignored?: unknown; quotedphrasesnotfound?: unknown };
  const ignored = list(warninglist.phrasesignored);
  if (ignored.length > 0) warnings.push(`Mots ignorés par PubMed : ${ignored.join(', ')}.`);
  const quoted = list(warninglist.quotedphrasesnotfound);
  if (quoted.length > 0) warnings.push(`Expressions entre guillemets introuvables : ${quoted.join(', ')}.`);

  return {
    count,
    webenv: String(result.webenv ?? ''),
    querykey: String(result.querykey ?? ''),
    queryTranslation: typeof result.querytranslation === 'string' ? result.querytranslation : null,
    ids: list(result.idlist),
    warnings,
  };
}

/* ─────────────────────────────── Notices XML ────────────────────────────── */

export interface ParsedBatch {
  refs: BiblioRefInput[];
  /** Notices lues mais inexploitables (sans titre). */
  skipped: number;
  /** PMID de toutes les notices du lot, exploitables ou non. */
  pmids: string[];
}

function blankPubmed(title: string): BiblioRefInput {
  return {
    source: 'pubmed',
    title,
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
    refType: 'JOUR',
  };
}

/** PubMed termine ses titres par un point ; un titre traduit est entre crochets « [Titre.] ». */
function cleanTitle(raw: string): string {
  let title = raw.trim();
  if (/^\[.*\]\.?$/.test(title)) title = title.replace(/^\[/, '').replace(/\]\.?$/, '');
  return title.replace(/(?<!\.)\.$/, '').trim();
}

function authorsOf(list: XmlElement | null): string[] {
  return childrenOf(list, 'Author')
    .map((a) => {
      const collective = textOf(childOf(a, 'CollectiveName'));
      if (collective) return collective;
      const last = textOf(childOf(a, 'LastName'));
      const initials = textOf(childOf(a, 'Initials'));
      return [last, initials].filter(Boolean).join(' ');
    })
    .filter(Boolean);
}

const yearIn = (text: string): number | null => {
  const m = /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/.exec(text);
  return m ? Number(m[1]) : null;
};

function yearOfDate(date: XmlElement | null): number | null {
  if (!date) return null;
  const year = Number(textOf(childOf(date, 'Year')));
  if (Number.isInteger(year) && year > 0) return year;
  return yearIn(textOf(childOf(date, 'MedlineDate')));
}

/** Résumé : un paragraphe par section, chacune précédée de son intitulé (« METHODS: … »). */
function abstractOf(abstract: XmlElement | null): string | null {
  const parts = childrenOf(abstract, 'AbstractText')
    .map((section) => {
      const text = textOf(section);
      if (!text) return '';
      const label = (section.attrs.Label ?? '').trim();
      return label && label.toUpperCase() !== 'UNLABELLED' ? `${label}: ${text}` : text;
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : null;
}

const unique = (values: string[]): string[] => [...new Set(values.filter(Boolean))];

function idsOf(list: XmlElement | null): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const id of childrenOf(list, 'ArticleId')) {
    const type = (id.attrs.IdType ?? '').toLowerCase();
    const value = textOf(id);
    if (type && value && !ids[type]) ids[type] = value;
  }
  return ids;
}

/** Type RIS déduit des types de publication de PubMed. */
export function refTypeFromPublicationTypes(types: string[]): RefType {
  const set = new Set(types.map((t) => t.toLowerCase()));
  if (set.has('congress') || set.has('meeting abstract')) return 'CONF';
  if (set.has('dataset')) return 'DATA';
  if (set.has('preprint')) return 'UNPB';
  if (set.has('technical report') || set.has('government publication')) return 'RPRT';
  if (set.has('academic dissertation') || set.has('dissertation')) return 'THES';
  return 'JOUR';
}

function readArticle(node: XmlElement): BiblioRefInput | null {
  const citation = childOf(node, 'MedlineCitation');
  const article = childOf(citation, 'Article');
  const title = cleanTitle(textOf(childOf(article, 'ArticleTitle')) || textOf(childOf(article, 'VernacularTitle')));
  if (!title) return null;

  const ref = blankPubmed(title);
  ref.pmid = textOf(childOf(citation, 'PMID')) || null;
  ref.authors = authorsOf(childOf(article, 'AuthorList'));

  const journal = childOf(article, 'Journal');
  const issue = childOf(journal, 'JournalIssue');
  ref.journal = textOf(childOf(journal, 'Title')) || textOf(childOf(journal, 'ISOAbbreviation')) || null;
  ref.volume = textOf(childOf(issue, 'Volume')) || null;
  ref.issue = textOf(childOf(issue, 'Issue')) || null;
  ref.year = yearOfDate(childOf(issue, 'PubDate')) ?? yearOfDate(childOf(article, 'ArticleDate'));

  const pagination = childOf(article, 'Pagination');
  const medlinePgn = textOf(childOf(pagination, 'MedlinePgn'));
  const start = textOf(childOf(pagination, 'StartPage'));
  const end = textOf(childOf(pagination, 'EndPage'));
  ref.pages = medlinePgn || (start ? (end ? `${start}-${end}` : start) : null);

  // Identifiants : ceux de la notice elle-même (PubmedData), jamais ceux de sa liste de références citées.
  const ids = idsOf(pathOf(node, 'PubmedData', 'ArticleIdList'));
  const elocationDoi = childrenOf(article, 'ELocationID').find((e) => (e.attrs.EIdType ?? '').toLowerCase() === 'doi');
  ref.doi = normDoi(ids.doi) ?? normDoi(textOf(elocationDoi));
  const pmc = (ids.pmc ?? '').toUpperCase();
  ref.pmcid = /^PMC\d+$/.test(pmc) ? pmc : null;
  ref.pmid = ref.pmid ?? ids.pubmed ?? null;
  ref.url = ref.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/` : null;

  ref.abstract = abstractOf(childOf(article, 'Abstract'));
  ref.keywords = unique(childrenOf(citation, 'KeywordList').flatMap((list) => childrenOf(list, 'Keyword').map(textOf)));
  ref.meshTerms = unique(
    childrenOf(childOf(citation, 'MeshHeadingList'), 'MeshHeading').map((h) => textOf(childOf(h, 'DescriptorName'))),
  );
  ref.publicationTypes = unique(childrenOf(childOf(article, 'PublicationTypeList'), 'PublicationType').map(textOf));
  ref.refType = refTypeFromPublicationTypes(ref.publicationTypes);
  return ref;
}

function readBook(node: XmlElement): BiblioRefInput | null {
  const doc = childOf(node, 'BookDocument');
  const book = childOf(doc, 'Book');
  const bookTitle = cleanTitle(textOf(childOf(book, 'BookTitle')));
  const chapterTitle = cleanTitle(textOf(childOf(doc, 'ArticleTitle')));
  const title = chapterTitle || bookTitle;
  if (!title) return null;

  const ref = blankPubmed(title);
  ref.refType = chapterTitle ? 'CHAP' : 'BOOK';
  ref.journal = chapterTitle ? bookTitle || null : null;
  ref.pmid = textOf(childOf(doc, 'PMID')) || null;
  const lists = [...childrenOf(doc, 'AuthorList'), ...childrenOf(book, 'AuthorList')];
  const authors = lists.find((l) => (l.attrs.Type ?? 'authors') === 'authors');
  // Un livre sans auteurs nommés (GeneReviews) est cité par ses directeurs de publication.
  ref.authors = authorsOf(authors ?? lists[0] ?? null);
  ref.year = yearOfDate(childOf(doc, 'ContributionDate')) ?? yearOfDate(childOf(book, 'PubDate'));
  const ids = { ...idsOf(childOf(doc, 'ArticleIdList')), ...idsOf(pathOf(node, 'PubmedBookData', 'ArticleIdList')) };
  ref.doi = normDoi(ids.doi);
  ref.pmid = ref.pmid ?? ids.pubmed ?? null;
  ref.url = ref.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/` : null;
  ref.abstract = abstractOf(childOf(doc, 'Abstract'));
  ref.keywords = unique(childrenOf(doc, 'KeywordList').flatMap((list) => childrenOf(list, 'Keyword').map(textOf)));
  ref.publicationTypes = unique(childrenOf(doc, 'PublicationType').map(textOf));
  return ref;
}

/** Lit la réponse d'`efetch` (`PubmedArticleSet`) : articles et livres. */
export function parsePubmedXml(xml: string): ParsedBatch {
  const root = parseXml(xml);
  const set = descendantsOf(root, 'PubmedArticleSet')[0] ?? root;
  const refs: BiblioRefInput[] = [];
  const pmids: string[] = [];
  let skipped = 0;
  for (const node of set.children) {
    if (typeof node === 'string') continue;
    let ref: BiblioRefInput | null = null;
    let pmid = '';
    try {
      if (node.name === 'PubmedArticle') {
        pmid = textOf(pathOf(node, 'MedlineCitation', 'PMID'));
        ref = readArticle(node);
      } else if (node.name === 'PubmedBookArticle') {
        pmid = textOf(pathOf(node, 'BookDocument', 'PMID'));
        ref = readBook(node);
      } else {
        continue;
      }
    } catch {
      ref = null;
    }
    if (pmid) pmids.push(pmid);
    if (ref) refs.push(ref);
    else skipped += 1;
  }
  return { refs, skipped, pmids };
}

/* ─────────────────────────────── Recherche ──────────────────────────────── */

export interface PubmedSearchParams {
  query: string;
  yearFrom?: number;
  yearTo?: number;
  sort: SearchSort;
  /** `null` : tout récupérer (jusqu'au plafond). Sinon, les N premiers dans l'ordre demandé. */
  limit: number | null;
}

export interface PubmedSearchResult {
  refs: BiblioRefInput[];
  skipped: number;
  totalCount: number;
  queryTranslation: string | null;
  warnings: string[];
  /** Tranches de dates interrogées séparément (au-delà de 9 999 résultats). */
  slices: number;
}

/** Jour civil compté depuis l'époque, en UTC : de quoi couper une période en deux. */
const DAY = 86_400_000;
const toDay = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
function fromDay(day: number): string {
  const date = new Date(day * DAY);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}/${pad(date.getUTCMonth() + 1)}/${pad(date.getUTCDate())}`;
}

const fmt = (n: number) => n.toLocaleString('fr-FR');

/**
 * Interroge PubMed et rend toutes les notices (ou les N premières).
 *
 * Tout ou rien : une erreur en cours de récupération lève une `EutilsError` et
 * aucune notice n'est versée — un diagramme de flux ne doit pas compter une
 * récupération à moitié faite. Les nouvelles tentatives du client absorbent
 * les coupures passagères.
 */
export async function searchPubmed(
  cfg: EutilsConfig,
  params: PubmedSearchParams,
  deps: EutilsDeps = {},
  client: EutilsClient = new EutilsClient(cfg, deps),
): Promise<PubmedSearchResult> {
  const mindate = params.yearFrom ? String(params.yearFrom) : undefined;
  const maxdate = params.yearTo ? String(params.yearTo) : undefined;
  const main = await client.esearch(params.query, { mindate, maxdate, sort: params.sort });
  const warnings = [...main.warnings];
  const context = { totalCount: main.count, queryTranslation: main.queryTranslation };
  const result = (refs: BiblioRefInput[], skipped: number, slices: number): PubmedSearchResult => ({
    refs,
    skipped,
    totalCount: main.count,
    queryTranslation: main.queryTranslation,
    warnings,
    slices,
  });
  if (main.count === 0) return result([], 0, 0);

  const all = params.limit === null;
  if (all && main.count > cfg.maxRecords) {
    throw new EutilsError(
      'cap',
      `L’équation renvoie ${fmt(main.count)} résultats dans PubMed, au-delà du plafond de ${fmt(cfg.maxRecords)} notices par passe (BIBLIO_PUBMED_MAX). ` +
        'Affinez l’équation ou la période, ou relevez le plafond côté serveur. Rien n’a été importé : le diagramme de flux ne compte pas une récupération partielle.',
      context,
    );
  }
  const wanted = all ? main.count : Math.min(params.limit ?? 0, main.count, ESEARCH_WINDOW);

  const refs: BiblioRefInput[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  const fetchAll = async (history: { webenv: string; querykey: string }, count: number) => {
    for (let start = 0; start < count; start += cfg.batchSize) {
      const batch = await client.efetch(history, start, Math.min(cfg.batchSize, count - start));
      skipped += batch.skipped;
      for (const ref of batch.refs) {
        // Deux tranches de dates contiguës ne se recouvrent pas, mais un PMID vu deux fois ne compte qu'une fois.
        if (ref.pmid && seen.has(ref.pmid)) continue;
        if (ref.pmid) seen.add(ref.pmid);
        refs.push(ref);
      }
    }
  };

  try {
    if (wanted <= ESEARCH_WINDOW) {
      await fetchAll(main, wanted);
      if (!all && wanted < main.count) {
        warnings.push(
          `Exploration : ${fmt(wanted)} premiers résultats sur ${fmt(main.count)} (${params.sort === 'date' ? 'les plus récents' : 'par pertinence'}). Pour une revue systématique, récupérez-les tous.`,
        );
      }
      if (refs.length + skipped < wanted) {
        warnings.push(`${fmt(wanted - refs.length - skipped)} notices annoncées n’ont pas été rendues par PubMed (notices retirées ou en cours de traitement).`);
      }
      return result(refs, skipped, 1);
    }

    // Au-delà de 9 999 : tranches de dates de publication, coupées en deux tant qu'elles dépassent la fenêtre.
    const currentYear = new Date().getUTCFullYear();
    const first = toDay(params.yearFrom ?? 1500, 1, 1);
    const last = toDay(params.yearTo ?? currentYear + 5, 12, 31);
    const slices: { from: number; to: number; search: EsearchResult }[] = [];
    const split = async (from: number, to: number): Promise<void> => {
      const search = await client.esearch(params.query, { mindate: fromDay(from), maxdate: fromDay(to) });
      if (search.count === 0) return;
      if (search.count <= ESEARCH_WINDOW || from >= to) {
        if (search.count > ESEARCH_WINDOW) {
          warnings.push(`${fmt(search.count)} notices datées du seul ${fromDay(from)} : seules les ${fmt(ESEARCH_WINDOW)} premières ont pu être récupérées (limite de PubMed).`);
        }
        slices.push({ from, to, search });
        return;
      }
      const middle = Math.floor((from + to) / 2);
      await split(from, middle);
      await split(middle + 1, to);
    };
    await split(first, last);
    for (const slice of slices) await fetchAll(slice.search, Math.min(slice.search.count, ESEARCH_WINDOW));

    warnings.push(`Plus de ${fmt(ESEARCH_WINDOW)} résultats : la recherche a été découpée en ${slices.length} tranches de dates de publication.`);
    const missing = main.count - refs.length - skipped;
    if (missing > 0) {
      warnings.push(
        `${fmt(missing)} notices sur ${fmt(main.count)} n’ont pas pu être récupérées (sans date de publication exploitable, retirées, ou au-delà des tranches).`,
      );
    }
    return result(refs, skipped, slices.length);
  } catch (error) {
    if (error instanceof EutilsError) {
      throw new EutilsError(error.kind, error.message, context);
    }
    throw error;
  }
}
