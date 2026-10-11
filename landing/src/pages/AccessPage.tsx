import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CodeBlock } from '../components/CodeBlock';
import { IntroVideo } from '../components/IntroVideo';
import { IconArrow, IconExternal, IconInfo, IconKey, IconLaptop, IconPlay, IconShield } from '../components/icons';
import { useAuth } from '../lib/auth';
import { ANONYMISATION_VERSION, CHARTER_ITEMS } from '../lib/charter';
import { config } from '../lib/config';
import { ETHICS, ethicsAdvice, HOSTINGS, labelOf, nextStep, ROLES, STUDY_TYPES, VOLUMES } from '../lib/onboarding';
import { usePageTitle } from '../lib/usePageTitle';
import { useOnboardingState } from '../lib/useOnboarding';
import { SIGN_OUT } from './SignOutPage';

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * L'accès : l'aboutissement du parcours. Le bouton « Ouvrir l'application » mène à l'adresse configurée
 * (`VITE_APP_URL`) — par défaut l'application installée sur le poste de l'utilisateur, qui n'est pas joignable de
 * l'extérieur : si elle n'est pas démarrée, la page ne s'ouvre pas, et le mode d'emploi est juste en dessous.
 *
 * Un parcours inachevé renvoie à /bienvenue : on n'arrive ici qu'avec un profil complet et l'engagement pris.
 */
export function AccessPage() {
  usePageTitle('Mon accès', { noindex: true });
  const { user } = useAuth();
  const navigate = useNavigate();
  const { state, error, reload } = useOnboardingState(user);

  useEffect(() => {
    if (state && nextStep(state) !== 'done') navigate('/bienvenue', { replace: true });
  }, [state, navigate]);

  if (error) {
    return (
      <div className="view container narrow">
        <div className="notice notice-error" role="alert">
          <IconInfo size={18} />
          <div>
            {error}{' '}
            <button type="button" className="link-button" onClick={() => void reload()}>
              Réessayer
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (!state || !state.profile || nextStep(state) !== 'done') {
    return (
      <div className="container narrow loading-panel" role="status">
        <span className="spinner" aria-hidden="true" />
        <p>Préparation de votre accès…</p>
      </div>
    );
  }

  const profile = state.profile;
  const advice = ethicsAdvice(profile.ethics);
  const confirmedOn = formatDate(state.consentedAt);
  const docs = `${config.repoUrl}/blob/main/docs`;

  return (
    <div className="view container access">
      <section className="hero hero-access" aria-labelledby="access-title">
        <p className="eyebrow">Votre accès est prêt</p>
        <h1 id="access-title">{profile.fullName ? `Bonjour, ${profile.fullName}.` : 'Votre accès est prêt.'}</h1>
        <p className="sub">
          Votre profil est enregistré et votre engagement d’anonymisation est pris. L’application s’ouvre sur votre ordinateur
          {config.appIsLocal ? ' (' : '.'}
          {config.appIsLocal && <code>{config.appUrl}</code>}
          {config.appIsLocal && ').'}
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary btn-lg" href={config.appUrl} target="_blank" rel="noopener noreferrer">
            Ouvrir l’application <IconExternal size={18} />
            <span className="sr-only"> (s’ouvre dans un nouvel onglet)</span>
          </a>
          <Link className="btn btn-glass btn-lg" to="/bienvenue?modifier">
            Modifier mes réponses
          </Link>
        </div>
        <p className="hero-note">
          <IconInfo size={18} />
          <span>
            Si la page ne répond pas, l’application n’est pas démarrée sur cet ordinateur : suivez les étapes ci-dessous.
          </span>
        </p>
      </section>

      <div className="access-grid">
        <section className="panel-card" aria-labelledby="start-title">
          <h2 id="start-title">
            <IconLaptop size={20} /> Démarrer l’application
          </h2>
          <ol className="plain-steps">
            <li>
              Installez <strong>Node.js 22.13</strong> ou plus récent (version « LTS » sur{' '}
              <a href="https://nodejs.org" target="_blank" rel="noopener noreferrer">
                nodejs.org
              </a>
              ).
            </li>
            <li>Récupérez le projet et lancez-le :</li>
          </ol>
          <CodeBlock
            label="Commandes d’installation"
            lines={[`git clone ${config.repoUrl}.git`, 'cd PubResearcher', 'npm ci', 'npm start']}
          />
          <p className="small muted">
            Sans terminal : téléchargez le ZIP du projet, puis double-cliquez sur <code>lancer.bat</code> (Windows) ou{' '}
            <code>lancer.command</code> (macOS). Laissez la fenêtre ouverte tant que vous travaillez.{' '}
            <a href={`${docs}/guide-administrateur.md`} target="_blank" rel="noopener noreferrer">
              Guide de l’administrateur
            </a>
            .
          </p>
          <p className="small">Pour essayer avec 24 dossiers fictifs, une fois l’application lancée :</p>
          <CodeBlock label="Commande des dossiers fictifs" lines={['npm run demo -- --upload']} />
        </section>

        <section className="panel-card" aria-labelledby="charter-title">
          <h2 id="charter-title">
            <IconShield size={20} /> Votre engagement
          </h2>
          <p>
            Confirmé{confirmedOn ? ` le ${confirmedOn}` : ''}, texte du <code>{state.consentedVersion ?? ANONYMISATION_VERSION}</code>.
            L’application vous le redemandera avant votre premier import : l’engagement vaut pour chaque navigateur.
          </p>
          <details className="faq-item compact">
            <summary>Relire les cinq engagements</summary>
            <ol className="recall">
              {CHARTER_ITEMS.map((item) => (
                <li key={item.id}>{item.text}</li>
              ))}
            </ol>
          </details>
        </section>

        <section className="panel-card" aria-labelledby="claude-title">
          <h2 id="claude-title">
            <IconKey size={20} /> Activer Claude (facultatif)
          </h2>
          <p>
            Les règles suffisent pour les valeurs qu’annonce un libellé. Pour le texte rédigé, Claude lit les comptes rendus avec
            votre propre clé d’API Anthropic : vous payez Anthropic à l’usage, PubResearcher ne prélève rien.
          </p>
          <p>
            <Link className="btn btn-primary" to="/activer-claude">
              Obtenir ma clé, pas à pas <IconArrow size={16} />
            </Link>
          </p>
          <p className="small muted">Cinq minutes, une seule fois. La clé se colle ensuite dans l’application, jamais sur ce site.</p>
        </section>

        <section className="panel-card" aria-labelledby="study-title">
          <h2 id="study-title">Votre étude</h2>
          <dl className="recap">
            <div>
              <dt>Fonction</dt>
              <dd>{labelOf(ROLES, profile.role)}</dd>
            </div>
            <div>
              <dt>Établissement</dt>
              <dd>
                {profile.institution}, {profile.country}
              </dd>
            </div>
            {profile.specialty && (
              <div>
                <dt>Spécialité</dt>
                <dd>{profile.specialty}</dd>
              </div>
            )}
            <div>
              <dt>Type d’étude</dt>
              <dd>{labelOf(STUDY_TYPES, profile.studyType)}</dd>
            </div>
            <div>
              <dt>Dossiers</dt>
              <dd>{labelOf(VOLUMES, profile.volume)}</dd>
            </div>
            <div>
              <dt>Hébergement</dt>
              <dd>{labelOf(HOSTINGS, profile.hosting)}</dd>
            </div>
            <div>
              <dt>Autorisation</dt>
              <dd>{labelOf(ETHICS, profile.ethics)}</dd>
            </div>
          </dl>
          <div className={advice.tone === 'attention' ? 'notice notice-warn' : 'notice notice-info'}>
            {advice.tone === 'attention' ? <IconShield size={18} /> : <IconInfo size={18} />}
            <div>{advice.text}</div>
          </div>
        </section>
      </div>

      <section className="panel-card access-video" aria-labelledby="video-title">
        <h2 id="video-title">
          <IconPlay size={20} /> Revoir la présentation
        </h2>
        <IntroVideo preload="none" />
      </section>

      <p className="access-foot">
        <Link to="/">
          <IconArrow size={16} className="flip" /> Retour à l’accueil
        </Link>
        <Link to="/deconnexion" state={SIGN_OUT}>
          Se déconnecter
        </Link>
      </p>
    </div>
  );
}
