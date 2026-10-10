import fs from 'node:fs';
import path from 'node:path';
import { db, nowIso, parseJson } from '../db/index.js';
import { incomingDir, uploadsDir } from '../config.js';
import type { DocKind, DocumentMeta } from '../domain/types.js';
import type { SourceDoc } from '../engine/rules.js';
import { resolveServedType } from '../lib/mime.js';

interface DocumentRow {
  id: number;
  patient_id: number;
  filename: string;
  stored_name: string;
  kind: string;
  mime: string;
  size: number;
  sha256: string;
  parse_status: string;
  parse_error: string | null;
  text_content: string;
  metadata: string;
  created_at: string;
}

function toDocument(row: DocumentRow): DocumentMeta {
  return {
    id: row.id,
    patientId: row.patient_id,
    filename: row.filename,
    kind: row.kind as DocKind,
    mime: row.mime,
    size: row.size,
    sha256: row.sha256,
    createdAt: row.created_at,
    parseStatus: row.parse_status as DocumentMeta['parseStatus'],
    previewable: resolveServedType(row.stored_name).inline,
    parseError: row.parse_error,
    textLength: row.text_content.length,
    metadata: parseJson<Record<string, unknown>>(row.metadata, {}),
  };
}

/** Chemin sur disque du fichier d'origine. */
export function storedPath(patientId: number, storedName: string): string {
  return path.join(uploadsDir, String(patientId), storedName);
}

export function listDocuments(patientId: number): DocumentMeta[] {
  const rows = db
    .prepare('SELECT * FROM documents WHERE patient_id = ? ORDER BY created_at, id')
    .all(patientId) as DocumentRow[];
  return rows.map(toDocument);
}

export function getDocument(id: number): DocumentMeta | null {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
  return row ? toDocument(row) : null;
}

/** Renvoie le texte intégral extrait, pour l'écran de vérification. */
export function getDocumentText(id: number): string | null {
  const row = db.prepare('SELECT text_content FROM documents WHERE id = ?').get(id) as
    | { text_content: string }
    | undefined;
  return row ? row.text_content : null;
}

export function getDocumentFile(
  id: number,
): { path: string; mime: string; filename: string; storedName: string } | null {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
  if (!row) return null;
  return {
    path: storedPath(row.patient_id, row.stored_name),
    mime: row.mime,
    filename: row.filename,
    // Porte l'extension du fichier d'origine, que le renommage ne touche pas.
    storedName: row.stored_name,
  };
}

/** Un document identique (même empreinte) est-il déjà présent dans ce dossier ? */
export function findDuplicate(patientId: number, sha256: string): DocumentMeta | null {
  const row = db
    .prepare('SELECT * FROM documents WHERE patient_id = ? AND sha256 = ?')
    .get(patientId, sha256) as DocumentRow | undefined;
  return row ? toDocument(row) : null;
}

export function insertDocument(input: {
  patientId: number;
  filename: string;
  storedName: string;
  kind: DocKind;
  mime: string;
  size: number;
  sha256: string;
  parseStatus: DocumentMeta['parseStatus'];
  parseError: string | null;
  text: string;
  metadata: Record<string, unknown>;
  dicomTags?: Record<string, string>;
}): DocumentMeta {
  const info = db
    .prepare(
      `INSERT INTO documents
         (patient_id, filename, stored_name, kind, mime, size, sha256,
          parse_status, parse_error, text_content, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.patientId,
      input.filename,
      input.storedName,
      input.kind,
      input.mime,
      input.size,
      input.sha256,
      input.parseStatus,
      input.parseError,
      input.text,
      // Les tags DICOM voyagent dans les métadonnées pour rester interrogeables
      // par le moteur sans table supplémentaire.
      JSON.stringify({ ...input.metadata, dicomTags: input.dicomTags ?? undefined }),
      nowIso(),
    );
  return getDocument(Number(info.lastInsertRowid))!;
}

/**
 * Renomme un document.
 *
 * Seul le nom affiché change. Le fichier reste stocké sous son nom généré, et
 * l'empreinte comme le texte extrait sont intacts : renommer ne peut donc pas
 * invalider une extraction ni casser une justification déjà enregistrée.
 *
 * Le nom porte du sens dans une étude — « CR opératoire » vaut mieux que
 * « IMG_2381 » quand on relit trente dossiers.
 */
export function renameDocument(id: number, filename: string): DocumentMeta | null {
  const info = db
    .prepare('UPDATE documents SET filename = ? WHERE id = ?')
    .run(filename, id);
  if (info.changes === 0) return null;
  return getDocument(id);
}

export function deleteDocument(id: number): boolean {
  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
  if (!row) return false;
  db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  // Le fichier peut avoir disparu du disque : la suppression reste un succès.
  fs.rm(storedPath(row.patient_id, row.stored_name), { force: true }, () => undefined);
  return true;
}

/** Charge le corpus d'un patient sous la forme attendue par le moteur de règles. */
export function loadSourceDocs(patientId: number): SourceDoc[] {
  const rows = db
    .prepare(
      `SELECT id, filename, kind, text_content, metadata
         FROM documents
        WHERE patient_id = ?
        ORDER BY created_at, id`,
    )
    .all(patientId) as Pick<DocumentRow, 'id' | 'filename' | 'kind' | 'text_content' | 'metadata'>[];

  return rows.map((row) => {
    const meta = parseJson<{ dicomTags?: Record<string, string> }>(row.metadata, {});
    return {
      id: row.id,
      name: row.filename,
      kind: row.kind as DocKind,
      text: row.text_content,
      dicomTags: meta.dicomTags ?? {},
    };
  });
}

/**
 * Efface le dépôt provisoire des fichiers en cours de réception.
 *
 * Un arrêt brutal pendant un envoi y laisse des fichiers : des données de
 * patients qui n'appartiennent à aucun dossier. Appelée au démarrage.
 */
export function purgeIncoming(): number {
  fs.mkdirSync(incomingDir, { recursive: true });
  const leftovers = fs.readdirSync(incomingDir);
  for (const name of leftovers) fs.rmSync(path.join(incomingDir, name), { recursive: true, force: true });
  return leftovers.length;
}
