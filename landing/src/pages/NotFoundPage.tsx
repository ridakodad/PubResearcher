import { Link } from 'react-router-dom';
import { IconArrow } from '../components/icons';
import { usePageTitle } from '../lib/usePageTitle';

export function NotFoundPage() {
  usePageTitle('Page introuvable', { noindex: true });
  return (
    <div className="view container narrow empty-page">
      <p className="eyebrow">Erreur 404</p>
      <h1>Cette page n’existe pas.</h1>
      <p>L’adresse est peut-être mal saisie, ou la page a changé de place.</p>
      <p>
        <Link className="btn btn-primary" to="/">
          Retour à l’accueil <IconArrow size={16} />
        </Link>
      </p>
    </div>
  );
}
