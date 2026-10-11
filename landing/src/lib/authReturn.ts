/**
 * Ce que l'adresse apporte au retour d'une authentification : une erreur, ou un lien reçu par e-mail.
 *
 * Erreurs. Quand l'utilisateur refuse l'accès sur la page de Google, ou ouvre un lien périmé, le service
 * d'authentification le renvoie ici avec `error`, `error_code` et `error_description` dans l'adresse — dans la requête
 * (flux PKCE) ou dans le fragment. Le texte d'origine est en anglais et technique : on ne l'affiche jamais, on le
 * remplace par une phrase qui dit quoi faire.
 *
 * Liens « token_hash ». Avec les modèles de courriels de la documentation (docs/page-d-accueil.md, § 5.1), le lien de
 * confirmation et celui de réinitialisation mènent directement au site : `/bienvenue?token_hash=…&type=email`,
 * `/mot-de-passe?token_hash=…&type=recovery`. Le site échange ce jeton contre une session. Contrairement au lien par
 * défaut (flux PKCE, qui exige le navigateur où la demande a été faite), il marche sur n'importe quel appareil, et un
 * logiciel de sécurité qui « visite » le lien avant l'utilisateur ne le consomme pas : seul le site l'échange.
 */

const PARAMS = ['error', 'error_code', 'error_description'] as const;

/** Jetons d'un retour « implicite » (ancien format de lien) : le site ne les accepte pas, ni ne les laisse dans l'adresse. */
const IMPLICIT_PARAMS = ['access_token', 'refresh_token', 'expires_at', 'expires_in', 'token_type', 'type', 'provider_token', 'provider_refresh_token'];

function read(search: string, hash: string, key: string): string {
  const fromQuery = new URLSearchParams(search).get(key);
  if (fromQuery) return fromQuery;
  return new URLSearchParams(hash.replace(/^#/, '')).get(key) ?? '';
}

/** Où l'on revient : la page « mot de passe » reçoit les liens de réinitialisation, les autres pages tout le reste. */
export type ReturnContext = 'recovery' | 'default';

/**
 * Le lien porte un code, mais aucune session n'en est sortie : lien ouvert dans un autre navigateur que celui de
 * l'inscription (le vérificateur PKCE est resté là-bas), ou déjà utilisé. Si l'adresse a été confirmée par ce clic, le
 * mot de passe suffit : on le dit, plutôt que de renvoyer sans un mot vers la connexion.
 */
export const LINK_NOT_COMPLETED =
  'La connexion n’a pas pu se terminer dans ce navigateur : le lien a été ouvert ailleurs que là où vous vous êtes inscrit, ou il a déjà servi. Si vous avez confirmé votre adresse, connectez-vous avec votre mot de passe.';

/** Lien de confirmation refusé par le service : expiré, ou déjà utilisé. */
export const EMAIL_LINK_FAILED =
  'Ce lien a expiré ou a déjà servi. Connectez-vous : si votre adresse n’est pas encore confirmée, vous pourrez recevoir un nouveau lien.';

/** Lien de réinitialisation inutilisable ici. On ne peut pas se « connecter avec son mot de passe » : on l'a oublié. */
export const RECOVERY_LINK_FAILED =
  'Ce lien de réinitialisation ne peut pas servir ici : il a expiré, il a déjà servi, ou il a été ouvert ailleurs que dans le navigateur où vous l’avez demandé. Demandez-en un nouveau ci-dessous.';

/** Le message à montrer, ou `null` si l'adresse ne porte aucune erreur d'authentification. */
export function parseAuthReturn(search: string, hash: string, context: ReturnContext = 'default'): string | null {
  const error = read(search, hash, 'error');
  if (!error) return null;
  if (context === 'recovery') return RECOVERY_LINK_FAILED;
  const code = read(search, hash, 'error_code');
  if (code === 'otp_expired') return EMAIL_LINK_FAILED;
  if (error === 'access_denied') return 'La connexion a été annulée. Vous pouvez réessayer quand vous voulez.';
  return 'La connexion n’a pas abouti. Réessayez dans un instant.';
}

/** L'adresse sans les paramètres d'erreur (pour ne pas les rejouer au rechargement). Les autres paramètres restent. */
export function stripAuthReturn(href: string): string {
  const url = new URL(href);
  for (const key of PARAMS) url.searchParams.delete(key);
  const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
  for (const key of PARAMS) hash.delete(key);
  // Le fragment porte aussi, selon le flux, d'autres paramètres qu'il ne faut pas toucher : on n'ôte que les erreurs.
  url.hash = hash.toString();
  return `${url.pathname}${url.search}${url.hash}`;
}

export interface EmailLink {
  tokenHash: string;
  /** `email` : confirmation de l'adresse (inscription) ; `recovery` : réinitialisation du mot de passe. */
  type: 'email' | 'recovery';
}

/** Le lien « token_hash » que porte la requête, ou `null`. Les types que le site n'envoie pas sont ignorés. */
export function parseEmailLink(search: string): EmailLink | null {
  const params = new URLSearchParams(search);
  const tokenHash = (params.get('token_hash') ?? '').trim();
  const raw = params.get('type') ?? '';
  // `signup` est l'ancien nom de `email` pour une confirmation d'inscription.
  const type = raw === 'recovery' ? 'recovery' : raw === 'email' || raw === 'signup' ? 'email' : null;
  if (!type || !/^[A-Za-z0-9_-]{8,200}$/.test(tokenHash)) return null;
  return { tokenHash, type };
}

/** Le fragment porte-t-il des jetons de session (ancien format de lien, refusé par le flux PKCE) ? */
export function hasImplicitTokens(hash: string): boolean {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  return params.has('access_token') || params.has('refresh_token');
}

/**
 * L'adresse sans lien reçu par e-mail ni jetons de session : un jeton ne doit rester ni dans l'historique, ni dans une
 * adresse que l'on copie. Les autres paramètres restent.
 */
export function stripEmailLink(href: string): string {
  const url = new URL(href);
  if (url.searchParams.has('token_hash')) {
    url.searchParams.delete('token_hash');
    url.searchParams.delete('type');
  }
  if (hasImplicitTokens(url.hash)) {
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    for (const key of IMPLICIT_PARAMS) hash.delete(key);
    url.hash = hash.toString();
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
