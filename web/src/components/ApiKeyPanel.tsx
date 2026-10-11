import { useEffect, useId, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import { formatDateTime, modelLabel } from '../lib/format';
import type { ApiKeyStatus } from '../lib/types';
import { Spinner, useToast } from './ui';
import { IconCheck, IconExternal, IconShield } from './icons';

/**
 * La clé d'API Anthropic de l'utilisateur : chacun paie l'IA avec sa propre clé, directement à Anthropic.
 *
 * La clé saisie est vérifiée par le serveur auprès d'Anthropic, puis enregistrée sur cet ordinateur. Elle ne revient
 * jamais vers la page : on n'en montre que la provenance et les quatre derniers caractères.
 */
export function ApiKeyPanel({ onChange, compact = false }: { onChange?: (status: ApiKeyStatus) => void; compact?: boolean }) {
  const toast = useToast();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [editing, setEditing] = useState(!compact);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState<'save' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .apiKey()
      .then((s) => {
        if (cancelled) return;
        setStatus(s);
        if (s.source === null) setEditing(true);
      })
      .catch(() => {
        if (!cancelled) setError('État de la clé illisible : rechargez la page.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function apply(next: ApiKeyStatus) {
    setStatus(next);
    onChange?.(next);
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!value.trim()) {
      setError('Collez votre clé d’API Anthropic.');
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const next = await api.saveApiKey(value);
      setValue('');
      setEditing(false);
      apply(next);
      toast.success('Clé vérifiée et enregistrée sur cet ordinateur.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (busy) return;
    if (!window.confirm('Retirer votre clé de cet ordinateur ? L’extraction par Claude ne sera plus possible sans clé.')) return;
    setBusy('remove');
    setError(null);
    try {
      const next = await api.removeApiKey();
      apply(next);
      if (next.source === null) setEditing(true);
      toast.success('Clé retirée.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  const describe = (s: ApiKeyStatus) =>
    s.source === 'app'
      ? `Votre clé (${s.hint ?? '…'})${s.savedAt ? `, enregistrée le ${formatDateTime(s.savedAt)}` : ''}`
      : s.source === 'env'
        ? `Clé fournie par le serveur (${s.hint ?? '…'})`
        : 'Aucune clé enregistrée';

  return (
    <section className="card" aria-labelledby={`${inputId}-titre`}>
      <div className="card-head">
        <div>
          <h2 id={`${inputId}-titre`} style={{ fontSize: '1rem', margin: 0 }}>
            Clé d’API Anthropic
          </h2>
          <div className="sub">{status ? describe(status) : 'Lecture…'}</div>
        </div>
        {status && status.source !== null && !editing && (
          <div className="card-actions">
            <button className="btn-sm" onClick={() => setEditing(true)}>
              {status.source === 'app' ? 'Changer de clé' : 'Utiliser ma propre clé'}
            </button>
            {status.source === 'app' && (
              <button className="btn-sm btn-quiet" onClick={() => void remove()} disabled={busy !== null} aria-busy={busy === 'remove'}>
                Retirer
              </button>
            )}
          </div>
        )}
      </div>

      {editing && (
        <div className="card-body stack" style={{ gap: 12 }}>
          <p className="small" style={{ margin: 0 }}>
            L’extraction par Claude et l’assistant de rédaction utilisent <strong>votre</strong> clé : vous payez Anthropic
            directement, à l’usage — PubResearcher ne facture rien. Avec {modelLabel(status?.model)}, comptez
            de 0,05 à 0,20 $US par dossier ordinaire ; le coût de chaque passe est estimé avant de la lancer.
          </p>
          <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
            <li>
              Créez une clé dans la{' '}
              <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">
                console d’Anthropic <IconExternal size={12} />
              </a>{' '}
              (compte gratuit, puis crédit prépayé).
            </li>
            <li>Fixez-y une limite de dépenses mensuelle : c’est votre garde-fou.</li>
            <li>Collez la clé ci-dessous : elle est vérifiée auprès d’Anthropic avant d’être enregistrée.</li>
          </ol>
          <form onSubmit={save} noValidate>
            <div className="field">
              <label htmlFor={inputId}>Clé d’API (commence par « sk-ant- »)</label>
              <input
                id={inputId}
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="none"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                aria-invalid={error ? true : undefined}
                aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
                placeholder="sk-ant-…"
              />
              <div className="field-hint" id={hintId}>
                <IconShield size={12} /> Elle reste sur cet ordinateur, hors de la base et des sauvegardes, et n’est plus
                jamais affichée en entier. N’envoyez à Claude que des documents anonymisés.
              </div>
              {error && (
                <div className="field-error" id={errorId} role="alert">
                  {error}
                </div>
              )}
            </div>
            <div className="row">
              <button type="submit" className="btn-primary" disabled={busy !== null} aria-busy={busy === 'save'}>
                {busy === 'save' ? <Spinner label="Vérification…" /> : 'Vérifier et enregistrer'}
              </button>
              {status && status.source !== null && (
                <button
                  type="button"
                  className="btn-quiet"
                  onClick={() => {
                    setEditing(false);
                    setValue('');
                    setError(null);
                  }}
                >
                  Annuler
                </button>
              )}
            </div>
          </form>
        </div>
      )}
      {!editing && status?.source === 'app' && (
        <div className="card-body small muted" style={{ paddingTop: 'var(--s2)', paddingBottom: 'var(--s3)' }}>
          <IconCheck size={12} /> Les passes par Claude sont facturées sur votre compte Anthropic.
        </div>
      )}
    </section>
  );
}
