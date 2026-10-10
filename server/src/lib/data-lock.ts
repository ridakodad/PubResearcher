import fs from 'node:fs';
import path from 'node:path';

/**
 * Verrou du dossier de données : une seule instance de l'outil écrit dans une base à la fois.
 *
 * SQLite tolère deux processus, mais l'outil non : les passes d'extraction, les recherches en cours et le
 * ménage du dépôt provisoire supposent qu'il est seul. Deux instances sur les mêmes données — le message
 * « port occupé » le suggérait en conseillant de changer seulement de port — se disputent la base (plus d'une
 * écriture sur deux échouait sur « database is locked ») et se détruisent mutuellement le dépôt provisoire.
 *
 * Le verrou est un fichier créé de façon exclusive, qui porte le numéro du processus. Un verrou laissé par un
 * processus qui n'existe plus (arrêt brutal, coupure de courant) est reconnu et repris sans intervention.
 */

export interface LockInfo {
  pid: number;
  port: number | null;
  startedAt: string;
}

export class DataInUseError extends Error {
  constructor(
    readonly holder: LockInfo,
    readonly lockFile: string,
  ) {
    super(
      `Ces données sont déjà utilisées par une autre instance de l'outil (processus ${holder.pid}` +
        `${holder.port ? `, port ${holder.port}` : ''}, démarrée le ${holder.startedAt.slice(0, 16).replace('T', ' à ')}).`,
    );
    this.name = 'DataInUseError';
  }
}

const LOCK_NAME = '.research-tool.lock';

/** Le processus existe-t-il ? (`kill(pid, 0)` n'envoie aucun signal : il teste seulement.) */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM : le processus existe mais appartient à un autre utilisateur — il est vivant.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>;
    return typeof parsed.pid === 'number'
      ? { pid: parsed.pid, port: typeof parsed.port === 'number' ? parsed.port : null, startedAt: String(parsed.startedAt ?? '') }
      : null;
  } catch {
    return null;
  }
}

export interface DataLock {
  file: string;
  release(): void;
}

export function acquireDataLock(
  dataDir: string,
  port: number | null,
  isAlive: (pid: number) => boolean = processIsAlive,
): DataLock {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, LOCK_NAME);
  const mine: LockInfo = { pid: process.pid, port, startedAt: new Date().toISOString() };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, JSON.stringify(mine), { flag: 'wx' });
      return {
        file,
        release() {
          // On ne retire que son propre verrou : un autre processus a pu le reprendre entre-temps.
          if (readLock(file)?.pid === process.pid) fs.rmSync(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const holder = readLock(file);
      if (holder && holder.pid !== process.pid && isAlive(holder.pid)) throw new DataInUseError(holder, file);
      // Verrou périmé (processus disparu, ou fichier illisible) : on le reprend.
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`Impossible de poser le verrou ${file}.`);
}
