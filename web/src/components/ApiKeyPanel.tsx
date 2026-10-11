import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatDateTime } from '../lib/format';
import type { ApiKeyStatus } from '../lib/types';
import { describeKey, useApiKey } from '../lib/useApiKey';
import { KeyForm } from './KeyForm';
import { useToast } from './ui';
import { IconCheck, IconKey } from './icons';

/**
 * La clé d'API Anthropic, là où l'on en a besoin (pages Extraction et Rédaction).
 *
 * Sans clé : une invitation courte qui mène au guide pas à pas (page « Activer Claude »), et un raccourci pour qui en a
 * déjà une. Avec une clé : sa provenance et ses quatre derniers caractères — jamais la clé —, la changer ou la retirer.
 */
export function ApiKeyPanel({ onChange }: { onChange?: (status: ApiKeyStatus) => void }) {
  const toast = useToast();
  const titleId = useId();
  const { status, loadError, apply, remove, removing } = useApiKey(onChange);
  const [editing, setEditing] = useState(false);

  const saved = (next: ApiKeyStatus) => {
    setEditing(false);
    apply(next);
  };

  async function confirmRemove() {
    if (removing) return;
    if (!window.confirm('Retirer votre clé de cet ordinateur ? Claude ne sera plus utilisable sans clé.')) return;
    const error = await remove();
    if (error) toast.error(error);
    else toast.success('Clé retirée.');
  }

  if (loadError) {
    return (
      <div className="notice notice-error" role="alert">
        <div>{loadError}</div>
      </div>
    );
  }

  // Aucune clé : on mène au guide, sans noyer la page sous les explications.
  if (status && status.source === null) {
    return (
      <section className="card key-invite" aria-labelledby={titleId}>
        <span className="key-invite-icon" aria-hidden="true">
          <IconKey size={22} />
        </span>
        <div className="key-invite-body">
          <h2 id={titleId}>Claude n’est pas encore activé</h2>
          <p className="small secondary">
            Les règles trouvent les valeurs qu’annonce un libellé ; Claude lit en plus le texte rédigé. Il lui faut votre clé
            d’API Anthropic : cinq minutes, une seule fois, et vous ne payez que ce que vous utilisez.
          </p>
          <div className="row">
            <Link className="btn btn-primary" to="/claude">
              Activer Claude, pas à pas
            </Link>
            <button type="button" className="btn-quiet" onClick={() => setEditing((v) => !v)} aria-expanded={editing}>
              J’ai déjà une clé
            </button>
          </div>
          {editing && <KeyForm onSaved={saved} onCancel={() => setEditing(false)} autoFocus />}
        </div>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby={titleId}>
      <div className="card-head">
        <div>
          <h2 id={titleId} style={{ fontSize: '1rem', margin: 0 }}>
            Clé d’API Anthropic
          </h2>
          <div className="sub">{status ? describeKey(status, formatDateTime) : 'Lecture…'}</div>
        </div>
        {status && !editing && (
          <div className="card-actions">
            <button className="btn-sm" onClick={() => setEditing(true)}>
              {status.source === 'app' ? 'Changer de clé' : 'Utiliser ma propre clé'}
            </button>
            {status.source === 'app' && (
              <button className="btn-sm btn-quiet" onClick={() => void confirmRemove()} disabled={removing} aria-busy={removing}>
                Retirer
              </button>
            )}
          </div>
        )}
      </div>
      {editing ? (
        <div className="card-body">
          <KeyForm onSaved={saved} onCancel={() => setEditing(false)} autoFocus submitLabel="Vérifier et enregistrer" />
        </div>
      ) : (
        status?.source === 'app' && (
          <div className="card-body small muted" style={{ paddingTop: 'var(--s2)', paddingBottom: 'var(--s3)' }}>
            <IconCheck size={12} /> Les passes par Claude sont facturées sur votre compte Anthropic.{' '}
            <Link to="/claude">Aide et dépannage</Link>
          </div>
        )
      )}
    </section>
  );
}
