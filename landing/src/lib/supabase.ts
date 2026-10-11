/**
 * Client Supabase, chargé à la demande : la page d'accueil se lit sans lui, et son code (une quarantaine de Ko
 * compressés) n'est téléchargé qu'une fois la connexion nécessaire.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { config } from './config';

let pending: Promise<SupabaseClient> | null = null;

export function supabase(): Promise<SupabaseClient> {
  if (!config.authConfigured) return Promise.reject(new Error('auth-not-configured'));
  pending ??= import('@supabase/supabase-js').then(({ createClient }) =>
    createClient(config.supabaseUrl, config.supabaseKey, {
      auth: {
        // Flux PKCE : le jeton ne transite jamais par l'adresse de la page, seulement un code à usage unique.
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }),
  );
  return pending;
}
