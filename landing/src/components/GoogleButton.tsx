import { useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { frenchAuthError } from '../lib/forms';
import { IconGoogle } from './icons';

/**
 * « Continuer avec Google ». Le dessin du « G » est celui de Google (couleurs d'origine, sur fond de la surface du
 * thème) ; le libellé reprend la formule recommandée par leurs consignes.
 *
 * Le navigateur quitte la page pour Google, puis revient sur /bienvenue : tout ce qui suit se joue au retour. Si
 * l'utilisateur revient par le bouton « précédent », la page peut être restituée telle quelle — d'où `pageshow`.
 */
export function GoogleButton({ label, onError }: { label: string; onError: (message: string) => void }) {
  const { signInWithGoogle, preview } = useAuth();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setBusy(false);
    };
    window.addEventListener('pageshow', restore);
    return () => window.removeEventListener('pageshow', restore);
  }, []);

  async function start() {
    setBusy(true);
    try {
      await signInWithGoogle();
    } catch (error) {
      onError(frenchAuthError(error));
      setBusy(false);
    }
  }

  return (
    <button type="button" className="btn btn-google" onClick={start} disabled={busy} aria-busy={busy}>
      <IconGoogle size={20} />
      <span>{busy ? 'Ouverture de Google…' : preview ? `${label} (aperçu)` : label}</span>
    </button>
  );
}
