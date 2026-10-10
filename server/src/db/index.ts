import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { dbPath, ensureDataDirs } from '../config.js';
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

function openDatabase(): { connection: DatabaseSync; migration: { from: number; to: number } } {
  try {
    ensureDataDirs();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    const opened = new DatabaseSync(dbPath);

    // WAL : les lectures ne bloquent pas l'écriture pendant l'import de documents.
    opened.exec('PRAGMA journal_mode = WAL');
    opened.exec('PRAGMA foreign_keys = ON');
    // Un second processus (sauvegarde, script de démonstration) qui touche la base au même
    // instant attend son tour au lieu d'échouer sur « database is locked ».
    opened.exec('PRAGMA busy_timeout = 5000');

    opened.exec(SCHEMA);
    return { connection: opened, migration: migrate(opened) };
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

const { connection, migration: appliedMigration } = openDatabase();

/** Évolution de la base appliquée au démarrage ({ from: 0, to: 0 } quand elle était déjà à jour). */
export const migration = appliedMigration;

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

/** Profondeur de transaction, pour imbriquer via SAVEPOINT sans conflit. */
let depth = 0;

export const db = {
  prepare(sql: string): Statement {
    return connection.prepare(sql) as unknown as Statement;
  },

  exec(sql: string): void {
    connection.exec(sql);
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
      const level = depth++;
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
        depth = level;
      }
    };
  },

  close(): void {
    connection.close();
  },
};

/**
 * Arrêt propre : ramène le journal (WAL) dans le fichier principal, puis ferme la base. Après cela, `research-tool.db`
 * contient à lui seul toutes les données — sans quoi un fichier copié sans son `-wal` aurait perdu les dernières écritures.
 */
export function closeDatabase(): void {
  try {
    connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* occupée par une sauvegarde en cours, ou déjà fermée : la fermeture ci-dessous fait le nécessaire */
  }
  try {
    connection.close();
  } catch {
    /* déjà fermée */
  }
}

/** Version du schéma de la base ouverte (voir `migrations.ts`). */
export function schemaVersion(): number {
  return currentVersion(connection);
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
