import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';

/** Réserve une page aux utilisateurs connectés ; les autres passent par la connexion, puis reviennent ici. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
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
  return <>{children}</>;
}
