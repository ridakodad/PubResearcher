/**
 * « Veille PubDaily » et import de références curatées depuis PubDaily.
 *
 * Deux routeurs sont exposés par ce module :
 *   - `biblioPubdailyRouter` : lecture publique de PubDaily (spécialités,
 *     tendances, articles, recherche). Monté AVANT `projectScope` : les
 *     données PubDaily sont publiques et ne dépendent pas du projet.
 *   - `biblioPubdailyImportRouter` : import effectif de PMIDs dans la
 *     bibliographie du projet courant. Monté APRÈS `projectScope`, puisqu'il
 *     écrit dans la base du projet.
 *
 * Les erreurs du client MCP (`PubdailyError`) sont converties en réponses
 * HTTP lisibles : jamais la trace du MCP n'arrive brute à l'interface.
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  PubdailyError,
  extractEsearchTerm,
  getPubdailyClient,
} from '../biblio/pubdaily.js';
import { EutilsClient, EutilsError, eutilsConfig, parsePubmedXml } from '../biblio/eutils.js';
import { addRefsFromSearch, createSearch, finishSearch } from '../repo/biblio.js';
import { HttpError, asyncHandler, badRequest } from '../lib/http.js';

export const biblioPubdailyRouter = Router();
export const biblioPubdailyImportRouter = Router();

function handle(error: unknown): never {
  if (error instanceof PubdailyError) {
    const status = error.kind === 'config' ? 503 : error.kind === 'timeout' ? 504 : 502;
    throw new HttpError(status, error.message, undefined, `pubdaily_${error.kind}`);
  }
  throw error as Error;
}

/* ─────────────────────────────── Lecture ──────────────────────────────── */

biblioPubdailyRouter.get(
  '/specialties',
  asyncHandler(async (_req, res) => {
    try {
      const r = await getPubdailyClient().listSpecialties();
      res.json(r);
    } catch (error) {
      handle(error);
    }
  }),
);

const trendsSchema = z.object({
  specialty: z.string().trim().min(1, 'Précisez la spécialité.').max(120),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

biblioPubdailyRouter.get(
  '/trends',
  asyncHandler(async (req, res) => {
    const { specialty, limit } = trendsSchema.parse(req.query);
    try {
      res.json(await getPubdailyClient().getResearchTrends(specialty, limit));
    } catch (error) {
      handle(error);
    }
  }),
);

const findTrendSchema = z.object({ q: z.string().trim().min(2).max(200) });

biblioPubdailyRouter.get(
  '/find-trend',
  asyncHandler(async (req, res) => {
    const { q } = findTrendSchema.parse(req.query);
    try {
      res.json(await getPubdailyClient().findTrend(q));
    } catch (error) {
      handle(error);
    }
  }),
);

const papersSchema = z.object({
  specialty: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  summarized_only: z
    .union([z.boolean(), z.enum(['true', 'false', '0', '1'])])
    .optional()
    .transform((v) => (typeof v === 'boolean' ? v : v === 'true' || v === '1')),
});

biblioPubdailyRouter.get(
  '/papers',
  asyncHandler(async (req, res) => {
    const { specialty, limit, summarized_only } = papersSchema.parse(req.query);
    try {
      res.json(await getPubdailyClient().getTopPapers(specialty, { limit, summarizedOnly: summarized_only }));
    } catch (error) {
      handle(error);
    }
  }),
);

const searchPapersSchema = z.object({
  q: z.string().trim().min(2).max(200),
  specialty: z.string().trim().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

biblioPubdailyRouter.get(
  '/search-papers',
  asyncHandler(async (req, res) => {
    const { q, specialty, limit } = searchPapersSchema.parse(req.query);
    try {
      res.json(await getPubdailyClient().searchPapers(q, { specialty, limit }));
    } catch (error) {
      handle(error);
    }
  }),
);

/* ──────────────── Papiers d'un sujet (via pubmed_search) ────────────── */

const topicPapersSchema = z.object({
  term: z.string().trim().min(2).max(2000).optional(),
  pubmed_search: z.string().trim().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

biblioPubdailyImportRouter.get(
  '/topics/:slug/papers',
  asyncHandler(async (req, res) => {
    const slug = String(req.params.slug ?? '').trim().slice(0, 200);
    if (!slug) throw badRequest('Sujet PubDaily introuvable.');
    const { term, pubmed_search, limit } = topicPapersSchema.parse(req.query);
    // L'URL `pubmed_search` du MCP contient le `?term=` ; l'interface le passe tel quel.
    const esearchTerm = term ?? extractEsearchTerm(pubmed_search ?? null);
    if (!esearchTerm) {
      throw badRequest('Ce sujet PubDaily n’a pas de requête PubMed exploitable (pubmed_search manquante).');
    }
    const client = new EutilsClient(eutilsConfig());
    const want = Math.min(limit ?? 50, 50);
    try {
      const search = await client.esearch(esearchTerm, { sort: 'date', retmax: want });
      // On passe par l'historique (WebEnv) comme le reste du code : les ids ne sont pas demandés à esearch.
      let refs: Awaited<ReturnType<typeof parsePubmedXml>>['refs'] = [];
      if (search.count > 0) {
        const batch = await client.efetch({ webenv: search.webenv, querykey: search.querykey }, 0, want);
        refs = batch.refs;
      }
      const pmids = refs.map((r) => r.pmid).filter((p): p is string => Boolean(p));
      // Flag « déjà importé » : on relit les PMIDs présents dans la base du projet.
      const existingPmids = new Set<string>();
      try {
        const { listExistingPmids } = await import('../repo/biblio.js');
        for (const p of listExistingPmids(pmids)) existingPmids.add(p);
      } catch {
        /* la fonction peut n'être pas encore disponible dans un contexte sans projet. */
      }
      res.json({
        slug,
        term: esearchTerm,
        totalCount: search.count,
        pmids,
        papers: refs.map((ref) => ({
          pmid: ref.pmid,
          title: ref.title,
          journal: ref.journal,
          year: ref.year,
          authors: ref.authors,
          abstract: ref.abstract,
          publicationTypes: ref.publicationTypes,
          alreadyImported: ref.pmid ? existingPmids.has(ref.pmid) : false,
        })),
      });
    } catch (error) {
      if (error instanceof EutilsError) {
        throw new HttpError(502, `PubMed indisponible : ${error.message}`, undefined, `eutils_${error.kind}`);
      }
      throw error;
    }
  }),
);

/* ───────────────────────────── Import projet ──────────────────────────── */

const importSchema = z.object({
  specialty: z.string().trim().max(200).optional(),
  topic: z.string().trim().max(300).optional(),
  page: z.string().trim().max(2000).optional(),
  pmids: z.array(z.union([z.number().int(), z.string()])).min(1).max(200),
});

biblioPubdailyImportRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    const input = importSchema.parse(req.body ?? {});
    const pmids = [...new Set(input.pmids.map((p) => String(p).replace(/[^0-9]/g, '')).filter(Boolean))];
    if (pmids.length === 0) throw badRequest('Aucun PMID exploitable.');

    const started = Date.now();
    const client = new EutilsClient(eutilsConfig());
    const searchId = createSearch({
      kind: 'import',
      source: 'pubdaily',
      actor: 'PubDaily (MCP)',
      query: `pmids: ${pmids.join(', ')}`,
      question: null,
      strategy: null,
      sourceLabel: input.topic ?? null,
      pubdailyTopic: input.topic ?? null,
      pubdailySpecialty: input.specialty ?? null,
      pubdailyPage: input.page ?? null,
      yearFrom: null,
      yearTo: null,
      maxResults: pmids.length,
      sort: 'relevance',
    });
    try {
      // On passe par esearch + historique : simple, cohérent avec le reste du code et testable.
      const term = pmids.map((p) => `${p}[uid]`).join(' OR ');
      const search = await client.esearch(term, { retmax: pmids.length });
      const batch = search.count > 0
        ? await client.efetch({ webenv: search.webenv, querykey: search.querykey }, 0, pmids.length)
        : { refs: [], skipped: 0, pmids: [] as string[] };
      const refs = batch.refs.map((r) => ({ ...r, source: 'pubdaily' as const }));
      const { added, duplicates } = addRefsFromSearch(searchId, refs);
      const persisted = finishSearch(searchId, {
        status: 'ok',
        returned: refs.length,
        skipped: batch.skipped,
        added,
        duplicates,
        durationMs: Date.now() - started,
        warnings: [],
      });
      res.status(201).json({ search: persisted, imported: added, duplicates });
    } catch (error) {
      const message = error instanceof EutilsError ? error.message : (error as Error).message;
      finishSearch(searchId, {
        status: 'error',
        error: message,
        durationMs: Date.now() - started,
        warnings: [],
      });
      throw new HttpError(502, `Import PubDaily impossible : ${message}`, undefined, 'pubdaily_import_failed');
    }
  }),
);
