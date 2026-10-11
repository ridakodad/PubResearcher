import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Où vivent les données (base SQLite, fichiers importés, clé d'API).
 *
 * Depuis les sources (`npm start`), dans `data/` à la racine du dépôt, comme toujours. Dans la version prête à
 * l'emploi (archive dézippée, marquée par `pubresearcher-package.json`), jamais dans le dossier de l'application :
 * une mise à jour remplace ce dossier tout entier, et les dossiers patients partiraient avec. Elles vont alors dans
 * le dossier de données de l'utilisateur, celui que chaque système prévoit pour cela. `DATA_DIR` l'emporte toujours.
 */

/** Fichier posé par `scripts/package.mjs` à la racine de l'application empaquetée. */
export const PACKAGE_MARKER = 'pubresearcher-package.json';

export interface PackageInfo {
  version: string;
  target: string;
  node: string;
}

/** Description de la version empaquetée, ou `null` quand l'outil tourne depuis les sources. */
export function readPackageInfo(root: string): PackageInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, PACKAGE_MARKER), 'utf8')) as Partial<PackageInfo>;
    return { version: String(parsed.version ?? ''), target: String(parsed.target ?? ''), node: String(parsed.node ?? '') };
  } catch {
    return null;
  }
}

export interface DataDirContext {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  repoRoot: string;
  packaged: boolean;
}

/** Dossier de données propre à l'utilisateur, selon les conventions du système. */
export function userDataDir(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homedir: string): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || pathApi.join(homedir, 'AppData', 'Local');
    return pathApi.join(base, 'PubResearcher');
  }
  if (platform === 'darwin') return pathApi.join(homedir, 'Library', 'Application Support', 'PubResearcher');
  // Linux et autres Unix : spécification XDG (un chemin relatif y est invalide, on l'ignore).
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg && pathApi.isAbsolute(xdg) ? xdg : pathApi.join(homedir, '.local', 'share');
  return pathApi.join(base, 'pubresearcher');
}

/** Dossier de données effectif : `DATA_DIR`, sinon le dossier de l'utilisateur (version empaquetée) ou `data/` (sources). */
export function resolveDataDir(ctx: DataDirContext): string {
  const explicit = ctx.env.DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  if (ctx.packaged) return userDataDir(ctx.env, ctx.platform, ctx.homedir);
  return path.join(ctx.repoRoot, 'data');
}

/** Contexte réel du processus. */
export function currentDataDirContext(repoRoot: string, packaged: boolean): DataDirContext {
  return { env: process.env, platform: process.platform, homedir: os.homedir(), repoRoot, packaged };
}

/**
 * Comment relancer l'outil, pour les messages d'échec de démarrage : « npm start » n'a aucun sens pour qui a
 * simplement dézippé l'application et double-cliqué sur son lanceur.
 */
export function launchHints(packaged: boolean, platform: NodeJS.Platform = process.platform): { relaunch: string; secondInstance: string } {
  if (!packaged) {
    return {
      relaunch: 'relancez « npm start »',
      secondInstance:
        `        macOS/Linux :  PORT=4100 DATA_DIR=./data-2 npm start\n` +
        `        Windows     :  $env:PORT=4100; $env:DATA_DIR="./data-2"; npm start\n`,
    };
  }
  if (platform === 'win32') {
    return {
      relaunch: 'relancez PubResearcher (double-clic sur PubResearcher.cmd)',
      secondInstance: `        Windows (PowerShell, dans le dossier de l'application) :  $env:PORT=4100; $env:DATA_DIR="$env:LOCALAPPDATA\\PubResearcher-2"; .\\PubResearcher.cmd\n`,
    };
  }
  const launcher = platform === 'darwin' ? './PubResearcher.command' : './pubresearcher.sh';
  return {
    relaunch: platform === 'darwin' ? 'relancez PubResearcher (double-clic sur PubResearcher.command)' : `relancez PubResearcher (${launcher})`,
    secondInstance: `        Dans un terminal, depuis le dossier de l'application :  PORT=4100 DATA_DIR=~/PubResearcher-2 ${launcher}\n`,
  };
}
