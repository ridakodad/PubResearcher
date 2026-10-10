import type { DocKind } from '../domain/types.js';

export interface ExtractionOutput {
  /** Texte brut exploitable par le moteur de règles. */
  text: string;
  /** Métadonnées structurées (pages, EXIF, tags DICOM…). */
  metadata: Record<string, unknown>;
  /** Tags DICOM aplatis, vide pour les autres natures de document. */
  dicomTags?: Record<string, string>;
}

export type Extractor = (buffer: Buffer, filename: string) => Promise<ExtractionOutput>;

/** Détermine la nature d'un document à partir du MIME et de l'extension. */
export function detectKind(filename: string, mime: string): DocKind {
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  const m = mime.toLowerCase();

  if (m === 'application/dicom' || ext === 'dcm' || ext === 'dicom') return 'dicom';
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (
    m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === 'docx'
  ) {
    return 'docx';
  }
  if (m.startsWith('image/') || ['jpg', 'jpeg', 'png', 'tif', 'tiff', 'webp', 'bmp'].includes(ext)) {
    return 'image';
  }
  if (
    m.startsWith('text/') ||
    m === 'application/rtf' ||
    ['txt', 'csv', 'md', 'rtf', 'html', 'htm', 'tsv', 'log'].includes(ext)
  ) {
    return 'text';
  }
  // Certains PACS exportent des DICOM sans extension ni MIME : le sniffing final
  // est fait par l'extracteur DICOM sur le préambule « DICM ».
  if (ext === '' && mime === 'application/octet-stream') return 'unknown';
  return 'unknown';
}

/** Détecte le magic number DICOM (« DICM » à l'offset 128). */
export function looksLikeDicom(buffer: Buffer): boolean {
  return buffer.length > 132 && buffer.toString('latin1', 128, 132) === 'DICM';
}
