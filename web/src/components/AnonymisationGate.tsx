import { useId, useState, type ReactNode } from 'react';
import {
  ACK_KEY,
  ANONYMISATION_VERSION,
  CHARTER_DISCLAIMER,
  CHARTER_ITEMS,
  CHARTER_LEAD,
  CHARTER_TITLE,
  allConfirmed,
  isAcknowledged,
  serialiseAcknowledgement,
} from '../lib/anonymisation';
import { readSetting, writeSetting } from '../lib/storage';
import { IconShield } from './icons';

const SECURITY_DOC = 'https://github.com/ridakodad/PubResearcher/blob/main/docs/securite-et-donnees.md';

/**
 * Charte d'anonymisation, placée devant tout ce qui fait entrer des documents de patients.
 *
 * Tant que la charte n'a pas été confirmée (dans ce navigateur, pour cette version du texte), l'écran d'import
 * n'existe pas : on ne peut pas choisir un fichier. Une fois confirmée, elle ne gêne plus — un rappel d'une ligne
 * reste affiché, et se déplie pour relire les engagements.
 *
 * C'est un rappel, pas un contrôle : l'outil ne peut pas savoir si un document est anonymisé (docs/securite-et-donnees.md).
 * La confirmation n'est mémorisée que dans le navigateur ; sans stockage, elle est redemandée à chaque ouverture.
 */
export function AnonymisationGate({ children }: { children: ReactNode }) {
  const [acknowledged, setAcknowledged] = useState(() => isAcknowledged(readSetting(ACK_KEY)));
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [reviewing, setReviewing] = useState(false);
  const titleId = useId();
  const hintId = useId();

  const remaining = CHARTER_ITEMS.length - CHARTER_ITEMS.filter((item) => checked.has(item.id)).length;

  function confirm() {
    if (!allConfirmed(checked)) return;
    writeSetting(ACK_KEY, serialiseAcknowledgement(new Date()));
    setAcknowledged(true);
  }

  if (!acknowledged) {
    return (
      <section className="charter" aria-labelledby={titleId}>
        <div className="charter-head">
          <span className="charter-badge" aria-hidden="true">
            <IconShield size={22} />
          </span>
          <div>
            <h3 id={titleId}>{CHARTER_TITLE}</h3>
            <p className="charter-lead">{CHARTER_LEAD}</p>
          </div>
        </div>

        <ul className="charter-points">
          {CHARTER_ITEMS.map((item) => (
            <li key={item.id}>{item.text}</li>
          ))}
        </ul>

        <label className="charter-attest">
          <input
            type="checkbox"
            checked={remaining === 0}
            onChange={(e) => setChecked(e.target.checked ? new Set(CHARTER_ITEMS.map((i) => i.id)) : new Set())}
          />
          <span>
            <strong>Je confirme ces {CHARTER_ITEMS.length} engagements</strong> pour les documents que j’importe.
          </span>
        </label>

        <p className="small muted">
          {CHARTER_DISCLAIMER}{' '}
          <a href={SECURITY_DOC} target="_blank" rel="noopener noreferrer">
            Sécurité et données personnelles
          </a>
          .
        </p>

        <div className="row">
          <button className="btn-primary" onClick={confirm} disabled={remaining > 0} aria-describedby={hintId}>
            Continuer
          </button>
          <span className="small muted" id={hintId} aria-live="polite">
            {remaining > 0 ? 'Cochez la case ci-dessus pour continuer.' : 'Merci : vous pouvez continuer.'}
          </span>
        </div>
      </section>
    );
  }

  return (
    <>
      <div className="charter-reminder">
        <IconShield size={18} />
        <span>
          <strong>Documents anonymisés ou pseudonymisés uniquement.</strong> L’outil n’anonymise rien.
        </span>
        <button className="btn-sm btn-quiet" aria-expanded={reviewing} onClick={() => setReviewing((open) => !open)}>
          {reviewing ? 'Masquer' : 'Revoir mes engagements'}
        </button>
        {reviewing && (
          <ul className="charter-recall" aria-label={`Engagements confirmés, version ${ANONYMISATION_VERSION}`}>
            {CHARTER_ITEMS.map((item) => (
              <li key={item.id}>{item.text}</li>
            ))}
          </ul>
        )}
      </div>
      {children}
    </>
  );
}
