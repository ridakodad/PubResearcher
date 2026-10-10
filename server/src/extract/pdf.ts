import { createRequire } from 'node:module';
import path from 'node:path';
import { limits } from './limits.js';
import { ocrStatus, runOcr } from './ocr.js';
import type { ExtractionOutput } from './types.js';

const require = createRequire(import.meta.url);

/** Dossier des polices standard livrées par pdfjs-dist (évite un avertissement au parsing). */
function standardFontDataUrl(): string {
  const pkg = require.resolve('pdfjs-dist/package.json');
  return path.join(path.dirname(pkg), 'standard_fonts') + path.sep;
}

/**
 * Au plus ce nombre de pages d'un même PDF passent par l'OCR (une page : quelques secondes).
 * `OCR_MAX_PAGES=0` interdit l'OCR des PDF. Lu à chaque document : la valeur se règle sans redémarrage.
 */
const ocrMaxPages = (): number => {
  const raw = process.env.OCR_MAX_PAGES;
  if (raw === undefined || raw === '') return 30;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 30;
};
/** Facteur de rendu des pages à reconnaître : 3 donne environ 216 points par pouce, suffisant pour du texte courant. */
const ocrScale = (): number => Math.min(4, Math.max(1, Number(process.env.OCR_PDF_SCALE ?? 3) || 3));
/** Une page dont la couche texte compte moins de caractères que cela est tenue pour un scan. */
const OCR_MIN_CHARS = 20;
/** Au-delà de ce nombre de pixels, on réduit le rendu plutôt que de saturer la mémoire. */
const OCR_MAX_PIXELS = 32_000_000;

interface RenderTarget {
  canvasFactory?: {
    create(width: number, height: number): { canvas: { toBuffer(type: string): Buffer }; context: unknown };
    destroy(target: unknown): void;
  };
}

/**
 * Rend une page de PDF en image PNG, pour la reconnaissance optique.
 * Renvoie `null` si le rendu est impossible (module de dessin absent, page illisible).
 */
async function renderPagePng(
  doc: RenderTarget,
  page: {
    getViewport(o: { scale: number }): { width: number; height: number };
    render(o: Record<string, unknown>): { promise: Promise<unknown> };
  },
): Promise<Buffer | null> {
  try {
    const factory = doc.canvasFactory;
    if (!factory) return null;
    let scale = ocrScale();
    let viewport = page.getViewport({ scale });
    if (viewport.width * viewport.height > OCR_MAX_PIXELS) {
      scale = scale * Math.sqrt(OCR_MAX_PIXELS / (viewport.width * viewport.height));
      viewport = page.getViewport({ scale });
    }
    const target = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    try {
      await page.render({ canvasContext: target.context, canvas: target.canvas, viewport }).promise;
      return target.canvas.toBuffer('image/png');
    } finally {
      factory.destroy(target);
    }
  } catch {
    return null;
  }
}

/**
 * Extrait le texte d'un PDF page par page.
 *
 * Les PDF issus d'un scanner ne contiennent aucune couche texte. Leurs pages
 * sont alors rendues en image puis reconnues par OCR — c'est la forme la plus
 * courante d'un compte rendu ancien. La page reconnue est signalée dans
 * `metadata.ocrPages` : un texte issu de l'OCR peut contenir des erreurs, et
 * les valeurs qu'on y trouve méritent d'être relues avec plus d'attention.
 *
 * Sans OCR disponible (désactivé, langue absente), la page reste vide et
 * `metadata.textLayer` vaut `false` : une saisie manuelle sera nécessaire.
 */
export async function extractPdf(buffer: Buffer, _filename: string): Promise<ExtractionOutput> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl: standardFontDataUrl(),
    isEvalSupported: false,
    useSystemFonts: false,
    // Les PDF de dossiers patients ne sont pas des applications : on ignore le JS embarqué.
    disableAutoFetch: true,
  }).promise;

  try {
    const pages: string[] = [];
    const started = Date.now();
    const maxPages = limits.maxPdfPages();
    const deadline = limits.pdfTimeoutMs();
    const maxChars = limits.maxTextChars();
    let textChars = 0;
    /** Pourquoi la lecture s'est arrêtée avant la dernière page, le cas échéant. */
    let stoppedBecause: 'pages' | 'time' | 'text' | null = doc.numPages > maxPages ? 'pages' : null;
    const lastPage = Math.min(doc.numPages, maxPages);
    const ocrPages: number[] = [];
    const ocrConfidences: number[] = [];
    const maxOcrPages = ocrMaxPages();
    let ocrAttempts = 0; // pages envoyées à l'OCR, reconnues ou non : c'est le travail qui est plafonné
    let ocrSkipped = 0;
    let ocrUsable: boolean | null = null; // résolu au premier besoin
    for (let i = 1; i <= lastPage; i++) {
      // Chaque page cède la main : lire un PDF de milliers de pages ne doit pas figer le serveur
      // pour les autres utilisateurs, ni dépasser le temps accordé.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (Date.now() - started > deadline) {
        stoppedBecause = 'time';
        break;
      }
      if (textChars > maxChars) {
        stoppedBecause = 'text';
        break;
      }
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let lastY: number | null = null;
      let line = '';
      const lines: string[] = [];

      for (const item of content.items) {
        if (!('str' in item)) continue;
        const y = item.transform[5] as number;
        // pdf.js restitue des fragments : on reconstitue les lignes par position
        // verticale, sans quoi les libellés « Âge : 54 » sont coupés en morceaux.
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          lines.push(line.trim());
          line = '';
        }
        line += item.str;
        if (item.hasEOL) {
          lines.push(line.trim());
          line = '';
        }
        lastY = y;
      }
      if (line.trim().length > 0) lines.push(line.trim());
      let pageText = lines.filter((l) => l.length > 0).join('\n');

      // Page sans couche texte : un scan. On la rend en image et on la lit.
      if (pageText.replace(/\s/g, '').length < OCR_MIN_CHARS) {
        if (ocrUsable === null) ocrUsable = maxOcrPages > 0 && (await ocrStatus()).available;
        if (ocrUsable) {
          if (ocrAttempts >= maxOcrPages) {
            ocrSkipped++;
          } else {
            ocrAttempts++;
            const png = await renderPagePng(doc as unknown as RenderTarget, page);
            const ocr = png ? await runOcr(png) : null;
            if (ocr && ocr.text.length > 0) {
              pageText = [pageText, ocr.text].filter(Boolean).join('\n');
              ocrPages.push(i);
              ocrConfidences.push(ocr.confidence);
            }
          }
        }
      }

      pages.push(pageText);
      textChars += pageText.length;
      page.cleanup();
    }

    const text = pages.join('\n\n');
    const info = await doc.getMetadata().catch(() => null);

    return {
      text,
      metadata: {
        pageCount: doc.numPages,
        textLayer: text.trim().length > 0,
        // Lecture interrompue avant la fin : le texte rendu est partiel, et le dit.
        ...(stoppedBecause
          ? {
              pagesRead: pages.length,
              pagesTruncated: doc.numPages - pages.length,
              truncatedBecause: stoppedBecause,
            }
          : {}),
        pdfInfo: info?.info ?? null,
        ocrApplied: ocrPages.length > 0,
        ...(ocrPages.length > 0
          ? {
              ocrPages,
              ocrConfidence: Math.round(ocrConfidences.reduce((a, b) => a + b, 0) / ocrConfidences.length),
            }
          : {}),
        ...(ocrSkipped > 0 ? { ocrSkippedPages: ocrSkipped } : {}),
      },
    };
  } finally {
    await doc.destroy();
  }
}
