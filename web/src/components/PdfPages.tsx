import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy } from 'pdfjs-dist';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/**
 * Aperçu d'un PDF dessiné par l'application elle-même (pdf.js), page par page.
 *
 * Le lecteur PDF du navigateur n'est pas toujours là : navigateur réglé pour télécharger les PDF, Edge ou Firefox
 * administrés, fenêtres intégrées, navigateurs sans greffon. Rendu ici, le document s'affiche partout, à côté de la
 * fiche, et la page qui contient l'extrait cliqué est mise en vue et surlignée.
 */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

export function PdfPages({ url, label, snippet, nonce }: { url: string; label: string; snippet?: string | null; nonce?: number }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [width, setWidth] = useState(0);
  const [hit, setHit] = useState<number | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const pageRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;
    setPdf(null);
    setError(null);
    (async () => {
      try {
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`le serveur a répondu ${res.status}`);
        const data = new Uint8Array(await res.arrayBuffer());
        doc = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
        if (!cancelled) setPdf(doc);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
      void doc?.destroy();
    };
  }, [url]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth - 24));
    ro.observe(el);
    setWidth(el.clientWidth - 24);
    return () => ro.disconnect();
  }, []);

  // Page de l'extrait cliqué : on cherche le début de l'extrait dans le texte de chaque page.
  useEffect(() => {
    if (!pdf || !snippet) {
      setHit(null);
      return;
    }
    const needle = fold(snippet.replace(/^…|…$/g, '')).slice(0, 40);
    if (needle.length < 4) return;
    let cancelled = false;
    (async () => {
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const text = fold((await page.getTextContent()).items.map((i) => ('str' in i ? i.str : '')).join(' '));
        if (text.includes(needle.slice(0, 24))) {
          if (cancelled) return;
          setHit(n);
          pageRefs.current[n - 1]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
          return;
        }
      }
      if (!cancelled) setHit(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [pdf, snippet, nonce]);

  if (error) {
    return (
      <div className="notice notice-warn" style={{ margin: 16 }}>
        <div>
          Le PDF n’a pas pu être affiché ({error}).{' '}
          <a href={url} target="_blank" rel="noreferrer">
            Ouvrir le fichier dans un onglet
          </a>
          , ou consultez le texte extrait.
        </div>
      </div>
    );
  }

  return (
    <div className="pdf-viewer" aria-label={`Aperçu de ${label}`}>
      <div className="pdf-toolbar">
        <span className="small muted">{pdf ? `${pdf.numPages} page${pdf.numPages > 1 ? 's' : ''}` : 'Chargement…'}</span>
        {hit && <span className="badge badge-auto">Extrait page {hit}</span>}
        <span style={{ marginLeft: 'auto' }} />
        <button className="btn-sm" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Réduire">
          −
        </button>
        <span className="small tabular" style={{ minWidth: 44, textAlign: 'center' }}>
          {Math.round(zoom * 100)} %
        </span>
        <button className="btn-sm" onClick={() => setZoom((z) => Math.min(3, +(z + 0.25).toFixed(2)))} aria-label="Agrandir">
          +
        </button>
      </div>
      <div ref={box} className="pdf-pages">
        {pdf &&
          width > 0 &&
          Array.from({ length: pdf.numPages }, (_, i) => (
            <PdfPage
              key={i}
              pdf={pdf}
              number={i + 1}
              width={width * zoom}
              highlighted={hit === i + 1}
              refCb={(el) => (pageRefs.current[i] = el)}
            />
          ))}
      </div>
    </div>
  );
}

function PdfPage({
  pdf,
  number,
  width,
  highlighted,
  refCb,
}: {
  pdf: PDFDocumentProxy;
  number: number;
  width: number;
  highlighted: boolean;
  refCb: (el: HTMLDivElement | null) => void;
}) {
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const holder = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(number <= 2);
  const [ratio, setRatio] = useState(1.414);

  // Les pages se dessinent quand elles approchent de l'écran : un compte rendu de 80 pages s'ouvre aussitôt.
  useEffect(() => {
    const el = holder.current;
    if (!el || visible) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !canvas.current || width <= 0) return;
    let task: { cancel: () => void } | null = null;
    let cancelled = false;
    void pdf.getPage(number).then((page) => {
      if (cancelled || !canvas.current) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const dpr = window.devicePixelRatio || 1;
      const viewport = page.getViewport({ scale: (width / base.width) * dpr });
      const c = canvas.current;
      c.width = Math.floor(viewport.width);
      c.height = Math.floor(viewport.height);
      c.style.width = `${Math.floor(width)}px`;
      c.style.height = `${Math.floor(viewport.height / dpr)}px`;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      task = page.render({ canvasContext: ctx, viewport });
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [pdf, number, width, visible]);

  return (
    <div
      ref={(el) => {
        holder.current = el;
        refCb(el);
      }}
      className={highlighted ? 'pdf-page is-hit' : 'pdf-page'}
      style={{ minHeight: visible ? undefined : width * ratio }}
    >
      <canvas ref={canvas} aria-label={`Page ${number}`} />
      <span className="pdf-page-no">{number}</span>
    </div>
  );
}
