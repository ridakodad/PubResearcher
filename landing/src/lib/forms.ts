/**
 * Validation des formulaires d'inscription et de connexion.
 *
 * Ces contrôles ne remplacent pas ceux du service d'authentification (qui fait foi) : ils évitent un aller-retour
 * réseau pour une faute évidente, et disent *quoi corriger* dans la langue de l'utilisateur.
 */

export type FieldErrors<K extends string> = Partial<Record<K, string>>;

/** Longueur maximale d'un mot de passe acceptée par le service d'authentification (limite de bcrypt : 72 octets). */
export const PASSWORD_MAX = 72;
export const PASSWORD_MIN = 10;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(email: string): string | null {
  const value = email.trim();
  if (value.length === 0) return 'Indiquez votre adresse e-mail.';
  if (value.length > 254 || !EMAIL.test(value)) return 'Cette adresse e-mail ne semble pas valide.';
  return null;
}

export function validatePassword(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN) return `Choisissez au moins ${PASSWORD_MIN} caractères (une phrase de passe convient).`;
  if (new TextEncoder().encode(password).length > PASSWORD_MAX) return `Ce mot de passe est trop long (${PASSWORD_MAX} octets au plus).`;
  if (/^\d+$/.test(password)) return 'Un mot de passe fait seulement de chiffres se devine trop vite.';
  const local = email.trim().split('@')[0]?.toLowerCase() ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local)) return 'Le mot de passe ne doit pas contenir votre adresse e-mail.';
  return null;
}

export interface SignupInput {
  email: string;
  password: string;
  confirm: string;
  fullName: string;
}

export function validateSignup(input: SignupInput): FieldErrors<'fullName' | 'email' | 'password' | 'confirm'> {
  const errors: FieldErrors<'fullName' | 'email' | 'password' | 'confirm'> = {};
  const name = input.fullName.trim();
  if (name.length < 2) errors.fullName = 'Indiquez votre nom.';
  else if (name.length > 120) errors.fullName = 'Ce nom est trop long (120 caractères au plus).';
  const email = validateEmail(input.email);
  if (email) errors.email = email;
  const password = validatePassword(input.password, input.email);
  if (password) errors.password = password;
  else if (input.confirm !== input.password) errors.confirm = 'Les deux mots de passe ne sont pas identiques.';
  return errors;
}

export function validateLogin(input: { email: string; password: string }): FieldErrors<'email' | 'password'> {
  const errors: FieldErrors<'email' | 'password'> = {};
  const email = validateEmail(input.email);
  if (email) errors.email = email;
  if (input.password.length === 0) errors.password = 'Indiquez votre mot de passe.';
  return errors;
}

export function validateNewPassword(input: { password: string; confirm: string }, email = ''): FieldErrors<'password' | 'confirm'> {
  const errors: FieldErrors<'password' | 'confirm'> = {};
  const password = validatePassword(input.password, email);
  if (password) errors.password = password;
  else if (input.confirm !== input.password) errors.confirm = 'Les deux mots de passe ne sont pas identiques.';
  return errors;
}

/** Code machine d'une erreur du service d'authentification (`email_not_confirmed`…), ou une chaîne vide. */
export function authErrorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : '';
}

/** Message d'erreur du service d'authentification, traduit et sans jargon. Ne laisse jamais passer le texte brut. */
export function frenchAuthError(error: unknown): string {
  const e = (error ?? {}) as { code?: unknown; message?: unknown; status?: unknown; name?: unknown };
  const code = typeof e.code === 'string' ? e.code : '';
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  const status = typeof e.status === 'number' ? e.status : 0;

  switch (code) {
    case 'invalid_credentials':
      return 'E-mail ou mot de passe incorrect.';
    case 'email_not_confirmed':
      return 'Adresse e-mail non confirmée : ouvrez le lien que nous vous avons envoyé.';
    case 'user_already_exists':
    case 'email_exists':
      return 'Un compte existe déjà avec cette adresse : connectez-vous.';
    case 'weak_password':
      return 'Ce mot de passe est trop faible : allongez-le ou mélangez les caractères.';
    case 'signup_disabled':
    case 'email_provider_disabled':
      return 'Les inscriptions par e-mail sont fermées sur ce site.';
    case 'provider_disabled':
    case 'oauth_provider_not_supported':
      return 'La connexion avec Google n’est pas encore activée sur ce site : utilisez votre adresse e-mail.';
    case 'over_email_send_rate_limit':
    case 'over_request_rate_limit':
    case 'over_sms_send_rate_limit':
      return 'Trop de tentatives en peu de temps : patientez une minute, puis réessayez.';
    case 'same_password':
      return 'Le nouveau mot de passe doit différer de l’ancien.';
    case 'session_expired':
    case 'session_not_found':
    case 'refresh_token_not_found':
      return 'Votre session a expiré : reconnectez-vous.';
    default:
  }

  if (status === 429 || message.includes('rate limit')) return 'Trop de tentatives en peu de temps : patientez une minute, puis réessayez.';
  if (message.includes('invalid login credentials')) return 'E-mail ou mot de passe incorrect.';
  if (message.includes('already registered')) return 'Un compte existe déjà avec cette adresse : connectez-vous.';
  if (message.includes('provider is not enabled') || message.includes('unsupported provider')) {
    return 'La connexion avec Google n’est pas encore activée sur ce site : utilisez votre adresse e-mail.';
  }
  if (message.includes('failed to fetch') || message.includes('networkerror') || message.includes('load failed') || e.name === 'AuthRetryableFetchError') {
    return 'Le service d’authentification est injoignable : vérifiez votre connexion, puis réessayez.';
  }
  return 'Une erreur est survenue. Réessayez dans un instant.';
}
