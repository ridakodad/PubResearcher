import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { LINK_NOT_COMPLETED, parseAuthReturn, stripAuthReturn } from './authReturn';
import { providerEnabled } from './authSettings';
import { config } from './config';
import { supabase } from './supabase';
import { pageUrl } from './urls';

/**
 * Session de l'utilisateur.
 *
 * Deux modes, qui ne se mélangent jamais :
 *  - **configuré** : Supabase (e-mail + mot de passe, ou Google). La session vit dans le navigateur ; les données
 *    (profil, engagement d'anonymisation) vivent dans la base, protégées par des règles d'accès par ligne.
 *  - **aperçu** : aucune variable `VITE_SUPABASE_*` n'est définie. On peut parcourir tout le parcours, mais rien
 *    n'est créé ni envoyé : l'identité est fictive et ne survit pas à la fermeture de l'onglet. Un bandeau le dit sur
 *    chaque page.
 *
 * Ni l'un ni l'autre ne protège l'application elle-même : ce site est la porte d'entrée, pas la serrure. L'outil
 * tourne sur le poste de l'utilisateur, avec ses propres protections (docs/securite-et-donnees.md).
 */

export type Provider = 'google' | 'email' | 'preview';

export interface AppUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  provider: Provider;
}

type Status = 'loading' | 'signed-out' | 'signed-in';

interface AuthValue {
  status: Status;
  user: AppUser | null;
  /** Vrai en mode aperçu (authentification non configurée). */
  preview: boolean;
  /** Vrai quand l'utilisateur arrive par un lien de réinitialisation de mot de passe. */
  recovery: boolean;
  /** Pourquoi le retour d'authentification (Google, lien reçu par e-mail) a échoué, en français, ou `null`. */
  returnError: string | null;
  clearReturnError: () => void;
  signUpWithEmail: (input: { email: string; password: string; fullName: string }) => Promise<{ confirmationSent: boolean }>;
  signInWithEmail: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  requestPasswordReset: (email: string) => Promise<void>;
  updatePassword: (password: string) => Promise<void>;
  resendConfirmation: (email: string) => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

const PREVIEW_KEY = 'pr:preview-user';

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** Une photo de profil n'est affichée que si c'est une adresse https. */
function avatar(value: unknown): string | null {
  const url = text(value);
  return /^https:\/\/[^\s"'<>]+$/.test(url) ? url : null;
}

function toAppUser(user: User): AppUser {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  return {
    id: user.id,
    email: user.email ?? '',
    name: text(meta.full_name) || text(meta.name),
    avatarUrl: avatar(meta.avatar_url ?? meta.picture),
    provider: user.app_metadata?.provider === 'google' ? 'google' : 'email',
  };
}

function readPreviewUser(): AppUser | null {
  try {
    const raw = sessionStorage.getItem(PREVIEW_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<AppUser>;
    if (value.provider !== 'preview' || typeof value.id !== 'string') return null;
    return { id: value.id, email: text(value.email), name: text(value.name), avatarUrl: null, provider: 'preview' };
  } catch {
    return null;
  }
}

function writePreviewUser(user: AppUser | null): void {
  try {
    if (user) sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(PREVIEW_KEY);
  } catch {
    // Sans stockage de session, l'aperçu ne survit pas à un rechargement : sans conséquence.
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<AppUser | null>(null);
  const [recovery, setRecovery] = useState(false);
  const [returnError, setReturnError] = useState<string | null>(() =>
    parseAuthReturn(window.location.search, window.location.hash),
  );
  const preview = !config.authConfigured;

  // L'erreur est lue une fois, puis retirée de l'adresse : un rechargement ne doit pas la rejouer.
  useEffect(() => {
    if (returnError) window.history.replaceState(null, '', stripAuthReturn(window.location.href));
  }, [returnError]);

  const apply = useCallback((session: Session | null) => {
    if (session?.user) {
      setUser(toAppUser(session.user));
      setStatus('signed-in');
    } else {
      setUser(null);
      setStatus('signed-out');
    }
  }, []);

  useEffect(() => {
    if (preview) {
      const existing = readPreviewUser();
      setUser(existing);
      setStatus(existing ? 'signed-in' : 'signed-out');
      return undefined;
    }

    let cancelled = false;
    let unsubscribe = () => {};
    // Le client retire le code de l'adresse en l'échangeant : on note avant lui s'il y en avait un.
    const arrivedWithCode = new URLSearchParams(window.location.search).has('code');
    supabase()
      .then(async (client) => {
        if (cancelled) return;
        // L'abonnement d'abord : l'événement « retour d'un lien de réinitialisation » est émis pendant
        // l'initialisation du client, et ne doit pas pouvoir partir avant qu'on l'écoute.
        const { data: sub } = client.auth.onAuthStateChange((event, session) => {
          if (cancelled) return;
          if (event === 'PASSWORD_RECOVERY') setRecovery(true);
          apply(session);
        });
        unsubscribe = () => sub.subscription.unsubscribe();
        // `getSession` attend la fin de l'initialisation du client : si l'adresse porte un code de retour
        // (Google, lien de confirmation, réinitialisation), il est échangé avant que l'on lise la session.
        const { data } = await client.auth.getSession();
        if (cancelled) return;
        apply(data.session);
        if (!data.session && arrivedWithCode) setReturnError((current) => current ?? LINK_NOT_COMPLETED);
      })
      .catch(() => {
        if (!cancelled) {
          setUser(null);
          setStatus('signed-out');
        }
      });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [apply, preview]);

  const startPreview = useCallback((input: { email: string; name: string }) => {
    const next: AppUser = { id: 'apercu', email: input.email, name: input.name, avatarUrl: null, provider: 'preview' };
    writePreviewUser(next);
    setUser(next);
    setStatus('signed-in');
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      user,
      preview,
      recovery,
      returnError,
      clearReturnError: () => setReturnError(null),

      async signUpWithEmail({ email, password, fullName }) {
        if (preview) {
          startPreview({ email: email.trim(), name: fullName.trim() });
          return { confirmationSent: false };
        }
        const client = await supabase();
        const { data, error } = await client.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { full_name: fullName.trim() }, emailRedirectTo: pageUrl(window.location.origin, '/bienvenue') },
        });
        if (error) throw error;
        // Avec la confirmation par e-mail, aucune session n'est ouverte avant le clic sur le lien.
        return { confirmationSent: !data.session };
      },

      async signInWithEmail(email, password) {
        if (preview) {
          startPreview({ email: email.trim(), name: '' });
          return;
        }
        const client = await supabase();
        const { error } = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      },

      async signInWithGoogle() {
        if (preview) {
          startPreview({ email: 'apercu@exemple.org', name: 'Visiteur (aperçu de la connexion Google)' });
          return;
        }
        // Google pas encore activé dans le projet : on le dit ici plutôt que de laisser le service afficher son
        // erreur brute, hors du site (voir authSettings.ts).
        const [client, googleEnabled] = await Promise.all([supabase(), providerEnabled('google')]);
        if (!googleEnabled) throw Object.assign(new Error('provider_disabled'), { code: 'provider_disabled' });
        const { error } = await client.auth.signInWithOAuth({
          provider: 'google',
          options: { redirectTo: pageUrl(window.location.origin, '/bienvenue'), queryParams: { prompt: 'select_account' } },
        });
        if (error) throw error;
        // Sans erreur, le navigateur part vers Google : la suite se passe au retour, sur /bienvenue.
      },

      async signOut() {
        if (preview) {
          writePreviewUser(null);
          setUser(null);
          setStatus('signed-out');
          return;
        }
        const client = await supabase();
        const { error } = await client.auth.signOut();
        if (error) throw error;
      },

      async requestPasswordReset(email) {
        if (preview) return;
        const client = await supabase();
        const { error } = await client.auth.resetPasswordForEmail(email.trim(), {
          redirectTo: pageUrl(window.location.origin, '/mot-de-passe'),
        });
        if (error) throw error;
      },

      async updatePassword(password) {
        if (preview) return;
        const client = await supabase();
        const { error } = await client.auth.updateUser({ password });
        if (error) throw error;
        setRecovery(false);
      },

      async resendConfirmation(email) {
        if (preview) return;
        const client = await supabase();
        const { error } = await client.auth.resend({
          type: 'signup',
          email: email.trim(),
          options: { emailRedirectTo: pageUrl(window.location.origin, '/bienvenue') },
        });
        if (error) throw error;
      },
    }),
    [status, user, preview, recovery, returnError, startPreview],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth doit être utilisé sous <AuthProvider>.');
  return value;
}
