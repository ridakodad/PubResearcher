import { useId, useRef, useState } from 'react';
import type { BiblioSource, BiblioStatus, PrismaCategory } from '../../lib/types';
import { formatBytes } from '../../lib/format';

/**
 * Import d'un export d'une autre base : Embase, Cochrane CENTRAL, Scopus, Web
 * of Science, LiSSa, une bibliothèque Zotero…
 *
 * La base d'origine se déclare : c'est elle qui range les notices dans la
 * bonne colonne du diagramme de flux (base de données, registre, autres
 * méthodes). Le format, lui, se reconnaît tout seul.
 */

const CATEGORY_LABELS: Record<PrismaCategory, string> = {
  database: 'Bases de données',
  register: 'Registres d’essais',
  other: 'Autres méthodes',
};

/** Extensions proposées par le sélecteur de fichier ; le serveur reconnaît le format au contenu. */
const ACCEPT = '.ris,.nbib,.medline,.txt,.bib,.bibtex,.csv,.tsv,application/x-research-info-systems,application/x-bibtex,text/csv,text/plain';

export function ImportForm({
  status,
  busy,
  onImport,
}: {
  status: BiblioStatus;
  busy: boolean;
  /** Rend `true` si l'import a réussi : le formulaire se vide alors. */
  onImport: (file: File, source: BiblioSource, label: string) => Promise<boolean>;
}) {
  const sourceId = useId();
  const labelId = useId();
  const fileId = useId();
  const hintId = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [source, setSource] = useState<BiblioSource | ''>('');
  const [label, setLabel] = useState('');
  const [file, setFile] = useState<File | null>(null);

  const tooBig = file !== null && file.size > status.importMaxBytes;
  const problem =
    source === ''
      ? 'Choisissez la base d’où vient le fichier.'
      : file === null
        ? 'Choisissez un fichier.'
        : tooBig
          ? `Fichier trop volumineux : au plus ${formatBytes(status.importMaxBytes)} par import.`
          : null;
  const named = source === 'other' || source === 'other_db';

  async function submit() {
    if (problem || !file || source === '') return;
    const done = await onImport(file, source, named ? label.trim() : '');
    if (done) {
      setFile(null);
      setLabel('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy) void submit();
      }}
    >
      <div className="grid grid-2 form-grid">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={sourceId}>Base d’origine</label>
          <select id={sourceId} value={source} onChange={(event) => setSource(event.target.value as BiblioSource | '')}>
            <option value="">Choisir la base…</option>
            {(Object.keys(CATEGORY_LABELS) as PrismaCategory[]).map((category) => (
              <optgroup key={category} label={CATEGORY_LABELS[category]}>
                {status.importSources
                  .filter((s) => s.category === category)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
          <div className="field-hint">
            Elle range les notices dans la bonne colonne du diagramme de flux : Google Scholar et « Autre » comptent
            sous « autres méthodes ».
          </div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={fileId}>Fichier exporté</label>
          <input
            ref={fileRef}
            id={fileId}
            type="file"
            accept={ACCEPT}
            aria-describedby={hintId}
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
          <div className="field-hint" id={hintId}>
            RIS (.ris), MEDLINE/PubMed (.nbib), BibTeX (.bib) ou CSV avec une ligne d’en-tête (title, authors, year, doi,
            pmid…). Au plus {formatBytes(status.importMaxBytes)}.
          </div>
        </div>
      </div>

      {named && (
        <div className="field" style={{ marginBottom: 0, maxWidth: 420 }}>
          <label htmlFor={labelId}>Nom de la source (facultatif)</label>
          <input
            id={labelId}
            type="text"
            maxLength={120}
            value={label}
            placeholder="par exemple : bibliothèque Zotero du service, recherche de citations"
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
      )}

      <div className="row" style={{ gap: 14 }}>
        <button type="submit" className="btn-primary" disabled={problem !== null || busy} aria-busy={busy}>
          {busy ? (
            <>
              <span className="spinner spinner-inline" aria-hidden="true" />
              <span>Import en cours…</span>
            </>
          ) : (
            'Importer les références'
          )}
        </button>
        <span className="small muted" style={{ flex: 1, minWidth: 240 }}>
          {problem ??
            `${file?.name ?? ''} (${formatBytes(file?.size ?? 0)}) : chaque notice passe par le dédoublonnage, et l’import est consigné dans le journal de recherche.`}
        </span>
      </div>
    </form>
  );
}
