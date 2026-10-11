#!/usr/bin/env node
// Version prête à l'emploi : une archive par système, à dézipper puis double-cliquer. Rien à installer (Node.js est
// fourni), aucune connexion au premier lancement (dépendances et données de l'OCR sont dans l'archive).
//
//   npm run package -- --target win-x64|mac-arm64|mac-x64|linux-x64|all [--node-version 22.23.3]
//                      [--out-dir dist-packages] [--cache-dir .package-cache] [--work-dir .package-work] [--skip-build]
//
// Étapes, pour chaque cible :
//   1. compilation du serveur et de l'interface (`npm run build`, sauf --skip-build) ;
//   2. Node.js officiel (nodejs.org/dist), vérifié contre SHASUMS256.txt, gardé en cache ;
//   3. dépendances de production seules, dans une copie de travail : `npm ci --omit=dev --workspace server`, avec
//      --os/--cpu/--libc de la cible, pour que le module natif de @napi-rs/canvas (rendu des pages de PDF scannés
//      pour l'OCR) soit celui de la cible et non celui de la machine qui construit ;
//   4. lanceurs, LISEZMOI.txt, archive (.zip pour Windows et macOS, .tar.gz pour Linux) et son empreinte SHA-256.
//
// Reproductible : versions figées (verrou npm, version de Node), fichiers triés, dates et droits fixés (date du
// dernier commit, ou SOURCE_DATE_EPOCH). Aucun lien symbolique dans l'archive (Windows ne les restitue pas).
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const here = path.join(root, 'scripts', 'package');

/** Version de Node.js embarquée : la dernière 22.x au moment de l'écriture (même majeure que `engines`). */
const DEFAULT_NODE_VERSION = '22.23.3';
/** Nom du dossier racine dans l'archive : court, pour rester loin de la limite de 260 caractères de l'Explorateur Windows. */
const ROOT_DIR = 'PubResearcher';

const TARGETS = {
  'win-x64': { os: 'win32', cpu: 'x64', nodeFile: (v) => 'win-x64/node.exe', archive: 'zip', canvas: '@napi-rs/canvas-win32-x64-msvc' },
  'mac-arm64': { os: 'darwin', cpu: 'arm64', nodeFile: (v) => `node-v${v}-darwin-arm64.tar.gz`, archive: 'zip', canvas: '@napi-rs/canvas-darwin-arm64' },
  'mac-x64': { os: 'darwin', cpu: 'x64', nodeFile: (v) => `node-v${v}-darwin-x64.tar.gz`, archive: 'zip', canvas: '@napi-rs/canvas-darwin-x64' },
  'linux-x64': { os: 'linux', cpu: 'x64', libc: 'glibc', nodeFile: (v) => `node-v${v}-linux-x64.tar.gz`, archive: 'tar.gz', canvas: '@napi-rs/canvas-linux-x64-gnu' },
};

// ---------------------------------------------------------------------------------------------------------------
// Arguments

function parseArgs(argv) {
  const opts = { targets: [], nodeVersion: DEFAULT_NODE_VERSION, outDir: 'dist-packages', cacheDir: '.package-cache', workDir: '.package-work', build: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`${arg} attend une valeur.`);
      return v;
    };
    if (arg === '--target') opts.targets.push(...value().split(','));
    else if (arg === '--node-version') opts.nodeVersion = value().replace(/^v/, '');
    else if (arg === '--out-dir') opts.outDir = value();
    else if (arg === '--cache-dir') opts.cacheDir = value();
    else if (arg === '--work-dir') opts.workDir = value();
    else if (arg === '--skip-build') opts.build = false;
    else if (arg === '--help' || arg === '-h') {
      console.log('npm run package -- --target win-x64|mac-arm64|mac-x64|linux-x64|all [--node-version X.Y.Z] [--out-dir D] [--cache-dir D] [--work-dir D] [--skip-build]');
      process.exit(0);
    } else fail(`Argument inconnu : ${arg}`);
  }
  if (opts.targets.length === 0) fail('Précisez la cible : --target win-x64|mac-arm64|mac-x64|linux-x64|all');
  if (opts.targets.includes('all')) opts.targets = Object.keys(TARGETS);
  for (const t of opts.targets) if (!TARGETS[t]) fail(`Cible inconnue : ${t} (attendu : ${Object.keys(TARGETS).join(', ')}, all)`);
  for (const key of ['outDir', 'cacheDir', 'workDir']) opts[key] = path.resolve(root, opts[key]);
  return opts;
}

function fail(message) {
  console.error(`\nEmpaquetage impossible : ${message}\n`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', ...options });
  if (result.status !== 0) fail(`« ${command} ${args.join(' ')} » a échoué (code ${result.status ?? result.signal}).`);
  return result;
}

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// ---------------------------------------------------------------------------------------------------------------
// Node.js officiel, vérifié

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) fail(`téléchargement de ${url} : HTTP ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.part`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(tmp, dest);
}

async function nodeShasums(version, cacheDir) {
  const file = path.join(cacheDir, `node-v${version}`, 'SHASUMS256.txt');
  if (!fs.existsSync(file)) await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, file);
  const sums = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})\s+(\S+)$/.exec(line.trim());
    if (m) sums.set(m[2], m[1]);
  }
  return sums;
}

/** Fichier de nodejs.org/dist, téléchargé une fois puis vérifié à chaque usage contre SHASUMS256.txt. */
async function nodeArtifact(version, name, sums, cacheDir) {
  const expected = sums.get(name);
  if (!expected) fail(`${name} absent de SHASUMS256.txt pour Node ${version}.`);
  const file = path.join(cacheDir, `node-v${version}`, name);
  if (!fs.existsSync(file) || sha256(file) !== expected) {
    console.log(`  téléchargement de Node.js ${version} : ${name}`);
    await download(`https://nodejs.org/dist/v${version}/${name}`, file);
  }
  const actual = sha256(file);
  if (actual !== expected) {
    fs.rmSync(file, { force: true });
    fail(`empreinte SHA-256 de ${name} inattendue (${actual}, attendu ${expected}) : fichier supprimé.`);
  }
  console.log(`  Node.js ${version} ${name} : SHA-256 vérifié (${expected.slice(0, 16)}…)`);
  return file;
}

/** Licence de Node.js : dans l'archive officielle pour macOS et Linux ; Windows n'a que node.exe, on la prend au tag. */
async function nodeLicense(version, cacheDir) {
  const file = path.join(cacheDir, `node-v${version}`, 'LICENSE');
  if (!fs.existsSync(file)) await download(`https://raw.githubusercontent.com/nodejs/node/v${version}/LICENSE`, file);
  return file;
}

async function installNode(target, spec, version, sums, cacheDir, appDir) {
  const nodeDir = path.join(appDir, 'node');
  fs.mkdirSync(nodeDir, { recursive: true });
  const archive = await nodeArtifact(version, spec.nodeFile(version), sums, cacheDir);
  if (spec.os === 'win32') {
    fs.copyFileSync(archive, path.join(nodeDir, 'node.exe'));
    fs.copyFileSync(await nodeLicense(version, cacheDir), path.join(nodeDir, 'LICENSE'));
    return 'node/node.exe';
  }
  const base = path.basename(archive).replace(/\.tar\.gz$/, '');
  const tmp = fs.mkdtempSync(path.join(path.dirname(appDir), 'node-'));
  run('tar', ['-xzf', archive, '-C', tmp, `${base}/bin/node`, `${base}/LICENSE`], { shell: false });
  fs.mkdirSync(path.join(nodeDir, 'bin'), { recursive: true });
  fs.copyFileSync(path.join(tmp, base, 'bin', 'node'), path.join(nodeDir, 'bin', 'node'));
  fs.copyFileSync(path.join(tmp, base, 'LICENSE'), path.join(nodeDir, 'LICENSE'));
  fs.rmSync(tmp, { recursive: true, force: true });
  return 'node/bin/node';
}

// ---------------------------------------------------------------------------------------------------------------
// Dépendances de production, pour la cible

function walk(dir, visit) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    visit(full, entry);
    if (entry.isDirectory() && !entry.isSymbolicLink() && fs.existsSync(full)) walk(full, visit);
  }
}

/** Retire ce qui ne sert pas à l'exécution : cartes de sources, déclarations TypeScript, constructions de pdf.js non utilisées. */
function prune(nodeModules) {
  let removed = 0;
  const drop = (p) => {
    fs.rmSync(p, { recursive: true, force: true });
    removed++;
  };
  // pdf.js : le serveur n'emploie que legacy/build (Node) ; build/, web/ et types/ visent les navigateurs et TypeScript.
  for (const sub of ['build', 'web', 'types']) drop(path.join(nodeModules, 'pdfjs-dist', sub));
  // Données de l'OCR : l'outil prend la variante 4.0.0_best_int (voir server/src/extract/ocr.ts), la 4.0.0 est un repli.
  if (fs.existsSync(path.join(nodeModules, '@tesseract.js-data', 'fra', '4.0.0_best_int', 'fra.traineddata.gz'))) {
    drop(path.join(nodeModules, '@tesseract.js-data', 'fra', '4.0.0'));
  }
  walk(nodeModules, (full, entry) => {
    if (entry.isDirectory() && entry.name === '.bin') return drop(full);
    if (!entry.isFile()) return;
    if (/\.(map|d\.ts|d\.mts|d\.cts|tsbuildinfo)$/.test(entry.name)) drop(full);
    else if (/\.md$/i.test(entry.name) && !/^licen[cs]e/i.test(entry.name)) drop(full);
  });
  return removed;
}

function installDependencies(target, spec, workDir, appDir) {
  const deps = path.join(workDir, `deps-${target}`);
  fs.rmSync(deps, { recursive: true, force: true });
  for (const file of ['package.json', 'package-lock.json', 'server/package.json', 'web/package.json']) {
    fs.mkdirSync(path.dirname(path.join(deps, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(deps, file));
  }
  const args = ['ci', '--omit=dev', '--workspace', 'server', `--os=${spec.os}`, `--cpu=${spec.cpu}`, '--ignore-scripts', '--no-audit', '--no-fund'];
  if (spec.libc) args.push(`--libc=${spec.libc}`);
  console.log(`  npm ${args.join(' ')}`);
  run('npm', args, { cwd: deps });

  const nodeModules = path.join(deps, 'node_modules');
  // Le lien de l'espace de travail (node_modules/@pubresearcher/server -> ../server) : le serveur est copié à part.
  fs.rmSync(path.join(nodeModules, '@pubresearcher'), { recursive: true, force: true });
  // npm garde aussi la variante musl sous Linux (glibc demandé) : seul le module natif de la cible reste.
  const napi = path.join(nodeModules, '@napi-rs');
  for (const name of fs.existsSync(napi) ? fs.readdirSync(napi) : []) {
    if (name.startsWith('canvas-') && `@napi-rs/${name}` !== spec.canvas) fs.rmSync(path.join(napi, name), { recursive: true, force: true });
  }
  const removed = prune(nodeModules);
  const links = [];
  walk(nodeModules, (full, entry) => entry.isSymbolicLink() && links.push(path.relative(deps, full)));
  if (links.length > 0) fail(`liens symboliques restants dans les dépendances : ${links.slice(0, 5).join(', ')}`);

  const canvasDir = path.join(nodeModules, ...spec.canvas.split('/'));
  const binaries = fs.existsSync(canvasDir) ? fs.readdirSync(canvasDir).filter((f) => f.endsWith('.node')) : [];
  if (binaries.length === 0) fail(`${spec.canvas} absent : le rendu des PDF scannés (OCR) ne marcherait pas sur ${target}.`);
  const lang = path.join(nodeModules, '@tesseract.js-data', 'fra', '4.0.0_best_int', 'fra.traineddata.gz');
  if (!fs.existsSync(lang)) fail('données de langue française de l’OCR absentes (@tesseract.js-data/fra).');
  fs.renameSync(nodeModules, path.join(appDir, 'node_modules'));
  fs.rmSync(deps, { recursive: true, force: true });
  console.log(`  dépendances : ${spec.canvas}/${binaries[0]}, données OCR fra, ${removed} fichiers inutiles retirés`);
}

// ---------------------------------------------------------------------------------------------------------------
// Application, lanceurs, notice

function copyTree(from, to, filter = () => true) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (!filter(src, entry)) continue;
    if (entry.isDirectory()) copyTree(src, dest, filter);
    else if (entry.isFile()) fs.copyFileSync(src, dest);
  }
}

function template(name, vars, { crlf = false, bom = false } = {}) {
  let text = fs.readFileSync(path.join(here, name), 'utf8').replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in vars)) fail(`variable {{${key}}} inconnue dans ${name}`);
    return vars[key];
  });
  text = text.replace(/\r\n/g, '\n');
  if (crlf) text = text.replace(/\n/g, '\r\n');
  return (bom ? '﻿' : '') + text;
}

/** Fichiers exécutables de l'archive (droits 0755) ; tout le reste est en 0644. */
function writeLaunchers(spec, stageDir, vars) {
  const executables = [];
  const write = (rel, content, executable = false) => {
    const file = path.join(stageDir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (executable) executables.push(rel);
  };
  if (spec.os === 'win32') {
    write('PubResearcher.cmd', template('PubResearcher.cmd', vars, { crlf: true }));
    write('LISEZMOI.txt', template('LISEZMOI-windows.txt', vars, { crlf: true, bom: true }));
  } else if (spec.os === 'darwin') {
    write('PubResearcher.command', template('PubResearcher.command', vars), true);
    write('PubResearcher.app/Contents/Info.plist', template('Info.plist', vars));
    write('PubResearcher.app/Contents/MacOS/PubResearcher', template('app-launcher.sh', vars), true);
    write('LISEZMOI.txt', template('LISEZMOI-macos.txt', vars));
  } else {
    write('pubresearcher.sh', template('pubresearcher.sh', vars), true);
    write('LISEZMOI.txt', template('LISEZMOI-linux.txt', vars));
  }
  return executables;
}

// ---------------------------------------------------------------------------------------------------------------
// Archives : écrites ici plutôt que par zip/tar du système, absents ou différents selon la machine (Windows n'a pas
// zip, macOS a bsdtar) ; on y fixe les droits Unix (le .command doit rester exécutable une fois dézippé sur macOS).

function listEntries(stageDir, executables) {
  const entries = [];
  const exec = new Set(executables.map((p) => p.split(path.sep).join('/')));
  walk(stageDir, (full, entry) => {
    const rel = path.relative(stageDir, full).split(path.sep).join('/');
    if (entry.isSymbolicLink()) fail(`lien symbolique dans l'archive : ${rel}`);
    if (entry.isDirectory()) entries.push({ name: `${ROOT_DIR}/${rel}/`, dir: true, mode: 0o755 });
    else entries.push({ name: `${ROOT_DIR}/${rel}`, file: full, mode: exec.has(rel) ? 0o755 : 0o644 });
  });
  entries.unshift({ name: `${ROOT_DIR}/`, dir: true, mode: 0o755 });
  // Ordre binaire (et non celui de la langue de la machine) : la même entrée donne la même archive partout.
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function dosDateTime(epochSeconds) {
  const d = new Date(Math.max(epochSeconds, 315532800) * 1000); // le format DOS commence en 1980
  const time = (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1);
  const date = ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate();
  return { time, date };
}

function writeZip(entries, dest, mtime) {
  if (entries.length >= 0xffff) fail(`trop de fichiers pour une archive zip simple (${entries.length})`);
  const fd = fs.openSync(dest, 'w');
  const { time, date } = dosDateTime(mtime);
  const central = [];
  let offset = 0;
  const put = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = entry.dir ? Buffer.alloc(0) : fs.readFileSync(entry.file);
    const crc = zlib.crc32(data);
    let method = 0;
    let body = data;
    if (data.length > 0) {
      const deflated = zlib.deflateRawSync(data, { level: 9 });
      if (deflated.length < data.length) {
        method = 8;
        body = deflated;
      }
    }
    if (offset + body.length > 0xfffffff0) fail('archive zip de plus de 4 Go : non prise en charge');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version nécessaire : 2.0
    local.writeUInt16LE(0x0800, 6); // noms en UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const headerOffset = offset;
    put(local);
    put(name);
    put(body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE((3 << 8) | 20, 4); // créé sous Unix : les droits de l'attribut externe sont lus
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    const unixMode = (entry.dir ? 0o040000 : 0o100000) | entry.mode;
    cd.writeUInt32LE(((unixMode << 16) | (entry.dir ? 0x10 : 0)) >>> 0, 38);
    cd.writeUInt32LE(headerOffset, 42);
    central.push(cd, name);
  }
  const cdStart = offset;
  for (const buf of central) put(buf);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  put(end);
  fs.closeSync(fd);
}

function tarHeader(name, { size = 0, mode, type, mtime }) {
  const h = Buffer.alloc(512);
  const field = (value, off, len) => h.write(value, off, len, 'utf8');
  const octal = (value, off, len) => field(value.toString(8).padStart(len - 1, '0'), off, len - 1);
  let prefix = '';
  let base = name;
  if (Buffer.byteLength(name) > 100) {
    // ustar : préfixe (155) + nom (100), coupés sur un « / » ; sinon l'en-tête PAX porte le chemin complet.
    const cut = name.lastIndexOf('/', name.length - 2);
    if (cut > 0 && Buffer.byteLength(name.slice(0, cut)) <= 155 && Buffer.byteLength(name.slice(cut + 1)) <= 100) {
      prefix = name.slice(0, cut);
      base = name.slice(cut + 1);
    } else base = name.slice(0, 100);
  }
  field(base, 0, 100);
  octal(mode, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(mtime, 136, 12);
  h.fill(' ', 148, 156);
  field(type, 156, 1);
  field('ustar\u000000', 257, 8);
  field('root', 265, 32);
  field('root', 297, 32);
  field(prefix, 345, 155);
  let sum = 0;
  for (const byte of h) sum += byte;
  field(sum.toString(8).padStart(6, '0') + '\u0000 ', 148, 8);
  return h;
}

const fitsUstar = (name) => {
  if (Buffer.byteLength(name) <= 100) return true;
  const cut = name.lastIndexOf('/', name.length - 2);
  return cut > 0 && Buffer.byteLength(name.slice(0, cut)) <= 155 && Buffer.byteLength(name.slice(cut + 1)) <= 100;
};

async function writeTarGz(entries, dest, mtime) {
  const gzip = zlib.createGzip({ level: 9 });
  const out = fs.createWriteStream(dest);
  gzip.pipe(out);
  const write = async (buf) => {
    if (!gzip.write(buf)) await once(gzip, 'drain');
  };
  const pad = (size) => (size % 512 === 0 ? null : Buffer.alloc(512 - (size % 512)));
  for (const entry of entries) {
    if (!fitsUstar(entry.name)) {
      // Enregistrement PAX « <longueur> path=<chemin>\n », la longueur comptant ses propres chiffres.
      const record = (() => {
        const body = ` path=${entry.name}\n`;
        const len = Buffer.byteLength(body);
        let total = len + String(len).length;
        if (String(total).length !== String(len).length) total = len + String(total).length;
        return `${total}${body}`;
      })();
      const data = Buffer.from(record, 'utf8');
      await write(tarHeader('PaxHeader', { size: data.length, mode: 0o644, type: 'x', mtime }));
      await write(data);
      const p = pad(data.length);
      if (p) await write(p);
    }
    const data = entry.dir ? null : fs.readFileSync(entry.file);
    await write(tarHeader(entry.name, { size: data?.length ?? 0, mode: entry.mode, type: entry.dir ? '5' : '0', mtime }));
    if (data) {
      await write(data);
      const p = pad(data.length);
      if (p) await write(p);
    }
  }
  await write(Buffer.alloc(1024));
  gzip.end();
  await once(out, 'close');
}

// ---------------------------------------------------------------------------------------------------------------

function sourceInfo() {
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const commit = git(['rev-parse', '--short=12', 'HEAD']);
  const epoch = Number(process.env.SOURCE_DATE_EPOCH || git(['log', '-1', '--format=%ct']) || Math.floor(Date.now() / 1000));
  const dirty = git(['status', '--porcelain', '--untracked-files=no']) !== '';
  return { commit: commit ? `${commit}${dirty ? '+modifications' : ''}` : 'inconnu', epoch };
}

const human = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} Mo`;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const pkg = readJson(path.join(root, 'package.json'));
  const engineMajor = Number(/(\d+)/.exec(pkg.engines?.node ?? '')?.[1]);
  if (Number(opts.nodeVersion.split('.')[0]) !== engineMajor) {
    fail(`Node ${opts.nodeVersion} : la majeure doit être celle de « engines » (${pkg.engines?.node}).`);
  }
  const source = sourceInfo();
  console.log(`\nPubResearcher ${pkg.version} (${source.commit}) — Node.js ${opts.nodeVersion} — cibles : ${opts.targets.join(', ')}\n`);

  if (opts.build) run('npm', ['run', 'build'], { cwd: root });
  for (const out of ['server/dist/index.js', 'web/dist/index.html']) {
    if (!fs.existsSync(path.join(root, out))) fail(`${out} manquant : lancez « npm run build » (ou retirez --skip-build).`);
  }

  const sums = await nodeShasums(opts.nodeVersion, opts.cacheDir);
  fs.mkdirSync(opts.outDir, { recursive: true });
  const produced = [];

  for (const target of opts.targets) {
    const spec = TARGETS[target];
    console.log(`\n== ${target}`);
    const work = path.join(opts.workDir, target);
    fs.rmSync(work, { recursive: true, force: true });
    const stageDir = path.join(work, ROOT_DIR);
    const appDir = path.join(stageDir, 'app');
    fs.mkdirSync(appDir, { recursive: true });

    // Application compilée. Le package.json de la racine donne la version affichée et consignée avec chaque passe.
    const rootPkg = { name: pkg.name, private: true, version: pkg.version, description: pkg.description, homepage: pkg.homepage, type: 'module', engines: pkg.engines };
    fs.writeFileSync(path.join(appDir, 'package.json'), `${JSON.stringify(rootPkg, null, 2)}\n`);
    const serverPkg = readJson(path.join(root, 'server', 'package.json'));
    const slimServerPkg = { name: serverPkg.name, private: true, version: serverPkg.version, type: serverPkg.type, main: serverPkg.main, dependencies: serverPkg.dependencies, engines: serverPkg.engines };
    fs.mkdirSync(path.join(appDir, 'server'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'server', 'package.json'), `${JSON.stringify(slimServerPkg, null, 2)}\n`);
    copyTree(path.join(root, 'server', 'dist'), path.join(appDir, 'server', 'dist'), (src) => !src.endsWith('.map'));
    copyTree(path.join(root, 'web', 'dist'), path.join(appDir, 'web', 'dist'), (src) => !src.endsWith('.map'));
    fs.copyFileSync(path.join(here, 'launcher.mjs'), path.join(appDir, 'launcher.mjs'));

    const nodeRel = await installNode(target, spec, opts.nodeVersion, sums, opts.cacheDir, appDir);
    installDependencies(target, spec, opts.workDir, appDir);

    // Marque de la version prête à l'emploi : le serveur range alors les données dans le dossier de l'utilisateur.
    const info = { name: 'PubResearcher', version: pkg.version, target, node: opts.nodeVersion, commit: source.commit };
    fs.writeFileSync(path.join(appDir, 'pubresearcher-package.json'), `${JSON.stringify(info, null, 2)}\n`);

    const vars = { VERSION: pkg.version, NODE_VERSION: opts.nodeVersion, TARGET: target, COMMIT: source.commit };
    const executables = writeLaunchers(spec, stageDir, vars);
    if (spec.os !== 'win32') executables.push(path.join('app', nodeRel));

    const entries = listEntries(stageDir, executables);
    const longest = entries.reduce((max, e) => Math.max(max, e.name.length), 0);
    // L'Explorateur de Windows refuse d'extraire au-delà de 260 caractères, dossier de destination compris.
    if (spec.os === 'win32' && longest > 170) fail(`chemin de ${longest} caractères dans l'archive : trop long pour l'Explorateur Windows.`);

    const archiveName = `PubResearcher-${pkg.version}-${target}.${spec.archive}`;
    const archive = path.join(opts.outDir, archiveName);
    fs.rmSync(archive, { force: true });
    if (spec.archive === 'zip') writeZip(entries, archive, source.epoch);
    else await writeTarGz(entries, archive, source.epoch);
    const digest = sha256(archive);
    fs.writeFileSync(`${archive}.sha256`, `${digest}  ${archiveName}\n`);
    const size = fs.statSync(archive).size;
    produced.push({ archiveName, size, digest, files: entries.filter((e) => !e.dir).length, longest });
    fs.rmSync(work, { recursive: true, force: true });
    console.log(`  ${archiveName} : ${human(size)}, ${entries.length} entrées, chemin le plus long ${longest} caractères`);
  }

  console.log(`\nArchives (${opts.outDir}) :`);
  for (const p of produced) console.log(`  ${p.archiveName}  ${human(p.size)}  sha256 ${p.digest}`);
  console.log('');
}

await main();
