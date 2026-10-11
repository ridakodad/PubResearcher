import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { HttpError, asyncHandler, badRequest, conflict, intParam, notFound, unprocessable } from '../lib/http.js';
import { NUMERIC_SETTINGS, readNumericEnv } from '../lib/env-check.js';
import {
  ApifyError,
  NO_TOKEN_MESSAGE,
  actorFor,
  adapterFor,
  apifyConfig,
  scholarQuery,
  searchSource,
  supportedActors,
} from '../biblio/apify.js';
import { ESEARCH_WINDOW, EUTILS_SERVICE, EutilsError, eutilsConfig, searchPubmed } from '../biblio/eutils.js';
import { refsToCsv, searchesToCsv, toBibtex, toRis } from '../biblio/export.js';
import { FORMAT_LABELS, IMPORT_FORMATS, ImportError, parseImport } from '../biblio/importers.js';
import {
  BIBLIO_SOURCES,
  DECISIONS,
  EXCLUSION_REASONS,
  SEARCHABLE_SOURCES,
  SOURCE_CATEGORY,
  SOURCE_LABELS,
  isExclusionReason,
  type BiblioSearch,
  type SearchableSource,
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
 * Revue bibliographique : interrogation de PubMed (API E-utilities du NCBI,
 * gratuite) et, en option, de Google Scholar (acteur Apify, facturé) ; import
 * des exports d'autres bases ; dédoublonnage, tri, exports.
 *
 * Garde-fous côté serveur : une seule passe à la fois (un double clic ne lance
 * pas deux récupérations, ni ne facture deux fois Scholar), des plafonds de
 * résultats, et des secrets (jeton Apify, clé NCBI) qui ne sortent jamais d'ici.
 */
export const biblioRouter = Router();

/** Une seule passe à la fois : un double clic ne doit pas lancer deux récupérations. */
let running = false;

const optionalYear = z.number().int().min(1800).max(2200).optional();

/** Taille maximale d'un fichier importé (50 Mo par défaut, `BIBLIO_IMPORT_MAX_MB`) : 50 000 notices avec résumés y tiennent. */
function importMaxBytes(): number {
  try {
    return readNumericEnv('BIBLIO_IMPORT_MAX_MB', process.env.BIBLIO_IMPORT_MAX_MB, 50, NUMERIC_SETTINGS.BIBLIO_IMPORT_MAX_MB) * 1024 * 1024;
  } catch {
    return 50 * 1024 * 1024;
  }
}

/** État de la configuration, sans jamais exposer le jeton ni la clé. */
biblioRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const apify = apifyConfig();
    const ncbi = eutilsConfig();
    const scholarActor = actorFor(apify, 'scholar');
    let scholarSupported = true;
    try {
      adapterFor('scholar', scholarActor);
    } catch {
      scholarSupported = false;
    }
    res.json({
      configured: apify.token.length > 0,
      maxResults: apify.maxResultsCap,
      running,
      pubmed: {
        service: EUTILS_SERVICE,
        apiKey: ncbi.apiKey.length > 0,
        email: ncbi.email.length > 0,
        maxRecords: ncbi.maxRecords,
        window: ESEARCH_WINDOW,
      },
      sources: {
        pubmed: { label: SOURCE_LABELS.pubmed, actor: EUTILS_SERVICE, supported: true, available: true, alternatives: [] },
        scholar: {
          label: SOURCE_LABELS.scholar,
          actor: scholarActor,
          supported: scholarSupported,
          available: apify.token.length > 0 && scholarSupported,
          alternatives: supportedActors('scholar'),
        },
      },
      importSources: BIBLIO_SOURCES.map((id) => ({ id, label: SOURCE_LABELS[id], category: SOURCE_CATEGORY[id] })),
      importFormats: IMPORT_FORMATS.map((id) => ({ id, label: FORMAT_LABELS[id] })),
      importMaxBytes: importMaxBytes(),
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
      .max(4000, "L'équation de recherche est limitée à 4 000 caractères."),
    sources: z
      .array(z.enum(SEARCHABLE_SOURCES))
      .min(1, 'Choisissez au moins une source.')
      .max(SEARCHABLE_SOURCES.length),
    /** Résultats demandés à Google Scholar (facturés par Apify). */
    maxResults: z.number().int().min(1).default(20),
    /** PubMed : `null` ou absent = tout récupérer (jusqu'au plafond) ; sinon les N premiers. */
    pubmedMax: z.number().int().min(1).max(ESEARCH_WINDOW, `Au plus ${ESEARCH_WINDOW} premiers résultats : au-delà, récupérez-les tous.`).nullable().default(null),
    yearFrom: optionalYear,
    yearTo: optionalYear,
    sort: z.enum(['relevance', 'date']).default('relevance'),
  })
  .refine((v) => v.yearFrom === undefined || v.yearTo === undefined || v.yearFrom <= v.yearTo, {
    message: "L'année de début dépasse l'année de fin.",
    path: ['yearFrom'],
  });

type SearchInput = z.infer<typeof searchSchema>;

/** Une source interrogée : la passe est consignée avant l'appel, close après — en succès comme en échec. */
async function runSource(source: SearchableSource, input: SearchInput): Promise<BiblioSearch> {
  const started = Date.now();
  if (source === 'pubmed') {
    const searchId = createSearch({
      source,
      actor: EUTILS_SERVICE,
      query: input.query,
      yearFrom: input.yearFrom ?? null,
      yearTo: input.yearTo ?? null,
      maxResults: input.pubmedMax ?? 0,
      sort: input.sort,
    });
    try {
      const result = await searchPubmed(eutilsConfig(), {
        query: input.query,
        yearFrom: input.yearFrom,
        yearTo: input.yearTo,
        sort: input.sort,
        limit: input.pubmedMax,
      });
      const { added, duplicates } = addRefsFromSearch(searchId, result.refs);
      return finishSearch(searchId, {
        status: 'ok',
        returned: result.refs.length,
        skipped: result.skipped,
        added,
        duplicates,
        durationMs: Date.now() - started,
        totalCount: result.totalCount,
        queryTranslation: result.queryTranslation,
        warnings: result.warnings,
      });
    } catch (error) {
      return finishSearch(searchId, {
        status: 'error',
        error: error instanceof EutilsError ? error.message : unexpected(error),
        durationMs: Date.now() - started,
        totalCount: error instanceof EutilsError ? error.context.totalCount : null,
        queryTranslation: error instanceof EutilsError ? error.context.queryTranslation : null,
      });
    }
  }

  // Google Scholar ne comprend pas la syntaxe de PubMed : les balises de champ sont retirées, et la passe le dit.
  const cfg = apifyConfig();
  const sent = scholarQuery(input.query);
  const warnings =
    sent.removed.length > 0
      ? [
          `Balises de champ PubMed retirées pour Google Scholar, qui ne les comprend pas (${sent.removed.join(', ')}). Équation envoyée : « ${sent.query} ».`,
        ]
      : [];
  const searchId = createSearch({
    source,
    actor: actorFor(cfg, source),
    query: input.query,
    sentQuery: sent.query !== input.query ? sent.query : null,
    yearFrom: input.yearFrom ?? null,
    yearTo: input.yearTo ?? null,
    maxResults: input.maxResults,
    sort: input.sort,
  });
  try {
    if (sent.query.length < 2) {
      throw new ApifyError('config', 'Une fois les balises PubMed retirées, l’équation est vide : saisissez des mots-clés pour Google Scholar.');
    }
    const result = await searchSource(cfg, source, {
      query: sent.query,
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
      warnings,
    });
  } catch (error) {
    return finishSearch(searchId, {
      status: 'error',
      error: error instanceof ApifyError ? error.message : unexpected(error),
      durationMs: Date.now() - started,
      warnings,
    });
  }
}

const unexpected = (error: unknown) =>
  `Échec inattendu de la recherche (${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}).`;

/**
 * Lance une passe sur une ou deux sources, en parallèle.
 *
 * Une source en échec n'annule pas l'autre : sa recherche est enregistrée en
 * erreur, avec le message qui dit quoi corriger, et l'autre verse ses
 * références (réponse 201). Si TOUTES les sources échouent, la réponse est une
 * erreur (502, code `all_sources_failed`) — les passes en échec restent
 * consignées dans l'historique, et le détail les rend.
 */
biblioRouter.post(
  '/searches',
  asyncHandler(async (req, res) => {
    const apify = apifyConfig();
    const input = searchSchema.parse(req.body);
    const sources = [...new Set(input.sources)];
    if (sources.includes('scholar')) {
      if (input.maxResults > apify.maxResultsCap) {
        throw badRequest(
          `Au plus ${apify.maxResultsCap} résultats Google Scholar par passe (BIBLIO_MAX_RESULTS) : chaque résultat est facturé par Apify.`,
        );
      }
      if (!apify.token) throw conflict(NO_TOKEN_MESSAGE);
    }
    if (running) throw conflict('Une recherche est déjà en cours : attendez sa fin.');

    running = true;
    try {
      const searches = await Promise.all(sources.map((source) => runSource(source, input)));
      const body = { searches, counts: counts(), prisma: prisma() };
      if (searches.every((s) => s.status === 'error')) {
        const detail = searches.map((s) => `${SOURCE_LABELS[s.source]} : ${s.error ?? 'échec'}`).join(' — ');
        throw new HttpError(502, `La recherche a échoué. ${detail}`, body, 'all_sources_failed');
      }
      res.status(201).json(body);
    } finally {
      running = false;
    }
  }),
);

/* ───────────────────────────────── Imports ──────────────────────────────── */

const importSchema = z.object({
  source: z.enum(BIBLIO_SOURCES, { errorMap: () => ({ message: 'Choisissez la base d’où vient le fichier.' }) }),
  sourceLabel: z.string().trim().max(120, 'Le nom de la source est limité à 120 caractères.').optional(),
  format: z.enum([...IMPORT_FORMATS, 'auto']).default('auto'),
});

/** Le fichier reste en mémoire : il est lu d'un trait, puis oublié. Sa taille est bornée avant lecture. */
function receiveFile(req: Request, res: Response, next: NextFunction): void {
  const limit = importMaxBytes();
  multer({ storage: multer.memoryStorage(), limits: { fileSize: limit, files: 1, fields: 10 } }).single('file')(
    req,
    res,
    (error: unknown) => {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          next(
            new HttpError(
              413,
              `Fichier trop volumineux : au plus ${Math.round(limit / 1024 / 1024)} Mo par import (BIBLIO_IMPORT_MAX_MB). Découpez l’export en plusieurs fichiers.`,
            ),
          );
          return;
        }
        next(badRequest(error.code === 'LIMIT_FILE_COUNT' ? 'Un seul fichier par import.' : `Import refusé (${error.code}).`));
        return;
      }
      next(error as Error | undefined);
    },
  );
}

/** Nom affiché d'un fichier : sans chemin, sans caractère de contrôle ni marque de sens d'écriture. */
const displayName = (raw: string): string =>
  (raw.split(/[\\/]/).pop() ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .slice(0, 200) || 'fichier';

/**
 * Importe un export d'une autre base (RIS, MEDLINE/.nbib, BibTeX, CSV).
 *
 * L'import se consigne comme une recherche — source déclarée, fichier, date,
 * nombre de notices — et le diagramme de flux le compte dans la colonne de sa
 * source (base de données, registre, ou autres méthodes). Les notices passent
 * par le même dédoublonnage que les recherches. Un fichier illisible est
 * refusé (422) sans rien consigner : il n'a rien identifié.
 */
biblioRouter.post(
  '/imports',
  receiveFile,
  asyncHandler(async (req, res) => {
    const input = importSchema.parse(req.body ?? {});
    const file = req.file;
    if (!file || file.size === 0) throw badRequest('Choisissez un fichier à importer (RIS, nbib, BibTeX ou CSV).');
    const fileName = displayName(file.originalname);

    const started = Date.now();
    let parsed: ReturnType<typeof parseImport>;
    try {
      parsed = parseImport(file.buffer, fileName, input.source, input.format);
    } catch (error) {
      if (error instanceof ImportError) throw unprocessable(`${fileName} : ${error.message}`, undefined, 'import_unreadable');
      throw error;
    }
    if (parsed.refs.length === 0) {
      throw unprocessable(
        `${fileName} : aucune référence lisible (format lu : ${FORMAT_LABELS[parsed.format]}). Vérifiez que le fichier est bien un export de références, avec un titre par notice.`,
        undefined,
        'import_empty',
      );
    }

    const searchId = createSearch({
      kind: 'import',
      source: input.source,
      actor: FORMAT_LABELS[parsed.format],
      query: '',
      fileName,
      sourceLabel: input.sourceLabel || null,
      yearFrom: null,
      yearTo: null,
      maxResults: 0,
      sort: 'relevance',
    });
    const { added, duplicates } = addRefsFromSearch(searchId, parsed.refs);
    const search = finishSearch(searchId, {
      status: 'ok',
      returned: parsed.refs.length,
      skipped: parsed.skipped,
      added,
      duplicates,
      durationMs: Date.now() - started,
      warnings: parsed.warnings,
    });
    res.status(201).json({ search, counts: counts(), prisma: prisma() });
  }),
);

/* ─────────────────────────────── Références ─────────────────────────────── */

const listSchema = z.object({
  decision: z.enum(DECISIONS).optional(),
  source: z.enum([...BIBLIO_SOURCES, 'both']).optional(),
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
    // Au tri sur titre et résumé, le motif d'exclusion est facultatif (PRISMA 2020) : une exclusion sans motif
    // se compte sous « motif non précisé » dans le diagramme de flux.
    const updated = updateRefDecision(id, {
      decision: patch.decision,
      exclusionReason: patch.exclusionReason === undefined ? undefined : (patch.exclusionReason as typeof current.exclusionReason),
      note: patch.note,
    });
    res.json({ ref: updated, counts: counts(), prisma: prisma() });
  }),
);

/* ──────────────────────────────── Exports ───────────────────────────────── */

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
