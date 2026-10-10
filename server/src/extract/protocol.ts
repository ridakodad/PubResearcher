import type { ParseResult } from './index.js';
import type { OcrResult } from './ocr.js';

/**
 * Messages échangés entre le serveur et ses fils d'analyse (voir `isolation.ts`).
 *
 * Un fil traite une tâche à la fois. Pendant une analyse, il peut demander la reconnaissance optique d'une
 * image au fil principal (`ocr-status`, `ocr-run`) : le moteur de reconnaissance n'existe qu'une fois.
 */

/**
 * Réglages lus dans l'environnement à chaque fichier. Un fil reçoit une copie de l'environnement à sa
 * création ; ceux-ci lui sont donc renvoyés à chaque tâche, pour que les plafonds se règlent sans redémarrage.
 */
export const PARSE_ENV_KEYS = [
  'MAX_TEXT_CHARS',
  'PDF_MAX_PAGES',
  'PDF_PARSE_TIMEOUT_MS',
  'DOCX_MAX_XML_MB',
  'DOCX_MAX_TOTAL_MB',
  'IMAGE_MAX_MEGAPIXELS',
  'OCR_MAX_PAGES',
  'OCR_PDF_SCALE',
] as const;

export interface ParseRequest {
  type: 'parse';
  id: number;
  buffer: Uint8Array;
  filename: string;
  mime: string;
  env: Record<string, string | undefined>;
}

export interface OcrReply {
  type: 'ocr-reply';
  id: number;
  value: unknown;
}

export type ToWorker = ParseRequest | OcrReply;

export type FromWorker =
  /** Le fil a fini de démarrer : il écoute. Un fil qui s'arrête avant cela n'a pas pu démarrer — ce n'est pas la faute du fichier. */
  | { type: 'ready' }
  | { type: 'result'; id: number; result: ParseResult }
  | { type: 'failure'; id: number; message: string }
  | { type: 'ocr-status'; id: number }
  | { type: 'ocr-run'; id: number; image: Uint8Array };

export type OcrRunValue = OcrResult | null;
