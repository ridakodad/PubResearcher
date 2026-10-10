import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, badRequest, conflict, intParam, notFound } from '../lib/http.js';
import {
  ApifyError,
  NO_TOKEN_MESSAGE,
  actorFor,
  adapterFor,
  apifyConfig,
  searchSource,
  supportedActors,
} from '../biblio/apify.js';
import { refsToCsv, searchesToCsv, toBibtex, toRis } from '../biblio/export.js';
import {
  BIBLIO_SOURCES,
  DECISIONS,
  EXCLUSION_REASONS,
  SOURCE_LABELS,
  isExclusionReason,
  type BiblioSearch,
  type BiblioSource,
} from '../biblio/types.js';
import {
  addRefsFromSearch,
  counts,
  createSearch,
  finishSearch,
  getRef,
  listAllRefs,
  listRefs,
  listSearches,
  prisma,
  updateRefDecision,
} from '../repo/biblio.js';

/**
 * Revue bibliographique : interrogation de PubMed et de Google Scholar par des
 * acteurs Apify, dédoublonnage, tri, exports.
 *
 * Chaque passe est facturée par Apify, au résultat. D'où trois garde-fous
 * côté serveur — le plafond de résultats, une seule passe à la fois, et un
 * jeton qui ne sort jamais d'ici.
 */
export const biblioRouter = Router();

/** Une seule passe à la fois : un double clic ne doit pas facturer deux fois. */
let running = false;

const optionalYear = z.number().int().min(1800).max(2200).optional();

/** État de la configuration, sans jamais exposer le jeton. */
biblioRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const cfg = apifyConfig();
    const source = (s: BiblioSource) => {
      const actor = actorFor(cfg, s);
      let supported = true;
      try {
        adapterFor(s, actor);
      } catch {
        supported = false;
      }
      return { label: SOURCE_LABELS[s], actor, supported, alternatives: supportedActors(s) };
    };
    res.json({
      configured: cfg.token.length > 0,
      maxResults: cfg.maxResultsCap,
      running,
      sources: { pubmed: source('pubmed'), scholar: source('scholar') },
      exclusionReasons: EXCLUSION_REASONS,
    });
  }),
);

biblioRouter.get(
  '/overview',
  asyncHandler(async (_req, res) => {
    res.json({ counts: counts(), prisma: prisma(), searches: listSearches() });
  }),
);

const searchSchema = z
  .object({
    query: z
      .string()
      .trim()
      .min(2, 'Saisissez une équation de recherche.')
      .max(500, "L'équation de recherche est limitée à 500 caractères."),
    sources: z
      .array(z.enum(BIBLIO_SOURCES))
      .min(1, 'Choisissez au moins une source.')
      .max(BIBLIO_SOURCES.length),
    maxResults: z.number().int().min(1).default(20),
    yearFrom: optionalYear,
    yearTo: optionalYear,
    sort: z.enum(['relevance', 'date']).default('relevance'),
  })
  .refine((v) => v.yearFrom === undefined || v.yearTo === undefined || v.yearFrom <= v.yearTo, {
    message: "L'année de début dépasse l'année de fin.",
    path: ['yearFrom'],
  });

/**
 * Lance une passe sur une ou deux sources, en parallèle.
 *
 * Une source en échec n'annule pas l'autre : sa recherche est enregistrée en
 * erreur, avec le message qui dit quoi corriger, et l'autre verse ses
 * références. Chaque recherche — réussie ou non — reste dans l'historique avec
 * sa chaîne exacte et sa date.
 */
biblioRouter.post(
  '/searches',
  asyncHandler(async (req, res) => {
    const cfg = apifyConfig();
    const input = searchSchema.parse(req.body);
    if (input.maxResults > cfg.maxResultsCap) {
      throw badRequest(
        `Au plus ${cfg.maxResultsCap} résultats par source et par passe (BIBLIO_MAX_RESULTS) : chaque résultat est facturé par Apify.`,
      );
    }
    if (!cfg.token) throw conflict(NO_TOKEN_MESSAGE);
    if (running) throw conflict('Une recherche est déjà en cours : attendez sa fin.');

    running = true;
    try {
      const sources = [...new Set(input.sources)];
      const searches = await Promise.all(
        sources.map(async (source): Promise<BiblioSearch> => {
          const actor = actorFor(cfg, source);
          const searchId = createSearch({
            source,
            actor,
            query: input.query,
            yearFrom: input.yearFrom ?? null,
            yearTo: input.yearTo ?? null,
            maxResults: input.maxResults,
            sort: input.sort,
          });
          const started = Date.now();
          try {
            const result = await searchSource(cfg, source, {
              query: input.query,
              maxResults: input.maxResults,
              yearFrom: input.yearFrom,
              yearTo: input.yearTo,
              sort: input.sort,
            });
            const { added, duplicates } = addRefsFromSearch(searchId, result.refs);
            return finishSearch(searchId, {
              status: 'ok',
              returned: result.refs.length,
              skipped: result.skipped,
              added,
              duplicates,
              durationMs: Date.now() - started,
            });
          } catch (error) {
            const message =
              error instanceof ApifyError
                ? error.message
                : `Échec inattendu de la recherche (${error instanceof Error ? error.message : String(error)}).`;
            return finishSearch(searchId, {
              status: 'error',
              error: message,
              durationMs: Date.now() - started,
            });
          }
        }),
      );
      res.status(201).json({ searches, counts: counts(), prisma: prisma() });
    } finally {
      running = false;
    }
  }),
);

const listSchema = z.object({
  decision: z.enum(DECISIONS).optional(),
  source: z.enum(['pubmed', 'scholar', 'both']).optional(),
  q: z.string().trim().max(200).optional(),
  sort: z.enum(['added', 'recent', 'cited']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

biblioRouter.get(
  '/refs',
  asyncHandler(async (req, res) => {
    const filter = listSchema.parse(req.query);
    res.json(listRefs(filter));
  }),
);

const decisionSchema = z.object({
  decision: z.enum(DECISIONS).optional(),
  exclusionReason: z.string().nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

biblioRouter.patch(
  '/refs/:id',
  asyncHandler(async (req, res) => {
    const id = intParam(req, 'id');
    const patch = decisionSchema.parse(req.body);
    const current = getRef(id);
    if (!current) throw notFound('Référence introuvable.');

    if (patch.exclusionReason != null && !isExclusionReason(patch.exclusionReason)) {
      throw badRequest("Motif d'exclusion inconnu.");
    }
    const decision = patch.decision ?? current.decision;
    const reason = (patch.exclusionReason ?? current.exclusionReason) as typeof current.exclusionReason;
    // Une exclusion se compte par son motif : sans lui, elle n'apparaîtrait nulle part dans le diagramme de flux.
    if (decision === 'exclude' && !reason) {
      throw badRequest("Une exclusion porte son motif : c'est lui que le diagramme de flux compte.");
    }

    const updated = updateRefDecision(id, {
      decision: patch.decision,
      exclusionReason: patch.exclusionReason == null ? undefined : (patch.exclusionReason as typeof current.exclusionReason),
      note: patch.note,
    });
    res.json({ ref: updated, counts: counts(), prisma: prisma() });
  }),
);

const exportSchema = z.object({
  format: z.enum(['csv', 'ris', 'bibtex', 'searches']).default('csv'),
  decision: z.enum(['pending', 'include', 'maybe', 'exclude', 'all']).default('all'),
});

const EXPORT_SCOPE = { all: 'toutes', include: 'retenues', maybe: 'a-voir', exclude: 'exclues', pending: 'a-trier' } as const;

const FORMATS = {
  csv: { type: 'text/csv; charset=utf-8', ext: 'csv', name: 'references' },
  ris: { type: 'application/x-research-info-systems; charset=utf-8', ext: 'ris', name: 'references' },
  bibtex: { type: 'application/x-bibtex; charset=utf-8', ext: 'bib', name: 'references' },
  searches: { type: 'text/csv; charset=utf-8', ext: 'csv', name: 'strategies-de-recherche' },
} as const;

biblioRouter.get(
  '/export',
  asyncHandler(async (req, res) => {
    const { format, decision } = exportSchema.parse(req.query);
    const spec = FORMATS[format];

    let body: string;
    if (format === 'searches') {
      body = searchesToCsv(listSearches());
    } else {
      const refs = listAllRefs({ decision: decision === 'all' ? undefined : decision });
      body = format === 'ris' ? toRis(refs) : format === 'bibtex' ? toBibtex(refs) : refsToCsv(refs);
    }

    const day = new Date().toISOString().slice(0, 10);
    // Le nom dit ce que le fichier contient : trois exports d'une même journée ne doivent pas s'écraser l'un l'autre.
    const scope = format === 'searches' ? '' : `-${EXPORT_SCOPE[decision]}`;
    res.setHeader('Content-Type', spec.type);
    res.setHeader('Content-Disposition', `attachment; filename="${spec.name}${scope}-${day}.${spec.ext}"`);
    res.send(body);
  }),
);
