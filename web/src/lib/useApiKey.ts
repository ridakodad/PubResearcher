import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from './api';
import type { ApiKeyStatus } from './types';
import { useWorkspace } from './workspace';

/**
 * État de la clé d'API Anthropic, partagé par le panneau des pages Extraction et Rédaction et par la page « Activer
 * Claude ». Chaque changement rafraîchit l'espace de travail : le rail et le plan de travail disent aussitôt si Claude
 * est activé.
 */
export function useApiKey(onChange?: (status: ApiKeyStatus) => void) {
  const { refresh } = useWorkspace();
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .apiKey()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setLoadError('État de la clé illisible : rechargez la page.');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = useCallback(
    (next: ApiKeyStatus) => {
      setStatus(next);
      onChange?.(next);
      refresh();
    },
    [onChange, refresh],
  );

  /** Retire la clé saisie dans l'application ; renvoie le message d'erreur, s'il y en a un. */
  const remove = useCallback(async (): Promise<string | null> => {
    setRemoving(true);
    try {
      apply(await api.removeApiKey());
      return null;
    } catch (err) {
      return err instanceof ApiError ? err.message : String(err);
    } finally {
      setRemoving(false);
    }
  }, [apply]);

  return { status, loadError, apply, remove, removing };
}

/** Une ligne qui décrit la clé en service, sans jamais la montrer. */
export function describeKey(status: ApiKeyStatus, formatDateTime: (iso: string) => string): string {
  if (status.source === 'app') {
    const saved = status.savedAt ? `, enregistrée le ${formatDateTime(status.savedAt)}` : '';
    const workspace = status.workspace ? ` · espace de travail « ${status.workspace} »` : '';
    return `Votre clé (${status.hint ?? '…'})${saved}${workspace}`;
  }
  if (status.source === 'env') return `Clé fournie par le serveur (${status.hint ?? '…'})`;
  return 'Aucune clé enregistrée';
}
