/**
 * Client Supabase, dans un fichier à part : la page s'affiche sans l'attendre, puis il est chargé en arrière-plan
 * (une soixantaine de Ko compressés) pour retrouver la session — c'est lui qui dit si le visiteur est connecté.
 * En mode aperçu, il n'est jamais téléchargé.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

let pending: Promise<SupabaseClient> | null = null;

export function supabase(): Promise<SupabaseClient> {
  if (!config.authConfigured) return Promise.reject(new Error('auth-not-configured'));
  pending ??= import('@supabase/supabase-js')
    .then(({ createClient }) =>
      createClient(config.supabaseUrl, config.supabaseKey, {
        auth: {
          // Flux PKCE : le jeton ne transite jamais par l'adresse de la page, seulement un code à usage unique.
          flowType: 'pkce',
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }),
    )
    .catch((error: unknown) => {
      // Chargement raté (réseau, nouvelle version déployée entre-temps) : la prochaine demande réessaiera.
      pending = null;
      throw error;
    });
  return pending;
}
