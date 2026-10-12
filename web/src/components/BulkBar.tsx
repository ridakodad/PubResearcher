import { ConfirmButton } from './ui';

/**
 * Barre des actions groupées : apparaît dès qu'un élément est coché. Elle dit combien d'éléments sont visés,
 * permet d'étendre la sélection à toute la liste (filtre compris) et de supprimer d'un geste confirmé.
 */
export function BulkBar({
  count,
  total,
  noun,
  onSelectAll,
  onClear,
  onDelete,
  busy,
  feminine,
}: {
  count: number;
  total: number;
  /** Nom au pluriel des éléments (« dossiers », « variables »). */
  noun: string;
  onSelectAll: () => void;
  onClear: () => void;
  onDelete: () => void;
  busy?: boolean;
  /** Accord au féminin (« variables sélectionnées »). */
  feminine?: boolean;
}) {
  if (count === 0) return null;
  return (
    <div className="bulk-bar" role="region" aria-label="Actions sur la sélection">
      <strong className="bulk-count" aria-live="polite">
        {count} {count > 1 ? noun : noun.replace(/s$/, '')} sélectionné{feminine ? 'e' : ''}{count > 1 ? 's' : ''}
      </strong>
      {count < total && (
        <button className="btn-sm btn-quiet" onClick={onSelectAll}>
          Tout sélectionner ({total})
        </button>
      )}
      <button className="btn-sm btn-quiet" onClick={onClear}>
        Désélectionner
      </button>
      <span className="bulk-spacer" />
      <ConfirmButton
        label={busy ? 'Suppression…' : `Supprimer la sélection (${count})`}
        confirmLabel={`Confirmer la suppression de ${count}`}
        subject={`${count} ${noun}`}
        title="Suppression définitive"
        onConfirm={onDelete}
      />
    </div>
  );
}

/** Case à cocher d'en-tête : cochée si tout est sélectionné, « indéterminée » si une partie l'est. */
export function SelectAllBox({ checked, partial, onChange, label }: { checked: boolean; partial: boolean; onChange: () => void; label: string }) {
  return (
    <input
      type="checkbox"
      className="row-check"
      aria-label={label}
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = partial && !checked;
      }}
      onChange={onChange}
    />
  );
}
