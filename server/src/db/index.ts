import { DatabaseSync } from 'node:sqlite';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import fs from 'node:fs';
import { dbPath, ensureDataDirs, uploadsDir } from '../config.js';
import { SCHEMA } from './schema.js';
import { currentVersion, migrate } from './migrations.js';
import { fatalStartup } from '../lib/startup-error.js';

/**
 * Couche base de données, adossée au module SQLite intégré à Node.
 *
 * Aucune dépendance native n'est utilisée : les modules compilés
 * (`better-sqlite3` et consorts) exigent une chaîne de compilation C++ dès
 * qu'aucun binaire précompilé ne correspond à la version de Node installée —
 * ce qui bloque l'installation sous Windows en réclamant Visual Studio.
 * `node:sqlite` supprime ce problème sur toutes les plateformes.
 *
 * L'adaptateur ci-dessous expose la surface minimale utilisée par les dépôts
 * (`prepare`, `exec`, `transaction`, `close`), y compris les transactions que
 * `node:sqlite` ne fournit pas.
 */

/**
 * Une base par projet de recherche.
 *
 * Chaque étude a sa propre base SQLite et son propre dossier de fichiers : deux études ne partagent ni patients, ni
 * fiche, ni bibliographie, et un projet se sauvegarde, s'archive ou se supprime d'un bloc. Le projet « principal »
 * est l'emplacement historique (`research-tool.db` et `uploads/` à la racine des données) : une installation
 * existante le retrouve tel quel.
 *
 * Le projet d'une requête est porté par un contexte asynchrone (`AsyncLocalStorage`) : les dépôts appellent `db`
 * sans savoir de quel projet il s'agit, et les tâches lancées par la requête (extraction, recherche PubMed) gardent
 * ce projet jusqu'au bout. Hors requête (démarrage, scripts, tests), c'est le projet principal.
 */
export interface ProjectContext {
  id: string;
  dbPath: string;
  uploadsDir: string;
  incomingDir: string;
  importsDir: string;
  connection: DatabaseSync;
  migration: { from: number; to: number };
  /** Profondeur de transaction, pour imbriquer via SAVEPOINT sans conflit. */
  depth: number;
}

/** Ouvre (ou crée) la base d'un projet et ses dossiers. Lève une erreur si la base est illisible. */
export function openProjectStore(id: string, root: { dbPath: string; uploadsDir: string }): ProjectContext {
  const incoming = path.join(root.uploadsDir, '.incoming');
  fs.mkdirSync(incoming, { recursive: true });
  fs.mkdirSync(path.dirname(root.dbPath), { recursive: true });
  const opened = new DatabaseSync(root.dbPath);
  try {
    // WAL : les lectures ne bloquent pas l'écriture pendant l'import de documents.
    opened.exec('PRAGMA journal_mode = WAL');
    opened.exec('PRAGMA foreign_keys = ON');
    // Un second processus (sauvegarde, script de démonstration) qui touche la base au même
    // instant attend son tour au lieu d'échouer sur « database is locked ».
    opened.exec('PRAGMA busy_timeout = 5000');
    opened.exec(SCHEMA);
    const migration = migrate(opened);
    return {
      id,
      dbPath: root.dbPath,
      uploadsDir: root.uploadsDir,
      incomingDir: incoming,
      importsDir: path.join(root.uploadsDir, 'imports'),
      connection: opened,
      migration,
      depth: 0,
    };
  } catch (error) {
    try {
      opened.close();
    } catch {
      /* déjà fermée */
    }
    throw error;
  }
}

function openMainProject(): ProjectContext {
  try {
    ensureDataDirs();
    return openProjectStore('principal', { dbPath, uploadsDir });
  } catch (error) {
    // Une base plus récente que l'outil porte déjà son message (voir `migrate`) : on le garde tel quel.
    if (error instanceof Error && /plus récente que cette version/.test(error.message)) {
      fatalStartup(`Base de données refusée : ${dbPath}`, new Error(error.message), 'Mettez l’outil à jour avant de l’ouvrir, ou utilisez la base d’origine.');
    }
    return fatalStartup(
      `La base de données n’a pas pu être ouverte : ${dbPath}`,
      error,
      'Vérifiez DATA_DIR et DB_PATH. Si la base est abîmée, restaurez une sauvegarde : npm run restore --workspace server -- <dossier de sauvegarde>.',
    );
  }
}

/** Le projet principal, ouvert au chargement du module. */
export const mainProject = openMainProject();

const scope = new AsyncLocalStorage<ProjectContext>();

/** Projet en cours : celui de la requête, sinon le projet principal. */
export function currentProject(): ProjectContext {
  return scope.getStore() ?? mainProject;
}

/** Exécute `fn` dans le projet donné (et tout ce qu'elle lance de façon asynchrone). */
export function inProject<T>(project: ProjectContext, fn: () => T): T {
  return scope.run(project, fn);
}

/** Évolution de la base principale appliquée au démarrage ({ from: 0, to: 0 } quand elle était déjà à jour). */
export const migration = mainProject.migration;

/** Résultat d'une écriture. */
export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Requête préparée. Les valeurs sortent en `unknown` : les dépôts les typent. */
export interface Statement {
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

/** Requêtes préparées, une fois par base et par texte SQL. */
const prepared = new WeakMap<DatabaseSync, Map<string, Statement>>();

function statementFor(sql: string): Statement {
  const connection = currentProject().connection;
  let cache = prepared.get(connection);
  if (!cache) {
    cache = new Map();
    prepared.set(connection, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = connection.prepare(sql) as unknown as Statement;
    cache.set(sql, statement);
  }
  return statement;
}

export const db = {
  /**
   * Requête préparée qui s'exécute toujours dans le projet en cours **au moment de l'appel**.
   *
   * Plusieurs dépôts préparent leurs requêtes une fois, au chargement du module. Liée à la connexion de ce
   * moment-là, une telle requête écrirait à jamais dans le projet principal, quel que soit le projet de la requête
   * (défaut corrigé en 1.7.1). La base est donc résolue à chaque exécution, et la requête réelle mise en cache par base.
   */
  prepare(sql: string): Statement {
    // Préparée tout de suite dans la base en cours : une erreur de syntaxe se voit au même endroit qu'avant.
    statementFor(sql);
    return {
      run: (...params: unknown[]) => statementFor(sql).run(...params),
      get: (...params: unknown[]) => statementFor(sql).get(...params),
      all: (...params: unknown[]) => statementFor(sql).all(...params),
    };
  },

  exec(sql: string): void {
    currentProject().connection.exec(sql);
  },

  /**
   * Enveloppe une fonction dans une transaction et renvoie une fonction de
   * même signature — reprend le comportement attendu par les dépôts.
   *
   * Les appels imbriqués utilisent un point de sauvegarde : une transaction
   * interne qui échoue n'annule que sa propre portion.
   */
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const project = currentProject();
      const connection = project.connection;
      const level = project.depth++;
      const savepoint = `sp_${level}`;
      connection.exec(level === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
      try {
        const result = fn(...args);
        connection.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        // Une annulation qui échoue ne doit pas masquer l'erreur d'origine.
        try {
          connection.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}`);
        } catch {
          /* connexion déjà interrompue */
        }
        throw error;
      } finally {
        project.depth = level;
      }
    };
  },

  close(): void {
    currentProject().connection.close();
  },
};

/** Ramène le journal (WAL) d'une base dans son fichier principal, puis la ferme. */
export function closeProjectStore(project: ProjectContext): void {
  try {
    project.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* occupée par une sauvegarde en cours, ou déjà fermée : la fermeture ci-dessous fait le nécessaire */
  }
  try {
    project.connection.close();
  } catch {
    /* déjà fermée */
  }
}

const closeHooks: (() => void)[] = [];
/** Les autres projets ouverts (registre des projets) se ferment avec la base principale. */
export function onCloseDatabase(hook: () => void): void {
  closeHooks.push(hook);
}

/**
 * Arrêt propre : ramène le journal (WAL) dans le fichier principal, puis ferme les bases. Après cela, chaque
 * `research-tool.db` contient à lui seul toutes ses données — sans quoi un fichier copié sans son `-wal` aurait perdu
 * les dernières écritures.
 */
export function closeDatabase(): void {
  for (const hook of closeHooks) hook();
  closeProjectStore(mainProject);
}

/** Version du schéma de la base ouverte (voir `migrations.ts`). */
export function schemaVersion(): number {
  return currentVersion(currentProject().connection);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Parse une colonne JSON en tolérant les valeurs nulles ou corrompues. */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
