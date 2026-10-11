import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { focusFirstError, PasswordField, TextField } from '../components/fields';
import { GoogleButton } from '../components/GoogleButton';
import { IconCheck, IconInfo, IconMail, IconShield } from '../components/icons';
import { useAuth } from '../lib/auth';
import {
  authErrorCode,
  frenchAuthError,
  PASSWORD_MIN,
  validateLogin,
  validateSignup,
  type FieldErrors,
} from '../lib/forms';
import { safeNext } from '../lib/urls';
import { usePageTitle } from '../lib/usePageTitle';

type Field = 'fullName' | 'email' | 'password' | 'confirm';

/**
 * Inscription et connexion : Google en premier (un clic, pas de mot de passe de plus à retenir), l'adresse e-mail
 * ensuite. Les deux écrans partagent la mise en page et diffèrent par les champs demandés.
 */
export function AuthPage({ mode }: { mode: 'signup' | 'login' }) {
  const signup = mode === 'signup';
  usePageTitle(signup ? 'Créer mon accès' : 'Se connecter', { noindex: true });

  const { status, preview, returnError, clearReturnError, signUpWithEmail, signInWithEmail, resendConfirmation } = useAuth();
  const [params] = useSearchParams();
  const next = safeNext(params.get('suite'));
  const suffix = next ? `?suite=${encodeURIComponent(next)}` : '';

  const formRef = useRef<HTMLFormElement>(null);
  const sentRef = useRef<HTMLHeadingElement>(null);
  const [values, setValues] = useState({ fullName: '', email: '', password: '', confirm: '' });
  const [errors, setErrors] = useState<FieldErrors<Field>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [resent, setResent] = useState(false);

  useEffect(() => {
    if (sentTo) sentRef.current?.focus();
  }, [sentTo]);

  if (status === 'signed-in') return <Navigate to={next ?? '/bienvenue'} replace />;

  const set = (key: Field) => (event: { target: { value: string } }) => {
    setValues((current) => ({ ...current, [key]: event.target.value }));
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }));
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setFormError(null);
    setErrorCode('');
    setResent(false);
    clearReturnError();

    const found = signup ? validateSignup(values) : validateLogin(values);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      // Le focus part après l'affichage des erreurs : `aria-invalid` doit déjà être posé.
      window.requestAnimationFrame(() => focusFirstError(formRef.current));
      return;
    }

    setBusy(true);
    try {
      if (signup) {
        const { confirmationSent } = await signUpWithEmail(values);
        if (confirmationSent) setSentTo(values.email.trim());
        // Sinon, la session est ouverte : le changement d'état renvoie vers la suite du parcours.
      } else {
        await signInWithEmail(values.email, values.password);
      }
    } catch (error) {
      setErrorCode(authErrorCode(error));
      setFormError(frenchAuthError(error));
    } finally {
      setBusy(false);
    }
  }

  async function resend(address: string) {
    setFormError(null);
    try {
      await resendConfirmation(address);
      setResent(true);
    } catch (error) {
      setFormError(frenchAuthError(error));
    }
  }

  if (sentTo) {
    return (
      <div className="view container narrow auth-single">
        <div className="auth-card auth-sent">
          <span className="auth-sent-icon" aria-hidden="true">
            <IconMail size={26} />
          </span>
          <h1 tabIndex={-1} ref={sentRef}>
            Vérifiez votre boîte e-mail
          </h1>
          <p>
            Un lien de confirmation vient d’être envoyé à <strong>{sentTo}</strong>. Ouvrez-le pour terminer l’inscription : vous
            reviendrez ici, connecté, pour décrire votre étude.
          </p>
          <p className="small muted">Il n’arrive pas ? Regardez dans les courriers indésirables, puis demandez un nouvel envoi.</p>
          <p className="small muted">
            Cette adresse avait déjà un compte, par e-mail ou avec Google ? Aucun lien n’est alors envoyé :{' '}
            <Link to="/connexion">connectez-vous</Link>.
          </p>
          {formError && (
            <div className="notice notice-error" role="alert">
              <IconInfo size={18} />
              <div>{formError}</div>
            </div>
          )}
          {resent && (
            <p className="form-ok" role="status">
              <IconCheck size={16} /> Un nouveau lien vient d’être envoyé.
            </p>
          )}
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => void resend(sentTo)}>
              Renvoyer le lien
            </button>
            <button type="button" className="btn btn-quiet" onClick={() => setSentTo(null)}>
              Changer d’adresse
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="view container auth">
      <aside className="auth-pitch hero" aria-label="Pourquoi s’inscrire">
        <p className="eyebrow">{signup ? 'Un accès, un engagement' : 'Content de vous revoir'}</p>
        <h2>{signup ? 'Trois minutes, et vous êtes prêt à ouvrir l’application.' : 'Reprenez là où vous vous étiez arrêté.'}</h2>
        <ul>
          <li>
            <IconCheck size={16} /> Google ou e-mail : une minute
          </li>
          <li>
            <IconCheck size={16} /> Cinq engagements d’anonymisation, enregistrés avec leur date
          </li>
          <li>
            <IconCheck size={16} /> Vos réponses d’accueil ne servent qu’à vous donner les bons rappels
          </li>
        </ul>
        <p className="auth-pitch-note">
          <IconShield size={20} />
          <span>Aucune donnée de patient ne passe par ce site : l’application tourne sur votre ordinateur.</span>
        </p>
      </aside>

      <div className="auth-card">
        <h1>{signup ? 'Créer mon accès' : 'Se connecter'}</h1>
        <p className="auth-sub">
          {signup ? 'Une fois inscrit, vous décrivez votre étude puis vous prenez l’engagement d’anonymisation.' : 'Retrouvez votre accès à l’application.'}
        </p>

        {preview && (
          <div className="notice notice-info">
            <IconInfo size={18} />
            <div>Mode aperçu : le bouton Google simule la connexion, aucun compte n’est créé.</div>
          </div>
        )}

        {(returnError || formError) && (
          <div className="notice notice-error" role="alert">
            <IconInfo size={18} />
            <div>
              {returnError ?? formError}
              {errorCode === 'email_not_confirmed' && values.email && (
                <>
                  {' '}
                  <button type="button" className="link-button" onClick={() => void resend(values.email)}>
                    Renvoyer le lien de confirmation
                  </button>
                </>
              )}
            </div>
          </div>
        )}
        {resent && !sentTo && (
          <p className="form-ok" role="status">
            <IconCheck size={16} /> Un nouveau lien vient d’être envoyé.
          </p>
        )}

        <GoogleButton
          label="Continuer avec Google"
          onError={(message) => {
            // Une nouvelle erreur remplace les précédentes (retour d'un lien, adresse non confirmée…).
            clearReturnError();
            setErrorCode('');
            setResent(false);
            setFormError(message);
          }}
        />

        <div className="divider-or" aria-hidden="true">
          <span>ou avec une adresse e-mail</span>
        </div>

        <form ref={formRef} onSubmit={submit} noValidate>
          {signup && (
            <TextField
              label="Nom et prénom"
              name="name"
              autoComplete="name"
              value={values.fullName}
              onChange={set('fullName')}
              error={errors.fullName}
            />
          )}
          <TextField
            label="Adresse e-mail"
            name="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            value={values.email}
            onChange={set('email')}
            error={errors.email}
          />
          <PasswordField
            label="Mot de passe"
            name="password"
            autoComplete={signup ? 'new-password' : 'current-password'}
            hint={signup ? `${PASSWORD_MIN} caractères au moins : une phrase de passe convient.` : undefined}
            value={values.password}
            onChange={set('password')}
            error={errors.password}
          />
          {signup && (
            <PasswordField
              label="Confirmez le mot de passe"
              name="confirm"
              autoComplete="new-password"
              value={values.confirm}
              onChange={set('confirm')}
              error={errors.confirm}
            />
          )}

          {!signup && (
            <p className="auth-forgot">
              <Link to="/mot-de-passe">Mot de passe oublié ?</Link>
            </p>
          )}

          <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy} aria-busy={busy}>
            {busy ? 'Un instant…' : signup ? 'Créer mon accès' : 'Me connecter'}
          </button>
        </form>

        {signup && (
          <p className="small muted auth-legal">
            En créant un accès, vous acceptez que vos réponses d’accueil soient enregistrées comme décrit dans la page{' '}
            <Link to="/confidentialite">Confidentialité</Link>. Aucune donnée de patient ne passe par ce site.
          </p>
        )}

        <p className="auth-switch">
          {signup ? (
            <>
              Déjà un compte ? <Link to={`/connexion${suffix}`}>Se connecter</Link>
            </>
          ) : (
            <>
              Pas encore de compte ? <Link to={`/inscription${suffix}`}>Créer mon accès</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
