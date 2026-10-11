import fs from 'node:fs';
import path from 'node:path';
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { dataDir } from '../config.js';
import { redactSecret } from '../lib/redact.js';
import { explainProblem, problemOf } from './anthropic-errors.js';

/**
 * La clé d'API Anthropic de l'utilisateur.
 *
 * Chacun paie l'IA avec sa propre clé, directement à Anthropic : l'outil ne facture rien. Saisie dans l'application, la
 * clé est vérifiée auprès d'Anthropic, puis enregistrée **sur cette machine**, dans un fichier à part
 * (`anthropic-key.json`, lisible du seul compte qui fait tourner l'outil). Elle n'est ni dans la base, ni dans les
 * sauvegardes, ni dans les exports. Elle ne repart jamais vers l'interface : seuls ses quatre derniers caractères,
 * pour la reconnaître.
 *
 * Une clé qui vaut pour plusieurs espaces de travail d'Anthropic doit nommer le sien à chaque requête
 * (`anthropic-workspace-id`) : la vérification le trouve seule — l'espace par défaut d'abord — et l'enregistre avec la
 * clé. L'utilisateur n'a pas à savoir ce qu'est un espace de travail.
 *
 * Une clé posée dans l'environnement du serveur (`ANTHROPIC_API_KEY`, et au besoin `ANTHROPIC_WORKSPACE_ID`) sert
 * encore, à défaut : c'est le réglage d'un serveur administré. Celle de l'application l'emporte.
 */

export type KeySource = 'app' | 'env';

export interface KeyStatus {
  /** D'où vient la clé utilisée, ou `null` s'il n'y en a aucune. */
  source: KeySource | null;
  /** Les quatre derniers caractères (`…a1B2`), pour reconnaître la clé sans la montrer. */
  hint: string | null;
  /** Date d'enregistrement d'une clé saisie dans l'application. */
  savedAt: string | null;
  /** Nom de l'espace de travail retenu pour une clé qui en couvre plusieurs ; `null` sinon. */
  workspace: string | null;
}

/** La clé à utiliser, et l'espace de travail à nommer à chaque requête s'il le faut. */
export interface ActiveKey {
  key: string;
  source: KeySource;
  workspaceId?: string;
}

/** Refus lisible : le message part tel quel vers l'interface. */
export class KeyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'KeyError';
  }
}

interface StoredKey {
  key: string;
  savedAt: string;
  workspaceId?: string;
  workspaceName?: string;
}

/** Ce que la vérification a appris de la clé : l'espace de travail où elle agit, quand elle en couvre plusieurs. */
export interface VerifiedKey {
  workspaceId?: string;
  workspaceName?: string;
}

/** Vérifie une clé auprès d'Anthropic ; lève une `KeyError` si elle ne peut pas servir. */
export type KeyVerifier = (key: string, model: string) => Promise<VerifiedKey | void>;

const hintOf = (key: string): string => `…${key.slice(-4)}`;

/** Options du client du SDK pour une clé : l'en-tête d'espace de travail l'accompagne quand il le faut. */
export function clientOptions(active: ActiveKey): ClientOptions {
  return {
    apiKey: active.key,
    ...(active.workspaceId ? { defaultHeaders: { 'anthropic-workspace-id': active.workspaceId } } : {}),
  };
}

/** Une même clé dans un autre espace de travail est un autre client. */
export const clientIdentity = (active: ActiveKey): string => `${active.key}\n${active.workspaceId ?? ''}`;

/** Forme d'une clé d'API Anthropic. Une clé d'administration (`sk-ant-admin…`) ne sert pas à interroger un modèle. */
export function checkKeyShape(raw: string): string {
  const key = raw.trim();
  if (!key) throw new KeyError('Collez votre clé d’API Anthropic.', 400);
  if (/\s/.test(key)) throw new KeyError('La clé ne doit contenir ni espace ni retour à la ligne : recopiez-la d’un seul tenant.', 400);
  if (key.startsWith('sk-ant-admin')) {
    throw new KeyError('C’est une clé d’administration : elle ne sert pas à interroger un modèle. Créez une clé d’API ordinaire.', 400);
  }
  if (!/^sk-ant-[A-Za-z0-9_-]{20,300}$/.test(key)) {
    throw new KeyError('Ce n’est pas une clé d’API Anthropic : elle commence par « sk-ant- ». Copiez-la depuis la console d’Anthropic.', 400);
  }
  return key;
}

/** Message quand l'espace de travail d'une clé ne peut pas être choisi automatiquement. */
export const WORKSPACE_HELP =
  'Cette clé vaut pour plusieurs espaces de travail d’Anthropic, et l’outil n’a pas pu choisir le sien. Le plus simple : dans la console d’Anthropic, créez une nouvelle clé en choisissant un seul espace de travail (« Default Workspace »), puis collez-la ici.';

/** Traduit un refus d'Anthropic pendant la vérification ; la clé n'apparaît jamais dans le message. */
function refusal(error: unknown, model: string, key: string): KeyError {
  if (error instanceof Anthropic.AuthenticationError) {
    return new KeyError('Anthropic refuse cette clé : elle est erronée, a expiré, ou a été désactivée. Vérifiez-la dans la console d’Anthropic.', 400);
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return new KeyError('Cette clé est reconnue, mais n’a pas accès à l’API (organisation ou espace de travail désactivé).', 400);
  }
  if (error instanceof Anthropic.NotFoundError) {
    return new KeyError(`La clé fonctionne, mais le modèle « ${model} » ne lui est pas accessible.`, 400);
  }
  const problem = problemOf(error);
  if (problem === 'workspace') return new KeyError(WORKSPACE_HELP, 400);
  if (problem) return new KeyError(explainProblem(problem, 'app'), 400);
  if (error instanceof Anthropic.RateLimitError) {
    return new KeyError('Anthropic limite le nombre de demandes pour le moment : réessayez dans une minute.', 429);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new KeyError('Anthropic est injoignable depuis ce poste : la clé n’a pas pu être vérifiée. Vérifiez la connexion, puis réessayez.', 502);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new KeyError(`Vérification impossible : ${redactSecret(message, key, '[clé masquée]')}`, 502);
}

interface WorkspacePage {
  data?: { id: string; name: string; archived_at: string | null }[];
}

/**
 * Pour une clé qui couvre plusieurs espaces de travail : les liste (une clé non liée à un espace peut le faire), place
 * l'espace par défaut en tête — c'est celui qu'une liste ordinaire omet —, et garde le premier où la clé interroge le
 * modèle.
 */
async function pickWorkspace(client: Anthropic, key: string, model: string): Promise<VerifiedKey> {
  let all: NonNullable<WorkspacePage['data']>;
  let named: NonNullable<WorkspacePage['data']>;
  try {
    all = (await client.get<WorkspacePage>('/v1/organizations/workspaces', { query: { limit: 100, include_default: true } })).data ?? [];
    named = (await client.get<WorkspacePage>('/v1/organizations/workspaces', { query: { limit: 100 } })).data ?? [];
  } catch (error) {
    if (error instanceof Anthropic.APIConnectionError) throw refusal(error, model, key);
    // Le rôle de l'utilisateur ne lui permet pas de lister les espaces : il faut une clé liée à un seul espace.
    throw new KeyError(WORKSPACE_HELP, 400);
  }
  const usable = all.filter((w) => !w.archived_at);
  const byDefault = usable.filter((w) => !named.some((n) => n.id === w.id));
  const candidates = [...byDefault, ...usable.filter((w) => !byDefault.includes(w))].slice(0, 5);
  for (const workspace of candidates) {
    try {
      await client.models.retrieve(model, {}, { headers: { 'anthropic-workspace-id': workspace.id } });
      return { workspaceId: workspace.id, workspaceName: workspace.name };
    } catch (error) {
      // Espace inaccessible à cette clé, ou modèle absent de cet espace : on essaie le suivant.
      if (error instanceof Anthropic.NotFoundError || error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.BadRequestError) {
        continue;
      }
      throw refusal(error, model, key);
    }
  }
  throw new KeyError(WORKSPACE_HELP, 400);
}

/**
 * Vérification réelle : la clé demande la fiche du modèle utilisé. Une seule requête, gratuite, qui prouve à la fois
 * que la clé est valide et que ce modèle lui est accessible — quelques-unes de plus si la clé doit nommer son espace
 * de travail.
 */
export const verifyWithAnthropic: KeyVerifier = async (key, model) => {
  const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 15_000 });
  try {
    await client.models.retrieve(model);
    return {};
  } catch (error) {
    if (problemOf(error) === 'workspace') return pickWorkspace(client, key, model);
    throw refusal(error, model, key);
  }
};

export interface KeyStore {
  /** La clé à utiliser maintenant, avec sa provenance (et son espace de travail s'il le faut), ou `null`. */
  active(): ActiveKey | null;
  status(): KeyStatus;
  /** Vérifie puis enregistre la clé ; renvoie l'état qui en résulte. */
  save(raw: string, model: string, verify?: KeyVerifier): Promise<KeyStatus>;
  /** Oublie la clé saisie dans l'application (celle de l'environnement, s'il y en a une, reprend la main). */
  remove(): KeyStatus;
  /** Masque toute clé connue (application ou environnement) dans un texte destiné à l'interface. */
  redact(text: string): string;
}

export function createKeyStore(file: string, env: NodeJS.ProcessEnv = process.env): KeyStore {
  // Relue au plus une fois par écriture : le fichier ne change que par `save` et `remove`.
  let cached: StoredKey | null | undefined;

  function readStored(): StoredKey | null {
    if (cached !== undefined) return cached;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<StoredKey>;
      cached =
        typeof parsed.key === 'string' && parsed.key.startsWith('sk-ant-')
          ? {
              key: parsed.key,
              savedAt: String(parsed.savedAt ?? ''),
              ...(typeof parsed.workspaceId === 'string' && parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
              ...(typeof parsed.workspaceName === 'string' && parsed.workspaceName ? { workspaceName: parsed.workspaceName } : {}),
            }
          : null;
    } catch {
      cached = null; // absent ou illisible : comme s'il n'y en avait pas
    }
    return cached;
  }

  const envKey = (): string => (env.ANTHROPIC_API_KEY ?? '').trim();
  const envWorkspace = (): string => (env.ANTHROPIC_WORKSPACE_ID ?? '').trim();

  const store: KeyStore = {
    active() {
      const stored = readStored();
      if (stored) return { key: stored.key, source: 'app', ...(stored.workspaceId ? { workspaceId: stored.workspaceId } : {}) };
      const fromEnv = envKey();
      if (!fromEnv) return null;
      const workspaceId = envWorkspace();
      return { key: fromEnv, source: 'env', ...(workspaceId ? { workspaceId } : {}) };
    },

    status() {
      const stored = readStored();
      const current = store.active();
      return {
        source: current?.source ?? null,
        hint: current ? hintOf(current.key) : null,
        savedAt: stored?.savedAt || null,
        workspace: current?.source === 'app' ? (stored?.workspaceName ?? null) : null,
      };
    },

    async save(raw, model, verify = verifyWithAnthropic) {
      const key = checkKeyShape(raw);
      const verified = (await verify(key, model)) ?? {};
      const record: StoredKey = {
        key,
        savedAt: new Date().toISOString(),
        ...(verified.workspaceId ? { workspaceId: verified.workspaceId } : {}),
        ...(verified.workspaceId && verified.workspaceName ? { workspaceName: verified.workspaceName } : {}),
      };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Écriture atomique, droits restreints dès la création : la clé n'existe jamais dans un fichier lisible par d'autres.
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
      fs.renameSync(temp, file);
      try {
        fs.chmodSync(file, 0o600);
      } catch {
        // Systèmes sans droits POSIX (Windows) : le fichier hérite des droits du dossier de données.
      }
      cached = record;
      return store.status();
    },

    remove() {
      try {
        fs.rmSync(file, { force: true });
      } finally {
        cached = null;
      }
      return store.status();
    },

    redact(text) {
      let out = text;
      for (const key of [readStored()?.key ?? '', envKey()]) out = redactSecret(out, key, '[clé masquée]');
      return out;
    },
  };
  return store;
}

/** La clé de cette installation, dans le dossier de données (hors de `uploads/` : les sauvegardes ne la prennent pas). */
export const keyStore = createKeyStore(path.join(dataDir, 'anthropic-key.json'));
