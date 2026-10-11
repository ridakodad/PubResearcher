/**
 * Adresses venant de la configuration.
 *
 * Les variables `VITE_*` sont saisies à la main dans un tableau de bord : une faute ne doit jamais produire un lien
 * qui exécute du code (`javascript:…`) ni une redirection vers un schéma inattendu. Seules les adresses http(s)
 * passent ; le reste vaut « non configuré ».
 */

/** L'adresse normalisée (sans barre finale), ou `null` si ce n'est pas une adresse http(s) valide. */
export function httpUrl(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Adresse d'une page de ce site, pour les retours d'authentification : toujours sur l'origine courante. */
export function pageUrl(origin: string, path: string): string {
  return `${origin.replace(/\/$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * Chemin de retour après connexion (`?suite=/acces`). Seul un chemin interne du site est admis : une adresse complète,
 * un `//autre-site` ou un chemin inconnu renvoient au parcours normal (redirection ouverte).
 */
const INTERNAL_PATHS = new Set(['/bienvenue', '/acces']);
export function safeNext(value: string | null | undefined): string | null {
  if (!value) return null;
  return INTERNAL_PATHS.has(value) ? value : null;
}
