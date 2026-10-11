import { useEffect } from 'react';

const DEFAULT_TITLE = 'PubResearcher — l’espace de travail d’une étude rétrospective';

/**
 * Titre de l'onglet (et de l'annonce d'un lecteur d'écran) pour la page affichée ; `null` : le titre par défaut.
 *
 * `noindex` demande aux moteurs de recherche de ne pas référencer la page (formulaires, pages d'un compte, erreur 404) :
 * seules l'accueil et la page de confidentialité ont du contenu à trouver. Le fichier robots.txt interdit en plus
 * l'exploration des pages privées.
 */
export function usePageTitle(title: string | null, { noindex = false }: { noindex?: boolean } = {}): void {
  useEffect(() => {
    document.title = title ? `${title} — PubResearcher` : DEFAULT_TITLE;
  }, [title]);

  useEffect(() => {
    if (!noindex) return undefined;
    const meta = document.createElement('meta');
    meta.name = 'robots';
    meta.content = 'noindex';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, [noindex]);
}
