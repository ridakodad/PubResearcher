import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Balises de partage (aperçu d'un lien sur les messageries et réseaux). Une image de partage exige une adresse
 * absolue : elles ne sont donc posées que si `VITE_SITE_URL` est renseignée ; sans elle, mieux vaut ne rien
 * annoncer qu'une adresse relative que les robots ne résolvent pas.
 */
function socialTags(siteUrl: string): Plugin {
  return {
    name: 'pubresearcher-social-tags',
    transformIndexHtml(html) {
      const tags = [
        '<meta property="og:type" content="website" />',
        '<meta property="og:locale" content="fr_FR" />',
        '<meta property="og:site_name" content="PubResearcher" />',
        '<meta property="og:title" content="PubResearcher — l’espace de travail d’une étude rétrospective" />',
        '<meta property="og:description" content="Vos dossiers patients en jeu de données traçable, et votre revue de littérature, sur votre poste." />',
      ];
      if (siteUrl) {
        tags.push(
          `<meta property="og:url" content="${siteUrl}/" />`,
          `<meta property="og:image" content="${siteUrl}/og.png" />`,
          '<meta property="og:image:width" content="1280" />',
          '<meta property="og:image:height" content="640" />',
          '<meta name="twitter:card" content="summary_large_image" />',
        );
      }
      return html.replace('<!--social-tags-->', tags.join('\n    '));
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const siteUrl = (env.VITE_SITE_URL ?? '').trim().replace(/\/+$/, '');
  return {
    plugins: [react(), socialTags(/^https?:\/\/[^\s"<>]+$/.test(siteUrl) ? siteUrl : '')],
    server: { port: 5174 },
    build: { outDir: 'dist', sourcemap: false },
    // Configuration PostCSS vide mais explicite : la compilation ne doit pas dépendre d'un fichier de configuration
    // trouvé plus haut dans l'arborescence (même raison que pour l'application, voir web/vite.config.ts).
    css: { postcss: {} },
  };
});
