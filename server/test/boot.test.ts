/**
 * Démarrage réel du serveur, dans un vrai processus : ce que les autres tests, qui construisent l'application
 * sans passer par `index.ts`, ne peuvent pas voir — l'ordre des imports (le verrou avant la base), la lecture
 * de l'environnement, les messages d'échec, l'arrêt propre.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const serverDir = fileURLToPath(new URL('..', import.meta.url));

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-boot-'));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

interface Running {
  child: ChildProcess;
  port: number;
  output: () => string;
  exited: Promise<number | null>;
}

function launch(env: Record<string, string>): Running {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: { ...process.env, OCR_ENABLED: '0', APP_PASSWORD: '', HOST: '', ALLOWED_HOSTS: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let text = '';
  child.stdout?.on('data', (c: Buffer) => (text += c.toString('utf8')));
  child.stderr?.on('data', (c: Buffer) => (text += c.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  return { child, port: Number(env.PORT ?? 0), output: () => text, exited };
}

function get(port: number, route: string, headers: Record<string, string> = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: route, headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

/** Attend que le serveur réponde, ou que le processus s'arrête (alors l'échec est expliqué par sa sortie). */
async function ready(run: Running, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exitedEarly: number | null | undefined;
  void run.exited.then((code) => (exitedEarly = code));
  while (Date.now() < deadline) {
    if (exitedEarly !== undefined) assert.fail(`le serveur s'est arrêté (code ${exitedEarly}) :\n${run.output()}`);
    try {
      if ((await get(run.port, '/api/health')).status === 200) return;
    } catch {
      /* pas encore à l'écoute */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`le serveur n'a pas répondu en ${timeoutMs} ms :\n${run.output()}`);
}

/** Attend l'annonce « prêt » dans la sortie du serveur — quand la sonde de santé elle-même peut être refusée (noms d'hôte). */
async function announced(run: Running, timeoutMs = 40_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/prêt sur/.test(run.output())) return;
    if (run.child.exitCode !== null) assert.fail(`le serveur s'est arrêté (code ${run.child.exitCode}) :\n${run.output()}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`le serveur n'a rien annoncé en ${timeoutMs} ms :\n${run.output()}`);
}

async function stop(run: Running): Promise<number | null> {
  if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill('SIGTERM');
  return Promise.race([run.exited, new Promise<number | null>((r) => setTimeout(() => r(-1), 10_000))]);
}

describe('démarrage du serveur (processus réel)', () => {
  test('il démarre, pose son verrou, refuse les noms inconnus, puis s’arrête proprement en le retirant', async () => {
    const dataDir = tempDir();
    const port = await freePort();
    const run = launch({ PORT: String(port), DATA_DIR: dataDir });
    try {
      await ready(run);

      const health = JSON.parse((await get(port, '/api/health')).text) as { status: string; schemaVersion: number };
      assert.equal(health.status, 'ok');
      assert.match(run.output(), /PubResearcher .* prêt sur http:\/\/localhost:\d+/);
      assert.ok(!/ATTENTION/.test(run.output()), 'écoute sur le poste : pas d’avertissement de réseau');

      const lockFile = path.join(dataDir, '.research-tool.lock');
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8')) as { pid: number; port: number };
      assert.equal(lock.pid, run.child.pid);
      assert.equal(lock.port, port);

      const foreign = await get(port, '/api/patients', { Host: 'evil.example' });
      assert.equal(foreign.status, 403, 'le contrôle des noms d’hôte est bien branché au démarrage');

      const dbFile = path.join(dataDir, 'research-tool.db');
      assert.ok(fs.existsSync(`${dbFile}-wal`), 'tant que l’outil tourne, le journal WAL existe');

      assert.equal(await stop(run), 0, run.output());
      assert.match(run.output(), /arrêt en cours/);
      assert.equal(fs.existsSync(lockFile), false, 'le verrou est retiré à l’arrêt');
      // Arrêt propre : la base est fermée, son journal ramené dans le fichier principal. Copier `research-tool.db`
      // seul ne perd alors aucune écriture.
      assert.equal(fs.existsSync(`${dbFile}-wal`), false, 'plus de journal WAL après un arrêt propre');
      assert.equal(fs.existsSync(`${dbFile}-shm`), false, 'plus de fichier -shm après un arrêt propre');
      const copy = new DatabaseSync(dbFile, { readOnly: true });
      try {
        const { n } = copy.prepare('SELECT COUNT(*) AS n FROM templates').get() as { n: number };
        assert.ok(n >= 1, 'le fichier principal, seul, contient déjà la fiche amorcée au premier démarrage');
      } finally {
        copy.close();
      }
    } finally {
      run.child.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('une seconde instance sur les mêmes données est refusée en le disant, la première continue', async () => {
    const dataDir = tempDir();
    const [first, second] = [await freePort(), await freePort()];
    const run = launch({ PORT: String(first), DATA_DIR: dataDir });
    try {
      await ready(run);
      const other = launch({ PORT: String(second), DATA_DIR: dataDir });
      assert.equal(await other.exited, 1);
      assert.match(other.output(), /déjà utilisées par une autre instance/);
      assert.match(other.output(), new RegExp(`processus ${run.child.pid}`));
      assert.match(other.output(), /DATA_DIR=\.\/data-2/, 'le message propose la solution');
      assert.doesNotMatch(other.output(), /\n\s+at /, 'pas de trace de pile');
      assert.equal((await get(first, '/api/health')).status, 200, 'la première instance n’est pas touchée');
      assert.ok(fs.existsSync(path.join(dataDir, '.research-tool.lock')), 'le refus ne retire pas le verrou de la première');
    } finally {
      await stop(run);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('un verrou laissé par un processus disparu ne bloque pas le démarrage', async () => {
    const dataDir = tempDir();
    const dead = spawnSync(process.execPath, ['-e', '0']).pid ?? 0;
    fs.writeFileSync(path.join(dataDir, '.research-tool.lock'), JSON.stringify({ pid: dead, port: 4000, startedAt: '2026-10-01T00:00:00.000Z' }));
    const port = await freePort();
    const run = launch({ PORT: String(port), DATA_DIR: dataDir });
    try {
      await ready(run);
      const lock = JSON.parse(fs.readFileSync(path.join(dataDir, '.research-tool.lock'), 'utf8')) as { pid: number };
      assert.equal(lock.pid, run.child.pid);
    } finally {
      await stop(run);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('un réglage invalide arrête le démarrage avec le nom du réglage, sans trace de pile', async () => {
    for (const [name, value] of [['PORT', 'abc'], ['PORT', '0'], ['PORT', '70000'], ['MAX_UPLOAD_BYTES', '-1'], ['MAX_REQUEST_BYTES', '12abc']] as const) {
      const dataDir = tempDir();
      try {
        const run = launch({ DATA_DIR: dataDir, [name]: value });
        assert.equal(await run.exited, 1, `${name}=${value}`);
        assert.match(run.output(), new RegExp(`Configuration invalide : ${name}=« ${value} »`));
        assert.doesNotMatch(run.output(), /\n\s+at /);
        assert.equal(fs.existsSync(path.join(dataDir, 'research-tool.db')), false, 'la base n’est même pas ouverte');
      } finally {
        fs.rmSync(dataDir, { recursive: true, force: true });
      }
    }
  });

  test('tout réglage numérique invalide arrête le démarrage, tous annoncés d’un coup, avant le verrou et la base', async () => {
    const dataDir = tempDir();
    try {
      const run = launch({ DATA_DIR: dataDir, PARSE_WORKER_MB: 'abc', PDF_MAX_PAGES: '-5', LLM_MAX_CHARS_PER_DOC: '60 000', LLM_EFFORT: 'hgih', OCR_PDF_SCALE: '9' });
      assert.equal(await run.exited, 1);
      for (const name of ['PARSE_WORKER_MB', 'PDF_MAX_PAGES', 'LLM_MAX_CHARS_PER_DOC', 'LLM_EFFORT', 'OCR_PDF_SCALE']) {
        assert.match(run.output(), new RegExp(`${name}=«`), `${name} est annoncé`);
      }
      assert.match(run.output(), /Corrigez ces réglages/);
      assert.doesNotMatch(run.output(), /\n\s+at /, 'pas de trace de pile');
      assert.equal(fs.existsSync(path.join(dataDir, 'research-tool.db')), false, 'la base n’est même pas ouverte');
      assert.equal(fs.existsSync(path.join(dataDir, '.research-tool.lock')), false, 'aucun verrou n’est posé');
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('des réglages valides, hors défauts, ne gênent pas le démarrage', async () => {
    const dataDir = tempDir();
    const port = await freePort();
    const run = launch({
      PORT: String(port), DATA_DIR: dataDir, PARSE_CONCURRENCY: '1', PDF_MAX_PAGES: '100', OCR_PDF_SCALE: '2.5', OCR_MAX_PAGES: '0',
      LLM_EFFORT: 'medium', LLM_MAX_CHARS_PER_DOC: '20000', REGEX_BUDGET_MS: '100', PARSE_WORKER_MB: '512',
    });
    try {
      await ready(run);
      assert.equal(await stop(run), 0, run.output());
    } finally {
      run.child.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('un dossier de données impossible (sous un fichier) : une phrase qui dit quoi corriger, pas une trace de pile', async () => {
    const root = tempDir();
    const file = path.join(root, 'un-fichier');
    fs.writeFileSync(file, 'ce n’est pas un dossier');
    try {
      const run = launch({ DATA_DIR: path.join(file, 'donnees') });
      assert.equal(await run.exited, 1);
      assert.match(run.output(), /Le dossier de données est inutilisable/);
      assert.match(run.output(), /un élément du chemin est un fichier, pas un dossier/);
      assert.match(run.output(), /DATA_DIR/);
      assert.doesNotMatch(run.output(), /\n\s+at /);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('une base abîmée ou plus récente que l’outil est refusée, avec le moyen de s’en sortir', async () => {
    const corrupted = tempDir();
    fs.writeFileSync(path.join(corrupted, 'research-tool.db'), 'ceci n’est pas une base SQLite, loin de là'.repeat(40));
    const newer = tempDir();
    const db = new DatabaseSync(path.join(newer, 'research-tool.db'));
    db.exec('PRAGMA user_version = 99');
    db.close();
    try {
      const a = launch({ DATA_DIR: corrupted });
      assert.equal(await a.exited, 1);
      assert.match(a.output(), /La base de données n’a pas pu être ouverte/);
      assert.match(a.output(), /pas une base de données lisible/);
      assert.match(a.output(), /npm run restore/);
      assert.doesNotMatch(a.output(), /\n\s+at /);
      assert.equal(fs.readFileSync(path.join(corrupted, 'research-tool.db'), 'utf8').startsWith('ceci n’est pas'), true, 'le fichier n’est pas écrasé');

      const b = launch({ DATA_DIR: newer });
      assert.equal(await b.exited, 1);
      assert.match(b.output(), /Base de données refusée/);
      assert.match(b.output(), /version 99, plus récente que cette version de l'outil/);
      assert.match(b.output(), /Mettez l’outil à jour/);
      assert.doesNotMatch(b.output(), /\n\s+at /);
    } finally {
      fs.rmSync(corrupted, { recursive: true, force: true });
      fs.rmSync(newer, { recursive: true, force: true });
    }
  });

  test('un port déjà pris par un autre programme est expliqué, et le verrou ne reste pas', async () => {
    const dataDir = tempDir();
    const occupant = net.createServer();
    await new Promise<void>((resolve) => occupant.listen(0, '127.0.0.1', resolve));
    const port = (occupant.address() as net.AddressInfo).port;
    try {
      const run = launch({ PORT: String(port), DATA_DIR: dataDir });
      assert.equal(await run.exited, 1);
      assert.match(run.output(), new RegExp(`Le port ${port} est déjà occupé`));
      assert.doesNotMatch(run.output(), /\n\s+at /);
      assert.equal(fs.existsSync(path.join(dataDir, '.research-tool.lock')), false);
    } finally {
      occupant.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('écoute sur le réseau sans mot de passe : avertissement net ; avec mot de passe et noms autorisés : accès contrôlé', async () => {
    const open = tempDir();
    const portOpen = await freePort();
    const unprotected = launch({ PORT: String(portOpen), DATA_DIR: open, HOST: '0.0.0.0' });
    try {
      await ready(unprotected);
      assert.match(unprotected.output(), /ATTENTION — l'outil écoute sur 0\.0\.0\.0/);
      assert.equal((await get(portOpen, '/api/patients', { Host: 'nimporte.quoi' })).status, 200, 'sans liste de noms, tous sont acceptés');
    } finally {
      await stop(unprotected);
      fs.rmSync(open, { recursive: true, force: true });
    }

    const closed = tempDir();
    const portClosed = await freePort();
    const protectedRun = launch({ PORT: String(portClosed), DATA_DIR: closed, HOST: '0.0.0.0', APP_PASSWORD: 'secret-de-test', ALLOWED_HOSTS: 'outil.example' });
    try {
      await announced(protectedRun);
      assert.doesNotMatch(protectedRun.output(), /ATTENTION/);
      assert.match(protectedRun.output(), /Accès protégé par mot de passe/);
      assert.equal((await get(portClosed, '/api/patients', { Host: 'evil.example' })).status, 403);
      assert.equal((await get(portClosed, '/api/patients', { Host: 'outil.example' })).status, 401, 'le bon nom, sans mot de passe');
      const auth = `Basic ${Buffer.from('x:secret-de-test').toString('base64')}`;
      assert.equal((await get(portClosed, '/api/patients', { Host: 'outil.example', Authorization: auth })).status, 200);
    } finally {
      await stop(protectedRun);
      fs.rmSync(closed, { recursive: true, force: true });
    }
  });
});
