/**
 * Réglages publics du service d'authentification (`/auth/v1/settings`) : quels moyens de connexion sont activés.
 *
 * Une seule utilité : ne pas envoyer quelqu'un vers Google tant que la connexion Google n'est pas activée dans le
 * projet Supabase. Le service répondrait alors par une page d'erreur brute (du JSON, en anglais), hors du site.
 * Dans le doute (réseau, réponse inattendue), on laisse faire : cette vérification ne doit jamais bloquer une
 * connexion qui aurait abouti.
 */
import { config } from './config';

export async function providerEnabled(provider: 'google'): Promise<boolean> {
  try {
    const response = await fetch(`${config.supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: config.supabaseKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return true;
    const settings = (await response.json()) as { external?: Record<string, unknown> } | null;
    return settings?.external?.[provider] !== false;
  } catch {
    return true;
  }
}
