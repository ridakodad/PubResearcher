import type { BiblioSearch } from '../../lib/types';
import { formatDateTime } from '../../lib/format';
import { SOURCE_LABELS, formatPeriod } from './shared';

const STATUS: Record<BiblioSearch['status'], { label: string; className: string }> = {
  ok: { label: 'Réussie', className: 'badge badge-auto' },
  error: { label: 'Échec', className: 'badge badge-error' },
  running: { label: 'En cours', className: 'badge badge-warn' },
};

/**
 * Les stratégies de recherche : la pièce qu'un relecteur de revue systématique
 * demande en premier. Chaque passe — réussie ou non — garde sa chaîne exacte,
 * sa date, l'acteur interrogé et ce qu'elle a rendu.
 *
 * Six colonnes, pas davantage : la période et l'erreur vont sous l'équation, le
 * statut et l'action s'empilent. Le tableau tient ainsi sans défilement latéral
 * sur un écran d'ordinateur portable, où un statut coupé ne se lit pas.
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
    <div className="table-scroll" tabIndex={0} role="region" aria-label="Historique des recherches (défilement horizontal)">
      <table className="history">
        <thead>
          <tr>
            <th>Date</th>
            <th>Source</th>
            <th>Équation</th>
            <th className="num">Rendues</th>
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
            return (
              <tr key={search.id}>
                <td className="nowrap">{formatDateTime(search.queriedAt)}</td>
                <td>
                  <div>{SOURCE_LABELS[search.source]}</div>
                  <div className="mono muted history-actor" title="Acteur Apify interrogé">
                    {search.actor}
                  </div>
                </td>
                <td className="history-query">
                  <div>{search.query}</div>
                  <div className="small muted">
                    {period === '—' ? 'sans limite de date' : period}
                    {' · '}
                    {search.sort === 'date' ? 'plus récentes d’abord' : 'par pertinence'}
                  </div>
                  {failed && search.error && <div className="small history-error">{search.error}</div>}
                </td>
                <td className="num">
                  {search.returned}
                  <span className="muted"> / {search.maxResults}</span>
                </td>
                <td className="num">{search.added}</td>
                <td className="num">{search.duplicates}</td>
                <td>
                  <div className="history-status">
                    <span className={state.className}>{state.label}</span>
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
