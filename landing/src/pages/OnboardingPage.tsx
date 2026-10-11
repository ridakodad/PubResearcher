import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CharterChecklist } from '../components/CharterChecklist';
import { ChoiceField, focusFirstError, SelectField, TextField } from '../components/fields';
import { IconInfo, IconShield } from '../components/icons';
import { Stepper } from '../components/Stepper';
import { useAuth } from '../lib/auth';
import {
  allConfirmed,
  ANONYMISATION_VERSION,
  CHARTER_DISCLAIMER,
  CHARTER_LEAD,
  CHARTER_TITLE,
} from '../lib/charter';
import {
  EMPTY_PROFILE,
  ETHICS,
  ethicsAdvice,
  HOSTINGS,
  nextStep,
  ROLES,
  STUDY_TYPES,
  validateProfileStep,
  VOLUMES,
  type ProfileDraft,
  type ProfileField,
} from '../lib/onboarding';
import { recordConsent, saveProfile } from '../lib/profile';
import type { FieldErrors } from '../lib/forms';
import { usePageTitle } from '../lib/usePageTitle';
import { useOnboardingState } from '../lib/useOnboarding';

const STEP_LABELS = ['Votre profil', 'Votre étude', 'Votre engagement'] as const;
const STEP_HEADINGS = ['Qui êtes-vous ?', 'Quelle étude préparez-vous ?', 'Votre engagement d’anonymisation'] as const;

/**
 * Parcours d'accueil : le profil, l'étude, puis la charte d'anonymisation. Chaque étape enregistre ce qu'elle a
 * recueilli avant de passer à la suivante — quitter la page n'efface rien, et la reprise se fait là où l'on s'est arrêté.
 *
 * `?modifier` rouvre le parcours depuis le début pour corriger ses réponses ; la charte n'est alors redemandée que si
 * le texte a changé depuis la dernière confirmation.
 */
export function OnboardingPage() {
  usePageTitle('Bienvenue', { noindex: true });
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const editing = params.has('modifier');
  const { state, error: loadError, reload } = useOnboardingState(user);

  const [draft, setDraft] = useState<ProfileDraft>(EMPTY_PROFILE);
  const [step, setStep] = useState<1 | 2 | 3 | null>(null);
  const [errors, setErrors] = useState<FieldErrors<ProfileField>>({});
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const formRef = useRef<HTMLFormElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const initialised = useRef(false);
  const stepChanged = useRef(false);

  const charterPending = state ? state.consentedVersion !== ANONYMISATION_VERSION : true;
  const stepCount = charterPending ? 3 : 2;

  // Une fois l'état chargé : préremplir, puis reprendre à la première étape qui reste à faire.
  useEffect(() => {
    if (!state || !user || initialised.current) return;
    initialised.current = true;
    const profile = state.profile ?? { ...EMPTY_PROFILE, fullName: user.name };
    setDraft(profile);

    const target = nextStep(state);
    if (editing) setStep(1);
    else if (target === 'done') navigate('/acces', { replace: true });
    else if (target === 'charter') setStep(3);
    else setStep(state.profile && Object.keys(validateProfileStep(1, profile)).length === 0 ? 2 : 1);
  }, [state, user, editing, navigate]);

  // Au changement d'étape (pas au premier affichage), le titre prend le focus : un lecteur d'écran l'annonce.
  useEffect(() => {
    if (step === null) return;
    if (stepChanged.current) {
      headingRef.current?.focus();
      window.scrollTo({ top: 0 });
    }
    stepChanged.current = true;
  }, [step]);

  if (!user) return null;

  if (loadError) {
    return (
      <div className="view container narrow">
        <div className="notice notice-error" role="alert">
          <IconInfo size={18} />
          <div>
            {loadError}{' '}
            <button type="button" className="link-button" onClick={() => void reload()}>
              Réessayer
            </button>
          </div>
        </div>
      </div>
    );
  }
  if (step === null) {
    return (
      <div className="container narrow loading-panel" role="status">
        <span className="spinner" aria-hidden="true" />
        <p>Chargement de vos réponses…</p>
      </div>
    );
  }

  const set = (key: ProfileField) => (value: string) => {
    setDraft((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }));
  };
  const setText = (key: ProfileField) => (event: { target: { value: string } }) => set(key)(event.target.value);

  /** Contrôle l'étape 1 ou 2, enregistre, puis passe à la suite. */
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !user || (step !== 1 && step !== 2)) return;
    setSaveError(null);

    const found = validateProfileStep(step, draft);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      window.requestAnimationFrame(() => focusFirstError(formRef.current));
      return;
    }

    setBusy(true);
    try {
      await saveProfile(user, draft);
      if (step === 1) setStep(2);
      else if (charterPending) setStep(3);
      else navigate('/acces', { replace: true });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Impossible d’enregistrer vos réponses.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmCharter() {
    if (busy || !user || !allConfirmed(checked)) return;
    setBusy(true);
    setSaveError(null);
    try {
      await recordConsent(user);
      try {
        await saveProfile(user, draft, new Date());
      } catch {
        // La date de fin du parcours est un confort : l'engagement, lui, est enregistré. Le détail est dans la console.
      }
      navigate('/acces', { replace: true });
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : 'Impossible d’enregistrer votre engagement.');
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const advice = draft.ethics ? ethicsAdvice(draft.ethics) : null;

  return (
    <div className="view container narrow onboarding">
      <p className="eyebrow">
        Bienvenue{user.name ? ', ' : ''}
        {user.name && <span className="eyebrow-name">{user.name}</span>}
      </p>
      <Stepper steps={STEP_LABELS.slice(0, stepCount)} current={step} />

      <div className="onboarding-card">
        <h1 tabIndex={-1} ref={headingRef}>
          {step === 3 ? CHARTER_TITLE : STEP_HEADINGS[step - 1]}
        </h1>
        <p className="onboarding-progress">
          Étape {step} sur {stepCount}
        </p>

        {saveError && (
          <div className="notice notice-error" role="alert">
            <IconInfo size={18} />
            <div>{saveError}</div>
          </div>
        )}

        {step === 1 && (
          <form ref={formRef} onSubmit={submit} noValidate>
            <TextField
              label="Nom et prénom"
              autoComplete="name"
              value={draft.fullName}
              onChange={setText('fullName')}
              error={errors.fullName}
            />
            <SelectField label="Fonction" options={ROLES} value={draft.role} onChange={set('role')} error={errors.role} />
            <TextField
              label="Établissement ou laboratoire"
              autoComplete="organization"
              value={draft.institution}
              onChange={setText('institution')}
              error={errors.institution}
            />
            <TextField
              label="Pays"
              autoComplete="country-name"
              value={draft.country}
              onChange={setText('country')}
              error={errors.country}
            />
            <TextField
              label="Spécialité"
              optional
              hint="Par exemple : cardiologie, pneumologie, médecine interne."
              value={draft.specialty}
              onChange={setText('specialty')}
              error={errors.specialty}
            />
            <div className="form-actions">
              <button type="submit" className="btn btn-primary btn-lg" disabled={busy} aria-busy={busy}>
                {busy ? 'Enregistrement…' : 'Continuer'}
              </button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form ref={formRef} onSubmit={submit} noValidate>
            <SelectField
              label="Type d’étude"
              options={STUDY_TYPES}
              value={draft.studyType}
              onChange={set('studyType')}
              error={errors.studyType}
            />
            <ChoiceField
              legend="Combien de dossiers envisagez-vous d’exploiter ?"
              options={VOLUMES}
              value={draft.volume}
              onChange={set('volume')}
              error={errors.volume}
            />
            <ChoiceField
              legend="Où ferez-vous tourner l’outil ?"
              hint="Il n’écoute que sur l’ordinateur où il est lancé."
              options={HOSTINGS}
              value={draft.hosting}
              onChange={set('hosting')}
              error={errors.hosting}
            />
            <ChoiceField
              legend="Où en est l’autorisation de l’étude (comité d’éthique, CNDP, RGPD…) ?"
              options={ETHICS}
              value={draft.ethics}
              onChange={set('ethics')}
              error={errors.ethics}
            />

            {advice && (
              <div className={advice.tone === 'attention' ? 'notice notice-warn' : 'notice notice-info'} role="status">
                {advice.tone === 'attention' ? <IconShield size={18} /> : <IconInfo size={18} />}
                <div>{advice.text}</div>
              </div>
            )}

            <div className="form-actions">
              <button type="button" className="btn btn-lg" onClick={() => setStep(1)} disabled={busy}>
                Retour
              </button>
              <button type="submit" className="btn btn-primary btn-lg" disabled={busy} aria-busy={busy}>
                {busy ? 'Enregistrement…' : charterPending ? 'Continuer' : 'Enregistrer'}
              </button>
            </div>
          </form>
        )}

        {step === 3 && (
          <section className="charter charter-flat" aria-label="Charte d’anonymisation">
            <div className="charter-head">
              <span className="charter-badge" aria-hidden="true">
                <IconShield size={22} />
              </span>
              <p className="charter-lead">{CHARTER_LEAD}</p>
            </div>

            <CharterChecklist checked={checked} onToggle={toggle} />

            <p className="small muted">{CHARTER_DISCLAIMER}</p>

            <div className="form-actions">
              <button type="button" className="btn btn-lg" onClick={() => setStep(2)} disabled={busy}>
                Retour
              </button>
              <button
                type="button"
                className="btn btn-primary btn-lg"
                onClick={() => void confirmCharter()}
                disabled={busy || !allConfirmed(checked)}
                aria-busy={busy}
              >
                {busy ? 'Enregistrement…' : 'Je confirme et j’enregistre'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
