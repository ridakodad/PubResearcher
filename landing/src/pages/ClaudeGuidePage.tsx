import { Link } from 'react-router-dom';
import { IconArrow, IconExternal, IconInfo, IconShield } from '../components/icons';
import { useAuth } from '../lib/auth';
import { GUIDE_COST, GUIDE_HELP, GUIDE_INTRO, GUIDE_STEPS, GUIDE_TITLE, PASTE_STEP } from '../lib/claudeGuide';
import { usePageTitle } from '../lib/usePageTitle';

/**
 * « Activer Claude », la version publique du guide de l'application : obtenir sa clé d'API Anthropic pas à pas, avant
 * même d'avoir installé l'outil. Le texte est celui de l'application (copie comparée par un test) ; seule la dernière
 * étape diffère : ici, on dit où coller la clé — dans l'application, jamais sur ce site.
 */
export function ClaudeGuidePage() {
  usePageTitle(GUIDE_TITLE);
  const { user } = useAuth();

  return (
    <div className="view container narrow-wide guide-page">
      <p className="eyebrow">Facultatif · cinq minutes</p>
      <h1>{GUIDE_TITLE}</h1>
      <p className="lead">{GUIDE_INTRO}</p>

      <div className="notice notice-info">
        <IconInfo size={18} />
        <div>
          <strong>Ce que ça coûte.</strong> {GUIDE_COST}
        </div>
      </div>

      <ol className="guide-steps" aria-label="Les quatre étapes pour activer Claude">
        {GUIDE_STEPS.map((step, index) => (
          <li className="guide-step" key={step.id}>
            <div className="guide-step-head">
              <span className="guide-num" aria-hidden="true">
                {index + 1}
              </span>
              <h2>
                <span className="sr-only">Étape {index + 1} : </span>
                {step.title}
              </h2>
              <span className="guide-time">
                <span className="sr-only">environ </span>
                <span aria-hidden="true">≈ </span>
                {step.minutes} min
              </span>
            </div>
            <ul className="guide-actions">
              {step.actions.map((action) => (
                <li key={action}>{action}</li>
              ))}
            </ul>
            <div>
              <a className="btn btn-primary" href={step.link.href} target="_blank" rel="noopener noreferrer">
                {step.link.label} <IconExternal size={16} />
                <span className="sr-only"> (s’ouvre dans un nouvel onglet)</span>
              </a>
            </div>
            {step.tip && (
              <p className="guide-tip">
                <IconInfo size={16} /> {step.tip}
              </p>
            )}
          </li>
        ))}
        <li className="guide-step guide-step-paste">
          <div className="guide-step-head">
            <span className="guide-num" aria-hidden="true">
              4
            </span>
            <h2>
              <span className="sr-only">Étape 4 : </span>
              {PASTE_STEP.title}
            </h2>
          </div>
          <p className="guide-text">{PASTE_STEP.onSite}</p>
          <p className="guide-tip">
            <IconShield size={16} /> Ce site ne vous demandera jamais votre clé, et n’en garde aucune.
          </p>
        </li>
      </ol>

      <section className="guide-help" aria-labelledby="aide-claude">
        <h2 id="aide-claude">Un souci ?</h2>
        {GUIDE_HELP.map((item) => (
          <details className="faq-item" key={item.question}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </section>

      <p className="access-foot">
        {user ? (
          <Link to="/acces">
            <IconArrow size={16} className="flip" /> Retour à mon accès
          </Link>
        ) : (
          <Link to="/inscription">
            Créer mon accès <IconArrow size={16} />
          </Link>
        )}
        <Link to="/">Retour à l’accueil</Link>
      </p>
    </div>
  );
}
