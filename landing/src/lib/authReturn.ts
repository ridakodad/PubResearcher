/**
 * Retour d'une authentification qui n'a pas abouti.
 *
 * Quand l'utilisateur refuse l'accès sur la page de Google, ou ouvre un lien de confirmation périmé, le service
 * d'authentification le renvoie ici avec `error`, `error_code` et `error_description` dans l'adresse — dans la
 * requête (flux PKCE) ou dans le fragment (liens envoyés par e-mail). Le texte d'origine est en anglais et technique :
 * on ne l'affiche jamais, on le remplace par une phrase qui dit quoi faire.
 */

const PARAMS = ['error', 'error_code', 'error_description'] as const;

function read(search: string, hash: string, key: string): string {
  const fromQuery = new URLSearchParams(search).get(key);
  if (fromQuery) return fromQuery;
  return new URLSearchParams(hash.replace(/^#/, '')).get(key) ?? '';
}

/**
 * Le lien porte un code, mais aucune session n'en est sortie : lien ouvert dans un autre navigateur que celui de
 * l'inscription (le vérificateur PKCE est resté là-bas), ou déjà utilisé. Si l'adresse a été confirmée par ce clic, le
 * mot de passe suffit : on le dit, plutôt que de renvoyer sans un mot vers la connexion.
 */
export const LINK_NOT_COMPLETED =
  'La connexion n’a pas pu se terminer dans ce navigateur : le lien a été ouvert ailleurs que là où vous vous êtes inscrit, ou il a déjà servi. Si vous avez confirmé votre adresse, connectez-vous avec votre mot de passe.';

/** Le message à montrer, ou `null` si l'adresse ne porte aucune erreur d'authentification. */
export function parseAuthReturn(search: string, hash: string): string | null {
  const error = read(search, hash, 'error');
  if (!error) return null;
  const code = read(search, hash, 'error_code');
  if (code === 'otp_expired') {
    return 'Ce lien a expiré ou a déjà servi. Connectez-vous : si votre adresse n’est pas encore confirmée, vous pourrez recevoir un nouveau lien.';
  }
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
