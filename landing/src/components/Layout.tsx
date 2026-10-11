import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Footer } from './Footer';
import { Header } from './Header';
import { PreviewBanner } from './PreviewBanner';

/**
 * Le cadre commun : lien d'évitement, bandeau d'aperçu, en-tête, contenu, pied de page.
 *
 * Une application à page unique ne change pas de page pour le navigateur : à chaque navigation, c'est ici qu'on
 * remonte en haut, qu'on place le focus sur le contenu (un lecteur d'écran annonce alors la nouvelle page) ou qu'on
 * descend jusqu'à l'ancre demandée.
 */
/** `#%` ou `#%E0` dans l'adresse ne doivent pas faire tomber la page : un fragment illisible ne vise rien. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function Layout({ children }: { children: ReactNode }) {
  const { pathname, hash } = useLocation();
  const first = useRef(true);

  useEffect(() => {
    const initial = first.current;
    first.current = false;

    if (hash) {
      const target = document.getElementById(safeDecode(hash.slice(1)));
      if (target) {
        target.scrollIntoView();
        return;
      }
    }
    if (initial) return;
    window.scrollTo(0, 0);
    document.getElementById('main')?.focus({ preventScroll: true });
  }, [pathname, hash]);

  return (
    <div className="site">
      <a className="skip-link" href="#main">
        Aller au contenu
      </a>
      <PreviewBanner />
      <Header />
      <main id="main" tabIndex={-1}>
        {children}
      </main>
      <Footer />
    </div>
  );
}
