import { useCallback, useEffect, useState } from 'react';
import type { AppUser } from './auth';
import { loadOnboardingState } from './profile';
import type { OnboardingState } from './onboarding';

/** État du parcours d'accueil d'un utilisateur connecté (profil, dernière charte confirmée). */
export function useOnboardingState(user: AppUser | null) {
  const [state, setState] = useState<OnboardingState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const userId = user?.id ?? null;

  const reload = useCallback(async () => {
    if (!user) return;
    setError(null);
    try {
      setState(await loadOnboardingState(user));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
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
