import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api';
import type { Capabilities } from './types';

/**
 * État d'ensemble de l'espace de travail.
 *
 * Le rail d'outils et le plan de travail affichent les mêmes compteurs. Les
 * charger une seule fois ici évite de répéter les mêmes requêtes à chaque
 * changement d'outil, et garantit que les deux vues ne se contredisent pas.
 */
export interface WorkspaceSummary {
  patients: number;
  documents: number;
  unreadable: number;
  templateId: number | null;
  templateName: string | null;
  fields: number;
  /** Taux de remplissage du tableau, en pourcentage. */
  completeness: number;
  capabilities: Capabilities | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const EMPTY: Omit<WorkspaceSummary, 'refresh'> = {
  patients: 0,
  documents: 0,
  unreadable: 0,
  templateId: null,
  templateName: null,
  fields: 0,
  completeness: 0,
  capabilities: null,
  loading: true,
  error: null,
};

const WorkspaceContext = createContext<WorkspaceSummary | null>(null);

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState(EMPTY);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setState((current) => ({ ...current, loading: true, error: null }));
      try {
        const [{ patients }, { active }, capabilities] = await Promise.all([
          api.listPatients(),
          api.listTemplates(),
          api.capabilities(),
        ]);

        // Le taux de remplissage suppose une fiche : sans fiche active, il n'y
        // a rien à remplir et la requête n'a pas lieu d'être.
        const dataset = active ? await api.dataset(active.id) : null;
        if (cancelled) return;

        setState({
          patients: patients.length,
          documents: patients.reduce((sum, p) => sum + p.documentCount, 0),
          unreadable: patients.reduce((sum, p) => sum + p.unreadableCount, 0),
          templateId: active?.id ?? null,
          templateName: active?.name ?? null,
          fields: active?.fields.length ?? 0,
          completeness: dataset?.summary.completeness ?? 0,
          capabilities,
          loading: false,
          error: null,
        });
      } catch (error) {
        if (cancelled) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tick]);

  const value = useMemo<WorkspaceSummary>(() => ({ ...state, refresh }), [state, refresh]);

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceSummary {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace doit être utilisé dans un WorkspaceProvider.');
  return ctx;
}
