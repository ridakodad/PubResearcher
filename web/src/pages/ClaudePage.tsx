import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyForm } from '../components/KeyForm';
import { useToast } from '../components/ui';
import { IconCheck, IconExternal, IconInfo, IconKey } from '../components/icons';
import {
  GUIDE_COST,
  GUIDE_HELP,
  GUIDE_INTRO,
  GUIDE_STEPS,
  GUIDE_WHAT,
  PASTE_STEP,
  type GuideStep,
} from '../lib/claudeGuide';
import { formatDateTime, modelLabel } from '../lib/format';
import { readSetting, writeSetting } from '../lib/storage';
import type { ApiKeyStatus } from '../lib/types';
import { describeKey, useApiKey } from '../lib/useApiKey';

const DONE_KEY = 'claude:etapes-faites';

/** Étapes cochées : un confort, retenu dans ce navigateur pour qui revient après avoir quitté la page. */
function readDone(): Set<string> {
  return new Set((readSetting(DONE_KEY) ?? '').split(',').filter(Boolean));
}

/**
 * Activer Claude : obtenir sa clé d'API Anthropic sans se perdre, puis la coller ici.
 *
 * Trois étapes chez Anthropic, chacune avec le lien qui mène directement à la bonne page de la console, puis le champ
 * où coller la clé. Une fois la clé enregistrée, la page devient celle de la clé : son état, la changer, la retirer,
 * et le dépannage en mots simples.
 */
export function ClaudePage() {
  const toast = useToast();
  const { status, loadError, apply, remove, removing } = useApiKey();
  const [done, setDone] = useState<Set<string>>(readDone);
  const [showGuide, setShowGuide] = useState(false);
  const [editing, setEditing] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const active = status !== null && status.source !== null;
  const wasActive = useRef<boolean | null>(null);

  // Quand la clé vient d'être enregistrée, le titre change : il prend le focus, pour que le lecteur d'écran l'annonce.
  useEffect(() => {
    if (status === null) return;
    if (wasActive.current === false && active) headingRef.current?.focus();
    wasActive.current = active;
  }, [status, active]);

  function toggle(id: string) {
    setDone((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      writeSetting(DONE_KEY, [...next].join(','));
      return next;
    });
  }

  function saved(next: ApiKeyStatus) {
    const all = new Set(GUIDE_STEPS.map((s) => s.id));
    writeSetting(DONE_KEY, [...all].join(','));
    setDone(all);
    setEditing(false);
    setShowGuide(false);
    apply(next);
  }

  async function confirmRemove() {
    if (removing) return;
    if (!window.confirm('Retirer votre clé de cet ordinateur ? Claude ne sera plus utilisable sans clé.')) return;
    const error = await remove();
    if (error) toast.error(error);
    else toast.success('Clé retirée.');
  }

  const guideVisible = status !== null && (!active || showGuide);

  return (
    <div className="stack claude-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Instruments</div>
          <h1 ref={headingRef} tabIndex={-1}>
            {active ? 'Claude est activé' : 'Activer Claude'}
          </h1>
          <p className="sub">{active ? GUIDE_WHAT : GUIDE_INTRO}</p>
        </div>
      </div>

      {loadError && (
        <div className="notice notice-error" role="alert">
          <div>{loadError}</div>
        </div>
      )}

      {status && active && (
        <section className="card key-active" aria-labelledby="cle-active">
          <div className="card-head">
            <span className="key-active-icon" aria-hidden="true">
              <IconCheck size={18} />
            </span>
            <div>
              <h2 id="cle-active" style={{ fontSize: '1rem', margin: 0 }}>
                Votre clé est en service
              </h2>
              <div className="sub">{describeKey(status, formatDateTime)}</div>
            </div>
            {!editing && (
              <div className="card-actions">
                <button className="btn-sm" onClick={() => setEditing(true)}>
                  {status.source === 'app' ? 'Changer de clé' : 'Utiliser ma propre clé'}
                </button>
                {status.source === 'app' && (
                  <button className="btn-sm btn-quiet" onClick={() => void confirmRemove()} disabled={removing} aria-busy={removing}>
                    Retirer
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="card-body stack" style={{ gap: 12 }}>
            {editing ? (
              <KeyForm onSaved={saved} onCancel={() => setEditing(false)} autoFocus submitLabel="Vérifier et enregistrer" />
            ) : (
              <>
                <p className="small secondary" style={{ margin: 0 }}>
                  Modèle : {modelLabel(status.model)}. Les passes par Claude sont facturées sur votre compte Anthropic ; leur
                  coût s’affiche avant que vous les lanciez, puis une fois terminées.
                </p>
                <div className="row">
                  <Link className="btn btn-primary btn-sm" to="/extraction">
                    Extraire avec Claude
                  </Link>
                  <Link className="btn btn-sm" to="/redaction">
                    Ouvrir l’assistant de rédaction
                  </Link>
                  {!showGuide && (
                    <button className="btn-sm btn-quiet" onClick={() => setShowGuide(true)}>
                      Revoir le guide pas à pas
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </section>
      )}

      <div className="notice notice-info">
        <IconInfo size={18} />
        <div>
          <strong>Ce que ça coûte.</strong> {GUIDE_COST}
        </div>
      </div>

      {guideVisible && (
        <ol className="guide-steps" aria-label="Les quatre étapes pour activer Claude">
          {GUIDE_STEPS.map((step, index) => (
            <GuideStepCard key={step.id} step={step} number={index + 1} done={done.has(step.id)} onToggle={() => toggle(step.id)} />
          ))}
          <li className="guide-step guide-step-paste" id="coller-la-cle">
            <div className="guide-step-head">
              <span className="guide-num" aria-hidden="true">
                4
              </span>
              <h2>
                <span className="sr-only">Étape 4 : </span>
                {PASTE_STEP.title}
              </h2>
            </div>
            <p className="guide-text">{PASTE_STEP.inApp}</p>
            {active && !editing ? (
              <p className="small muted" style={{ margin: 0 }}>
                <IconKey size={12} /> Une clé est déjà en service : « Changer de clé », plus haut, la remplace.
              </p>
            ) : (
              !active && <KeyForm onSaved={saved} />
            )}
          </li>
        </ol>
      )}

      <section className="guide-help" aria-labelledby="aide-claude">
        <h2 id="aide-claude">Un souci ?</h2>
        {GUIDE_HELP.map((item) => (
          <details key={item.question}>
            <summary>{item.question}</summary>
            <p>{item.answer}</p>
          </details>
        ))}
      </section>
    </div>
  );
}

function GuideStepCard({ step, number, done, onToggle }: { step: GuideStep; number: number; done: boolean; onToggle: () => void }) {
  const checkId = `etape-${step.id}`;
  return (
    <li className={done ? 'guide-step done' : 'guide-step'}>
      <div className="guide-step-head">
        <span className="guide-num" aria-hidden="true">
          {done ? <IconCheck size={16} /> : number}
        </span>
        <h2>
          <span className="sr-only">Étape {number} : </span>
          {step.title}
        </h2>
        <span className="guide-time">
          <span className="sr-only">environ </span>
          <span aria-hidden="true">≈ </span>
          {step.minutes} min
        </span>
      </div>
      {!done && (
        <>
          <ul className="guide-actions">
            {step.actions.map((action) => (
              <li key={action}>{action}</li>
            ))}
          </ul>
          <div className="row">
            <a className="btn btn-primary" href={step.link.href} target="_blank" rel="noopener noreferrer">
              {step.link.label} <IconExternal size={14} />
              <span className="sr-only"> (s’ouvre dans un nouvel onglet)</span>
            </a>
          </div>
          {step.tip && (
            <p className="guide-tip">
              <IconInfo size={14} /> {step.tip}
            </p>
          )}
        </>
      )}
      <label className="guide-done" htmlFor={checkId}>
        <input id={checkId} type="checkbox" checked={done} onChange={onToggle} />
        {done ? 'Fait — décocher pour revoir l’étape' : 'C’est fait'}
      </label>
    </li>
  );
}
