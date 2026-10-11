import { useAuth } from '../lib/auth';
import { config } from '../lib/config';
import { IconInfo } from './icons';

/**
 * Bandeau du mode aperçu, sur chaque page : tant que l'authentification n'est pas branchée (variables `VITE_SUPABASE_*`),
 * le parcours se visite mais rien n'est envoyé ni conservé. Mieux vaut le dire en haut de chaque écran que laisser
 * croire qu'un compte a été créé.
 */
export function PreviewBanner() {
  const { preview } = useAuth();
  if (!preview) return null;
  return (
    <aside className="preview-banner" aria-label="Mode aperçu">
      <IconInfo size={18} />
      <p>
        <strong>Mode aperçu.</strong> Le parcours se visite, mais rien n’est envoyé ni conservé : la connexion et
        l’enregistrement ne sont pas branchés.{' '}
        <a href={`${config.repoUrl}/blob/main/docs/page-d-accueil.md`} target="_blank" rel="noopener noreferrer">
          Comment les brancher
        </a>
        .
      </p>
    </aside>
  );
}
