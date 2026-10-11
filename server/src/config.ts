import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NUMERIC_SETTINGS, readNumericEnv } from './lib/env-check.js';

// Conservé ici : les tests et les scripts l'importent depuis la configuration.
export { readIntEnv } from './lib/env-check.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Lit un réglage numérique de la configuration ; une valeur invalide arrête le démarrage en disant laquelle et pourquoi. */
function fromEnv(name: 'PORT' | 'MAX_UPLOAD_BYTES' | 'MAX_REQUEST_BYTES', fallback: number): number {
  try {
    return readNumericEnv(name, process.env[name], fallback, NUMERIC_SETTINGS[name]);
  } catch (error) {
    console.error(`\nConfiguration invalide : ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

/** Racine du dépôt (server/src -> server -> racine, ou server/dist -> server -> racine). */
export const repoRoot = path.resolve(here, '..', '..');

/** Répertoire de données : base SQLite + fichiers uploadés. */
export const dataDir = path.resolve(process.env.DATA_DIR?.trim() || path.join(repoRoot, 'data'));

export const uploadsDir = path.join(dataDir, 'uploads');
/**
 * Dépôt provisoire des fichiers en cours de réception. Sur le même disque que
 * les dossiers patients, pour que le rangement définitif soit un simple
 * renommage — et hors de la mémoire : plusieurs fichiers de 200 Mo en
 * parallèle ne doivent pas coucher le serveur.
 */
export const incomingDir = path.join(uploadsDir, '.incoming');
/**
 * Tableaux de cohorte importés (classeurs, CSV). Conservés comme les documents — ils justifient chaque valeur
 * importée — et sous `uploads/`, donc compris dans les sauvegardes.
 */
export const importsDir = path.join(uploadsDir, 'imports');
// `DB_PATH=` (vide) vaut « non défini » : un chemin vide ouvrait une base temporaire, perdue au redémarrage.
export const dbPath = process.env.DB_PATH?.trim() || path.join(dataDir, 'research-tool.db');

export const port = fromEnv('PORT', 4000);

/**
 * Adresse d'écoute. Par défaut le poste lui-même : l'outil n'est pas joignable du réseau tant qu'on ne
 * l'a pas voulu (`HOST=0.0.0.0`). Des comptes rendus de patients ne doivent pas être servis à un
 * réseau d'hôpital parce que quelqu'un a lancé « npm start » sans y penser.
 */
export const host = process.env.HOST?.trim() || '127.0.0.1';

/**
 * Noms sous lesquels l'outil accepte d'être appelé, en plus de ceux du poste lui-même (`ALLOWED_HOSTS=outil.chu.example`).
 * Un site tiers peut faire pointer son propre nom vers 127.0.0.1 pour lire l'API depuis le navigateur du chercheur
 * (« DNS rebinding ») : tant que l'outil n'écoute que sur le poste, il refuse donc tout nom qu'il ne connaît pas.
 */
export const extraAllowedHosts = (process.env.ALLOWED_HOSTS ?? '')
  .split(',')
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

/**
 * Origines autorisées à écrire (`ALLOWED_ORIGINS=https://outil.chu.example`), en plus de l'origine de l'outil et de celles de
 * `CORS_ORIGINS`. Utile quand un proxy réécrit l'en-tête `Host` : l'origine que voit le navigateur n'est alors plus celle que voit l'outil.
 */
export const extraAllowedOrigins = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/** Mot de passe d'accès (HTTP Basic). Absent : pas de contrôle d'accès. */
export const appPassword = process.env.APP_PASSWORD && process.env.APP_PASSWORD.length > 0 ? process.env.APP_PASSWORD : null;

/** Origines autorisées pour le CORS en développement (le front Vite tourne sur 5173). */
export const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** Taille maximale d'un fichier uploadé (les séries DICOM et les PDF scannés sont volumineux). */
export const maxUploadBytes = fromEnv('MAX_UPLOAD_BYTES', 200 * 1024 * 1024);

/** Taille maximale d'une requête d'import entière (tous fichiers confondus). */
export const maxRequestBytes = fromEnv('MAX_REQUEST_BYTES', 2 * 1024 * 1024 * 1024);

/** Dossier des assets du front compilé, servis en production. */
export const webDistDir = path.join(repoRoot, 'web', 'dist');

export function ensureDataDirs(): void {
  fs.mkdirSync(uploadsDir, { recursive: true });
  fs.mkdirSync(incomingDir, { recursive: true });
}
