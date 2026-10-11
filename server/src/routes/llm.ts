import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, intQuery, notFound } from '../lib/http.js';
import { KeyError, keyStore } from '../engine/api-key.js';
import { estimateExtraction, extractionModel, llmStatus } from '../engine/llm.js';
import { getActiveTemplate, getTemplate } from '../repo/templates.js';
import { listPatients } from '../repo/patients.js';
import { loadSourceDocs } from '../repo/documents.js';

/**
 * Clé d'API Anthropic de l'utilisateur, et coût prévisible d'une passe.
 *
 * L'utilisateur paie l'IA avec sa propre clé : il la saisit ici, elle est vérifiée auprès d'Anthropic puis enregistrée
 * sur cette machine (voir `engine/api-key.ts`). Aucune réponse ne contient la clé : seulement sa provenance et ses
 * quatre derniers caractères.
 */
export const llmRouter = Router();

const keySchema = z.object({ key: z.string().max(400) }).strict();

const statusBody = () => ({ ...keyStore.status(), model: extractionModel(), available: llmStatus().available });

llmRouter.get('/key', (_req, res) => {
  res.json(statusBody());
});

llmRouter.put(
  '/key',
  asyncHandler(async (req, res) => {
    const { key } = keySchema.parse(req.body ?? {});
    try {
      await keyStore.save(key, extractionModel());
    } catch (error) {
      if (error instanceof KeyError) throw new HttpError(error.status, keyStore.redact(error.message), undefined, 'api-key-refused');
      throw error;
    }
    console.log(`[pubresearcher] clé d'API Anthropic enregistrée (${keyStore.status().hint ?? '?'})`);
    res.json(statusBody());
  }),
);

llmRouter.delete('/key', (_req, res) => {
  keyStore.remove();
  console.log("[pubresearcher] clé d'API Anthropic retirée de l'application");
  res.json(statusBody());
});

/**
 * Fourchette de coût d'une passe par Claude sur tous les dossiers, pour la fiche donnée (ou la fiche active). Calculée
 * sur toutes les variables : en mode mixte, les règles en trouvent une partie, et la passe coûte moins.
 */
llmRouter.get(
  '/estimate',
  asyncHandler(async (req, res) => {
    const id = intQuery(req, 'templateId');
    const template = id ? getTemplate(id) : getActiveTemplate();
    if (!template) throw notFound("Aucune fiche d'exploitation disponible.");
    const patients = listPatients().map((p) => loadSourceDocs(p.id));
    res.json({ estimate: estimateExtraction(template.fields, template.name, patients) });
  }),
);
