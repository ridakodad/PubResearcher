import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { maxUploadBytes } from '../config.js';
import { formatSize } from './size.js';

/** Erreur applicative portant un code HTTP. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
    /** Code stable que l'interface peut tester sans lire le message. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (msg: string, details?: unknown, code?: string) => new HttpError(400, msg, details, code);
export const notFound = (msg: string) => new HttpError(404, msg);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);
/** Requête bien formée mais refusée en l'état : l'appelant peut la rejouer en confirmant. */
export const unprocessable = (msg: string, details?: unknown, code?: string) =>
  new HttpError(422, msg, details, code);

/** Enveloppe un handler asynchrone pour router les rejets vers le middleware d'erreur. */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

/**
 * Entier strictement positif écrit en chiffres décimaux, sans zéro initial, ou `null`.
 *
 * `Number()` seul lirait « 0x10 » comme 16, « 1e3 » comme 1000, « 5.0 » comme 5 et « 007 » comme 7 : un même
 * dossier aurait plusieurs adresses. Un identifiant au-delà de 2^53 perd sa précision en JavaScript et fait
 * échouer SQLite.
 */
function positiveInt(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^[1-9]\d{0,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Lit un paramètre d'URL entier, en refusant les valeurs non numériques. */
export function intParam(req: Request, name: string): number {
  const raw = req.params[name];
  const n = positiveInt(raw);
  if (n === null) throw badRequest(`Paramètre « ${name} » invalide : ${String(raw).slice(0, 40)}`);
  return n;
}

export function intQuery(req: Request, name: string): number | null {
  const raw = req.query[name];
  if (raw === undefined || raw === '') return null;
  const n = positiveInt(raw);
  if (n === null) throw badRequest(`Paramètre « ${name} » invalide.`);
  return n;
}

/**
 * Middleware d'erreur : réponses JSON homogènes, messages en français.
 *
 * Une erreur du client (JSON mal formé, fichier trop gros) reste une erreur 4xx
 * avec un message qui dit quoi faire — jamais une « erreur interne ». Pour une
 * vraie erreur serveur, la réponse ne cite ni message SQL ni chemin disque : elle
 * porte une référence, que le journal du serveur reprend avec la pile complète.
 */
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'Données invalides.',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof HttpError) {
    res
      .status(err.status)
      .json({ error: err.message, code: err.code ?? undefined, details: err.details ?? undefined });
    return;
  }

  // Import de fichiers : limites de multer.
  if (err instanceof multer.MulterError) {
    const messages: Record<string, [number, string]> = {
      LIMIT_FILE_SIZE: [
        413,
        `Fichier trop volumineux : la limite est de ${formatSize(maxUploadBytes)} par fichier (MAX_UPLOAD_BYTES). Relevez-la si ce document est légitime, ou exportez-le sous une forme plus légère.`,
      ],
      LIMIT_FILE_COUNT: [413, 'Trop de fichiers dans un même envoi (200 au plus). Importez-les en plusieurs lots.'],
      LIMIT_UNEXPECTED_FILE: [400, 'Champ de fichier inattendu : utilisez « files ».'],
    };
    const [status, message] = messages[err.code] ?? [400, `Import refusé (${err.code}).`];
    res.status(status).json({ error: message });
    return;
  }

  // Envoi multipart illisible (coupé en route, délimiteur absent) : une erreur du client, pas du serveur.
  if (
    err instanceof Error &&
    /^(Malformed part header|Malformed urlencoded form|Unexpected end of form|Multipart: |Missing Content-Type|Unsupported content type|Part terminated early|Malformed part)/i.test(
      err.message,
    )
  ) {
    res.status(400).json({
      error: 'Envoi illisible : le corps de la requête est incomplet ou mal formé. Relancez l’import.',
    });
    return;
  }

  // Erreurs du lecteur de requêtes d'Express : JSON mal formé, corps trop gros, encodage.
  const http = err as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = Number(http.status ?? http.statusCode);
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    const message =
      http.type === 'entity.too.large'
        ? 'Requête trop volumineuse : un corps JSON ne dépasse pas 5 Mo (limite fixe). Importez les fichiers par le formulaire d’import.'
        : http.type === 'entity.parse.failed'
          ? 'Corps de requête illisible : le JSON est mal formé.'
          : status === 415
            ? 'Type de contenu non pris en charge : attendu application/json en UTF-8, sans compression.'
            : 'Requête invalide.';
    res.status(status).json({ error: message });
    return;
  }

  // Contrainte d'unicité SQLite : message compréhensible plutôt qu'une 500.
  const message = err instanceof Error ? err.message : String(err);
  // Un nombre que SQLite ne sait pas lier (au-delà de 2^53) vient toujours de la requête, jamais du serveur.
  if (/too large to be represented|out of range/i.test(message) && err instanceof RangeError) {
    res.status(400).json({ error: 'Valeur numérique hors limites.' });
    return;
  }
  if (message.includes('UNIQUE constraint failed')) {
    res.status(409).json({ error: 'Cet enregistrement existe déjà.' });
    return;
  }

  const reference = crypto.randomBytes(4).toString('hex');
  console.error(`[erreur non gérée ${reference}]`, err);
  res.status(500).json({
    error: `Erreur interne du serveur (référence ${reference}). Le journal du serveur en donne le détail.`,
    // Détail technique : réservé au diagnostic, jamais en fonctionnement normal.
    ...(process.env.RT_DEBUG === '1' ? { details: message } : {}),
  });
}
