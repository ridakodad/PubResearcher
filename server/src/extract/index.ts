import type { DocKind } from '../domain/types.js';
import { extractDicom } from './dicom.js';
import { extractDocx } from './docx.js';
import { extractImage } from './image.js';
import { formatSize } from '../lib/size.js';
import { limits } from './limits.js';
import { extractPdf } from './pdf.js';
import { decodeText, htmlToText, looksLikeHtml, looksLikeRtf, rtfToText } from './text.js';
import { detectKind, looksLikeDicom, type ExtractionOutput } from './types.js';

export { detectKind, looksLikeDicom };
export type { ExtractionOutput };

export interface ParseResult extends ExtractionOutput {
  kind: DocKind;
  status: 'ok' | 'empty' | 'error';
  error: string | null;
}

/**
 * Analyse un fichier uploadé : détermine sa nature puis délègue à l'extracteur
 * correspondant. Une erreur d'analyse n'interrompt pas l'import — le document
 * est conservé avec son statut d'erreur, l'utilisateur pouvant saisir les
 * variables manuellement.
 */
export async function parseDocument(
  buffer: Buffer,
  filename: string,
  mime: string,
): Promise<ParseResult> {
  let kind = detectKind(filename, mime);

  // Les exports PACS arrivent souvent sans extension : on confirme par le
  // préambule du fichier plutôt que par son nom.
  if ((kind === 'unknown' || kind === 'text') && looksLikeDicom(buffer)) {
    kind = 'dicom';
  }

  // Un fichier vide n'est pas un document : sans cette garde, une image de 0 octet passait pour « lue » (son en-tête
  // « Image : nom » suffit à produire du texte), et chaque extracteur avait son propre message pour la même chose.
  if (buffer.length === 0 && kind !== 'unknown') {
    return {
      kind,
      text: '',
      metadata: { textLayer: false },
      status: 'error',
      error: `Fichier vide (0 octet) : ${filename}. Réimportez-le depuis la source.`,
    };
  }

  try {
    const extracted = await runExtractor(kind, buffer, filename);
    const { output, warning } = capText(extracted);
    const status = output.text.trim().length > 0 ? 'ok' : 'empty';
    return { ...output, kind, status, error: warning };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const friendly = explainParseError(message, kind);
    return {
      kind,
      text: '',
      // Le message d'origine de la bibliothèque reste consultable pour le diagnostic.
      metadata: { textLayer: false, ...(friendly !== message ? { technicalError: message.slice(0, 300) } : {}) },
      status: 'error',
      error: friendly.slice(0, 500),
    };
  }
}

/**
 * Messages des bibliothèques de lecture, traduits en ce qu'un chercheur peut faire. Un « Invalid PDF structure. » ou
 * un « Maximum call stack size exceeded » ne dit ni ce qui est en cause ni que faire ; les messages déjà rédigés par
 * l'outil (plafonds, formats non pris en charge) passent tels quels.
 */
const PARSE_ERRORS: [RegExp, string][] = [
  [/No password given|Incorrect Password|PasswordException/i, 'PDF protégé par mot de passe : retirez la protection (ou exportez-le à nouveau) puis réimportez-le.'],
  [/Pages tree contains circular reference|Invalid PDF structure|Missing PDF header|XRef|Invalid (?:page|object)|Bad (?:FlateStream|encoding)/i, 'PDF corrompu ou illisible. Réexportez-le depuis le logiciel d’origine, puis réimportez-le.'],
  [/size is zero bytes|file is empty/i, 'Fichier vide (0 octet). Réimportez-le depuis la source.'],
  [/end of central directory|Corrupted zip|is this a zip file|End of data reached/i, 'Fichier Word illisible : ce n’est pas une archive .docx valide (fichier tronqué ou corrompu). Réenregistrez-le en .docx ou en PDF.'],
  [/entity not found|xmldom|DOCTYPE|ENTITY/i, 'Document Word refusé : il contient des références externes (entités XML) que l’outil ne suit pas, par sécurité. Réenregistrez-le depuis Word.'],
  [/Maximum call stack|too deep|nesting/i, 'Structure du document trop profonde ou trop complexe pour être lue (tableaux imbriqués, par exemple). Exportez-le en PDF.'],
  [/dicomParser\.parseDicom: missing required meta header|not a valid DICOM|Part 10/i, 'Fichier DICOM illisible : en-tête absent ou corrompu.'],
  [/dicomParser\..*(past end|out of range|buffer)/i, 'Fichier DICOM tronqué ou corrompu.'],
];

export function explainParseError(message: string, kind: DocKind): string {
  // Les messages de l'outil sont déjà en clair.
  if (/^(Format non pris en charge|Document Word trop volumineux|Archive Word trop volumineuse|Fichier vide|Image trop grande|Texte tronqué)/i.test(message)) return message;
  for (const [pattern, text] of PARSE_ERRORS) {
    if (pattern.test(message)) return text;
  }
  return kind === 'unknown' ? message : `Lecture impossible (${message.slice(0, 160)}). Le fichier est peut-être corrompu : réexportez-le puis réimportez-le.`;
}

/**
 * Plafonne le texte conservé. Un document de plusieurs dizaines de mégaoctets de texte ne se lit
 * pas, et chaque règle d'extraction le parcourrait à chaque passe, pour chaque variable.
 * Le texte est coupé à une fin de ligne, et le document le dit : la coupure ne doit jamais passer
 * pour une absence de valeur.
 */
function capText(output: ExtractionOutput): { output: ExtractionOutput; warning: string | null } {
  const max = limits.maxTextChars();
  if (output.text.length <= max) {
    const stopped = output.metadata['truncatedBecause'];
    const pagesTruncated = Number(output.metadata['pagesTruncated'] ?? 0);
    const warning =
      stopped && pagesTruncated > 0
        ? `Lecture partielle : ${pagesTruncated} page${pagesTruncated > 1 ? 's' : ''} non lue${pagesTruncated > 1 ? 's' : ''} (${
            stopped === 'pages' ? 'plafond de pages PDF_MAX_PAGES' : stopped === 'time' ? 'délai PDF_PARSE_TIMEOUT_MS dépassé' : 'plafond de texte MAX_TEXT_CHARS'
          }).`
        : null;
    return { output, warning };
  }
  const cut = output.text.lastIndexOf('\n', max);
  const kept = output.text.slice(0, cut > max * 0.9 ? cut : max);
  return {
    output: {
      ...output,
      text: kept,
      metadata: { ...output.metadata, textTruncated: true, textOriginalLength: output.text.length },
    },
    warning:
      `Texte tronqué : ${kept.length.toLocaleString('fr-FR')} caractères conservés sur ${output.text.length.toLocaleString('fr-FR')} ` +
      `(${formatSize(output.text.length)}). Relevez MAX_TEXT_CHARS si ce document est légitime.`,
  };
}

async function runExtractor(
  kind: DocKind,
  buffer: Buffer,
  filename: string,
): Promise<ExtractionOutput> {
  switch (kind) {
    case 'pdf':
      return extractPdf(buffer, filename);
    case 'docx':
      return extractDocx(buffer, filename);
    case 'dicom':
      return extractDicom(buffer, filename);
    case 'image':
      return extractImage(buffer, filename);
    case 'text':
      return extractPlainText(buffer);
    default: {
      const ext = filename.toLowerCase().split('.').pop() ?? '';
      const legacy: Record<string, string> = {
        doc: 'Ancien format Word (.doc) : enregistrez-le en .docx ou en PDF',
        xls: 'Feuille de calcul Excel : exportez-la en CSV ou en PDF',
        xlsx: 'Feuille de calcul Excel : exportez-la en CSV ou en PDF',
        ppt: 'Présentation PowerPoint : exportez-la en PDF',
        pptx: 'Présentation PowerPoint : exportez-la en PDF',
        odt: 'Document OpenDocument : enregistrez-le en .docx ou en PDF',
        zip: 'Archive : décompressez-la et importez les fichiers qu’elle contient',
        exe: 'Programme exécutable : ce n’est pas un document',
      };
      throw new Error(
        legacy[ext]
          ? `Format non pris en charge (${filename}). ${legacy[ext]}, puis réimportez-le.`
          : `Format non pris en charge (${filename}). Formats acceptés : PDF, Word (.docx), images, DICOM, texte.`,
      );
    }
  }
}

/**
 * Fichier « texte » : texte brut, RTF ou HTML, reconnus à leur contenu plutôt
 * qu'à leur extension — un export de logiciel hospitalier nomme volontiers du
 * RTF « .txt ». L'encodage est détecté : de l'UTF-8 lu en Windows-1252, ou
 * l'inverse, fait disparaître les accents que les règles cherchent.
 */
function extractPlainText(buffer: Buffer): ExtractionOutput {
  if (looksLikeRtf(buffer)) {
    // Un RTF est de l'ASCII : les accents y sont échappés (\'e9, \u233).
    return {
      text: rtfToText(buffer.toString('latin1')),
      metadata: { textLayer: true, format: 'rtf' },
    };
  }
  const { text, charset } = decodeText(buffer);
  if (looksLikeHtml(text)) {
    return { text: htmlToText(text), metadata: { textLayer: true, format: 'html', charset } };
  }
  return { text, metadata: { textLayer: true, format: 'texte', charset } };
}
