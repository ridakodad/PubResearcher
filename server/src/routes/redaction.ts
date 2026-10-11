import { Router } from 'express';
import { z } from 'zod';
import { idNumber } from '../lib/schemas.js';
import { asyncHandler, notFound } from '../lib/http.js';
import { getActiveTemplate, getTemplate } from '../repo/templates.js';
import { buildDataset, buildFieldStats } from './analytics.js';
import { ChatError, chatAvailable, chatModel, streamReply, type CohortContext } from '../engine/chat.js';
import { costOf } from '../engine/pricing.js';

export const redactionRouter = Router();

const messageSchema = z.object({
  templateId: idNumber.optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().min(1).max(40_000),
      }),
    )
    .min(1)
    // Une conversation trop longue coûte cher et n'améliore rien : au-delà,
    // mieux vaut repartir d'un fil neuf.
    .max(60),
});

/**
 * Contexte transmis à l'assistant.
 *
 * Agrégats seulement : effectifs, distributions, définitions. Aucune ligne
 * patient ne quitte la machine pour cet usage — rédiger un article n'exige pas
 * de connaître les individus.
 */
function cohortContext(templateId: number | undefined): CohortContext {
  const template = templateId ? getTemplate(templateId) : getActiveTemplate();
  if (!template) throw notFound("Aucune fiche d'exploitation disponible.");

  const rows = buildDataset(template);
  const filled = rows.reduce((sum, row) => sum + row.filled, 0);
  const cells = rows.length * template.fields.length;

  return {
    template,
    patientCount: rows.length,
    completeness: cells > 0 ? Math.round((filled / cells) * 100) : 0,
    stats: buildFieldStats(template, rows),
  };
}

redactionRouter.get(
  '/redaction/status',
  asyncHandler(async (_req, res) => {
    res.json({ available: chatAvailable() });
  }),
);

/**
 * Échange avec l'assistant, diffusé au fil de sa production.
 *
 * Une section « Résultats » fait plusieurs milliers de caractères : attendre la
 * réponse entière donnerait une impression de blocage, et une requête longue
 * s'expose à expirer. Le flux est encodé en « événements côté serveur », que le
 * navigateur sait lire sans bibliothèque.
 */
redactionRouter.post(
  '/redaction/message',
  asyncHandler(async (req, res) => {
    const { templateId, messages } = messageSchema.parse(req.body);
    const context = cohortContext(templateId);

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Un intermédiaire qui tamponnerait la réponse annulerait tout l'intérêt
    // du flux : la réponse arriverait d'un bloc.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    /*
     * Le client peut fermer l'onglet en cours de rédaction : inutile de
     * continuer à écrire dans une réponse que plus personne ne lit.
     *
     * L'écoute porte sur la *réponse*, jamais sur la requête. Sur un POST,
     * `req` émet « close » dès que son corps a fini d'être lu — c'est-à-dire
     * immédiatement — et le drapeau serait levé avant la première écriture :
     * le flux partirait vide, sans la moindre erreur visible.
     */
    let closed = false;
    res.on('close', () => {
      closed = true;
    });

    try {
      const usage = await streamReply(context, messages, (text) => {
        if (!closed) send('delta', { text });
      });
      if (!closed) send('done', { usage, costUsd: costOf(chatModel(), usage) });
    } catch (error) {
      const message =
        error instanceof ChatError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      // L'en-tête est déjà parti : l'erreur ne peut plus être un code HTTP,
      // elle voyage donc dans le flux lui-même.
      if (!closed) send('error', { message });
    } finally {
      res.end();
    }
  }),
);
