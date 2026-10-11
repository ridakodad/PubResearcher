import { useEffect, useId, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { SIGN_OUT } from '../pages/SignOutPage';
import { Brand } from './Brand';
import { IconClose, IconMenu } from './icons';
import { ThemeToggle } from './ThemeToggle';

const NAV = [
  { hash: '#outils', label: 'L’application' },
  { hash: '#parcours', label: 'Le parcours' },
  { hash: '#donnees', label: 'Vos données' },
  { hash: '#installer', label: 'Installer' },
  { hash: '#questions', label: 'Questions' },
] as const;

/** Les boutons de compte : visiteur → connexion et inscription ; connecté → son accès et la déconnexion. */
function AccountLinks({ onNavigate }: { onNavigate?: () => void }) {
  const { status } = useAuth();

  if (status === 'loading') return null;

  if (status === 'signed-in') {
    return (
      <>
        <Link className="btn btn-primary" to="/acces" onClick={onNavigate}>
          Mon accès
        </Link>
        <Link className="btn btn-quiet" to="/deconnexion" state={SIGN_OUT} onClick={onNavigate}>
          Se déconnecter
        </Link>
      </>
    );
  }

  return (
    <>
      <Link className="btn btn-quiet" to="/connexion" onClick={onNavigate}>
        Se connecter
      </Link>
      <Link className="btn btn-primary" to="/inscription" onClick={onNavigate}>
        Créer un compte
      </Link>
    </>
  );
}

/**
 * En-tête : une pastille de verre flottante, comme la navigation de l'application. Sur écran étroit, les liens
 * passent dans un panneau que l'on ouvre au bouton « Menu » (fermé par Échap, par un clic sur un lien ou par un
 * changement de page).
 */
export function Header() {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const panelId = useId();

  useEffect(() => setOpen(false), [location.pathname, location.hash]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [open]);

  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link to="/" className="brand-link" aria-label="PubResearcher, page d’accueil">
          <Brand />
        </Link>

        <nav className="site-nav" aria-label="Sections de la page d’accueil">
          {NAV.map((item) => (
            <Link key={item.hash} to={{ pathname: '/', hash: item.hash }}>
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="site-header-end">
          <ThemeToggle />
          <div className="site-account">
            <AccountLinks />
          </div>
          <button
            type="button"
            className="btn-icon menu-button"
            aria-expanded={open}
            aria-controls={panelId}
            aria-label={open ? 'Fermer le menu' : 'Ouvrir le menu'}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <IconClose size={18} /> : <IconMenu size={18} />}
          </button>
        </div>
      </div>

      <div className="mobile-panel" id={panelId} hidden={!open}>
        <nav aria-label="Sections de la page d’accueil (menu)">
          {NAV.map((item) => (
            <Link key={item.hash} to={{ pathname: '/', hash: item.hash }} onClick={() => setOpen(false)}>
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="mobile-account">
          <AccountLinks onNavigate={() => setOpen(false)} />
        </div>
      </div>
    </header>
  );
}
