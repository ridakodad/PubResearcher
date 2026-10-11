import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { usePageTitle } from '../lib/usePageTitle';

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
  const { signOut } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    signOut()
      .catch((error: unknown) => console.error('[pubresearcher] déconnexion', error))
      .finally(() => {
        if (!cancelled) navigate('/', { replace: true });
      });
    return () => {
      cancelled = true;
    };
    // `signOut` change d'identité à chaque rendu du fournisseur : on ne se déconnecte qu'une fois, à l'arrivée.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="container narrow loading-panel" role="status">
      <span className="spinner" aria-hidden="true" />
      <p>Déconnexion…</p>
    </div>
  );
}
