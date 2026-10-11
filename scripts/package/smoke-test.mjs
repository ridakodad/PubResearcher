#!/usr/bin/env node
// Essai d'une archive de la version prête à l'emploi, sur le système qui lui correspond :
//
//   node scripts/package/smoke-test.mjs dist-packages/PubResearcher-1.5.0-linux-x64.tar.gz
//
// Décompresse dans un dossier neuf, lance le lanceur de l'archive avec un environnement vide (profil utilisateur
// neuf, PATH privé de tout Node.js : c'est forcément celui de l'archive qui tourne, proxy factice : toute sortie
// réseau échoue), attend /api/health, importe un PDF scanné et une photo de compte rendu et vérifie que l'OCR les a
// lus (données de langue et rendu des pages embarqués), vérifie l'emplacement des données, puis arrête l'outil.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const archive = path.resolve(process.argv[2] ?? '');
if (!process.argv[2] || !fs.existsSync(archive)) {
  console.error('Usage : node scripts/package/smoke-test.mjs <archive .zip ou .tar.gz>');
  process.exit(2);
}

const check = (ok, message) => {
  if (!ok) throw new Error(message);
  console.log(`  ✓ ${message}`);
};

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-essai-'));
const extractDir = path.join(work, 'extrait');
const home = path.join(work, 'profil');
fs.mkdirSync(extractDir);
fs.mkdirSync(home);

// Décompression avec l'outil du système : unzip sous Linux, bsdtar (tar) sous macOS et Windows.
const extract =
  archive.endsWith('.tar.gz')
    ? spawnSync('tar', ['-xzf', archive, '-C', extractDir], { stdio: 'inherit' })
    : process.platform === 'linux'
      ? spawnSync('unzip', ['-q', archive, '-d', extractDir], { stdio: 'inherit' })
      : // Sous Windows, le tar du système (bsdtar, qui lit les .zip), pas celui de Git Bash s'il passe devant dans le PATH.
        spawnSync(process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar', ['-xf', archive, '-C', extractDir], { stdio: 'inherit' });
if (extract.status !== 0) throw new Error(`décompression impossible (${extract.status})`);

const appRoot = path.join(extractDir, 'PubResearcher');
const info = JSON.parse(fs.readFileSync(path.join(appRoot, 'app', 'pubresearcher-package.json'), 'utf8'));
console.log(`\nEssai de ${path.basename(archive)} : PubResearcher ${info.version}, ${info.target}, Node.js ${info.node}\n`);

// PATH sans aucun Node.js.
const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter((dir) => {
  return !['node', 'node.exe'].some((exe) => fs.existsSync(path.join(dir, exe)));
});
const env = {
  PATH: pathDirs.join(path.delimiter),
  HOME: home,
  USERPROFILE: home,
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  TEMP: path.join(work, 'tmp'),
  TMP: path.join(work, 'tmp'),
  TMPDIR: path.join(work, 'tmp'),
  LANG: 'fr_FR.UTF-8',
  PUBRESEARCHER_NO_BROWSER: '1',
  // Toute tentative de sortie réseau (CDN de l'OCR, par exemple) échoue au lieu de réussir en douce.
  HTTPS_PROXY: 'http://127.0.0.1:9',
  HTTP_PROXY: 'http://127.0.0.1:9',
  ALL_PROXY: 'http://127.0.0.1:9',
  NODE_USE_ENV_PROXY: '1',
};
for (const name of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'SystemDrive']) if (process.env[name]) env[name] = process.env[name];
fs.mkdirSync(env.TEMP, { recursive: true });

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});
env.PORT = String(port);

const expectedDataDir =
  process.platform === 'win32'
    ? path.join(env.LOCALAPPDATA, 'PubResearcher')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'PubResearcher')
      : path.join(home, '.local', 'share', 'pubresearcher');

const launcher =
  process.platform === 'win32' ? ['cmd.exe', ['/d', '/c', path.join(appRoot, 'PubResearcher.cmd')]]
  : process.platform === 'darwin' ? [path.join(appRoot, 'PubResearcher.command'), []]
  : [path.join(appRoot, 'pubresearcher.sh'), []];
const child = spawn(launcher[0], launcher[1], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
let output = '';
child.stdout.on('data', (c) => (output += c));
child.stderr.on('data', (c) => (output += c));
let exitCode;
const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve((exitCode = code ?? signal))));

function stop() {
  if (exitCode !== undefined) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* déjà arrêté */
    }
  }
}

const base = `http://127.0.0.1:${port}`;
async function api(route, init) {
  const res = await fetch(base + route, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

try {
  const deadline = Date.now() + 90_000;
  let health = null;
  while (Date.now() < deadline && exitCode === undefined) {
    health = await api('/api/health').catch(() => null);
    if (health?.status === 200) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check(health?.status === 200 && health.body.status === 'ok', `/api/health répond (pid ${child.pid}, port ${port})`);
  check(health.body.version === info.version, `version ${health.body.version}`);
  check(output.includes(`Node.js ${info.node} fourni`), `le Node.js de l'archive tourne (${info.node}), PATH sans Node.js`);
  check(fs.existsSync(path.join(expectedDataDir, 'research-tool.db')), `données dans le dossier de l'utilisateur : ${expectedDataDir}`);
  check(!fs.existsSync(path.join(appRoot, 'app', 'data')) && !fs.existsSync(path.join(appRoot, 'data')), 'rien d’écrit dans le dossier de l’application');

  const caps = await api('/api/documents-capabilities');
  check(caps.body?.ocr?.available === true, `OCR disponible (${caps.body?.ocr?.lang})`);

  const patient = await api('/api/patients', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'ESSAI-001' }),
  });
  check(patient.status === 201, 'dossier ESSAI-001 créé');
  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(path.join(root, 'server', 'test', 'pdf-fixtures', 'scan.pdf'))]), 'compte-rendu-scanne.pdf');
  form.append('files', new Blob([fs.readFileSync(path.join(root, 'server', 'test', 'image-fixtures', 'scan-texte.png'))]), 'photo-compte-rendu.png');
  const started = Date.now();
  const upload = await api(`/api/patients/${patient.body.patient.id}/documents`, { method: 'POST', body: form });
  check(upload.status === 201 && upload.body.summary.imported === 2, `2 fichiers importés en ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const result of upload.body.results) {
    const text = await api(`/api/documents/${result.documentId}/text`);
    check(/Âge\s*:\s*54 ans/.test(text.body?.text ?? '') && /Sexe\s*:\s*Féminin/.test(text.body?.text ?? ''), `${result.filename} (${result.kind}) lu par l'OCR : « Âge : 54 ans », « Sexe : Féminin »`);
  }
} catch (error) {
  console.error(`\nÉCHEC : ${error.message}\n\nSortie de l'application :\n${output}`);
  // Sur GitHub Actions, la cause s'affiche dans les annotations de l'exécution, sans ouvrir le journal.
  if (process.env.GITHUB_ACTIONS) console.log(`::error title=Essai de l'archive::${error.message.replace(/\r?\n/g, ' ')}`);
  stop();
  await exited;
  process.exit(1);
}

stop();
await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
check(exitCode !== undefined, `arrêt par PID (${child.pid}) : terminé (${exitCode})`);
if (process.platform !== 'win32') {
  // Sous macOS, le lanceur (bash) attend Node : il peut se terminer quelques instants avant la fin de l'arrêt ordonné.
  const lock = path.join(expectedDataDir, '.research-tool.lock');
  for (let i = 0; i < 50 && fs.existsSync(lock); i++) await new Promise((r) => setTimeout(r, 200));
  check(!fs.existsSync(lock), 'arrêt ordonné : verrou des données retiré');
}
console.log(`\nSortie de l'application :\n${output.replace(/^/gm, '  | ')}`);
fs.rmSync(work, { recursive: true, force: true });
console.log('Essai réussi.\n');
