import { useId, useState } from 'react';
import type { BiblioDecision, BiblioRef, ExclusionReason } from '../../lib/types';
import { IconExternal } from '../icons';
import { guessLang } from '../../lib/format';
import {
  DECISION_BADGE,
  DECISION_LABELS,
  SOURCE_LABELS,
  doiHref,
  formatAuthors,
  formatCitation,
  pmcHref,
  pmidHref,
  safeHref,
} from './shared';

export interface DecidePatch {
  decision?: BiblioDecision;
  exclusionReason?: ExclusionReason | null;
  note?: string | null;
}

/**
 * Une référence, et de quoi la trier.
 *
 * Trier se fait en trois gestes : retenir, mettre de côté, exclure. L'exclusion
 * demande son motif avant de partir — c'est lui que le diagramme de flux
 * dénombre, et le serveur refuse une exclusion sans lui.
 */
export function RefCard({
  item,
  reasons,
  onDecide,
}: {
  item: BiblioRef;
  reasons: Record<ExclusionReason, string>;
  /** Rend `true` si le serveur a enregistré le changement. Gère lui-même l'affichage des erreurs. */
  onDecide: (id: number, patch: DecidePatch) => Promise<boolean>;
}) {
  const [picking, setPicking] = useState(false);
  const [reason, setReason] = useState<ExclusionReason | ''>(item.exclusionReason ?? '');
  const [note, setNote] = useState(item.note ?? '');
  const [busy, setBusy] = useState(false);
  const reasonId = useId();
  const noteId = useId();

  const href = safeHref(item.url);
  const pdf = safeHref(item.pdfUrl);
  const citedByHref = safeHref(item.citedByUrl);
  const pmid = item.pmid ? pmidHref(item.pmid) : null;
  const pmc = item.pmcid ? pmcHref(item.pmcid) : null;
  const summary = item.abstract ?? item.snippet;
  const summaryLabel = item.abstract ? 'Résumé' : 'Extrait affiché par Google Scholar (ce n’est pas le résumé)';

  async function decide(decision: BiblioDecision, exclusionReason?: ExclusionReason) {
    setBusy(true);
    try {
      const saved = await onDecide(item.id, { decision, ...(exclusionReason ? { exclusionReason } : {}) });
      if (saved) setPicking(false);
    } finally {
      setBusy(false);
    }
  }

  async function saveNote() {
    const next = note.trim();
    if (next === (item.note ?? '')) return;
    setBusy(true);
    try {
      await onDecide(item.id, { note: next === '' ? null : next });
    } finally {
      setBusy(false);
    }
  }

  const pressed = (decision: BiblioDecision) => item.decision === decision;

  return (
    <article className={`card ref-card ref-${item.decision}`}>
      <div className="card-body ref-body">
        <header className="ref-head">
          <h3 className="ref-title" lang={guessLang(item.title)}>
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer">
                {item.title}
                <IconExternal size={13} className="ref-external" />
              </a>
            ) : (
              item.title
            )}
          </h3>
          <div className="ref-badges">
            {item.sources.map((source) => (
              <span key={source} className="badge">
                {SOURCE_LABELS[source]}
              </span>
            ))}
            <span className={DECISION_BADGE[item.decision]}>
              {DECISION_LABELS[item.decision]}
              {item.exclusionReason && ` · ${reasons[item.exclusionReason]}`}
            </span>
          </div>
        </header>

        <div className="ref-meta">
          <div>{formatAuthors(item.authors)}</div>
          {formatCitation(item) && <div className="ref-cite">{formatCitation(item)}</div>}
        </div>

        <div className="ref-ids">
          {item.doi && (
            <a className="badge ref-id" href={doiHref(item.doi)} target="_blank" rel="noopener noreferrer">
              DOI {item.doi}
            </a>
          )}
          {item.pmid &&
            (pmid ? (
              <a className="badge ref-id" href={pmid} target="_blank" rel="noopener noreferrer">
                PMID {item.pmid}
              </a>
            ) : (
              <span className="badge ref-id">PMID {item.pmid}</span>
            ))}
          {item.pmcid &&
            (pmc ? (
              <a className="badge ref-id" href={pmc} target="_blank" rel="noopener noreferrer">
                {item.pmcid}
              </a>
            ) : (
              <span className="badge ref-id">{item.pmcid}</span>
            ))}
          {pdf && (
            <a className="badge ref-id" href={pdf} target="_blank" rel="noopener noreferrer">
              PDF
            </a>
          )}
          {item.citedBy !== null &&
            (citedByHref ? (
              <a className="badge ref-id" href={citedByHref} target="_blank" rel="noopener noreferrer">
                Cité {item.citedBy.toLocaleString('fr-FR')} fois
              </a>
            ) : (
              <span className="badge ref-id">Cité {item.citedBy.toLocaleString('fr-FR')} fois</span>
            ))}
          {item.titleTruncated && (
            <span className="badge badge-warn" title="Google Scholar coupe les titres longs ; le dédoublonnage en tient compte.">
              Titre tronqué par Scholar
            </span>
          )}
          {/* « Journal Article » qualifie presque toute notice : il n'aide pas à trier. */}
          {item.publicationTypes
            .filter((type) => type !== 'Journal Article')
            .slice(0, 3)
            .map((type) => (
              <span key={type} className="badge badge-type" title="Type de publication selon PubMed">
                {type}
              </span>
            ))}
        </div>

        {summary && (
          <details className="ref-details">
            <summary>{summaryLabel}</summary>
            <p className="ref-abstract" lang={guessLang(summary)}>
              {summary}
            </p>
            {item.meshTerms.length > 0 && (
              <p className="small muted ref-mesh">
                <strong>MeSH :</strong> {item.meshTerms.join(' · ')}
              </p>
            )}
          </details>
        )}

        <div className="ref-actions">
          <div className="decision-group" role="group" aria-label="Décision de tri">
            <button
              type="button"
              className="btn-sm"
              data-decision="include"
              aria-pressed={pressed('include')}
              disabled={busy}
              onClick={() => void decide('include')}
            >
              Retenir
            </button>
            <button
              type="button"
              className="btn-sm"
              data-decision="maybe"
              aria-pressed={pressed('maybe')}
              disabled={busy}
              onClick={() => void decide('maybe')}
            >
              À voir
            </button>
            <button
              type="button"
              className="btn-sm"
              data-decision="exclude"
              aria-pressed={pressed('exclude')}
              aria-expanded={picking}
              disabled={busy}
              onClick={() => setPicking((open) => !open)}
            >
              Exclure…
            </button>
          </div>
          {item.decision !== 'pending' && (
            <button
              type="button"
              className="btn-sm btn-quiet"
              disabled={busy}
              onClick={() => void decide('pending')}
            >
              Remettre à trier
            </button>
          )}
        </div>

        {picking && (
          <div className="exclude-box">
            <label htmlFor={reasonId}>Motif d’exclusion</label>
            <select
              id={reasonId}
              value={reason}
              onChange={(event) => setReason(event.target.value as ExclusionReason | '')}
            >
              <option value="">Choisir un motif…</option>
              {(Object.entries(reasons) as [ExclusionReason, string][]).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-sm btn-primary"
              disabled={reason === '' || busy}
              onClick={() => reason !== '' && void decide('exclude', reason)}
            >
              Confirmer l’exclusion
            </button>
            <button type="button" className="btn-sm btn-quiet" onClick={() => setPicking(false)}>
              Annuler
            </button>
          </div>
        )}

        <div className="ref-note">
          <label htmlFor={noteId} className="sr-only">
            Note de lecture
          </label>
          <input
            id={noteId}
            type="text"
            value={note}
            maxLength={2000}
            placeholder="Note de lecture (facultatif)"
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
            onBlur={() => void saveNote()}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
        </div>
      </div>
    </article>
  );
}
