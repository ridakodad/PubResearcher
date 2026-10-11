import { Link } from 'react-router-dom';
import { config } from '../lib/config';
import { Brand } from './Brand';
import { IconExternal } from './icons';

function External({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <IconExternal size={14} />
      <span className="sr-only"> (s’ouvre dans un nouvel onglet)</span>
    </a>
  );
}

export function Footer() {
  const docs = `${config.repoUrl}/blob/main/docs`;
  return (
    <footer className="site-footer">
      <div className="container footer-grid">
        <div className="footer-about">
          <Brand />
          <p className="small">
            L’espace de travail d’une étude rétrospective, sur votre poste. C’est un outil de recherche : il n’anonymise
            rien et n’est pas un dispositif médical.
          </p>
        </div>

        <nav aria-label="Ce site" className="footer-col">
          <h2 className="footer-title">Ce site</h2>
          <ul>
            <li>
              <Link to="/inscription">Créer un compte</Link>
            </li>
            <li>
              <Link to="/connexion">Se connecter</Link>
            </li>
            <li>
              <Link to="/confidentialite">Confidentialité</Link>
            </li>
          </ul>
        </nav>

        <nav aria-label="Le projet" className="footer-col">
          <h2 className="footer-title">Le projet</h2>
          <ul>
            <li>
              <External href={config.repoUrl}>Code source</External>
            </li>
            <li>
              <External href={`${docs}/guide-chercheur.md`}>Guide du chercheur</External>
            </li>
            <li>
              <External href={`${docs}/securite-et-donnees.md`}>Sécurité et données</External>
            </li>
            <li>
              <External href={`${docs}/changelog.md`}>Journal des versions</External>
            </li>
          </ul>
        </nav>
      </div>
      <div className="container footer-base">
        <p className="small">PubResearcher · version {config.version}</p>
      </div>
    </footer>
  );
}
