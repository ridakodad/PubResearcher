import mammoth from 'mammoth';
import { formatSize } from '../lib/size.js';
import { limits } from './limits.js';
import { htmlToText } from './text.js';
import type { ExtractionOutput } from './types.js';
import { readZipDirectory } from './zip-guard.js';

/**
 * Refuse un fichier Word dont le contenu décompressé dépasse ce que l'outil sait lire sans risque.
 *
 * L'annuaire de l'archive annonce les tailles avant toute décompression : un fichier de 400 Ko qui
 * en contient 100 Mo de XML répétitif est repéré ici, au lieu de saturer la mémoire du serveur.
 */
function assertReasonableSize(buffer: Buffer): void {
  const directory = readZipDirectory(buffer);
  if (!directory) return; // pas une archive lisible : la conversion dira ce qui ne va pas
  if (directory.zip64) {
    throw new Error('Archive Word trop volumineuse (format ZIP64) : un compte rendu n’en a pas besoin.');
  }
  const xml = directory.entries
    .filter((e) => /\.(xml|rels)$/i.test(e.name))
    .reduce((total, e) => total + e.uncompressedSize, 0);
  const total = directory.entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
  if (xml > limits.maxDocxXmlBytes()) {
    throw new Error(
      `Document Word trop volumineux une fois décompressé (${formatSize(xml)} de texte structuré, limite ${formatSize(limits.maxDocxXmlBytes())}). ` +
        `Exportez-le en PDF, ou relevez DOCX_MAX_XML_MB si ce document est légitime.`,
    );
  }
  if (total > limits.maxDocxTotalBytes()) {
    throw new Error(
      `Document Word trop volumineux une fois décompressé (${formatSize(total)}, limite ${formatSize(limits.maxDocxTotalBytes())}). ` +
        `Relevez DOCX_MAX_TOTAL_MB si ce document est légitime.`,
    );
  }
}

/**
 * Extrait le texte d'un document Word.
 *
 * Les fiches sont très souvent structurées en tableaux Word. `extractRawText`
 * colle les cellules sans séparateur exploitable ; on passe donc par la
 * conversion HTML pour réinjecter des délimiteurs entre cellules et lignes,
 * ce qui permet aux règles « libellé : valeur » de fonctionner sur les tableaux.
 */
export async function extractDocx(buffer: Buffer, _filename: string): Promise<ExtractionOutput> {
  assertReasonableSize(buffer);
  const html = await mammoth.convertToHtml({ buffer });
  const text = htmlToText(html.value);

  const messages = html.messages
    .filter((m) => m.type === 'warning' || m.type === 'error')
    .map((m) => m.message)
    .slice(0, 20);

  return {
    text,
    metadata: {
      converterMessages: messages,
      textLayer: text.trim().length > 0,
    },
  };
}
