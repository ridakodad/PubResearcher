/**
 * Parcours d'accueil : ce que l'on demande, comment on le contrôle, où l'on reprend.
 *
 * Trois étapes : le profil professionnel, l'étude envisagée, puis la charte d'anonymisation. Les deux premières
 * se sauvegardent ensemble ; la charte s'enregistre à part, avec sa version, comme une pièce qui se prouve
 * (table `consents` : une ligne par engagement, jamais modifiée). Rien de tout cela ne porte sur un patient.
 */
import type { FieldErrors } from './forms';
import { ANONYMISATION_VERSION } from './charter';

export interface Option {
  value: string;
  label: string;
}

export const ROLES: readonly Option[] = [
  { value: 'interne', label: 'Interne, résident' },
  { value: 'medecin', label: 'Médecin' },
  { value: 'chercheur', label: 'Chercheur, enseignant-chercheur' },
  { value: 'doctorant', label: 'Doctorant, étudiant en thèse' },
  { value: 'arc', label: 'ARC, data manager, biostatisticien' },
  { value: 'autre', label: 'Autre' },
];

export const STUDY_TYPES: readonly Option[] = [
  { value: 'retro-mono', label: 'Étude rétrospective monocentrique' },
  { value: 'retro-multi', label: 'Étude rétrospective multicentrique' },
  { value: 'these', label: 'Thèse de médecine ou mémoire' },
  { value: 'revue', label: 'Revue de littérature seulement' },
  { value: 'essai', label: 'Essayer l’outil, avec des données fictives' },
  { value: 'autre', label: 'Autre' },
];

export const VOLUMES: readonly Option[] = [
  { value: 'lt100', label: 'Moins de 100 dossiers' },
  { value: '100-1000', label: 'De 100 à 1 000 dossiers' },
  { value: 'gt1000', label: 'Plus de 1 000 dossiers' },
  { value: 'inconnu', label: 'Je ne sais pas encore' },
];

export const HOSTINGS: readonly Option[] = [
  { value: 'poste', label: 'Sur mon ordinateur' },
  { value: 'etablissement', label: 'Sur un serveur de mon établissement' },
  { value: 'inconnu', label: 'Je ne sais pas encore' },
];

export const ETHICS: readonly Option[] = [
  { value: 'obtenue', label: 'Obtenue' },
  { value: 'en-cours', label: 'En cours de demande' },
  { value: 'pas-encore', label: 'Pas encore demandée' },
  { value: 'sans-objet', label: 'Sans objet : données fictives seulement' },
];

export interface ProfileDraft {
  fullName: string;
  role: string;
  institution: string;
  country: string;
  specialty: string;
  studyType: string;
  volume: string;
  hosting: string;
  ethics: string;
}

export type ProfileField = keyof ProfileDraft;

export const EMPTY_PROFILE: ProfileDraft = {
  fullName: '',
  role: '',
  institution: '',
  country: '',
  specialty: '',
  studyType: '',
  volume: '',
  hosting: '',
  ethics: '',
};

const oneOf = (options: readonly Option[], value: string): boolean => options.some((o) => o.value === value);

/** Espaces de bord retirés, espaces internes réduits : « Dr  Ben  Ali » et « Dr Ben Ali » sont la même saisie. */
export function normalizeDraft(draft: ProfileDraft): ProfileDraft {
  const out = { ...draft };
  for (const key of Object.keys(out) as ProfileField[]) out[key] = out[key].replace(/\s+/g, ' ').trim();
  return out;
}

/** Étape 1 : le profil. Étape 2 : l'étude. Les erreurs sont rangées par champ, en français. */
export function validateProfileStep(step: 1 | 2, input: ProfileDraft): FieldErrors<ProfileField> {
  const draft = normalizeDraft(input);
  const errors: FieldErrors<ProfileField> = {};

  if (step === 1) {
    if (draft.fullName.length < 2) errors.fullName = 'Indiquez votre nom.';
    else if (draft.fullName.length > 120) errors.fullName = 'Ce nom est trop long (120 caractères au plus).';
    if (!oneOf(ROLES, draft.role)) errors.role = 'Choisissez votre fonction.';
    if (draft.institution.length < 2) errors.institution = 'Indiquez votre établissement ou votre laboratoire.';
    else if (draft.institution.length > 160) errors.institution = 'Ce nom est trop long (160 caractères au plus).';
    if (draft.country.length < 2) errors.country = 'Indiquez votre pays.';
    else if (draft.country.length > 80) errors.country = 'Ce nom est trop long (80 caractères au plus).';
    if (draft.specialty.length > 120) errors.specialty = 'Cette spécialité est trop longue (120 caractères au plus).';
  } else {
    if (!oneOf(STUDY_TYPES, draft.studyType)) errors.studyType = 'Choisissez le type d’étude.';
    if (!oneOf(VOLUMES, draft.volume)) errors.volume = 'Choisissez un ordre de grandeur.';
    if (!oneOf(HOSTINGS, draft.hosting)) errors.hosting = 'Dites où vous ferez tourner l’outil.';
    if (!oneOf(ETHICS, draft.ethics)) errors.ethics = 'Indiquez où en est l’autorisation de l’étude.';
  }
  return errors;
}

export function isProfileComplete(draft: ProfileDraft): boolean {
  return (
    Object.keys(validateProfileStep(1, draft)).length === 0 && Object.keys(validateProfileStep(2, draft)).length === 0
  );
}

/** Ce que l'on sait d'un compte : suffit à décider où l'envoyer. */
export interface OnboardingState {
  profile: ProfileDraft | null;
  /** Version de la charte la plus récemment confirmée, ou `null` si aucune. */
  consentedVersion: string | null;
  /** Date (ISO 8601) de cette confirmation, ou `null`. */
  consentedAt?: string | null;
}

export type OnboardingStep = 'profile' | 'charter' | 'done';

/** Reprise du parcours : profil incomplet → profil ; charte absente ou périmée → charte ; sinon, terminé. */
export function nextStep(state: OnboardingState, currentVersion: string = ANONYMISATION_VERSION): OnboardingStep {
  if (!state.profile || !isProfileComplete(state.profile)) return 'profile';
  if (state.consentedVersion !== currentVersion) return 'charter';
  return 'done';
}

/** Ligne de la table `profiles` (colonnes en snake_case) : la même forme à l'écriture et à la lecture. */
export interface ProfileRow {
  user_id: string;
  full_name: string;
  role: string;
  institution: string;
  country: string;
  specialty: string | null;
  study_type: string | null;
  volume: string | null;
  hosting: string | null;
  ethics: string | null;
  /** Absent tant que le parcours n'est pas terminé : l'écriture « fusionne », elle n'efface pas une date déjà posée. */
  onboarding_completed_at?: string | null;
}

export function toRow(userId: string, input: ProfileDraft, completedAt?: Date): ProfileRow {
  const d = normalizeDraft(input);
  return {
    user_id: userId,
    full_name: d.fullName,
    role: d.role,
    institution: d.institution,
    country: d.country,
    specialty: d.specialty || null,
    study_type: d.studyType || null,
    volume: d.volume || null,
    hosting: d.hosting || null,
    ethics: d.ethics || null,
    ...(completedAt ? { onboarding_completed_at: completedAt.toISOString() } : {}),
  };
}

export function fromRow(row: Partial<ProfileRow> | null | undefined): ProfileDraft | null {
  if (!row || typeof row.full_name !== 'string') return null;
  return {
    fullName: row.full_name,
    role: row.role ?? '',
    institution: row.institution ?? '',
    country: row.country ?? '',
    specialty: row.specialty ?? '',
    studyType: row.study_type ?? '',
    volume: row.volume ?? '',
    hosting: row.hosting ?? '',
    ethics: row.ethics ?? '',
  };
}

/** Libellé d'une valeur d'option (pour le récapitulatif de la page d'accès). */
export function labelOf(options: readonly Option[], value: string): string {
  return options.find((o) => o.value === value)?.label ?? '';
}

/**
 * Ce que l'on dit à l'utilisateur sur l'autorisation de son étude, selon sa réponse. L'outil ne la vérifie pas :
 * c'est un rappel adapté à sa situation, pas une barrière.
 */
export function ethicsAdvice(ethics: string): { tone: 'ok' | 'attention'; text: string } {
  switch (ethics) {
    case 'obtenue':
      return { tone: 'ok', text: 'Gardez la référence de l’autorisation avec le protocole : elle se cite dans la partie « Méthodes ».' };
    case 'en-cours':
      return { tone: 'attention', text: 'Tant que l’autorisation n’est pas obtenue, n’importez que les dossiers fictifs fournis avec l’outil (npm run demo).' };
    case 'pas-encore':
      return { tone: 'attention', text: 'Avant d’importer de vrais dossiers, demandez l’autorisation (comité d’éthique, CNDP au Maroc, RGPD ailleurs). En attendant, essayez l’outil avec les dossiers fictifs (npm run demo).' };
    default:
      return { tone: 'ok', text: 'Les dossiers fictifs fournis avec l’outil (npm run demo) suffisent pour tout essayer.' };
  }
}
