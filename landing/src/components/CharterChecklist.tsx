import { CHARTER_ITEMS } from '../lib/charter';

/**
 * Les engagements de la charte d'anonymisation, à cocher un par un.
 *
 * Même texte que dans l'application (voir lib/charter.ts) : ce qui est confirmé ici est ce que l'application redemande
 * avant l'import. Le bouton de confirmation reste à la charge de la page qui l'affiche — il n'est actif que lorsque
 * tout est coché.
 */
export function CharterChecklist({
  checked,
  onToggle,
}: {
  checked: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const total = CHARTER_ITEMS.length;
  const done = CHARTER_ITEMS.filter((item) => checked.has(item.id)).length;

  return (
    <>
      <fieldset className="charter-list">
        <legend className="sr-only">Mes engagements avant d’importer des données de patients</legend>
        {CHARTER_ITEMS.map((item) => (
          <label className="charter-item" key={item.id}>
            <input type="checkbox" checked={checked.has(item.id)} onChange={() => onToggle(item.id)} />
            <span>{item.text}</span>
          </label>
        ))}
      </fieldset>
      <p className="small muted" aria-live="polite">
        {done === total
          ? 'Les cinq engagements sont confirmés.'
          : `${done} engagement${done > 1 ? 's' : ''} confirmé${done > 1 ? 's' : ''} sur ${total}.`}
      </p>
    </>
  );
}
