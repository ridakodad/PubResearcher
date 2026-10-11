import { Fragment, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/**
 * Réserve une page aux utilisateurs connectés ; les autres passent par la connexion, puis reviennent ici.
 *
 * La page est propre à l'utilisateur (clé = son identifiant) : si un autre compte se connecte dans un autre onglet,
 * elle repart de zéro au lieu de garder, sous le nouveau compte, les réponses saisies pour l'ancien.
 */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return (
      <div className="container narrow loading-panel" role="status">
        <span className="spinner" aria-hidden="true" />
        <p>Chargement de votre session…</p>
      </div>
    );
  }
  if (status === 'signed-out') {
    return <Navigate to={`/connexion?suite=${encodeURIComponent(location.pathname)}`} replace />;
  }
  return <Fragment key={user?.id}>{children}</Fragment>;
}
