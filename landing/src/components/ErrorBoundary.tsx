import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Dernier filet : une erreur imprévue dans l'affichage ne doit pas laisser une page blanche. Le détail va à la console
 * (pour l'éditeur du site) ; l'utilisateur reçoit une phrase et un moyen de recharger.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('[pubresearcher] erreur d’affichage', error, info.componentStack);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="container narrow empty-page" role="alert">
        <h1>Quelque chose s’est mal passé.</h1>
        <p>La page n’a pas pu s’afficher. Rechargez-la ; si cela se reproduit, revenez dans un instant.</p>
        <p>
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
            Recharger la page
          </button>
        </p>
      </div>
    );
  }
}
