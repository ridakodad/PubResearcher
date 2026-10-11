import { db, nowIso, parseJson } from '../db/index.js';
import { isTruncated, normTitle } from '../biblio/normalize.js';
import {
  DECISIONS,
  SOURCE_CATEGORY,
  SOURCE_LABELS,
  isBiblioSource,
  isExclusionReason,
  isRefType,
  type BiblioCounts,
  type BiblioPrisma,
  type BiblioRef,
  type BiblioRefInput,
  type BiblioSearch,
  type BiblioSource,
  type Decision,
  type ExclusionReason,
  type PrismaSourceCount,
  type SearchKind,
  type SearchSort,
  type SearchStatus,
} from '../biblio/types.js';

/* ───────────────────────────────── Lignes ──────────────────────────────── */

interface RefRow {
  id: number;
  norm_title: string;
  title_truncated: number;
  title: string;
  authors: string;
  year: number | null;
  journal: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  pmid: string | null;
  pmcid: string | null;
  url: string | null;
  pdf_url: string | null;
  abstract: string | null;
  snippet: string | null;
  keywords: string;
  mesh_terms: string;
  publication_types: string;
  cited_by: number | null;
  cited_by_url: string | null;
  sources: string;
  ref_type: string | null;
  decision: string;
  exclusion_reason: string | null;
  note: string | null;
  first_search_id: number | null;
  created_at: string;
  updated_at: string;
}

interface SearchRow {
  id: number;
  kind: string;
  source: string;
  actor: string;
  query: string;
  year_from: number | null;
  year_to: number | null;
  max_results: number;
  sort: string;
  status: string;
  error: string | null;
  returned: number;
  skipped: number;
  added: number;
  duplicates: number;
  duration_ms: number | null;
  queried_at: string;
  sent_query: string | null;
  query_translation: string | null;
  file_name: string | null;
  source_label: string | null;
  warnings: string;
  total_count: number | null;
}

const isSource = isBiblioSource;
const isDecision = (v: unknown): v is Decision => DECISIONS.includes(v as Decision);

function toRef(row: RefRow): BiblioRef {
  return {
    id: row.id,
    sources: parseJson<unknown[]>(row.sources, []).filter(isSource),
    titleTruncated: row.title_truncated === 1,
    title: row.title,
    authors: parseJson<string[]>(row.authors, []),
    year: row.year,
    journal: row.journal,
    volume: row.volume,
    issue: row.issue,
    pages: row.pages,
    doi: row.doi,
    pmid: row.pmid,
    pmcid: row.pmcid,
    url: row.url,
    pdfUrl: row.pdf_url,
    abstract: row.abstract,
    snippet: row.snippet,
    keywords: parseJson<string[]>(row.keywords, []),
    meshTerms: parseJson<string[]>(row.mesh_terms, []),
    publicationTypes: parseJson<string[]>(row.publication_types, []),
    citedBy: row.cited_by,
    citedByUrl: row.cited_by_url,
    refType: isRefType(row.ref_type) ? row.ref_type : null,
    decision: isDecision(row.decision) ? row.decision : 'pending',
    exclusionReason: isExclusionReason(row.exclusion_reason) ? row.exclusion_reason : null,
    note: row.note,
    firstSearchId: row.first_search_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toSearch(row: SearchRow): BiblioSearch {
  return {
    id: row.id,
    kind: row.kind === 'import' ? 'import' : 'search',
    source: isSource(row.source) ? row.source : 'pubmed',
    actor: row.actor,
    query: row.query,
    sentQuery: row.sent_query,
    queryTranslation: row.query_translation,
    fileName: row.file_name,
    sourceLabel: row.source_label,
    yearFrom: row.year_from,
    yearTo: row.year_to,
    maxResults: row.max_results,
    sort: row.sort === 'date' ? 'date' : 'relevance',
    status: (['running', 'ok', 'error'] as SearchStatus[]).includes(row.status as SearchStatus)
      ? (row.status as SearchStatus)
      : 'error',
    error: row.error,
    warnings: parseJson<unknown[]>(row.warnings, []).filter((w): w is string => typeof w === 'string'),
    totalCount: row.total_count,
    returned: row.returned,
    skipped: row.skipped,
    added: row.added,
    duplicates: row.duplicates,
    durationMs: row.duration_ms,
    queriedAt: row.queried_at,
  };
}

/* ─────────────────────────────── Recherches ────────────────────────────── */

export function createSearch(input: {
  kind?: SearchKind;
  source: BiblioSource;
  actor: string;
  query: string;
  sentQuery?: string | null;
  fileName?: string | null;
  sourceLabel?: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  maxResults: number;
  sort: SearchSort;
}): number {
  const result = db
    .prepare(
      `INSERT INTO biblio_searches
         (kind, source, actor, query, sent_query, file_name, source_label, year_from, year_to, max_results, sort, status, queried_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
    )
    .run(
      input.kind ?? 'search',
      input.source,
      input.actor,
      input.query,
      input.sentQuery ?? null,
      input.fileName ?? null,
      input.sourceLabel ?? null,
      input.yearFrom,
      input.yearTo,
      input.maxResults,
      input.sort,
      nowIso(),
    );
  return Number(result.lastInsertRowid);
}

/** Ce qu'une passe a appris de la source, réussie ou non : le journal de recherche le garde. */
interface SearchFacts {
  totalCount?: number | null;
  queryTranslation?: string | null;
  warnings?: string[];
}

export function finishSearch(
  id: number,
  outcome:
    | ({ status: 'ok'; returned: number; skipped: number; added: number; duplicates: number; durationMs: number } & SearchFacts)
    | ({ status: 'error'; error: string; durationMs: number } & SearchFacts),
): BiblioSearch {
  const facts = [
    outcome.totalCount ?? null,
    outcome.queryTranslation ?? null,
    JSON.stringify(outcome.warnings ?? []),
  ];
  if (outcome.status === 'ok') {
    db.prepare(
      `UPDATE biblio_searches
          SET status = 'ok', returned = ?, skipped = ?, added = ?, duplicates = ?, duration_ms = ?,
              total_count = ?, query_translation = ?, warnings = ?
        WHERE id = ?`,
    ).run(outcome.returned, outcome.skipped, outcome.added, outcome.duplicates, outcome.durationMs, ...facts, id);
  } else {
    db.prepare(
      `UPDATE biblio_searches
          SET status = 'error', error = ?, duration_ms = ?, total_count = ?, query_translation = ?, warnings = ?
        WHERE id = ?`,
    ).run(outcome.error, outcome.durationMs, ...facts, id);
  }
  return getSearch(id) as BiblioSearch;
}

export function getSearch(id: number): BiblioSearch | null {
  const row = db.prepare('SELECT * FROM biblio_searches WHERE id = ?').get(id) as SearchRow | undefined;
  return row ? toSearch(row) : null;
}

export function listSearches(): BiblioSearch[] {
  return (db.prepare('SELECT * FROM biblio_searches ORDER BY id DESC').all() as SearchRow[]).map(toSearch);
}

/**
 * Une recherche encore « en cours » au démarrage n'a plus d'acteur derrière
 * elle : le serveur s'est arrêté pendant l'appel. Elle est close en erreur
 * plutôt que de tourner indéfiniment dans l'historique.
 */
export function recoverInterruptedSearches(): number {
  return db
    .prepare(
      `UPDATE biblio_searches
          SET status = 'error', error = 'Interrompue : le serveur s''est arrêté pendant la recherche.'
        WHERE status = 'running'`,
    )
    .run().changes;
}

/* ─────────────────────────── Rapprochement des notices ──────────────────── */

/** Écart d'années tolérable entre deux notices d'un même article (mise en ligne vs numéro). */
const YEAR_TOLERANCE = 1;

const yearsCompatible = (a: number | null, b: number | null): boolean =>
  a === null || b === null || Math.abs(a - b) <= YEAR_TOLERANCE;

/**
 * Deux notices qui portent chacune un identifiant fort, différent, désignent
 * deux articles — même si leurs titres coïncident. Sur une vraie recherche
 * PubMed, c'est fréquent : cinq lettres à l'éditeur intitulées « Duration of
 * antibiotics in complicated appendicitis », une revue Cochrane et sa mise à
 * jour, ou les réponses d'un même auteur publiées sous un DOI commun. Les
 * fusionner fausserait le nombre de références à trier.
 */
function conflicts(row: RefRow, ref: BiblioRefInput, by: 'doi' | 'pmcid' | 'title'): boolean {
  if (row.pmid && ref.pmid && row.pmid !== ref.pmid) return true;
  return by === 'title' && row.doi !== null && ref.doi !== null && row.doi !== ref.doi;
}

/**
 * Cherche la notice déjà connue qui désigne le même article.
 *
 * Par ordre de fiabilité : DOI, PMID, PMCID, puis titre normalisé. Un
 * rapprochement est refusé quand les deux notices portent des PMID différents
 * (ou, pour un rapprochement par titre, des DOI différents) : voir `conflicts`.
 * Le rapprochement par titre exige aussi des années compatibles — « Editorial »
 * et sa réponse portent parfois le même titre — et sait lire un titre tronqué
 * par Google Scholar, dans les deux sens (la notice connue est tronquée, ou la
 * nouvelle l'est).
 */
function findExisting(ref: BiblioRefInput): RefRow | null {
  if (ref.pmid) {
    const row = db.prepare('SELECT * FROM biblio_refs WHERE pmid = ? LIMIT 1').get(ref.pmid) as RefRow | undefined;
    if (row) return row;
  }
  if (ref.doi) {
    const rows = db.prepare('SELECT * FROM biblio_refs WHERE doi = ?').all(ref.doi) as RefRow[];
    const row = rows.find((r) => !conflicts(r, ref, 'doi'));
    if (row) return row;
  }
  // Scholar pointe souvent vers la copie PMC de l'article : l'identifiant PMC suffit à le reconnaître.
  if (ref.pmcid) {
    const rows = db.prepare('SELECT * FROM biblio_refs WHERE pmcid = ?').all(ref.pmcid) as RefRow[];
    const row = rows.find((r) => !conflicts(r, ref, 'pmcid'));
    if (row) return row;
  }

  const norm = normTitle(ref.title);
  if (norm.length < 12) return null; // un titre trop court ne dit rien
  const sameWork = (r: RefRow) => yearsCompatible(r.year, ref.year) && !conflicts(r, ref, 'title');

  const exact = db
    .prepare('SELECT * FROM biblio_refs WHERE norm_title = ?')
    .all(norm) as RefRow[];
  const byExact = exact.find(sameWork);
  if (byExact) return byExact;

  // Titre tronqué (le préfixe des titres connus) ou notice connue tronquée.
  const truncatedNew = isTruncated(ref.title);
  if (truncatedNew && norm.length >= 25) {
    const rows = db
      .prepare(`SELECT * FROM biblio_refs WHERE norm_title LIKE ? || '%'`)
      .all(norm) as RefRow[];
    const hit = rows.find(sameWork);
    if (hit) return hit;
  }
  const knownTruncated = db
    .prepare(`SELECT * FROM biblio_refs WHERE title_truncated = 1 AND ? LIKE norm_title || '%'`)
    .all(norm) as RefRow[];
  return knownTruncated.find((r) => r.norm_title.length >= 25 && sameWork(r)) ?? null;
}

const orNull = <T>(current: T | null, incoming: T | null): T | null => current ?? incoming;
const nonEmpty = <T>(current: T[], incoming: T[]): T[] => (current.length > 0 ? current : incoming);

/** Ce que la nouvelle notice apporte à la notice connue. Rien n'est jamais effacé. */
function mergeRefs(existing: RefRow, incoming: BiblioRefInput): void {
  const known = toRef(existing);
  const sources = [...new Set([...known.sources, incoming.source])];

  // Le titre complet l'emporte sur le titre tronqué ; PubMed fait foi pour la revue et les auteurs.
  const incomingTruncated = isTruncated(incoming.title);
  const takeTitle = known.titleTruncated && !incomingTruncated;
  // Une notice PubMed (API ou export .nbib) fait foi pour les auteurs et la revue.
  const fromPubmed = incoming.source === 'pubmed';

  db.prepare(
    `UPDATE biblio_refs SET
       title = ?, norm_title = ?, title_truncated = ?,
       authors = ?, year = ?, journal = ?, volume = ?, issue = ?, pages = ?,
       doi = ?, pmid = ?, pmcid = ?, url = ?, pdf_url = ?, abstract = ?, snippet = ?,
       keywords = ?, mesh_terms = ?, publication_types = ?,
       cited_by = ?, cited_by_url = ?, sources = ?, ref_type = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    takeTitle ? incoming.title : known.title,
    takeTitle ? normTitle(incoming.title) : existing.norm_title,
    takeTitle ? 0 : existing.title_truncated,
    JSON.stringify(fromPubmed && incoming.authors.length > 0 ? incoming.authors : nonEmpty(known.authors, incoming.authors)),
    orNull(known.year, incoming.year),
    fromPubmed ? orNull(incoming.journal, known.journal) : orNull(known.journal, incoming.journal),
    orNull(known.volume, incoming.volume),
    orNull(known.issue, incoming.issue),
    orNull(known.pages, incoming.pages),
    orNull(known.doi, incoming.doi),
    orNull(known.pmid, incoming.pmid),
    orNull(known.pmcid, incoming.pmcid),
    orNull(known.url, incoming.url),
    orNull(known.pdfUrl, incoming.pdfUrl),
    orNull(known.abstract, incoming.abstract),
    orNull(known.snippet, incoming.snippet),
    JSON.stringify(nonEmpty(known.keywords, incoming.keywords)),
    JSON.stringify(nonEmpty(known.meshTerms, incoming.meshTerms)),
    JSON.stringify(nonEmpty(known.publicationTypes, incoming.publicationTypes)),
    known.citedBy === null ? incoming.citedBy : Math.max(known.citedBy, incoming.citedBy ?? 0),
    orNull(known.citedByUrl, incoming.citedByUrl),
    JSON.stringify(sources),
    fromPubmed && incoming.refType ? incoming.refType : (known.refType ?? incoming.refType ?? null),
    nowIso(),
    existing.id,
  );
}

/**
 * Verse les références d'une recherche (ou d'un import) dans la bibliothèque.
 *
 * Une référence déjà connue — même DOI, même PMID, ou même titre — n'est pas
 * dupliquée : elle s'enrichit (la notice Google Scholar apporte le nombre de
 * citations, la notice PubMed le résumé) et la recherche y est rattachée.
 *
 * `added` et `duplicates` décrivent CETTE passe, pour son bilan et
 * l'historique : relancer une équation donne « 0 nouvelle, n déjà connues ».
 * Le diagramme de flux, lui, ne les additionne pas d'une passe à l'autre : il
 * se calcule des rattachements (`biblio_hits`), voir `prisma()`. Deux notices
 * d'une même liste qui désignent le même article sont comptées dans `copies`.
 */
export const addRefsFromSearch = db.transaction(
  (searchId: number, refs: BiblioRefInput[]): { added: number; duplicates: number } => {
    let added = 0;
    let duplicates = 0;
    const hit = db.prepare(
      `INSERT INTO biblio_hits (search_id, ref_id, rank, copies) VALUES (?, ?, ?, 1)
       ON CONFLICT (search_id, ref_id) DO UPDATE SET copies = copies + 1`,
    );

    refs.forEach((ref, index) => {
      const existing = findExisting(ref);
      if (existing) {
        mergeRefs(existing, ref);
        hit.run(searchId, existing.id, index + 1);
        duplicates += 1;
        return;
      }
      const now = nowIso();
      const result = db
        .prepare(
          `INSERT INTO biblio_refs
             (norm_title, title_truncated, title, authors, year, journal, volume, issue, pages,
              doi, pmid, pmcid, url, pdf_url, abstract, snippet, keywords, mesh_terms,
              publication_types, cited_by, cited_by_url, sources, ref_type, first_search_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          normTitle(ref.title),
          isTruncated(ref.title) ? 1 : 0,
          ref.title,
          JSON.stringify(ref.authors),
          ref.year,
          ref.journal,
          ref.volume,
          ref.issue,
          ref.pages,
          ref.doi,
          ref.pmid,
          ref.pmcid,
          ref.url,
          ref.pdfUrl,
          ref.abstract,
          ref.snippet,
          JSON.stringify(ref.keywords),
          JSON.stringify(ref.meshTerms),
          JSON.stringify(ref.publicationTypes),
          ref.citedBy,
          ref.citedByUrl,
          JSON.stringify([ref.source]),
          ref.refType ?? null,
          searchId,
          now,
          now,
        );
      hit.run(searchId, Number(result.lastInsertRowid), index + 1);
      added += 1;
    });
    return { added, duplicates };
  },
);

/* ─────────────────────────────── Références ─────────────────────────────── */

export interface RefFilter {
  decision?: Decision;
  source?: BiblioSource | 'both';
  q?: string;
  sort?: 'added' | 'recent' | 'cited';
  limit?: number;
  offset?: number;
}

function whereOf(filter: RefFilter): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (filter.decision) {
    parts.push('decision = ?');
    params.push(filter.decision);
  }
  if (filter.source === 'both') {
    // « Trouvées par plusieurs sources ».
    parts.push('json_array_length(sources) > 1');
  } else if (filter.source) {
    parts.push('sources LIKE ?');
    params.push(`%"${filter.source}"%`);
  }
  return { sql: parts.length > 0 ? `WHERE ${parts.join(' AND ')}` : '', params };
}

/** Texte sans accents ni casse, espaces simples : de quoi comparer « Étude » et « etude ». */
const foldSearch = (text: string): string => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Termes d'une recherche : des mots, ou des expressions entre guillemets. Tous doivent figurer dans la notice,
 * dans n'importe quel champ et dans n'importe quel ordre — taper « diabète enfant » trouve « Diabetes in children
 * and … » comme « enfant … diabète ».
 */
export function searchTerms(query: string): string[] {
  const terms: string[] = [];
  for (const match of query.matchAll(/"([^"]+)"|([^\s,;"]+)/g)) {
    const term = foldSearch(match[1] ?? match[2] ?? '');
    if (term) terms.push(term);
  }
  return terms.slice(0, 12);
}

/** Texte interrogeable d'une notice : tout ce qu'un chercheur peut se rappeler d'un article. */
function searchableText(ref: BiblioRef): string {
  return foldSearch(
    [
      ref.title,
      ref.authors.join(' '),
      ref.journal,
      ref.abstract,
      ref.snippet,
      ref.keywords.join(' '),
      ref.meshTerms.join(' '),
      ref.doi,
      ref.pmid,
      ref.pmcid,
      ref.year,
    ]
      .filter((part) => part !== null && part !== undefined && part !== '')
      .join(' '),
  );
}

export function listRefs(filter: RefFilter = {}): { refs: BiblioRef[]; total: number } {
  const { sql, params } = whereOf(filter);
  const order =
    filter.sort === 'recent'
      ? 'ORDER BY year IS NULL, year DESC, id ASC'
      : filter.sort === 'cited'
        ? 'ORDER BY cited_by IS NULL, cited_by DESC, id ASC'
        : 'ORDER BY id ASC';
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const offset = Math.max(filter.offset ?? 0, 0);

  const terms = searchTerms(filter.q ?? '');
  if (terms.length > 0) {
    // Recherche en clair : SQLite ne replie les accents ni la casse des lettres non ASCII, et ne sait pas
    // chercher plusieurs mots à la fois. La bibliothèque d'une revue tient en quelques milliers de notices.
    const all = (db.prepare(`SELECT * FROM biblio_refs ${sql} ${order}`).all(...params) as RefRow[]).map(toRef);
    const found = all.filter((ref) => {
      const text = searchableText(ref);
      return terms.every((term) => text.includes(term));
    });
    return { refs: found.slice(offset, offset + limit), total: found.length };
  }

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM biblio_refs ${sql}`).get(...params) as { n: number }).n;
  const rows = db
    .prepare(`SELECT * FROM biblio_refs ${sql} ${order} LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as RefRow[];
  return { refs: rows.map(toRef), total };
}

/**
 * Toutes les références qui répondent au filtre, sans plafond. Une page de liste est bornée à 1 000 lignes ; un export
 * ne peut pas l'être : une bibliothèque de 1 200 références livrée tronquée à 1 000, sans le dire, fausserait
 * le diagramme de flux de l'article qui l'utilise.
 */
export function listAllRefs(filter: Pick<RefFilter, 'decision' | 'source'> = {}): BiblioRef[] {
  const { sql, params } = whereOf(filter);
  return (db.prepare(`SELECT * FROM biblio_refs ${sql} ORDER BY id ASC`).all(...params) as RefRow[]).map(toRef);
}

export function getRef(id: number): BiblioRef | null {
  const row = db.prepare('SELECT * FROM biblio_refs WHERE id = ?').get(id) as RefRow | undefined;
  return row ? toRef(row) : null;
}

export function updateRefDecision(
  id: number,
  patch: { decision?: Decision; exclusionReason?: ExclusionReason | null; note?: string | null },
): BiblioRef | null {
  const current = getRef(id);
  if (!current) return null;

  const decision = patch.decision ?? current.decision;
  // Le motif n'a de sens que pour une exclusion : il disparaît avec elle.
  const reason =
    decision === 'exclude'
      ? patch.exclusionReason === undefined
        ? current.exclusionReason
        : patch.exclusionReason
      : null;
  const note = patch.note === undefined ? current.note : patch.note?.trim() || null;

  db.prepare(
    'UPDATE biblio_refs SET decision = ?, exclusion_reason = ?, note = ?, updated_at = ? WHERE id = ?',
  ).run(decision, reason, note, nowIso(), id);
  return getRef(id);
}

/* ───────────────────────────── Dénombrements ────────────────────────────── */

export function counts(): BiblioCounts {
  const byDecision = db
    .prepare('SELECT decision, COUNT(*) AS n FROM biblio_refs GROUP BY decision')
    .all() as { decision: string; n: number }[];
  const count = (d: Decision) => byDecision.find((r) => r.decision === d)?.n ?? 0;

  const perSource = db
    .prepare(
      `SELECT s.value AS source, COUNT(*) AS n
         FROM biblio_refs r, json_each(r.sources) s
        GROUP BY s.value`,
    )
    .all() as { source: string; n: number }[];
  const bySource: BiblioCounts['bySource'] = {};
  for (const row of perSource) if (isSource(row.source)) bySource[row.source] = row.n;
  const multi = db.prepare('SELECT COUNT(*) AS n FROM biblio_refs WHERE json_array_length(sources) > 1').get() as {
    n: number;
  };

  return {
    total: byDecision.reduce((sum, r) => sum + r.n, 0),
    pending: count('pending'),
    include: count('include'),
    maybe: count('maybe'),
    exclude: count('exclude'),
    bySource,
    multiSource: multi.n,
  };
}

/**
 * Chiffres du diagramme de flux. Aucun n'est saisi : ils se calculent des
 * rattachements entre recherches réussies et références (`biblio_hits`), et de
 * l'état de tri.
 *
 * - **Notices identifiées, par source** : pour chaque source (PubMed, Embase…),
 *   le nombre de notices DISTINCTES que ses recherches et imports réussis ont
 *   rendues. Une référence rendue par trois passes de la même source — la même
 *   équation relancée, ou deux équations qui se recoupent — compte UNE fois
 *   pour cette source : relancer une recherche ne gonfle plus le diagramme.
 *   Deux notices d'un même export qui désignent le même article (doublon
 *   interne, `copies`) comptent pour deux, comme dans le fichier.
 * - **Notices identifiées** : la somme des sources, rangées dans leur colonne
 *   PRISMA 2020 (bases de données, registres, autres méthodes — Google
 *   Scholar en fait partie).
 * - **Doublons retirés** : identifiées − références uniques. Un article
 *   trouvé par PubMed et par Embase compte une fois par source, puis une fois
 *   comme doublon.
 * - **À trier** : les références uniques de la bibliothèque.
 *
 * Ainsi « identifiées − doublons = à trier » tient toujours, quel que soit le
 * nombre de passes.
 */
export function prisma(): BiblioPrisma {
  const rows = db
    .prepare(
      `SELECT source, COALESCE(SUM(copies), 0) AS n FROM (
         SELECT s.source AS source, h.ref_id AS ref_id, MAX(h.copies) AS copies
           FROM biblio_hits h JOIN biblio_searches s ON s.id = h.search_id
          WHERE s.status = 'ok'
          GROUP BY s.source, h.ref_id
       ) GROUP BY source`,
    )
    .all() as { source: string; n: number }[];

  // « Autre » : les noms libres donnés aux imports sont repris dans le libellé.
  const labels = db
    .prepare(
      `SELECT source, GROUP_CONCAT(DISTINCT source_label) AS labels
         FROM biblio_searches WHERE status = 'ok' AND source_label IS NOT NULL AND source_label <> ''
        GROUP BY source`,
    )
    .all() as { source: string; labels: string | null }[];
  const labelOf = (source: BiblioSource): string => {
    const named = labels.find((l) => l.source === source)?.labels;
    return named ? `${SOURCE_LABELS[source]} : ${named.split(',').join(', ')}` : SOURCE_LABELS[source];
  };

  const bySource: PrismaSourceCount[] = rows
    .filter((r): r is { source: BiblioSource; n: number } => isSource(r.source) && r.n > 0)
    .map((r) => ({ source: r.source, label: labelOf(r.source), category: SOURCE_CATEGORY[r.source], count: r.n }))
    .sort((a, b) => b.count - a.count);
  const sum = (category?: string) =>
    bySource.filter((r) => category === undefined || r.category === category).reduce((total, r) => total + r.count, 0);

  const c = counts();
  const byReason = db
    .prepare(
      `SELECT exclusion_reason AS reason, COUNT(*) AS n
         FROM biblio_refs WHERE decision = 'exclude' GROUP BY exclusion_reason ORDER BY n DESC`,
    )
    .all() as { reason: string | null; n: number }[];

  const identified = sum();
  return {
    identified,
    bySource,
    identifiedDatabases: sum('database'),
    identifiedRegisters: sum('register'),
    identifiedOther: sum('other'),
    duplicatesRemoved: Math.max(0, identified - c.total),
    screened: c.total,
    excluded: c.exclude,
    excludedByReason: byReason.map((r) => ({
      reason: isExclusionReason(r.reason) ? r.reason : 'unspecified',
      count: r.n,
    })),
    maybe: c.maybe,
    pending: c.pending,
    included: c.include,
  };
}
