import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatBytes } from '../lib/format';
import { ConfirmButton, ErrorPanel, Modal, Spinner, onTabKeyDown, useToast } from './ui';
import { IconAlert } from './icons';
import type { DocumentMeta, Evidence } from '../lib/types';

/**
 * Lecteur de documents, affiché à côté de la fiche pendant la relecture.
 *
 * La relecture consiste à confronter une valeur au document qui la justifie.
 * Tant que le document s'ouvrait dans une fenêtre modale, il fallait fermer
 * pour saisir puis rouvrir pour vérifier la variable suivante. Le lecteur
 * reste donc à l'écran, et suit la fiche : cliquer sur la justification d'une
 * variable l'amène sur le bon document, à la bonne ligne.
 */

type Mode = 'apercu' | 'texte';

/** Au-delà de ce nombre de documents, la liste déroulante remplace les onglets. */
const MAX_TABS = 8;

/**
 * Le serveur décide seul de ce qu'il accepte d'afficher dans la page, et le
 * calcule sur le nom de stockage. Le client s'y range plutôt que de rejouer la
 * règle sur un nom d'affichage que l'utilisateur peut avoir renommé.
 */
function hasNativePreview(doc: DocumentMeta): boolean {
  return doc.previewable;
}

function isPdf(doc: DocumentMeta): boolean {
  return doc.kind === 'pdf';
}

export interface ViewerFocus {
  documentId: number;
  evidence: Evidence;
  /** Change à chaque clic, même sur la même justification, pour rejouer le défilement. */
  nonce: number;
}

export function DocumentViewer({
  documents,
  focus,
  onReparse,
  onDelete,
  onAdd,
  onRenamed,
}: {
  documents: DocumentMeta[];
  focus: ViewerFocus | null;
  onReparse: (doc: DocumentMeta) => void;
  onDelete: (doc: DocumentMeta) => void;
  onAdd: () => void;
  onRenamed: () => void;
}) {
  const [selectedId, setSelectedId] = useState<number | null>(documents[0]?.id ?? null);
  const [mode, setMode] = useState<Mode>('apercu');
  const [enlarged, setEnlarged] = useState(false);
  /** Document en cours de renommage. Aucun bouton dédié : le nom se modifie
      sur place, au double-clic sur son onglet. */
  const [renaming, setRenaming] = useState<number | null>(null);

  const selected = documents.find((d) => d.id === selectedId) ?? documents[0] ?? null;
  const selectedIndex = selected ? documents.findIndex((d) => d.id === selected.id) : -1;
  const step = (delta: number) => {
    const next = documents[selectedIndex + delta];
    if (next) setSelectedId(next.id);
  };

  // Le document sélectionné peut disparaître (suppression) : on retombe sur le
  // premier plutôt que d'afficher un panneau vide.
  useEffect(() => {
    if (documents.length === 0) setSelectedId(null);
    else if (!documents.some((d) => d.id === selectedId)) setSelectedId(documents[0]!.id);
  }, [documents, selectedId]);

  // Le mode suit le format : un DOCX n'a pas d'aperçu, son texte est tout ce
  // qu'il y a à voir.
  useEffect(() => {
    if (selected && !hasNativePreview(selected)) setMode('texte');
  }, [selected]);

  /*
   * Une justification cliquée dans la fiche amène ici. On montre alors le
   * document lui-même — c'est le scan ou la photo que le relecteur veut voir,
   * pas sa transcription. La citation s'affiche au-dessus, et reste
   * consultable dans le texte extrait d'un clic pour qui veut la position
   * exacte. Les formats sans aperçu n'ont que leur texte à offrir.
   */
  useEffect(() => {
    if (!focus) return;
    setSelectedId(focus.documentId);
    const target = documents.find((d) => d.id === focus.documentId);
    if (target && !hasNativePreview(target)) setMode('texte');
    else setMode('apercu');
  }, [focus, documents]);

  if (documents.length === 0) {
    return (
      <div className="card">
        <div className="card-head">
          <h2>Documents</h2>
        </div>
        <div className="empty-state">
          <h3>Aucun document</h3>
          <p>Les documents importés ici alimentent l’extraction et servent de référence à la relecture.</p>
          <button className="btn-primary btn-sm" onClick={onAdd}>
            Ajouter des documents
          </button>
        </div>
      </div>
    );
  }

  if (!selected) return null;

  return (
    <>
      <div className="card doc-panel">
        <div className="card-head" style={{ gap: 8 }}>
          <h2>Documents</h2>
          <span className="sub">{documents.length}</span>
          <div className="card-actions">
            <button className="btn-sm" onClick={onAdd}>
              Ajouter
            </button>
          </div>
        </div>

        {/* Sélection du document : une puce par fichier, l'onglet courant marqué. Au-delà de quelques
            fichiers (une série DICOM en compte des centaines), les onglets débordent de l'écran et
            demandent autant d'appuis sur Tab : on passe à une liste déroulante. */}
        {documents.length > MAX_TABS ? (
          <div className="doc-picker">
            <button
              className="btn-sm"
              onClick={() => step(-1)}
              disabled={selectedIndex <= 0}
              aria-label="Document précédent"
            >
              ←
            </button>
            <select
              value={selected.id}
              onChange={(e) => setSelectedId(Number(e.target.value))}
              aria-label={`Document du dossier (${documents.length})`}
            >
              {documents.map((doc, i) => (
                <option key={doc.id} value={doc.id}>
                  {i + 1}/{documents.length} — {doc.filename}
                  {doc.parseStatus !== 'ok' ? ' (sans texte)' : ''}
                </option>
              ))}
            </select>
            <button
              className="btn-sm"
              onClick={() => step(1)}
              disabled={selectedIndex >= documents.length - 1}
              aria-label="Document suivant"
            >
              →
            </button>
          </div>
        ) : (
        <div className="doc-tabs" role="tablist" aria-label="Documents du dossier">
          {documents.map((doc) => (
            renaming === doc.id ? (
              <RenameField
                key={doc.id}
                doc={doc}
                onDone={() => {
                  setRenaming(null);
                  onRenamed();
                }}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <button
                key={doc.id}
                id={`doc-onglet-${doc.id}`}
                role="tab"
                aria-selected={doc.id === selected.id}
                aria-controls="doc-panneau"
                tabIndex={doc.id === selected.id ? 0 : -1}
                className={doc.id === selected.id ? 'doc-tab active' : 'doc-tab'}
                onClick={() => setSelectedId(doc.id)}
                onKeyDown={onTabKeyDown}
                onDoubleClick={() => setRenaming(doc.id)}
                title={`${doc.filename} — double-cliquer pour renommer`}
              >
                <span className="truncate">{doc.filename}</span>
                {doc.parseStatus !== 'ok' && (
                  <span className="doc-tab-flag" title="Aucun texte exploitable" aria-hidden="true" />
                )}
              </button>
            )
          ))}
        </div>
        )}

        <ViewerToolbar
          doc={selected}
          mode={mode}
          onMode={setMode}
          onEnlarge={() => setEnlarged(true)}
        />

        {/* La citation qui a motivé la valeur, gardée sous les yeux pendant
            qu'on regarde le document d'où elle vient. */}
        {focus && focus.documentId === selected.id && (
          <div className="doc-quote">
            <span className="doc-quote-text">« {focus.evidence.snippet} »</span>
            {mode !== 'texte' && (
              <button className="btn-sm" onClick={() => setMode('texte')}>
                Situer dans le texte
              </button>
            )}
          </div>
        )}

        {/* Un document lu en partie (texte tronqué, pages au-delà du plafond) : l'extraction ne voit pas le reste. */}
        {selected.parseStatus === 'ok' && selected.parseError && (
          <div className="notice notice-warn" role="note" style={{ margin: '8px 0 0' }}>
            <IconAlert size={16} />
            <div>
              <strong>Lecture incomplète.</strong> {selected.parseError}
            </div>
          </div>
        )}

        <div
          className="doc-body"
          id="doc-panneau"
          {...(documents.length > MAX_TABS ? {} : { role: 'tabpanel', 'aria-labelledby': `doc-onglet-${selected.id}` })}
        >
          <ViewerBody doc={selected} mode={mode} focus={focus} />
        </div>

        <div className="doc-foot">
          <span className="small muted">{formatBytes(selected.size)}</span>
          <div className="spacer" />
          <a
            className="btn btn-sm"
            href={api.documentFileUrl(selected.id)}
            target="_blank"
            rel="noreferrer"
          >
            Ouvrir le fichier
          </a>
          <button
            className="btn-sm btn-quiet"
            onClick={() => setRenaming(selected.id)}
            title="Donner un nom parlant à ce document"
          >
            Renommer
          </button>
          <button
            className="btn-sm btn-quiet"
            onClick={() => onReparse(selected)}
            title="Relancer l’analyse du fichier"
          >
            Ré-analyser
          </button>
          <ConfirmButton
            label="Supprimer"
            confirmLabel="Confirmer"
            subject={`le document ${selected.filename}`}
            onConfirm={() => onDelete(selected)}
          />
        </div>
      </div>

      {enlarged && (
        <Modal title={selected.filename} onClose={() => setEnlarged(false)} width={1240}>
          <div className="doc-enlarged">
            <ViewerBody doc={selected} mode={mode} focus={focus} />
          </div>
        </Modal>
      )}
    </>
  );
}

function ViewerToolbar({
  doc,
  mode,
  onMode,
  onEnlarge,
}: {
  doc: DocumentMeta;
  mode: Mode;
  onMode: (mode: Mode) => void;
  onEnlarge: () => void;
}) {
  const native = hasNativePreview(doc);
  return (
    <div className="doc-toolbar">
      <div className="row" style={{ gap: 4 }}>
        <button
          className={mode === 'apercu' ? 'btn-primary btn-sm' : 'btn-sm'}
          onClick={() => onMode('apercu')}
          disabled={!native}
          title={native ? undefined : "Ce format n’a pas d’aperçu dans le navigateur"}
        >
          Aperçu
        </button>
        <button
          className={mode === 'texte' ? 'btn-primary btn-sm' : 'btn-sm'}
          onClick={() => onMode('texte')}
        >
          Texte extrait
        </button>
      </div>
      <div className="spacer" />
      <button className="btn-sm" onClick={onEnlarge} title="Afficher en grand">
        Agrandir
      </button>
    </div>
  );
}

function ViewerBody({
  doc,
  mode,
  focus,
}: {
  doc: DocumentMeta;
  mode: Mode;
  focus: ViewerFocus | null;
}) {
  if (mode === 'apercu' && hasNativePreview(doc)) {
    if (isPdf(doc)) {
      /* `object` plutôt que `iframe` : quand le navigateur ne sait pas rendre
         le PDF, il affiche le contenu de repli au lieu d'un cadre vide. */
      return (
        <object
          className="doc-frame"
          data={api.documentFileUrl(doc.id)}
          type="application/pdf"
          aria-label={`Aperçu de ${doc.filename}`}
        >
          <div style={{ padding: 16 }}>
            <div className="notice notice-info">
              <IconAlert size={18} />
              <div>
                Ce navigateur n’affiche pas les PDF dans la page.{' '}
                <a href={api.documentFileUrl(doc.id)} target="_blank" rel="noreferrer">
                  Ouvrir le fichier dans un onglet
                </a>
                , ou consultez le texte extrait.
              </div>
            </div>
          </div>
        </object>
      );
    }
    return <ImagePreview doc={doc} />;
  }
  return <TextPreview doc={doc} focus={focus} />;
}

/**
 * Aperçu d'image avec agrandissement.
 *
 * Une photo de compte rendu est souvent illisible à la largeur du panneau :
 * il faut pouvoir grossir et se déplacer dans l'image sans quitter la fiche.
 */
function ImagePreview({ doc }: { doc: DocumentMeta }) {
  const [zoom, setZoom] = useState(100);

  // Repartir de la largeur ajustée en changeant de document : le grossissement
  // choisi pour l'un n'a pas de sens pour le suivant.
  useEffect(() => setZoom(100), [doc.id]);

  const step = (delta: number) => setZoom((z) => Math.min(500, Math.max(50, z + delta)));

  return (
    <div className="doc-image-wrap">
      <div className="doc-zoom">
        <button className="btn-sm" onClick={() => step(-25)} disabled={zoom <= 50} aria-label="Réduire">
          −
        </button>
        <span className="small mono" style={{ minWidth: 46, textAlign: 'center' }}>
          {zoom} %
        </span>
        <button className="btn-sm" onClick={() => step(25)} disabled={zoom >= 500} aria-label="Agrandir">
          +
        </button>
        <button className="btn-sm" onClick={() => setZoom(100)} disabled={zoom === 100}>
          Ajuster
        </button>
      </div>
      <div className="doc-image-scroll">
        <img
          src={api.documentFileUrl(doc.id)}
          alt={doc.filename}
          style={{ width: `${zoom}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Texte réellement extrait, avec la citation mise en évidence.
 *
 * C'est la vue qui explique un échec d'extraction : si le texte est vide ou
 * mal reconnu, la règle ne pouvait rien trouver.
 */
function TextPreview({ doc, focus }: { doc: DocumentMeta; focus: ViewerFocus | null }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const markRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setError(null);
    api
      .getDocumentText(doc.id)
      .then((r) => !cancelled && setText(r.text))
      .catch((err) => !cancelled && setError(err instanceof ApiError ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [doc.id]);

  const range = useMemo(() => {
    if (text === null || !focus || focus.documentId !== doc.id) return null;
    return locateEvidence(text, focus.evidence);
  }, [text, focus, doc.id]);

  // Amener la citation sous les yeux, une fois le texte rendu.
  useEffect(() => {
    if (!range || !markRef.current) return;
    const motionOk = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    markRef.current.scrollIntoView({
      behavior: motionOk ? 'smooth' : 'auto',
      block: 'center',
    });
  }, [range, focus?.nonce]);

  if (error) return <ErrorPanel message={error} />;
  if (text === null) {
    return (
      <div style={{ padding: 16 }}>
        <Spinner label="Chargement du texte…" />
      </div>
    );
  }

  if (text.trim().length === 0) return <EmptyTextNotice doc={doc} />;

  return (
    <>
      <OcrNotice metadata={doc.metadata} />
      <pre className="doc-text">
        {range ? (
          <>
            {text.slice(0, range.start)}
            <mark className="doc-mark" ref={markRef}>
              {text.slice(range.start, range.end)}
            </mark>
            {text.slice(range.end)}
          </>
        ) : (
          text
        )}
      </pre>
    </>
  );
}

/**
 * Pourquoi un document n'a aucun texte — la vraie cause, pas la plus fréquente.
 *
 * Dire « PDF scanné ou OCR indisponible » d'un fichier .exe ou d'un Word corrompu envoie le chercheur sur
 * une fausse piste : il active l'OCR, et rien ne change.
 */
function EmptyTextNotice({ doc }: { doc: DocumentMeta }) {
  const meta = doc.metadata;
  const ocrApplied = meta['ocrApplied'] === true;
  const ocrSkipped = typeof meta['ocrSkipped'] === 'string' ? meta['ocrSkipped'] : null;
  let message: string;
  let hint = 'Les variables correspondantes devront être saisies à la main.';

  if (doc.parseStatus === 'error' && doc.parseError) {
    message = `Ce document n’a pas pu être lu : ${doc.parseError}`;
  } else if (doc.kind === 'unknown') {
    message = 'Format non pris en charge. Formats acceptés : PDF, Word (.docx), images, DICOM et texte.';
    hint = 'Convertissez le fichier (en PDF ou en .docx), puis réimportez-le.';
  } else if (ocrSkipped) {
    message = `La reconnaissance optique n’a pas été lancée : ${ocrSkipped}.`;
  } else if ((doc.kind === 'image' || doc.kind === 'pdf') && ocrApplied) {
    message = 'La reconnaissance optique n’a trouvé aucun texte : page vide, image trop sombre ou écriture manuscrite.';
  } else if (doc.kind === 'image' || (doc.kind === 'pdf' && meta['textLayer'] === false)) {
    message =
      'Ce document est une image sans texte (scan, photo) et la reconnaissance optique n’est pas disponible sur ce poste.';
    hint = 'Activez-la (voir le guide d’administration), puis cliquez sur « Ré-analyser ». À défaut, saisissez les variables à la main.';
  } else {
    message = 'Le fichier ne contient aucun texte.';
  }

  return (
    <div style={{ padding: 16 }}>
      <div className="notice notice-warn">
        <IconAlert size={18} />
        <div>
          {message} {hint}
        </div>
      </div>
    </div>
  );
}

/**
 * Prévient que le texte vient d'une lecture optique.
 *
 * Un OCR confond un 1 et un l, un 5 et un S, et perd parfois un « pas » : la
 * valeur extraite d'un scan se relit contre l'image, pas contre sa transcription.
 * Le bandeau le rappelle là où le relecteur regarde, avec la confiance mesurée.
 */
function OcrNotice({ metadata }: { metadata: Record<string, unknown> }) {
  if (metadata['ocrApplied'] !== true) return null;
  const confidence =
    typeof metadata['ocrConfidence'] === 'number' ? Math.round(metadata['ocrConfidence']) : null;
  const pages = Array.isArray(metadata['ocrPages']) ? (metadata['ocrPages'] as number[]) : [];
  const skipped = typeof metadata['ocrSkippedPages'] === 'number' ? metadata['ocrSkippedPages'] : 0;
  return (
    <div className="doc-ocr" role="note">
      <IconAlert size={16} />
      <div>
        Texte reconnu par OCR
        {confidence !== null && ` (confiance moyenne ${confidence} %)`}
        {pages.length > 0 && ` — page${pages.length > 1 ? 's' : ''} ${pages.join(', ')}`}. Une lecture
        optique peut confondre des chiffres ou perdre une négation : confrontez les valeurs à
        l’image du document.
        {skipped > 0 &&
          ` ${skipped} page${skipped > 1 ? 's' : ''} n'${skipped > 1 ? 'ont' : 'a'} pas été lue${skipped > 1 ? 's' : ''} (plafond de pages OCR atteint : relevez OCR_MAX_PAGES si ce document le justifie).`}
      </div>
    </div>
  );
}

/**
 * Retrouve la citation dans le texte affiché.
 *
 * Les positions enregistrées lors de l'extraction peuvent avoir vieilli : le
 * document a pu être ré-analysé depuis, avec un texte légèrement différent.
 * On les vérifie donc avant de s'y fier, et on retombe sur une recherche de
 * l'extrait quand elles ne correspondent plus.
 */
export function locateEvidence(
  text: string,
  evidence: Evidence,
): { start: number; end: number } | null {
  const { start, end, snippet } = evidence;

  if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= text.length) {
    const atPosition = text.slice(start, end);
    if (atPosition.trim().length > 0 && snippet.includes(atPosition.trim())) {
      return { start, end };
    }
  }

  // `makeSnippet` encadre la correspondance de points de suspension : on ne
  // garde que le corps pour la recherche de repli.
  const core = snippet.replace(/^…\s*/, '').replace(/\s*…$/, '').trim();
  if (core.length === 0) return null;
  const found = text.indexOf(core);
  return found === -1 ? null : { start: found, end: found + core.length };
}

/**
 * Renommage sur place.
 *
 * Le nom d'un document est une étiquette de travail : « CR opératoire » se
 * relit mieux que « IMG_2381 » sur trente dossiers. Le fichier, son empreinte
 * et son texte extrait ne bougent pas — renommer ne peut donc invalider ni une
 * extraction ni une justification.
 */
function RenameField({
  doc,
  onDone,
  onCancel,
}: {
  doc: DocumentMeta;
  onDone: () => void;
  onCancel: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState(doc.filename);
  const [saving, setSaving] = useState(false);

  /** `keepOpen` : l'utilisateur est encore dans le champ (Entrée) — on l'y laisse corriger plutôt que de le renvoyer. */
  const commit = async (keepOpen: boolean) => {
    const name = value.trim();
    if (name.length === 0 || name === doc.filename) return onCancel();
    setSaving(true);
    try {
      await api.renameDocument(doc.id, name);
      onDone();
    } catch (error) {
      // Le nom d'origine est conservé : rien n'est perdu. Mais l'échec se dit — sans cela, le champ se fermait en silence.
      toast.error(error instanceof ApiError ? error.message : 'Le document n’a pas pu être renommé.');
      setSaving(false);
      if (!keepOpen) onCancel();
    }
  };

  return (
    <input
      className="doc-tab-input"
      autoFocus
      disabled={saving}
      value={value}
      aria-label={`Nouveau nom pour ${doc.filename}`}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => void commit(false)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void commit(true);
        if (e.key === 'Escape') onCancel();
      }}
    />
  );
}
