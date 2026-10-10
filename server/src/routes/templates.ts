import { Router } from 'express';
import { asyncHandler, badRequest, intParam, notFound } from '../lib/http.js';
import {
  fieldInputSchema,
  fieldUpdateSchema,
  reorderSchema,
  templateDuplicateSchema,
  templateImportSchema,
  templateInputSchema,
  templateUpdateSchema,
  testRuleSchema,
} from '../lib/schemas.js';
import {
  createField,
  createTemplate,
  deleteField,
  deleteTemplate,
  duplicateTemplate,
  getActiveTemplate,
  getField,
  getTemplate,
  listTemplates,
  reorderFields,
  setActiveTemplate,
  updateField,
  updateTemplate,
  type FieldInput,
} from '../repo/templates.js';
import { loadSourceDocs } from '../repo/documents.js';
import { db } from '../db/index.js';
import { extractFieldDetailed, type SourceDoc } from '../engine/rules.js';
import type { TemplateField } from '../domain/types.js';

export const templatesRouter = Router();

templatesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ templates: listTemplates(), active: getActiveTemplate() });
  }),
);

templatesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = templateInputSchema.parse(req.body);
    const template = createTemplate(input);
    res.status(201).json({ template: getTemplate(template.id) });
  }),
);

templatesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const template = getTemplate(intParam(req, 'id'));
    if (!template) throw notFound("Fiche d'exploitation introuvable.");
    res.json({ template });
  }),
);

templatesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = intParam(req, 'id');
    const input = templateUpdateSchema.parse(req.body);
    if (!updateTemplate(id, input)) throw notFound("Fiche d'exploitation introuvable.");
    if (input.isActive) setActiveTemplate(id);
    res.json({ template: getTemplate(id) });
  }),
);

templatesRouter.post(
  '/:id/activate',
  asyncHandler(async (req, res) => {
    const id = intParam(req, 'id');
    if (!getTemplate(id)) throw notFound("Fiche d'exploitation introuvable.");
    setActiveTemplate(id);
    res.json({ template: getTemplate(id) });
  }),
);

/** Duplique une fiche : permet de la faire évoluer sans toucher aux données déjà saisies. */
templatesRouter.post(
  '/:id/duplicate',
  asyncHandler(async (req, res) => {
    const id = intParam(req, 'id');
    const { name: given } = templateDuplicateSchema.parse(req.body ?? {});
    const name = given || `${getTemplate(id)?.name ?? 'Fiche'} (copie)`.slice(0, 200);
    const copy = duplicateTemplate(id, name);
    if (!copy) throw notFound("Fiche d'exploitation introuvable.");
    res.status(201).json({ template: copy });
  }),
);

templatesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = intParam(req, 'id');
    if (listTemplates().length <= 1) {
      throw badRequest("Impossible de supprimer la dernière fiche d'exploitation.");
    }
    if (!deleteTemplate(id)) throw notFound("Fiche d'exploitation introuvable.");
    res.status(204).end();
  }),
);

/**
 * Importe une fiche exportée en JSON.
 * Permet de partager un paramétrage entre postes ou entre études.
 */
templatesRouter.post(
  '/import',
  asyncHandler(async (req, res) => {
    const payload = templateImportSchema.parse(req.body);

    // Tout est vérifié avant la première écriture : une fiche importée est créée en entier ou pas du tout.
    // Une erreur au milieu laissait auparavant une fiche amputée dans la liste, à côté de l'erreur affichée.
    const seen = new Set<string>();
    for (const field of payload.fields) {
      validateOptions(field as FieldInput);
      if (seen.has(field.key)) {
        throw badRequest(`Deux variables portent la clé « ${field.key} » : chaque clé doit être unique dans la fiche.`);
      }
      seen.add(field.key);
    }

    const created = db.transaction(() => {
      const template = createTemplate({ name: payload.name, description: payload.description ?? null });
      for (const [index, field] of payload.fields.entries()) {
        createField(template.id, { ...(field as FieldInput), position: index });
      }
      return template;
    })();
    res.status(201).json({ template: getTemplate(created.id) });
  }),
);

// ------------------------------------------------------------------ variables

templatesRouter.post(
  '/:id/fields',
  asyncHandler(async (req, res) => {
    const templateId = intParam(req, 'id');
    if (!getTemplate(templateId)) throw notFound("Fiche d'exploitation introuvable.");
    const input = fieldInputSchema.parse(req.body) as FieldInput;
    validateOptions(input);
    res.status(201).json({ field: createField(templateId, input) });
  }),
);

templatesRouter.patch(
  '/fields/:fieldId',
  asyncHandler(async (req, res) => {
    const fieldId = intParam(req, 'fieldId');
    const current = getField(fieldId);
    if (!current) throw notFound('Variable introuvable.');
    const input = fieldUpdateSchema.parse(req.body) as Partial<FieldInput>;
    validateOptions({ ...current, ...input } as FieldInput);
    res.json({ field: updateField(fieldId, input) });
  }),
);

templatesRouter.delete(
  '/fields/:fieldId',
  asyncHandler(async (req, res) => {
    if (!deleteField(intParam(req, 'fieldId'))) throw notFound('Variable introuvable.');
    res.status(204).end();
  }),
);

templatesRouter.post(
  '/:id/fields/reorder',
  asyncHandler(async (req, res) => {
    const templateId = intParam(req, 'id');
    const { fieldIds } = reorderSchema.parse(req.body);
    reorderFields(templateId, fieldIds);
    res.json({ template: getTemplate(templateId) });
  }),
);

/**
 * Teste les règles d'une variable sans rien enregistrer.
 * Le paramétrage d'une fiche est itératif : ce banc d'essai montre
 * immédiatement ce que la règle capture, et dans quel document.
 */
templatesRouter.post(
  '/fields/test',
  asyncHandler(async (req, res) => {
    const { field, patientId, sampleText } = testRuleSchema.parse(req.body);
    validateOptions(field as FieldInput);

    const docs: SourceDoc[] = [];
    if (sampleText && sampleText.trim().length > 0) {
      docs.push({ id: 0, name: 'Texte de test', kind: 'text', text: sampleText, dicomTags: {} });
    }
    if (patientId) docs.push(...loadSourceDocs(patientId));

    if (docs.length === 0) {
      throw badRequest('Fournissez un texte de test ou sélectionnez un dossier patient.');
    }

    // Variable éphémère : jamais persistée, uniquement évaluée.
    const probe: TemplateField = {
      id: -1,
      templateId: -1,
      key: field.key,
      label: field.label,
      type: field.type as TemplateField['type'],
      section: field.section ?? 'Test',
      unit: field.unit ?? null,
      description: field.description ?? null,
      required: field.required ?? false,
      options: field.options ?? [],
      position: 0,
      extraction: field.extraction ?? { enabled: true, rules: [] },
    };

    const { hit, rejected } = extractFieldDetailed(probe, docs);
    res.json({
      found: hit !== null,
      value: hit?.value ?? null,
      confidence: hit?.confidence ?? null,
      evidence: hit?.evidence ?? null,
      // Valeurs trouvées mais inutilisables : sans elles, « rien trouvé » ne dit pas si la
      // règle a manqué sa cible ou si c'est la valeur qui a été refusée (« < 5 », hors bornes).
      rejected,
      documentsTested: docs.length,
    });
  }),
);

/** Une variable à choix impose une liste d'options non vide. */
function validateOptions(field: FieldInput): void {
  if ((field.type === 'enum' || field.type === 'multi') && (field.options ?? []).length === 0) {
    throw badRequest(
      `La variable « ${field.label} » est de type « ${field.type === 'enum' ? 'choix unique' : 'choix multiple'} » : renseignez au moins une option.`,
    );
  }
}
