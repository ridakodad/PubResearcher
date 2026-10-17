import { Router } from 'express';
import { z } from 'zod';
import { STUDY_TYPES, buildStrategy, countEquation, type StudyType } from '../biblio/query-builder.js';
import { asyncHandler } from '../lib/http.js';

/**
 * Assistant de recherche en langage naturel (voir `biblio/query-builder.ts`).
 *
 * - `POST /build` : question → stratégie (PICO, concepts, équation, nombres PubMed, avertissements). Rien n'est
 *   écrit : l'utilisateur relit l'équation, puis lance la recherche par `POST /api/biblio/searches`, avec la
 *   question et la stratégie, que le journal de recherche consigne.
 * - `POST /count` : recompte une équation retouchée à la main (et ses blocs).
 */
export const biblioAssistantRouter = Router();

const optionalYear = z.number().int().min(1800).max(2200).optional();

const buildSchema = z
  .object({
    question: z.string().trim().min(5, 'Décrivez votre question de recherche.').max(2000, 'La question est limitée à 2 000 caractères.'),
    lang: z.enum(['fr', 'en']).optional(),
    yearFrom: optionalYear,
    yearTo: optionalYear,
    studyTypes: z.array(z.enum(STUDY_TYPES as [StudyType, ...StudyType[]])).max(STUDY_TYPES.length).optional(),
  })
  .refine((v) => v.yearFrom === undefined || v.yearTo === undefined || v.yearFrom <= v.yearTo, {
    message: "L'année de début dépasse l'année de fin.",
    path: ['yearFrom'],
  });

biblioAssistantRouter.post(
  '/build',
  asyncHandler(async (req, res) => {
    const input = buildSchema.parse(req.body ?? {});
    res.json(await buildStrategy(input));
  }),
);

const countSchema = z.object({
  equation: z.string().trim().min(2, 'Équation vide.').max(4000, "L'équation de recherche est limitée à 4 000 caractères."),
  blocks: z
    .array(z.object({ name: z.string().max(200), block: z.string().trim().min(1).max(4000) }))
    .max(8)
    .default([]),
  yearFrom: optionalYear,
  yearTo: optionalYear,
});

biblioAssistantRouter.post(
  '/count',
  asyncHandler(async (req, res) => {
    const input = countSchema.parse(req.body ?? {});
    res.json(await countEquation(input.equation, input.blocks, { yearFrom: input.yearFrom, yearTo: input.yearTo }));
  }),
);
