import { Router } from 'express';
import { z } from 'zod';
import { db, inProject } from '../db/index.js';
import { asyncHandler, badRequest, notFound } from '../lib/http.js';
import {
  createProject,
  deleteProject,
  getProject,
  getProjectInfo,
  initializeProject,
  listProjects,
  MAIN_PROJECT_ID,
  updateProject,
} from '../projects.js';
import { createField, createTemplate, getActiveTemplate, setActiveTemplate } from '../repo/templates.js';

/**
 * Projets de recherche : une étude = un projet, avec sa propre base (patients, fiche, extraction, bibliographie,
 * rédaction). Ces routes ne dépendent pas du projet de la requête.
 */
export const projectsRouter = Router();

const nameSchema = z.string().trim().min(1, 'Donnez un nom au projet.').max(120, 'Nom trop long (120 caractères au plus).');
const createSchema = z.object({
  name: nameSchema,
  description: z.string().max(2000).nullish(),
  /** Reprendre la fiche d'exploitation active d'un autre projet, au lieu de la fiche générale par défaut. */
  copyTemplateFrom: z.string().nullish(),
});
const updateSchema = z.object({ name: nameSchema.optional(), description: z.string().max(2000).nullish() });

/** Quelques chiffres pour reconnaître un projet dans la liste. */
function summary(id: string) {
  const project = getProject(id);
  if (!project) return null;
  return inProject(project, () => {
    const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      patients: count('SELECT COUNT(*) AS n FROM patients'),
      documents: count('SELECT COUNT(*) AS n FROM documents'),
      references: count('SELECT COUNT(*) AS n FROM biblio_refs'),
      template: getActiveTemplate()?.name ?? null,
    };
  });
}

projectsRouter.get('/', (_req, res) => {
  res.json(listProjects().map((p) => ({ ...p, isMain: p.id === MAIN_PROJECT_ID, stats: summary(p.id) })));
});

projectsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const input = createSchema.parse(req.body);
    let source: ReturnType<typeof getActiveTemplate> = null;
    if (input.copyTemplateFrom) {
      const from = getProject(input.copyTemplateFrom);
      if (!from) throw badRequest('Projet source introuvable pour la copie de la fiche.');
      source = inProject(from, () => getActiveTemplate());
    }
    const { info, context } = createProject({ name: input.name, description: input.description });
    if (source) {
      const template = source;
      inProject(context, () =>
        db.transaction(() => {
          const copy = createTemplate({ name: template.name, description: template.description });
          for (const field of template.fields) {
            createField(copy.id, {
              key: field.key,
              label: field.label,
              type: field.type,
              section: field.section,
              unit: field.unit,
              description: field.description,
              required: field.required,
              options: field.options,
              position: field.position,
              extraction: field.extraction,
            });
          }
          setActiveTemplate(copy.id);
        })(),
      );
    }
    initializeProject(context);
    res.status(201).json({ ...info, isMain: false, stats: summary(info.id) });
  }),
);

projectsRouter.patch('/:id', (req, res) => {
  const input = updateSchema.parse(req.body);
  const info = updateProject(req.params.id, input);
  if (!info) throw notFound('Projet introuvable.');
  res.json({ ...info, isMain: info.id === MAIN_PROJECT_ID, stats: summary(info.id) });
});

/** Suppression définitive : le nom exact du projet doit être recopié (`confirmName`). */
projectsRouter.delete('/:id', (req, res) => {
  const info = getProjectInfo(req.params.id);
  if (!info) throw notFound('Projet introuvable.');
  if (info.id === MAIN_PROJECT_ID) throw badRequest('Le projet principal ne peut pas être supprimé.');
  const confirm = typeof req.body?.confirmName === 'string' ? req.body.confirmName.trim() : '';
  if (confirm !== info.name) throw badRequest('Recopiez le nom exact du projet pour confirmer la suppression.', undefined, 'CONFIRM_NAME');
  deleteProject(info.id);
  res.status(204).end();
});
