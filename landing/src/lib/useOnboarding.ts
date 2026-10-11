import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppUser } from './auth';
import { loadOnboardingState } from './profile';
import type { OnboardingState } from './onboarding';

/** État du parcours d'accueil d'un utilisateur connecté (profil, dernière charte confirmée). */
export function useOnboardingState(user: AppUser | null) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const userId = user?.id ?? null;
  const current = useRef(userId);
  current.current = userId;

  const reload = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      const loaded = await loadOnboardingState(user);
      if (current.current === user.id) setState(loaded); // sinon : réponse tardive, pour un compte qui n'est plus là
    } catch (err) {
      if (current.current === user.id) setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    }
    // `user` change d'identité à chaque rendu du fournisseur : seul son identifiant compte.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    setState(null);
    void reload();
  }, [reload]);

  return { state, error, reload };
}
