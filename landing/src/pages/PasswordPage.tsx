import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { focusFirstError, PasswordField, TextField } from '../components/fields';
import { IconCheck, IconInfo } from '../components/icons';
import { useAuth } from '../lib/auth';
import { frenchAuthError, PASSWORD_MIN, validateEmail, validateNewPassword, type FieldErrors } from '../lib/forms';
import { usePageTitle } from '../lib/usePageTitle';

/**
 * Mot de passe oublié, ou à changer.
 *
 * Déconnecté : on demande un lien par e-mail. La réponse est toujours la même, que l'adresse existe ou non — sinon la
 * page servirait à savoir qui a un compte. Connecté (y compris en arrivant par le lien reçu) : on choisit le nouveau.
 */
export function PasswordPage() {
  usePageTitle('Mot de passe', { noindex: true });
  const { status, user, recovery, requestPasswordReset, updatePassword } = useAuth();
  const formRef = useRef<HTMLFormElement>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<FieldErrors<'email' | 'password' | 'confirm'>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<'sent' | 'changed' | null>(null);
  const [busy, setBusy] = useState(false);

  if (status === 'loading') {
    return (
      <div className="container narrow loading-panel" role="status">
        <span className="spinner" aria-hidden="true" />
        <p>Chargement…</p>
      </div>
    );
  }

  const updating = status === 'signed-in';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(null);

    const found: FieldErrors<'email' | 'password' | 'confirm'> = updating
      ? validateNewPassword({ password, confirm }, user?.email ?? '')
      : (() => {
          const message = validateEmail(email);
          return message ? { email: message } : {};
        })();
    setErrors(found);
    if (Object.keys(found).length > 0) {
      window.requestAnimationFrame(() => focusFirstError(formRef.current));
      return;
    }

    setBusy(true);
    try {
      if (updating) {
        await updatePassword(password);
        setDone('changed');
      } else {
        await requestPasswordReset(email);
        setDone('sent');
      }
    } catch (error) {
      setFormError(frenchAuthError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view container narrow auth-single">
      <div className="auth-card">
        <h1>{updating ? (recovery ? 'Choisir un nouveau mot de passe' : 'Changer de mot de passe') : 'Mot de passe oublié'}</h1>

        {done === 'sent' && (
          <div className="notice notice-info" role="status">
            <IconInfo size={18} />
            <div>
              Si un compte existe pour <strong>{email.trim()}</strong>, un lien de réinitialisation vient d’être envoyé. Pensez à
              regarder dans les courriers indésirables.
            </div>
          </div>
        )}
        {done === 'changed' && (
          <>
            <p className="form-ok" role="status">
              <IconCheck size={16} /> Votre mot de passe est modifié.
            </p>
            <p>
              <Link className="btn btn-primary" to="/acces">
                Continuer vers mon accès
              </Link>
            </p>
          </>
        )}

        {done === null && (
          <>
            <p className="auth-sub">
              {updating
                ? `Choisissez un mot de passe de ${PASSWORD_MIN} caractères au moins.`
                : 'Indiquez l’adresse de votre compte : nous vous envoyons un lien pour en choisir un nouveau.'}
            </p>

            {formError && (
              <div className="notice notice-error" role="alert">
                <IconInfo size={18} />
                <div>{formError}</div>
              </div>
            )}

            <form ref={formRef} onSubmit={submit} noValidate>
              {updating ? (
                <>
                  <PasswordField
                    label="Nouveau mot de passe"
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    error={errors.password}
                  />
                  <PasswordField
                    label="Confirmez le mot de passe"
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    error={errors.confirm}
                  />
                </>
              ) : (
                <TextField
                  label="Adresse e-mail"
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  error={errors.email}
                />
              )}
              <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy} aria-busy={busy}>
                {busy ? 'Un instant…' : updating ? 'Enregistrer' : 'Envoyer le lien'}
              </button>
            </form>

            {!updating && (
              <p className="auth-switch">
                <Link to="/connexion">Retour à la connexion</Link>
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
