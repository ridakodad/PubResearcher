import type { BiblioSearch } from '../../lib/types';
import { formatDateTime } from '../../lib/format';
import { SOURCE_LABELS, fmtCount, formatPeriod } from './shared';

const STATUS: Record<BiblioSearch['status'], { label: string; className: string }> = {
  ok: { label: 'Réussie', className: 'badge badge-auto' },
  error: { label: 'Échec', className: 'badge badge-error' },
  running: { label: 'En cours', className: 'badge badge-warn' },
};

/** « 712 notices récupérées sur 712 annoncées » : ce que PRISMA-S demande pour chaque source. */
function retrievedLabel(search: BiblioSearch): string {
  if (search.totalCount === null) return `${fmtCount(search.returned)} notice${search.returned > 1 ? 's' : ''}`;
  return `${fmtCount(search.returned)} sur ${fmtCount(search.totalCount)}`;
}

/**
 * Le journal de recherche : la pièce qu'un relecteur de revue systématique
 * demande en premier. Chaque passe — réussie ou non — et chaque import gardent
 * leur date, leur source, l'équation exacte (et sa traduction par PubMed) ou le
 * fichier importé, et ce qu'ils ont rendu.
 *
 * Six colonnes, pas davantage : la période, les avertissements et l'erreur vont
 * sous l'équation, le statut et l'action s'empilent. Le tableau tient ainsi
 * sans défilement latéral sur un écran d'ordinateur portable.
 */
export function SearchHistory({
  searches,
  onReuse,
}: {
  searches: BiblioSearch[];
  onReuse: (search: BiblioSearch) => void;
}) {
  const ordered = [...searches].sort((a, b) => b.id - a.id);

  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Historique des recherches et des imports (défilement horizontal)">
      <table className="history">
        <thead>
          <tr>
            <th>Date</th>
            <th>Source</th>
            <th>Équation ou fichier</th>
            <th className="num" title="Notices récupérées, sur le nombre total annoncé par la source">
              Récupérées
            </th>
            <th className="num">Nouvelles</th>
            <th className="num">Connues</th>
            <th>Statut</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((search) => {
            const state = STATUS[search.status];
            const period = formatPeriod(search.yearFrom, search.yearTo);
            const failed = search.status === 'error';
            const imported = search.kind === 'import';
            return (
              <tr key={search.id}>
                <td className="nowrap">{formatDateTime(search.queriedAt)}</td>
                <td>
                  <div>
                    {SOURCE_LABELS[search.source]}
                    {search.sourceLabel && <span className="muted"> — {search.sourceLabel}</span>}
                  </div>
                  <div
                    className="mono muted history-actor"
                    title={imported ? 'Format du fichier importé' : 'Service interrogé'}
                  >
                    {imported ? `import ${search.actor}` : search.actor}
                  </div>
                </td>
                <td className="history-query">
                  {imported ? (
                    <div className="mono">{search.fileName}</div>
                  ) : (
                    <>
                      <div>{search.query}</div>
                      <div className="small muted">
                        {period === '—' ? 'sans limite de date' : period}
                        {' · '}
                        {search.sort === 'date' ? 'plus récentes d’abord' : 'par pertinence'}
                        {search.source === 'pubmed' && (search.maxResults > 0 ? ` · ${search.maxResults} premières` : ' · toutes')}
                      </div>
                      {search.sentQuery && (
                        <div className="small muted">
                          Envoyée : <span className="mono">{search.sentQuery}</span>
                        </div>
                      )}
                      {search.queryTranslation && (
                        <details className="small history-translation">
                          <summary>Traduction par PubMed</summary>
                          <code>{search.queryTranslation}</code>
                        </details>
                      )}
                    </>
                  )}
                  {search.warnings.map((warning) => (
                    <div key={warning} className="small history-warn">
                      {warning}
                    </div>
                  ))}
                  {failed && search.error && <div className="small history-error">{search.error}</div>}
                </td>
                <td className="num nowrap">{failed && search.totalCount === null ? '—' : retrievedLabel(search)}</td>
                <td className="num">{fmtCount(search.added)}</td>
                <td className="num">{fmtCount(search.duplicates)}</td>
                <td>
                  <div className="history-status">
                    <span className={state.className}>{state.label}</span>
                    {!imported && (
                      <button
                        type="button"
                        className="btn-sm btn-quiet"
                        title={
                          failed
                            ? 'Recharger cette équation dans le formulaire, avec cette seule source'
                            : 'Recharger cette équation, sa période et son ordre dans le formulaire'
                        }
                        onClick={() => onReuse(search)}
                      >
                        Reprendre
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
