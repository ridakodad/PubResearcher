/**
 * Schéma SQLite. Exécuté à chaque démarrage : toutes les instructions sont
 * idempotentes (`IF NOT EXISTS`).
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS patients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  label       TEXT,
  notes       TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  patient_id    INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  stored_name   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  mime          TEXT NOT NULL,
  size          INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  parse_status  TEXT NOT NULL DEFAULT 'pending',
  parse_error   TEXT,
  text_content  TEXT NOT NULL DEFAULT '',
  metadata      TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_patient ON documents(patient_id);
-- Un même fichier ne peut être importé deux fois pour un même patient.
CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_dedup ON documents(patient_id, sha256);

CREATE TABLE IF NOT EXISTS templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fields (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  label       TEXT NOT NULL,
  type        TEXT NOT NULL,
  section     TEXT NOT NULL DEFAULT 'Général',
  unit        TEXT,
  description TEXT,
  required    INTEGER NOT NULL DEFAULT 0,
  options     TEXT NOT NULL DEFAULT '[]',
  position    INTEGER NOT NULL DEFAULT 0,
  extraction  TEXT NOT NULL DEFAULT '{"enabled":true,"rules":[]}'
);
CREATE INDEX IF NOT EXISTS idx_fields_template ON fields(template_id, position);
CREATE UNIQUE INDEX IF NOT EXISTS idx_fields_key ON fields(template_id, key);

CREATE TABLE IF NOT EXISTS records (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id       INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  patient_id        INTEGER NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  last_extraction_at TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_records_unique ON records(template_id, patient_id);

CREATE TABLE IF NOT EXISTS record_values (
  record_id  INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  field_id   INTEGER NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
  value      TEXT,
  source     TEXT NOT NULL DEFAULT 'empty',
  confidence REAL,
  evidence   TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (record_id, field_id)
);
-- Revue bibliographique : chaque interrogation d'une source est conservée avec
-- sa chaîne exacte et sa date — c'est ce qui rend la recherche reproductible.
CREATE TABLE IF NOT EXISTS biblio_searches (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,
  actor        TEXT NOT NULL,
  query        TEXT NOT NULL,
  year_from    INTEGER,
  year_to      INTEGER,
  max_results  INTEGER NOT NULL,
  sort         TEXT NOT NULL DEFAULT 'relevance',
  status       TEXT NOT NULL DEFAULT 'running',
  error        TEXT,
  returned     INTEGER NOT NULL DEFAULT 0,
  skipped      INTEGER NOT NULL DEFAULT 0,
  added        INTEGER NOT NULL DEFAULT 0,
  duplicates   INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER,
  queried_at   TEXT NOT NULL
);

-- Une ligne par article, quelle que soit la source qui l'a rendu.
CREATE TABLE IF NOT EXISTS biblio_refs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  norm_title        TEXT NOT NULL,
  title_truncated   INTEGER NOT NULL DEFAULT 0,
  title             TEXT NOT NULL,
  authors           TEXT NOT NULL DEFAULT '[]',
  year              INTEGER,
  journal           TEXT,
  volume            TEXT,
  issue             TEXT,
  pages             TEXT,
  doi               TEXT,
  pmid              TEXT,
  pmcid             TEXT,
  url               TEXT,
  pdf_url           TEXT,
  abstract          TEXT,
  snippet           TEXT,
  keywords          TEXT NOT NULL DEFAULT '[]',
  mesh_terms        TEXT NOT NULL DEFAULT '[]',
  publication_types TEXT NOT NULL DEFAULT '[]',
  cited_by          INTEGER,
  cited_by_url      TEXT,
  sources           TEXT NOT NULL DEFAULT '[]',
  decision          TEXT NOT NULL DEFAULT 'pending',
  exclusion_reason  TEXT,
  note              TEXT,
  first_search_id   INTEGER REFERENCES biblio_searches(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_biblio_refs_decision ON biblio_refs(decision);
CREATE INDEX IF NOT EXISTS idx_biblio_refs_doi ON biblio_refs(doi);
CREATE INDEX IF NOT EXISTS idx_biblio_refs_pmid ON biblio_refs(pmid);
CREATE INDEX IF NOT EXISTS idx_biblio_refs_pmcid ON biblio_refs(pmcid);
CREATE INDEX IF NOT EXISTS idx_biblio_refs_title ON biblio_refs(norm_title);

-- Quelle recherche a rendu quelle référence, et à quel rang.
CREATE TABLE IF NOT EXISTS biblio_hits (
  search_id INTEGER NOT NULL REFERENCES biblio_searches(id) ON DELETE CASCADE,
  ref_id    INTEGER NOT NULL REFERENCES biblio_refs(id) ON DELETE CASCADE,
  rank      INTEGER NOT NULL,
  PRIMARY KEY (search_id, ref_id)
);
`;
