import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // En développement le front et l'API tournent séparément ; le proxy évite
    // toute configuration CORS côté navigateur.
    proxy: {
      '/api': {
        target: process.env.API_URL ?? 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  build: { outDir: 'dist', sourcemap: true },

  /*
   * Configuration PostCSS vide, mais explicite.
   *
   * Sans elle, l'outil de construction remonte l'arborescence à la recherche
   * d'un fichier de configuration et adopte le premier trouvé — y compris un
   * `tailwind.config.js` posé dans le dossier personnel de l'utilisateur pour
   * un tout autre projet. La compilation dépendrait alors de ce qui traîne sur
   * le poste. Les styles de cette application sont écrits à la main, sans
   * greffon : la recherche s'arrête ici.
   */
  css: { postcss: {} },
});
