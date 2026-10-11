import { useId, useRef, useState, type FormEvent } from 'react';
import { api, ApiError } from '../lib/api';
import type { ApiKeyStatus } from '../lib/types';
import { Spinner, useToast } from './ui';
import { IconEye, IconShield } from './icons';

/**
 * Le champ où l'on colle sa clé d'API Anthropic. Le serveur la fait vérifier par Anthropic avant de l'enregistrer :
 * une clé refusée l'est avec sa raison, en français, et rien n'est gardé.
 */
export function KeyForm({
  onSaved,
  onCancel,
  autoFocus = false,
  submitLabel = 'Vérifier et activer',
}: {
  onSaved: (status: ApiKeyStatus) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  submitLabel?: string;
}) {
  const toast = useToast();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!value.trim()) {
      setError('Collez votre clé d’API Anthropic : elle commence par « sk-ant- ».');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await api.saveApiKey(value);
      setValue('');
      setVisible(false);
      onSaved(next);
      toast.success('Claude est activé : clé vérifiée par Anthropic et enregistrée sur cet ordinateur.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
      inputRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="key-form" onSubmit={save} noValidate>
      <div className="field">
        <label htmlFor={inputId}>Votre clé d’API (elle commence par « sk-ant- »)</label>
        <div className="key-input">
          <input
            ref={inputRef}
            id={inputId}
            type={visible ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            autoFocus={autoFocus}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${hintId}${error ? ` ${errorId}` : ''}`}
            placeholder="sk-ant-…"
          />
          <button
            type="button"
            className="btn-sm btn-quiet"
            onClick={() => setVisible((v) => !v)}
            aria-pressed={visible}
            aria-controls={inputId}
          >
            <IconEye size={16} /> {visible ? 'Masquer' : 'Afficher'}
          </button>
        </div>
        <div className="field-hint" id={hintId}>
          <IconShield size={12} /> Elle reste sur cet ordinateur, hors de la base et des sauvegardes, et ne sera plus jamais
          affichée en entier. N’envoyez à Claude que des documents anonymisés.
        </div>
        {error && (
          <div className="field-error" id={errorId} role="alert">
            {error}
          </div>
        )}
      </div>
      <div className="row">
        <button type="submit" className="btn-primary" disabled={busy} aria-busy={busy}>
          {busy ? <Spinner label="Vérification auprès d’Anthropic…" /> : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="btn-quiet" onClick={onCancel} disabled={busy}>
            Annuler
          </button>
        )}
      </div>
    </form>
  );
}
