import path from 'node:path';

/**
 * Type à servir pour un document importé, et droit de l'afficher dans la page.
 *
 * Le type déclaré à l'import vient du client et ne vaut rien : un navigateur
 * qui ne reconnaît pas l'extension, ou un import par script, laissent
 * `application/octet-stream`, et le lecteur intégré du navigateur refuse alors
 * d'afficher un PDF pourtant valide.
 *
 * On se fie donc à l'extension — mais celle du **nom de stockage**, jamais du
 * nom affiché : ce dernier est renommable, et baptiser un PDF « Compte rendu
 * opératoire » ne doit pas le rendre soudain inaffichable.
 */

/**
 * Formats que le navigateur peut rendre sans risque.
 *
 * La liste est délibérément fermée. Un document importé est un fichier
 * quelconque : servi en ligne avec un type que le navigateur exécute — SVG et
 * HTML au premier chef — il s'exécuterait dans l'origine de l'application, où
 * se trouvent les données de l'étude. Tout ce qui n'est pas ici part en
 * téléchargement, jamais rendu dans la page.
 */
const INLINE_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain; charset=utf-8',
};

/** Extension sûre, dérivée du nom (jamais de chemin). */
export function safeExtension(filename: string): string {
  const ext = path.extname(path.basename(filename)).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

export interface ServedType {
  mime: string;
  /** Le navigateur peut-il l'afficher dans la page sans danger ? */
  inline: boolean;
}

export function resolveServedType(storedName: string): ServedType {
  const mime = INLINE_TYPES[safeExtension(storedName)];
  return mime ? { mime, inline: true } : { mime: 'application/octet-stream', inline: false };
}
