import { IconCheck } from './icons';

/**
 * Les étapes du parcours d'accueil. L'état est dit en toutes lettres (« terminée », « étape en cours ») et par la
 * forme du repère — un rond plein coché, un rond cerclé —, jamais par la seule couleur.
 */
export function Stepper({ steps, current }: { steps: readonly string[]; current: number }) {
  return (
    <ol className="stepper" aria-label="Avancement">
      {steps.map((label, index) => {
        const number = index + 1;
        const state = number < current ? 'done' : number === current ? 'current' : 'todo';
        return (
          <li key={label} className={`stepper-item stepper-${state}`} aria-current={state === 'current' ? 'step' : undefined}>
            <span className="stepper-dot" aria-hidden="true">
              {state === 'done' ? <IconCheck size={14} /> : number}
            </span>
            <span className="stepper-label">
              {label}
              {state === 'done' && <span className="sr-only"> (terminée)</span>}
              {state === 'current' && <span className="sr-only"> (étape en cours)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
