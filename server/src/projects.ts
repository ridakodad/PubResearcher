import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './config.js';
import {
  closeProjectStore,
  inProject,
  mainProject,
  onCloseDatabase,
  openProjectStore,
  type ProjectContext,
} from './db/index.js';

/**
 * Registre des projets de recherche (une étude = un projet).
 *
 * Le registre est un petit fichier `projects.json` à la racine des données : nom, description, date de création.
 * Chaque projet autre que le principal vit dans `projects/<identifiant>/` (sa base et ses fichiers) ; supprimer un
 * projet, c'est supprimer ce dossier. Le projet principal reste à la racine, là où une installation antérieure
 * à la 1.7 a ses données.
 */
export interface ProjectInfo {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
}

export const MAIN_PROJECT_ID = 'principal';
const registryPath = path.join(dataDir, 'projects.json');
export const projectsDir = path.join(dataDir, 'projects');
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

let registry: ProjectInfo[] = loadRegistry();
const opened = new Map<string, ProjectContext>([[MAIN_PROJECT_ID, mainProject]]);
/** Tâches de mise en route d'une base (fiche par défaut, reprise des passes interrompues…), fixées au démarrage. */
let initializer: (() => void) | null = null;

onCloseDatabase(() => {
  for (const [id, project] of opened) if (id !== MAIN_PROJECT_ID) closeProjectStore(project);
});

function loadRegistry(): ProjectInfo[] {
  let list: ProjectInfo[] = [];
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { projects?: unknown };
    if (Array.isArray(raw.projects)) {
      list = raw.projects.filter(
        (p): p is ProjectInfo =>
          typeof p === 'object' && p !== null && typeof (p as ProjectInfo).id === 'string' && ID_PATTERN.test((p as ProjectInfo).id) && typeof (p as ProjectInfo).name === 'string',
      );
    }
  } catch {
    /* pas encore de registre : seul le projet principal existe */
  }
  if (!list.some((p) => p.id === MAIN_PROJECT_ID)) {
    list.unshift({ id: MAIN_PROJECT_ID, name: 'Étude principale', description: null, createdAt: new Date().toISOString() });
  }
  return list;
}

function saveRegistry(): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${registryPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ projects: registry }, null, 2));
  fs.renameSync(tmp, registryPath);
}

function projectRoot(id: string): { dbPath: string; uploadsDir: string } {
  const dir = path.join(projectsDir, id);
  return { dbPath: path.join(dir, 'research-tool.db'), uploadsDir: path.join(dir, 'uploads') };
}

/** Fixe les tâches lancées à l'ouverture de chaque base, et les applique au projet principal. */
export function setProjectInitializer(fn: () => void): void {
  initializer = fn;
  inProject(mainProject, fn);
}

/** Ouvre tous les projets inscrits (au démarrage) ; un projet illisible est signalé, pas bloquant. */
export function openAllProjects(): string[] {
  const problems: string[] = [];
  for (const info of registry) {
    if (opened.has(info.id)) continue;
    try {
      openProject(info.id);
    } catch (error) {
      problems.push(`${info.name} (${info.id}) : ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

function openProject(id: string): ProjectContext {
  const existing = opened.get(id);
  if (existing) return existing;
  const project = openProjectStore(id, projectRoot(id));
  opened.set(id, project);
  if (initializer) inProject(project, initializer);
  return project;
}

/** Contexte d'un projet inscrit, ouvert à la demande ; `null` si l'identifiant est inconnu. */
export function getProject(id: string): ProjectContext | null {
  if (!registry.some((p) => p.id === id)) return null;
  return openProject(id);
}

export function listProjects(): ProjectInfo[] {
  return registry.map((p) => ({ ...p }));
}

export function getProjectInfo(id: string): ProjectInfo | null {
  const info = registry.find((p) => p.id === id);
  return info ? { ...info } : null;
}

/** Identifiant lisible tiré du nom (« Pneumopathies 2024 » → « pneumopathies-2024 »), rendu unique. */
function makeId(name: string): string {
  const base =
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'projet';
  let id = base === MAIN_PROJECT_ID ? `${base}-2` : base;
  while (registry.some((p) => p.id === id) || fs.existsSync(path.join(projectsDir, id))) {
    id = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  }
  return id;
}

export function createProject(input: { name: string; description?: string | null }): { info: ProjectInfo; context: ProjectContext } {
  const info: ProjectInfo = {
    id: makeId(input.name),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    createdAt: new Date().toISOString(),
  };
  const context = openProjectStore(info.id, projectRoot(info.id));
  opened.set(info.id, context);
  registry.push(info);
  saveRegistry();
  return { info, context };
}

/** Termine la mise en route d'un projet créé (après une éventuelle copie de fiche). */
export function initializeProject(context: ProjectContext): void {
  if (initializer) inProject(context, initializer);
}

export function updateProject(id: string, input: { name?: string; description?: string | null }): ProjectInfo | null {
  const info = registry.find((p) => p.id === id);
  if (!info) return null;
  if (input.name !== undefined) info.name = input.name.trim();
  if (input.description !== undefined) info.description = input.description?.trim() || null;
  saveRegistry();
  return { ...info };
}

/** Supprime un projet et tout son contenu (base, documents). Le projet principal ne se supprime pas. */
export function deleteProject(id: string): boolean {
  if (id === MAIN_PROJECT_ID) throw new Error('Le projet principal ne peut pas être supprimé.');
  const index = registry.findIndex((p) => p.id === id);
  if (index < 0) return false;
  const project = opened.get(id);
  if (project) {
    closeProjectStore(project);
    opened.delete(id);
  }
  registry.splice(index, 1);
  saveRegistry();
  const dir = path.join(projectsDir, id);
  // Garde-fou : on ne supprime qu'un dossier situé sous projects/.
  if (path.dirname(dir) === projectsDir && ID_PATTERN.test(id)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Pour les tests : relit le registre et oublie les projets ouverts (sauf le principal). */
export function resetProjectsForTests(): void {
  for (const [id, project] of opened) if (id !== MAIN_PROJECT_ID) closeProjectStore(project);
  opened.clear();
  opened.set(MAIN_PROJECT_ID, mainProject);
  registry = loadRegistry();
}
