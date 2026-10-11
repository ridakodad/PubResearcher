import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { dataDir } from '../config.js';
import { redactSecret } from '../lib/redact.js';

/**
 * La clé d'API Anthropic de l'utilisateur.
 *
 * Chacun paie l'IA avec sa propre clé, directement à Anthropic : l'outil ne facture rien. Saisie dans l'application, la
 * clé est vérifiée auprès d'Anthropic, puis enregistrée **sur cette machine**, dans un fichier à part
 * (`anthropic-key.json`, lisible du seul compte qui fait tourner l'outil). Elle n'est ni dans la base, ni dans les
 * sauvegardes, ni dans les exports. Elle ne repart jamais vers l'interface : seuls ses quatre derniers caractères,
 * pour la reconnaître.
 *
 * Une clé posée dans l'environnement du serveur (`ANTHROPIC_API_KEY`) sert encore, à défaut : c'est le réglage d'un
 * serveur administré. Celle de l'application l'emporte.
 */

export type KeySource = 'app' | 'env';

export interface KeyStatus {
  /** D'où vient la clé utilisée, ou `null` s'il n'y en a aucune. */
  source: KeySource | null;
  /** Les quatre derniers caractères (`…a1B2`), pour reconnaître la clé sans la montrer. */
  hint: string | null;
  /** Date d'enregistrement d'une clé saisie dans l'application. */
  savedAt: string | null;
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
}

/** Vérifie une clé auprès d'Anthropic ; lève une `KeyError` si elle ne peut pas servir. */
export type KeyVerifier = (key: string, model: string) => Promise<void>;

const hintOf = (key: string): string => `…${key.slice(-4)}`;

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

/**
 * Vérification réelle : la clé demande la fiche du modèle utilisé. Une seule requête, gratuite, qui prouve à la fois
 * que la clé est valide et que ce modèle lui est accessible.
 */
export const verifyWithAnthropic: KeyVerifier = async (key, model) => {
  const client = new Anthropic({ apiKey: key, maxRetries: 1, timeout: 15_000 });
  try {
    await client.models.retrieve(model);
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      throw new KeyError('Anthropic refuse cette clé : elle est erronée, ou a été désactivée. Vérifiez-la dans la console d’Anthropic.', 400);
    }
    if (error instanceof Anthropic.PermissionDeniedError) {
      throw new KeyError('Cette clé est reconnue, mais n’a pas accès à l’API (organisation ou espace de travail désactivé).', 400);
    }
    if (error instanceof Anthropic.NotFoundError) {
      throw new KeyError(`La clé fonctionne, mais le modèle « ${model} » ne lui est pas accessible.`, 400);
    }
    if (error instanceof Anthropic.RateLimitError) {
      throw new KeyError('Anthropic limite le nombre de demandes pour le moment : réessayez dans une minute.', 429);
    }
    if (error instanceof Anthropic.APIConnectionError) {
      throw new KeyError('Anthropic est injoignable depuis ce poste : la clé n’a pas pu être vérifiée. Vérifiez la connexion, puis réessayez.', 502);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new KeyError(`Vérification impossible : ${redactSecret(message, key, '[clé masquée]')}`, 502);
  }
};

export interface KeyStore {
  /** La clé à utiliser maintenant, avec sa provenance, ou `null`. */
  active(): { key: string; source: KeySource } | null;
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
      cached = typeof parsed.key === 'string' && parsed.key.startsWith('sk-ant-') ? { key: parsed.key, savedAt: String(parsed.savedAt ?? '') } : null;
    } catch {
      cached = null; // absent ou illisible : comme s'il n'y en avait pas
    }
    return cached;
  }

  const envKey = (): string => (env.ANTHROPIC_API_KEY ?? '').trim();

  const store: KeyStore = {
    active() {
      const stored = readStored();
      if (stored) return { key: stored.key, source: 'app' };
      const fromEnv = envKey();
      return fromEnv ? { key: fromEnv, source: 'env' } : null;
    },

    status() {
      const stored = readStored();
      const current = store.active();
      return {
        source: current?.source ?? null,
        hint: current ? hintOf(current.key) : null,
        savedAt: stored?.savedAt || null,
      };
    },

    async save(raw, model, verify = verifyWithAnthropic) {
      const key = checkKeyShape(raw);
      await verify(key, model);
      const record: StoredKey = { key, savedAt: new Date().toISOString() };
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
