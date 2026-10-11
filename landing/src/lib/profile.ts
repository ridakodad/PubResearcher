/**
 * Enregistrement du profil et de l'engagement d'anonymisation.
 *
 * Configuré : tables `profiles` et `consents` de Supabase (voir supabase/migrations), protégées par des règles
 * d'accès par ligne — chacun ne lit et n'écrit que ses lignes. Aperçu : mémoire de l'onglet, rien ne part.
 * Aucune de ces tables ne reçoit jamais de donnée de patient.
 */
import type { AppUser } from './auth';
import { ANONYMISATION_VERSION, CHARTER_ITEMS } from './charter';
import { fromRow, toRow, type OnboardingState, type ProfileDraft, type ProfileRow } from './onboarding';
import { supabase } from './supabase';

const PREVIEW_PROFILE = 'pr:preview-profile';
const PREVIEW_CONSENT = 'pr:preview-consent';

/** Erreur d'enregistrement : le détail va à la console (pour l'éditeur du site), pas à l'écran de l'utilisateur. */
function storageError(context: string, cause: unknown): Error {
  console.error(`[pubresearcher] ${context}`, cause);
  return new Error('Impossible d’enregistrer ou de lire vos réponses pour le moment. Réessayez dans un instant.');
}

function readPreview<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writePreview(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Sans stockage de session, l'aperçu oublie ses réponses : sans conséquence.
  }
}

export async function loadOnboardingState(user: AppUser): Promise<OnboardingState> {
  if (user.provider === 'preview') {
    const row = readPreview<ProfileRow>(PREVIEW_PROFILE);
    const consent = readPreview<{ version: string; at?: string }>(PREVIEW_CONSENT);
    return { profile: fromRow(row), consentedVersion: consent?.version ?? null, consentedAt: consent?.at ?? null };
  }

  const client = await supabase();
  const [profile, consent] = await Promise.all([
    client.from('profiles').select('*').eq('user_id', user.id).maybeSingle(),
    client
      .from('consents')
      .select('version, accepted_at')
      .eq('user_id', user.id)
      .eq('kind', 'anonymisation')
      .order('accepted_at', { ascending: false })
      .limit(1),
  ]);
  if (profile.error) throw storageError('lecture du profil', profile.error);
  if (consent.error) throw storageError('lecture des engagements', consent.error);
  const last = (consent.data as { version: string; accepted_at?: string }[] | null)?.[0];
  return {
    profile: fromRow(profile.data as ProfileRow | null),
    consentedVersion: last?.version ?? null,
    consentedAt: last?.accepted_at ?? null,
  };
}

/** Enregistre (ou met à jour) le profil. `completed` n'est passé qu'à la dernière étape. */
export async function saveProfile(user: AppUser, draft: ProfileDraft, completed?: Date): Promise<void> {
  const row = toRow(user.id, draft, completed);
  if (user.provider === 'preview') {
    writePreview(PREVIEW_PROFILE, { ...readPreview<ProfileRow>(PREVIEW_PROFILE), ...row });
    return;
  }
  const client = await supabase();
  const { error } = await client.from('profiles').upsert(row, { onConflict: 'user_id' });
  if (error) throw storageError('enregistrement du profil', error);
}

/** Inscrit l'engagement pris, avec la version du texte : une ligne par confirmation, jamais modifiée ensuite. */
export async function recordConsent(user: AppUser): Promise<void> {
  if (user.provider === 'preview') {
    writePreview(PREVIEW_CONSENT, { version: ANONYMISATION_VERSION, at: new Date().toISOString() });
    return;
  }
  const client = await supabase();
  const { error } = await client.from('consents').insert({
    user_id: user.id,
    kind: 'anonymisation',
    version: ANONYMISATION_VERSION,
    items: CHARTER_ITEMS.map((item) => item.id),
  });
  if (error) throw storageError('enregistrement de l’engagement', error);
}
