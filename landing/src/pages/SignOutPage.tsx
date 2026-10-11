import { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { usePageTitle } from '../lib/usePageTitle';

/**
 * Marque posée par les boutons « Se déconnecter » du site. C'est un état de navigation : un lien venu d'un autre
 * site (ou une adresse tapée) ne peut pas la poser. Sans elle, la page demande confirmation au lieu de déconnecter
 * d'office — sinon n'importe quelle page du web pourrait déconnecter nos utilisateurs d'un simple lien.
 */
export const SIGN_OUT = { signOut: true } as const;

/**
 * Déconnexion : une page à elle, que l'on traverse.
 *
 * On ne se déconnecte pas depuis la page protégée qu'on quitte : l'état « déconnecté » arrive avant la navigation vers
 * l'accueil, la page protégée renvoie alors vers la connexion, et selon laquelle des deux redirections passe en dernier
 * on atterrit ici ou là. Passer par une page non protégée rend le trajet toujours le même : on quitte la page, on se
 * déconnecte, on arrive sur l'accueil.
 */
export function SignOutPage() {
  usePageTitle('Déconnexion', { noindex: true });
  const { status, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [confirmed, setConfirmed] = useState(() => (location.state as { signOut?: unknown } | null)?.signOut === true);

  useEffect(() => {
    if (!confirmed) return undefined;
    let cancelled = false;
    signOut()
      .catch((error: unknown) => console.error('[pubresearcher] déconnexion', error))
      .finally(() => {
        if (!cancelled) navigate('/', { replace: true });
      });
    return () => {
      cancelled = true;
    };
    // `signOut` change d'identité à chaque rendu du fournisseur : on ne se déconnecte qu'une fois, sur confirmation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirmed]);

  if (!confirmed && status === 'signed-out') return <Navigate to="/" replace />;

  if (!confirmed && status === 'signed-in') {
    return (
      <div className="view container narrow auth-single">
        <div className="auth-card">
          <h1>Se déconnecter ?</h1>
          <p className="auth-sub">Vous quitterez votre accès sur ce navigateur. Vos réponses restent enregistrées.</p>
          <div className="form-actions">
            <button type="button" className="btn btn-primary" onClick={() => setConfirmed(true)}>
              Me déconnecter
            </button>
            <Link className="btn btn-quiet" to="/acces">
              Rester connecté
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="container narrow loading-panel" role="status">
      <span className="spinner" aria-hidden="true" />
      <p>{confirmed ? 'Déconnexion…' : 'Chargement…'}</p>
    </div>
  );
}
