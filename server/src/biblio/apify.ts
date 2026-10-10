/**
 * Client Apify et adaptateurs d'acteurs pour la revue bibliographique.
 *
 * Apify n'est qu'un transporteur : chaque source est servie par un acteur du
 * Store, dont la sortie a sa propre forme. Un ADAPTATEUR par acteur sait deux
 * choses — fabriquer son entrée à partir d'une recherche, et lire chaque ligne
 * rendue comme une référence. Changer d'acteur, c'est changer d'adaptateur ;
 * le reste de l'application ne voit que des `BiblioRefInput`.
 *
 * Ces trois adaptateurs ont été écrits d'après des exécutions réelles des
 * acteurs (jeux d'essai dans `server/test/apify-fixtures/`), pas d'après leur
 * documentation seule : les noms de champs y sont ceux que les acteurs rendent
 * vraiment, y compris leurs défauts (lien PDF valant `javascript:void(0)`,
 * titres tronqués par une ellipse).
 *
 * Le jeton Apify ne quitte jamais ce module : il n'est ni journalisé, ni
 * rendu dans une erreur, ni transmis à l'interface.
 */

import { redactSecret } from '../lib/redact.js';
import {
  asArray,
  asRecord,
  clean,
  doiFromUrl,
  dropUndefined,
  intOrNull,
  isTruncated,
  normDoi,
  pmcFromUrl,
  safeUrl,
  splitAuthors,
  strOrNull,
  strings,
} from './normalize.js';
import { SOURCE_LABELS, type BiblioRefInput, type BiblioSource, type SearchSort } from './types.js';

/* ───────────────────────────── Configuration ───────────────────────────── */

export interface ApifyConfig {
  token: string;
  baseUrl: string;
  pubmedActor: string;
  scholarActor: string;
  timeoutMs: number;
  /** Plafond de résultats par source et par passe — chaque résultat est facturé. */
  maxResultsCap: number;
}

/** Lue à chaque appel : le jeton se pose dans l'environnement, jamais dans le code. */
export function apifyConfig(env: NodeJS.ProcessEnv = process.env): ApifyConfig {
  const number = (raw: string | undefined, fallback: number) => {
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    token: (env.APIFY_TOKEN ?? '').trim(),
    baseUrl: (env.APIFY_API_BASE ?? 'https://api.apify.com').trim().replace(/\/+$/, ''),
    pubmedActor: (env.APIFY_PUBMED_ACTOR ?? 'labrat011/pubmed-scraper').trim(),
    scholarActor: (env.APIFY_SCHOLAR_ACTOR ?? 'george.the.developer/google-scholar-scraper').trim(),
    timeoutMs: number(env.APIFY_TIMEOUT_MS, 290_000),
    maxResultsCap: Math.floor(number(env.BIBLIO_MAX_RESULTS, 100)),
  };
}

export const NO_TOKEN_MESSAGE =
  "Apify n'est pas configuré. Renseignez APIFY_TOKEN dans l'environnement du serveur " +
  '(console Apify › Settings › API & Integrations), puis redémarrez l\'application.';

/* ───────────────────────────────── Erreurs ──────────────────────────────── */

export type ApifyErrorKind =
  | 'config'
  | 'auth'
  | 'quota'
  | 'notfound'
  | 'timeout'
  | 'rate'
  | 'actor'
  | 'network';

export class ApifyError extends Error {
  constructor(
    readonly kind: ApifyErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApifyError';
  }
}

/** Longueur maximale d'un message d'acteur conservé : une réponse d'erreur n'a pas à peser des mégaoctets en base. */
const MAX_DETAIL = 300;

/**
 * Message de l'enveloppe d'erreur d'Apify : `{ error: { type, message } }`, borné.
 *
 * Il vient d'un acteur, c'est-à-dire du code d'un tiers : rien ne l'empêche de répéter ce qu'il a reçu,
 * en-têtes compris. Il est donc tronqué ici, et débarrassé du jeton avant de sortir (voir `redact`).
 */
function apifyMessage(body: unknown): string {
  const error = asRecord(asRecord(body)?.error);
  const message = clean(error?.message) || clean(asRecord(body)?.message);
  return message.length > MAX_DETAIL ? `${message.slice(0, MAX_DETAIL)}…` : message;
}

/**
 * Retire d'un texte le jeton Apify, sous toutes ses formes courantes (brut, `Bearer …`, encodé dans une adresse).
 * Un message d'erreur est écrit en base et resservi à chaque ouverture de la page : il ne doit jamais contenir de secret.
 */
export function redact(text: string, token: string): string {
  return redactSecret(text, token, '[jeton masqué]');
}

function httpError(status: number, body: unknown, actor: string): ApifyError {
  const detail = apifyMessage(body);
  switch (status) {
    case 401:
      return new ApifyError('auth', 'Jeton Apify refusé (401). Vérifiez APIFY_TOKEN.', status);
    case 402:
      return new ApifyError(
        'quota',
        "Crédit Apify insuffisant (402) : l'acteur n'a pas pu démarrer. Rechargez le compte ou relevez la limite de dépense.",
        status,
      );
    case 403:
      return new ApifyError(
        'auth',
        `Accès refusé à l'acteur ${actor} (403)${detail ? ` : ${detail}` : '.'}`,
        status,
      );
    case 404:
      return new ApifyError('notfound', `Acteur introuvable sur Apify : ${actor}.`, status);
    case 408:
      return new ApifyError(
        'timeout',
        "L'acteur a dépassé la limite de 300 s des appels synchrones d'Apify. Réduisez le nombre de résultats.",
        status,
      );
    case 429:
      return new ApifyError('rate', 'Apify limite le débit (429). Réessayez dans une minute.', status);
    default:
      return new ApifyError(
        'actor',
        `Apify a répondu ${status}${detail ? ` : ${detail}` : '.'}`,
        status,
      );
  }
}

/* ───────────────────────────── Appel d'un acteur ────────────────────────── */

/**
 * Lance un acteur et attend ses résultats, en un seul appel.
 *
 * Le point d'accès synchrone d'Apify (`run-sync-get-dataset-items`) rend les
 * lignes du jeu de données dès que l'exécution est finie, dans la limite de
 * 300 s. Une recherche bibliographique tient dans ce délai ; un point d'accès
 * asynchrone avec sondage ajouterait un état à conserver sans rien apporter.
 *
 * `fetchImpl` est injectable pour les tests : ils parlent à un faux serveur
 * Apify, jamais au vrai.
 */
export async function runActor(
  cfg: ApifyConfig,
  actor: string,
  input: Record<string, unknown>,
  maxItems: number,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown[]> {
  if (!cfg.token) throw new ApifyError('config', NO_TOKEN_MESSAGE);

  const id = encodeURIComponent(actor.replace('/', '~'));
  const url = `${cfg.baseUrl}/v2/acts/${id}/run-sync-get-dataset-items?format=json&clean=1&limit=${maxItems}`;

  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      // Le jeton voyage en en-tête, pas dans l'adresse : les adresses se retrouvent dans les journaux.
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      throw new ApifyError(
        'timeout',
        `Apify n'a pas répondu en ${Math.round(cfg.timeoutMs / 1000)} s. L'exécution a pu continuer côté Apify : consultez sa console avant de relancer.`,
      );
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApifyError('network', redact(`Apify est injoignable (${reason.slice(0, MAX_DETAIL)}).`, cfg.token));
  }

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* corps non JSON : traité plus bas */
  }

  if (!res.ok) {
    const failure = httpError(res.status, body, actor);
    throw new ApifyError(failure.kind, redact(failure.message, cfg.token), failure.status);
  }
  if (!Array.isArray(body)) {
    throw new ApifyError('actor', "Réponse inattendue d'Apify : un tableau de résultats était attendu.");
  }
  return body;
}

/* ─────────────────────────────── Adaptateurs ────────────────────────────── */

export interface SearchParams {
  query: string;
  maxResults: number;
  yearFrom?: number;
  yearTo?: number;
  sort: SearchSort;
}

export interface ActorAdapter {
  actor: string;
  source: BiblioSource;
  buildInput(params: SearchParams): Record<string, unknown>;
  /** `null` pour une ligne sans référence exploitable (message, ligne vide). */
  map(raw: unknown): BiblioRefInput | null;
}

function blank(source: BiblioSource, title: string): BiblioRefInput {
  return {
    source,
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
  };
}

/** PubMed — `labrat011/pubmed-scraper` (API E-utilities du NCBI, sans clé). */
const pubmedLabrat: ActorAdapter = {
  actor: 'labrat011/pubmed-scraper',
  source: 'pubmed',

  buildInput: (p) =>
    dropUndefined({
      mode: 'search_articles',
      query: p.query,
      maxResults: p.maxResults,
      sort: p.sort === 'date' ? 'pub_date' : 'relevance',
      dateFrom: p.yearFrom?.toString(),
      dateTo: p.yearTo?.toString(),
    }),

  map(raw) {
    const item = asRecord(raw);
    if (!item) return null;
    // PubMed termine ses titres par un point ; une ellipse, elle, est conservée.
    const title = clean(item.title).replace(/(?<!\.)\.$/, '');
    if (!title) return null;

    const ref = blank('pubmed', title);
    ref.authors = asArray(item.authors)
      .map((a) => {
        const author = asRecord(a);
        if (!author) return clean(a);
        const name = clean(`${clean(author.last_name)} ${clean(author.initials)}`);
        return name || clean(author.collective_name);
      })
      .filter(Boolean);
    ref.year = intOrNull(item.pub_year);
    ref.journal = strOrNull(item.journal);
    ref.volume = strOrNull(item.volume);
    ref.issue = strOrNull(item.issue);
    ref.pages = strOrNull(item.pages);
    ref.pmid = strOrNull(item.pmid);
    ref.doi = normDoi(item.doi) ?? normDoi(item.doi_url);
    ref.pmcid = strOrNull(item.pmc_id) ?? pmcFromUrl(safeUrl(item.pmc_url));
    ref.url = safeUrl(item.pubmed_url) ?? (ref.pmid ? `https://pubmed.ncbi.nlm.nih.gov/${ref.pmid}/` : null);
    ref.abstract = strOrNull(item.abstract);
    ref.keywords = strings(item.keywords);
    ref.meshTerms = strings(item.mesh_terms);
    ref.publicationTypes = strings(item.publication_types);
    return ref;
  },
};

/** Google Scholar — `george.the.developer/google-scholar-scraper` : année et lieu déjà séparés. */
const scholarGeorge: ActorAdapter = {
  actor: 'george.the.developer/google-scholar-scraper',
  source: 'scholar',

  buildInput: (p) =>
    dropUndefined({
      query: p.query,
      maxResults: p.maxResults,
      language: 'en',
      yearFrom: p.yearFrom,
      yearTo: p.yearTo,
      sortBy: p.sort === 'date' ? 'date' : 'relevance',
      includeAbstracts: true,
      includeCitations: false,
    }),

  map(raw) {
    const item = asRecord(raw);
    if (!item) return null;
    const title = clean(item.title);
    if (!title) return null;

    const ref = blank('scholar', title);
    ref.authors = splitAuthors(clean(item.authors));
    ref.year = intOrNull(item.year);
    ref.journal = strOrNull(item.publicationVenue);
    ref.url = safeUrl(item.url);
    ref.doi = doiFromUrl(ref.url);
    ref.pmcid = pmcFromUrl(ref.url);
    // L'acteur rend parfois `javascript:void(0)` : `safeUrl` l'écarte.
    ref.pdfUrl = safeUrl(item.pdfLink);
    ref.snippet = strOrNull(item.abstract);
    ref.citedBy = intOrNull(item.citationCount);
    ref.citedByUrl = safeUrl(item.citationUrl);
    return ref;
  },
};

/**
 * Google Scholar — `johnvc/google-scholar-api` : le lieu et l'année ne sont
 * que dans la ligne de résumé « auteurs - revue, année - site ».
 */
const scholarJohnvc: ActorAdapter = {
  actor: 'johnvc/google-scholar-api',
  source: 'scholar',

  buildInput: (p) => {
    const perPage = Math.min(20, p.maxResults);
    return dropUndefined({
      mode: 'search',
      q: p.query,
      num: perPage,
      max_pages: Math.ceil(p.maxResults / perPage),
      as_ylo: p.yearFrom,
      as_yhi: p.yearTo,
      // Le tri par date de Google Scholar ne porte que sur les douze derniers mois.
      scisbd: p.sort === 'date' ? '2' : '0',
    });
  },

  map(raw) {
    const item = asRecord(raw);
    if (!item) return null;
    // Les lignes de notice (quota, message) n'ont pas de titre : elles sont écartées.
    const title = clean(item.paper_title);
    if (!title) return null;

    const ref = blank('scholar', title);
    const info = asRecord(item.publication_info);
    const summary = clean(info?.summary);
    const [authorPart = '', venuePart = ''] = summary.split(/\s+-\s+/);

    const named = asArray(info?.authors)
      .map((a) => clean(asRecord(a)?.name))
      .filter(Boolean);
    ref.authors = named.length > 0 ? named : splitAuthors(authorPart);

    const yearMatch = /,?\s*((?:19|20)\d{2})\s*$/.exec(venuePart);
    ref.year = yearMatch ? Number(yearMatch[1]) : null;
    ref.journal = strOrNull(venuePart.replace(/,?\s*(?:19|20)\d{2}\s*$/, ''));

    ref.url = safeUrl(item.link);
    ref.doi = doiFromUrl(ref.url);
    ref.pmcid = pmcFromUrl(ref.url);
    ref.snippet = strOrNull(item.snippet);

    const pdf = asArray(item.resources)
      .map(asRecord)
      .find((r) => r && /pdf/i.test(clean(r.file_format)) && safeUrl(r.link));
    ref.pdfUrl = pdf ? safeUrl(pdf.link) : null;

    const links = asRecord(item.inline_links);
    ref.citedBy = intOrNull(links?.cited_by_total);
    ref.citedByUrl = safeUrl(links?.cited_by_link);
    return ref;
  },
};

export const ADAPTERS: ActorAdapter[] = [pubmedLabrat, scholarGeorge, scholarJohnvc];

export function supportedActors(source: BiblioSource): string[] {
  return ADAPTERS.filter((a) => a.source === source).map((a) => a.actor);
}

export function adapterFor(source: BiblioSource, actor: string): ActorAdapter {
  const found = ADAPTERS.find(
    (a) => a.source === source && a.actor.toLowerCase() === actor.toLowerCase(),
  );
  if (!found) {
    throw new ApifyError(
      'config',
      `L'acteur « ${actor} » n'est pas pris en charge pour ${SOURCE_LABELS[source]}. ` +
        `Acteurs pris en charge : ${supportedActors(source).join(', ')}.`,
    );
  }
  return found;
}

export const actorFor = (cfg: ApifyConfig, source: BiblioSource): string =>
  source === 'pubmed' ? cfg.pubmedActor : cfg.scholarActor;

/* ──────────────────────────────── Recherche ─────────────────────────────── */

export interface SourceResult {
  actor: string;
  refs: BiblioRefInput[];
  skipped: number;
}

/** Interroge une source et rend ses références, déjà lues par l'adaptateur de l'acteur. */
export async function searchSource(
  cfg: ApifyConfig,
  source: BiblioSource,
  params: SearchParams,
  fetchImpl: typeof fetch = fetch,
): Promise<SourceResult> {
  const adapter = adapterFor(source, actorFor(cfg, source));
  const items = await runActor(cfg, adapter.actor, adapter.buildInput(params), params.maxResults, fetchImpl);

  const refs: BiblioRefInput[] = [];
  let skipped = 0;
  for (const item of items) {
    let ref: BiblioRefInput | null = null;
    try {
      ref = adapter.map(item);
    } catch {
      ref = null;
    }
    if (ref) refs.push(ref);
    else skipped += 1;
  }

  // Des lignes sont revenues, aucune n'est une référence : l'acteur a sans doute
  // répondu par un message (quota, blocage). Mieux vaut le dire que rendre « 0 résultat ».
  if (refs.length === 0 && items.length > 0) {
    const notice = items
      .map((i) => asRecord(i))
      .map((r) => clean(r?.message) || clean(r?.notice) || clean(r?.error) || clean(r?.how_to_continue))
      .find(Boolean);
    throw new ApifyError(
      'actor',
      `L'acteur n'a rendu aucune référence exploitable${notice ? ` : ${notice}` : '.'}`,
    );
  }

  // Certains acteurs rendent plus que demandé : le plafond demandé fait foi.
  return { actor: adapter.actor, refs: refs.slice(0, params.maxResults), skipped };
}

export const isTruncatedTitle = isTruncated;
