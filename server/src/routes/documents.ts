import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { incomingDir, maxRequestBytes, maxUploadBytes, uploadsDir } from '../config.js';
import { parseIsolated } from '../extract/isolation.js';
import { ocrStatus } from '../extract/ocr.js';
import { llmStatus } from '../engine/llm.js';
import { HttpError, asyncHandler, badRequest, intParam, notFound } from '../lib/http.js';
import {
  deleteDocument,
  findDuplicate,
  getDocument,
  getDocumentFile,
  getDocumentText,
  insertDocument,
  listDocuments,
  renameDocument,
  storedPath,
} from '../repo/documents.js';
import { getPatient } from '../repo/patients.js';
import { documentUpdateSchema } from '../lib/schemas.js';
import { resolveServedType, safeExtension } from '../lib/mime.js';
import { limits } from '../extract/limits.js';
import { createLimiter } from '../lib/limiter.js';
import { formatSize } from '../lib/size.js';

/** Analyses de fichiers menées de front : chacune peut réclamer des centaines de mégaoctets. */
const parseSlot = createLimiter(limits.parseConcurrency);

export const documentsRouter = Router();

/**
 * Les fichiers sont reçus sur disque, jamais en mémoire : deux cents fichiers de
 * 200 Mo en un seul envoi coucheraient le serveur. Ils sont ensuite traités un
 * par un, donc un seul fichier est en mémoire à la fois.
 */
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, incomingDir),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: maxUploadBytes, files: 200 },
  // Les navigateurs envoient les noms de fichier en UTF-8 ; lus en latin1 (le défaut), « opératoire »
  // devient « opÃ©ratoire » et chaque justification cite un document au nom illisible.
  // (Option de multer 2, absente des types publiés.)
  defParamCharset: 'utf8',
} as multer.Options);

/** Refuse d'emblée un envoi dont la taille annoncée dépasse la limite par requête. */
function limitRequestSize(req: Request, _res: Response, next: NextFunction): void {
  const announced = Number(req.headers['content-length']);
  if (Number.isFinite(announced) && announced > maxRequestBytes) {
    next(
      new HttpError(
        413,
        `Envoi trop volumineux (${formatSize(announced)}) : la limite par envoi est de ${formatSize(maxRequestBytes)} (MAX_REQUEST_BYTES). Importez les fichiers en plusieurs lots.`,
      ),
    );
    return;
  }
  next();
}

/**
 * Nom d'affichage : on retire toute composante de chemin envoyée par le client, ainsi que les
 * caractères de contrôle et les marques de sens d'écriture, qui permettent d'afficher
 * « compte-rendu‮fdp.exe » comme un PDF.
 */
function displayName(filename: string): string {
  const cleaned = filename
    .replace(/\\/g, '/')
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '');
  return path.basename(cleaned).trim().slice(0, 255) || 'document';
}

/** Raison d'un échec d'enregistrement, sans nom de table ni chemin disque. */
function importFailure(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC') return 'Disque plein : le fichier n’a pas pu être enregistré.';
  if (code === 'EACCES' || code === 'EPERM') return 'Le dossier de données n’est pas accessible en écriture.';
  const reference = crypto.randomBytes(4).toString('hex');
  console.error(`[import échoué ${reference}]`, err);
  return `Le fichier n’a pas pu être enregistré (référence ${reference} dans le journal du serveur).`;
}

interface UploadOutcome {
  filename: string;
  status: 'imported' | 'duplicate' | 'error';
  documentId?: number;
  kind?: string;
  textLength?: number;
  message?: string;
}

/** Import de fichiers dans un dossier patient. */
documentsRouter.post(
  '/patients/:patientId/documents',
  limitRequestSize,
  upload.array('files'),
  asyncHandler(async (req, res) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    let payload: Record<string, unknown>;
    try {
      const patientId = intParam(req, 'patientId');
      const patient = getPatient(patientId);
      if (!patient) throw notFound('Dossier patient introuvable.');
      if (files.length === 0) throw badRequest('Aucun fichier reçu.');

      const patientDir = path.join(uploadsDir, String(patientId));
      await fs.mkdir(patientDir, { recursive: true });

      const results: UploadOutcome[] = [];

      for (const file of files) {
        results.push(await importOne(patientId, file));
      }

      payload = {
        results,
        documents: listDocuments(patientId),
        summary: {
          imported: results.filter((r) => r.status === 'imported').length,
          duplicates: results.filter((r) => r.status === 'duplicate').length,
          errors: results.filter((r) => r.status === 'error').length,
        },
      };
    } finally {
      // Quoi qu'il arrive — dossier inconnu, refus, panne — aucun fichier ne reste dans
      // le dépôt provisoire : ce sont des données de patients. Le ménage précède la
      // réponse, pour qu'un client qui vérifie le disque dès qu'il la reçoit le trouve propre.
      await Promise.all(files.map((f) => fs.rm(f.path, { force: true })));
    }
    res.status(201).json(payload);
  }),
);

/**
 * Analyse, range et enregistre un fichier reçu.
 *
 * N'échoue jamais : l'issue — importé, doublon, erreur — est dans le résultat,
 * pour qu'un fichier illisible n'empêche pas d'importer les autres.
 */
async function importOne(patientId: number, file: Express.Multer.File): Promise<UploadOutcome> {
  const name = displayName(file.originalname);
  let finalPath: string | null = null;
  try {
    const buffer = await fs.readFile(file.path);
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');

    const existing = findDuplicate(patientId, sha256);
    if (existing) {
      return {
        filename: name,
        status: 'duplicate',
        documentId: existing.id,
        message: `Fichier identique déjà importé (${existing.filename}).`,
      };
    }

    const parsed = await parseSlot(() => parseIsolated(buffer, name, file.mimetype, { transfer: true }));

    // Nom de stockage aléatoire : aucune donnée du client ne construit le chemin.
    const storedName = `${crypto.randomUUID()}${safeExtension(name)}`;
    finalPath = storedPath(patientId, storedName);
    // Même disque que le dépôt provisoire : un renommage, sans recopier le fichier.
    await fs.rename(file.path, finalPath);

    const doc = insertDocument({
      patientId,
      filename: name,
      storedName,
      kind: parsed.kind,
      mime: file.mimetype || 'application/octet-stream',
      size: file.size,
      sha256,
      parseStatus: parsed.status,
      parseError: parsed.error,
      text: parsed.text,
      metadata: parsed.metadata,
      dicomTags: parsed.dicomTags,
    });
    finalPath = null; // enregistré : le fichier a désormais une ligne qui le référence

    return {
      filename: name,
      status: 'imported',
      documentId: doc.id,
      kind: doc.kind,
      textLength: doc.textLength,
      message: parsed.error ?? undefined,
    };
  } catch (err) {
    // Une insertion refusée (doublon simultané, contrainte) ne doit pas laisser un
    // fichier de patient sans ligne qui le référence.
    if (finalPath) await fs.rm(finalPath, { force: true });

    // Deux envois du même fichier qui se croisent passent tous deux le contrôle de doublon avant
    // que l'un des deux n'écrive : c'est la contrainte d'unicité de la base qui tranche, et le
    // perdant est un doublon, pas une erreur.
    if (err instanceof Error && err.message.includes('UNIQUE constraint failed: documents.patient_id, documents.sha256')) {
      const sha256 = await fs
        .readFile(file.path)
        .then((b) => crypto.createHash('sha256').update(b).digest('hex'))
        .catch(() => null);
      const existing = sha256 ? findDuplicate(patientId, sha256) : null;
      return {
        filename: name,
        status: 'duplicate',
        ...(existing ? { documentId: existing.id } : {}),
        message: `Fichier identique déjà importé${existing ? ` (${existing.filename})` : ''}.`,
      };
    }
    return { filename: name, status: 'error', message: importFailure(err) };
  }
}

documentsRouter.get(
  '/documents/:id',
  asyncHandler(async (req, res) => {
    const doc = getDocument(intParam(req, 'id'));
    if (!doc) throw notFound('Document introuvable.');
    res.json({ document: doc });
  }),
);

/** Texte extrait intégral, affiché dans l'écran de vérification. */
documentsRouter.get(
  '/documents/:id/text',
  asyncHandler(async (req, res) => {
    const id = intParam(req, 'id');
    const text = getDocumentText(id);
    if (text === null) throw notFound('Document introuvable.');
    res.json({ text });
  }),
);

/** Fichier d'origine, pour relire le document source. */
documentsRouter.get(
  '/documents/:id/file',
  asyncHandler(async (req, res) => {
    const file = getDocumentFile(intParam(req, 'id'));
    if (!file) throw notFound('Document introuvable.');

    const { mime, inline } = resolveServedType(file.storedName);
    res.type(mime);
    // Sans cet en-tête, le navigateur devinerait le type d'après le contenu et
    // contournerait la liste fermée ci-dessus.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    );
    res.sendFile(file.path, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Fichier absent du disque.' });
    });
  }),
);

/**
 * Relance l'analyse d'un document déjà importé.
 * Utile après l'activation de l'OCR ou une mise à jour des extracteurs.
 */
documentsRouter.post(
  '/documents/:id/reparse',
  asyncHandler(async (req, res) => {
    const id = intParam(req, 'id');
    const doc = getDocument(id);
    const file = getDocumentFile(id);
    if (!doc || !file) throw notFound('Document introuvable.');

    const buffer = await fs.readFile(file.path).catch(() => null);
    if (!buffer) throw notFound('Fichier absent du disque : réimportez-le.');

    const parsed = await parseSlot(() => parseIsolated(buffer, doc.filename, doc.mime, { transfer: true }));
    const { db } = await import('../db/index.js');
    db.prepare(
      `UPDATE documents
          SET kind = ?, parse_status = ?, parse_error = ?, text_content = ?, metadata = ?
        WHERE id = ?`,
    ).run(
      parsed.kind,
      parsed.status,
      parsed.error,
      parsed.text,
      JSON.stringify({ ...parsed.metadata, dicomTags: parsed.dicomTags ?? undefined }),
      id,
    );

    res.json({ document: getDocument(id) });
  }),
);

/**
 * Renomme un document.
 *
 * Un nom parlant vaut mieux qu'un « IMG_2381 » quand on relit trente dossiers.
 * Seule l'étiquette change : le fichier, son empreinte et son texte extrait
 * restent en place, donc aucune extraction ni justification n'est invalidée.
 */
documentsRouter.patch(
  '/documents/:id',
  asyncHandler(async (req, res) => {
    const id = intParam(req, 'id');
    const { filename } = documentUpdateSchema.parse(req.body);
    const current = getDocument(id);
    if (!current) throw notFound('Document introuvable.');

    // L'extension du nom décide de la manière de relire le fichier (« Ré-analyser ») : on la garde. Un nom sans
    // extension la reprend ; un nom qui en porte une autre est refusé — « compte-rendu.docx » devenu « .pdf » ne
    // serait plus lisible, et le message d'erreur qui s'ensuivrait ne dirait pas pourquoi.
    const wanted = displayName(filename);
    const keep = /\.[A-Za-z0-9]{1,8}$/.exec(current.filename)?.[0] ?? '';
    const given = /\.[A-Za-z0-9]{2,5}$/.exec(wanted)?.[0] ?? '';
    if (keep && given && given.toLowerCase() !== keep.toLowerCase()) {
      throw badRequest(`L’extension d’un document ne change pas (${keep}) : renommez seulement son nom, sans modifier la fin.`);
    }
    const name = keep && !wanted.toLowerCase().endsWith(keep.toLowerCase()) ? `${wanted.replace(/\.+$/, '')}${keep}`.slice(0, 255) : wanted;

    const document = renameDocument(id, name);
    if (!document) throw notFound('Document introuvable.');
    res.json({ document });
  }),
);

documentsRouter.delete(
  '/documents/:id',
  asyncHandler(async (req, res) => {
    if (!deleteDocument(intParam(req, 'id'))) throw notFound('Document introuvable.');
    res.status(204).end();
  }),
);

/** État de l'OCR, affiché dans l'interface pour expliquer un texte vide. */
documentsRouter.get(
  '/documents-capabilities',
  asyncHandler(async (_req, res) => {
    res.json({ ocr: await ocrStatus(), llm: llmStatus(), maxUploadBytes });
  }),
);
