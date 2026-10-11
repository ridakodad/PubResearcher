import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import type { Option } from '../lib/onboarding';
import { IconEye, IconEyeOff } from './icons';

/**
 * Champs de formulaire : libellé visible, aide, erreur reliée au champ.
 *
 * Chaque champ nomme ce qu'il faut corriger (`aria-describedby` pointe vers l'aide et l'erreur) ; la couleur ne porte
 * jamais seule l'erreur. Le message de l'erreur est un texte, pas une infobulle, et reste affiché tant que le champ
 * n'est pas corrigé.
 */

interface BaseProps {
  label: string;
  hint?: ReactNode;
  error?: string;
  optional?: boolean;
}

function describe(id: string, hint: unknown, error: unknown): string | undefined {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean);
  return ids.length > 0 ? ids.join(' ') : undefined;
}

function Label({ htmlFor, label, optional }: { htmlFor: string; label: string; optional?: boolean }) {
  return (
    <label htmlFor={htmlFor}>
      {label}
      {optional && <span className="optional"> (facultatif)</span>}
    </label>
  );
}

function Messages({ id, hint, error }: { id: string; hint?: ReactNode; error?: string }) {
  return (
    <>
      {hint && (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </>
  );
}

type InputProps = BaseProps & Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-invalid' | 'aria-describedby'>;

export function TextField({ label, hint, error, optional, type = 'text', ...input }: InputProps) {
  const id = useId();
  return (
    <div className="field">
      <Label htmlFor={id} label={label} optional={optional} />
      <input id={id} type={type} {...input} aria-invalid={error ? true : undefined} aria-describedby={describe(id, hint, error)} />
      <Messages id={id} hint={hint} error={error} />
    </div>
  );
}

/** Mot de passe, avec un bouton pour le montrer : sur un téléphone, on se trompe plus souvent qu'on ne le croit. */
export function PasswordField({ label, hint, error, optional, ...input }: InputProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  return (
    <div className="field">
      <Label htmlFor={id} label={label} optional={optional} />
      <div className="password-wrap">
        <input
          id={id}
          {...input}
          type={shown ? 'text' : 'password'}
          aria-invalid={error ? true : undefined}
          aria-describedby={describe(id, hint, error)}
          autoCapitalize="none"
          spellCheck={false}
        />
        <button
          type="button"
          className="btn-icon password-toggle"
          aria-pressed={shown}
          aria-label="Afficher le mot de passe"
          title={shown ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
          onClick={() => setShown((value) => !value)}
        >
          {shown ? <IconEyeOff size={18} /> : <IconEye size={18} />}
        </button>
      </div>
      <Messages id={id} hint={hint} error={error} />
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  optional,
  options,
  value,
  onChange,
  placeholder = 'Choisir…',
}: BaseProps & { options: readonly Option[]; value: string; onChange: (value: string) => void; placeholder?: string }) {
  const id = useId();
  return (
    <div className="field">
      <Label htmlFor={id} label={label} optional={optional} />
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-invalid={error ? true : undefined}
        aria-describedby={describe(id, hint, error)}
      >
        <option value="">{placeholder}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <Messages id={id} hint={hint} error={error} />
    </div>
  );
}

/** Une question à réponse unique : des cartes à cocher plutôt qu'une liste déroulante, pour voir toutes les réponses. */
export function ChoiceField({
  legend,
  hint,
  error,
  options,
  value,
  onChange,
}: {
  legend: string;
  hint?: ReactNode;
  error?: string;
  options: readonly Option[];
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <fieldset className="choice-group" aria-invalid={error ? true : undefined} aria-describedby={describe(id, hint, error)}>
      <legend>{legend}</legend>
      <div className="choices">
        {options.map((option) => (
          <label className="choice" key={option.value}>
            <input type="radio" name={id} value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
      <Messages id={id} hint={hint} error={error} />
    </fieldset>
  );
}

/** Place le focus sur le premier champ en erreur d'un formulaire (ou sur la première réponse d'un groupe en erreur). */
export function focusFirstError(form: HTMLElement | null): void {
  const invalid = form?.querySelector<HTMLElement>('[aria-invalid="true"]');
  if (!invalid) return;
  const target = invalid.tagName === 'FIELDSET' ? invalid.querySelector<HTMLElement>('input') : invalid;
  target?.focus();
}
