import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { inProject, type ProjectContext } from '../db/index.js';
import { getProject, MAIN_PROJECT_ID } from '../projects.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Projet de recherche visé par la requête (en-tête `X-Project`, `?project=`, ou témoin pour les téléchargements). */
    project?: ProjectContext;
  }
}

/** Rattache la requête à son projet ; un projet inconnu est refusé plutôt que remplacé par le principal. */
export function projectScope(req: Request, res: Response, next: NextFunction): void {
  const header = req.get('x-project');
  const query = typeof req.query.project === 'string' ? req.query.project : undefined;
  // Les liens de téléchargement (exports, documents) ne portent pas d'en-tête : le projet choisi y est lu dans un
  // témoin posé par l'interface.
  const cookie = /(?:^|;\s*)pubresearcher_project=([a-z0-9-]{1,63})(?:;|$)/.exec(req.get('cookie') ?? '')?.[1];
  const id = (header ?? query ?? cookie ?? MAIN_PROJECT_ID).trim() || MAIN_PROJECT_ID;
  const project = getProject(id);
  if (!project) {
    res.status(404).json({ error: 'Projet introuvable : il a peut-être été supprimé. Choisissez un autre projet.', code: 'PROJECT_NOT_FOUND' });
    return;
  }
  req.project = project;
  inProject(project, next);
}

/**
 * Remet la requête dans son projet après un intergiciel à rappel (multer). La lecture du corps se termine dans un
 * événement du flux réseau ; Node y conserve aujourd'hui le contexte (vérifié par test/projects.test.ts), mais
 * c'est par précaution qu'on le rétablit : s'il se perdait, la suite écrirait dans le projet principal.
 */
export function keepProject(handler: RequestHandler): RequestHandler {
  return (req, res, next) =>
    handler(req, res, (error?: unknown) => {
      if (req.project) inProject(req.project, () => next(error));
      else next(error);
    });
}

/** Projet de la requête (le principal hors portée, pour les tests directs des routeurs). */
export function projectOf(req: Request): ProjectContext {
  return req.project ?? getProject(MAIN_PROJECT_ID)!;
}
