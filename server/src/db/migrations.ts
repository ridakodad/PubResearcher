import type { DatabaseSync } from 'node:sqlite';

/**
 * Évolutions du schéma, appliquées dans l'ordre et une seule fois.
 *
 * `schema.ts` décrit l'état de départ (version 0) : ses instructions sont
 * idempotentes et créent la base d'un poste neuf. Tout ce qui s'y ajoute ensuite
 * passe par ici, car `ALTER TABLE ... ADD COLUMN` ne se rejoue pas. La version
 * appliquée est consignée dans `PRAGMA user_version`, ce qui permet à une base
 * créée par une version antérieure de l'outil de monter d'elle-même, sans
 * script ni perte de données.
 *
 * Règle d'écriture : une migration ne retire et ne renomme jamais rien. Une
 * base migrée doit rester lisible par la version précédente de l'outil, le temps
 * qu'un poste revienne en arrière.
 */

export interface Migration {
  version: number;
  name: string;
  up(connection: DatabaseSync): void;
}

const hasColumn = (connection: DatabaseSync, table: string, column: string): boolean =>
  (connection.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'Traçabilité des valeurs et journal des passes',
    up(connection) {
      /*
       * Une valeur relue garde la trace de ce que la machine avait proposé :
       * c'est ce qui permet de dire, plus tard, combien de valeurs extraites ont
       * été confirmées, corrigées ou vidées — la mesure de fiabilité qu'une
       * méthode d'extraction doit rapporter.
       */
      if (!hasColumn(connection, 'record_values', 'origin_source')) {
        connection.exec('ALTER TABLE record_values ADD COLUMN origin_source TEXT');
      }
      if (!hasColumn(connection, 'record_values', 'origin_value')) {
        connection.exec('ALTER TABLE record_values ADD COLUMN origin_value TEXT');
      }
      if (!hasColumn(connection, 'record_values', 'reviewed_at')) {
        connection.exec('ALTER TABLE record_values ADD COLUMN reviewed_at TEXT');
      }

      connection.exec(`
        -- Une ligne par passe d'extraction : quelle fiche (empreinte), quel mode, quel modèle, quand.
        CREATE TABLE IF NOT EXISTS extraction_runs (
          id                   INTEGER PRIMARY KEY AUTOINCREMENT,
          template_id          INTEGER REFERENCES templates(id) ON DELETE SET NULL,
          template_name        TEXT NOT NULL,
          template_fingerprint TEXT NOT NULL,
          mode                 TEXT NOT NULL,
          model                TEXT,
          overwrite_manual     INTEGER NOT NULL DEFAULT 0,
          app_version          TEXT NOT NULL,
          started_at           TEXT NOT NULL,
          finished_at          TEXT,
          status               TEXT NOT NULL DEFAULT 'running',
          patients             INTEGER NOT NULL DEFAULT 0,
          documents            INTEGER NOT NULL DEFAULT 0,
          extracted            INTEGER NOT NULL DEFAULT 0,
          not_found            INTEGER NOT NULL DEFAULT 0,
          kept_manual          INTEGER NOT NULL DEFAULT 0,
          rejected             INTEGER NOT NULL DEFAULT 0
        );

        -- Journal des changements de valeur. On n'y écrit qu'à la suite : aucune fonction ne modifie un événement. Il disparaît avec le dossier, la variable ou la fiche auxquels il se rapporte (suppression en cascade : effacer un dossier efface ses données, historique compris).
        CREATE TABLE IF NOT EXISTS value_events (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          record_id  INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
          field_id   INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
          at         TEXT NOT NULL,
          action     TEXT NOT NULL,
          old_value  TEXT,
          old_source TEXT,
          new_value  TEXT,
          new_source TEXT,
          run_id     INTEGER REFERENCES extraction_runs(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_value_events_record ON value_events(record_id, field_id, id);
        CREATE INDEX IF NOT EXISTS idx_value_events_run ON value_events(run_id);
      `);
    },
  },
];

/** Version la plus récente que ce code sait produire. */
export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

export function currentVersion(connection: DatabaseSync): number {
  const row = connection.prepare('PRAGMA user_version').get() as { user_version: number };
  return Number(row.user_version);
}

/**
 * Applique les migrations manquantes, chacune dans sa transaction.
 * Refuse une base plus récente que le code : l'ouvrir risquerait de l'abîmer.
 */
export function migrate(connection: DatabaseSync): { from: number; to: number } {
  const from = currentVersion(connection);
  if (from > LATEST_VERSION) {
    throw new Error(
      `La base de données est en version ${from}, plus récente que cette version de l'outil (${LATEST_VERSION}). ` +
        `Mettez l'outil à jour avant de l'ouvrir : une version plus ancienne pourrait l'abîmer.`,
    );
  }
  let version = from;
  for (const migration of MIGRATIONS) {
    if (migration.version <= version) continue;
    connection.exec('BEGIN');
    try {
      migration.up(connection);
      connection.exec(`PRAGMA user_version = ${migration.version}`);
      connection.exec('COMMIT');
    } catch (error) {
      try {
        connection.exec('ROLLBACK');
      } catch {
        /* connexion déjà interrompue */
      }
      throw new Error(
        `Mise à jour de la base impossible (étape ${migration.version} : ${migration.name}) : ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
    version = migration.version;
  }
  return { from, to: version };
}
