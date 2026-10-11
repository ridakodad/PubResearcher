/**
 * Configuration lue à la compilation (variables `VITE_*`, voir `.env.example`).
 *
 * Rien ici n'est secret : tout ce qui est préfixé `VITE_` finit dans le code publié. La clé « publique » de
 * Supabase l'est par conception ; ce sont les règles d'accès par ligne (supabase/migrations) qui protègent les
 * données, pas la discrétion de cette clé.
 */
import pkg from '../../package.json';
import { httpUrl } from './urls';

const env = import.meta.env;
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const supabaseUrl = httpUrl(text(env.VITE_SUPABASE_URL));
const supabaseKey = text(env.VITE_SUPABASE_PUBLISHABLE_KEY) || text(env.VITE_SUPABASE_ANON_KEY);
const appUrl = httpUrl(text(env.VITE_APP_URL));

export const config = {
  /** Vrai quand le service d'authentification est configuré. Sinon : « mode aperçu », où rien n'est enregistré. */
  authConfigured: Boolean(supabaseUrl && supabaseKey),
  supabaseUrl: supabaseUrl ?? '',
  supabaseKey,
  /** Où mène « Ouvrir l'application » : par défaut, l'application installée sur le poste de l'utilisateur. */
  appUrl: appUrl ?? 'http://localhost:4000',
  appIsLocal: !appUrl || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(appUrl),
  repoUrl: 'https://github.com/ridakodad/PubResearcher',
  /** Mentions de la page « Confidentialité » : à renseigner par l'éditeur du site. */
  controllerName: text(env.VITE_CONTROLLER_NAME),
  contactEmail: text(env.VITE_CONTACT_EMAIL),
  version: pkg.version,
} as const;
