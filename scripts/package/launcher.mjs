// Lanceur de la version prête à l'emploi. Copié dans `app/` par `scripts/package.mjs`, démarré par PubResearcher.cmd,
// PubResearcher.command ou pubresearcher.sh avec le Node.js fourni dans l'archive : rien à installer, pas d'internet.
//
// Il démarre le serveur dans ce même processus (Ctrl+C ou fermer la fenêtre l'arrête), puis ouvre le navigateur dès
// que l'application répond. Si PubResearcher tourne déjà (second double-clic), il ouvre seulement le navigateur.
// PUBRESEARCHER_NO_BROWSER=1 (ou --no-browser) : ne pas ouvrir le navigateur (poste sans écran, essais).
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const info = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(appDir, 'pubresearcher-package.json'), 'utf8'));
  } catch {
    return {};
  }
})();
// Le serveur valide PORT et explique une valeur invalide ; ici on se contente d'une lecture prudente pour sonder.
const port = /^\d+$/.test(process.env.PORT?.trim() ?? '') ? Number(process.env.PORT.trim()) : 4000;
const url = `http://localhost:${port}`;
const openBrowserWanted = process.env.PUBRESEARCHER_NO_BROWSER !== '1' && !process.argv.includes('--no-browser');

/** Que répond le port ? `pubresearcher` (l'outil, déjà ouvert), `other` (un autre programme), `none` (personne). */
function probe(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', agent: false, timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk.slice(0, 4096)));
      res.on('end', () => {
        if (res.statusCode === 401 && /PubResearcher/.test(String(res.headers['www-authenticate'] ?? ''))) return resolve('pubresearcher');
        try {
          const parsed = JSON.parse(body);
          resolve(parsed && typeof parsed.version === 'string' && typeof parsed.status === 'string' ? 'pubresearcher' : 'other');
        } catch {
          resolve('other');
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve('none'));
  });
}

function openBrowser() {
  if (!openBrowserWanted) return;
  const [command, args] =
    process.platform === 'win32'
      ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => console.log(`Ouvrez votre navigateur à l'adresse ${url}`));
    child.unref();
  } catch {
    console.log(`Ouvrez votre navigateur à l'adresse ${url}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log(`\nPubResearcher ${info.version ?? ''} (Node.js ${process.versions.node} fourni avec l'application)\n`);

const before = await probe();
if (before === 'pubresearcher') {
  console.log(`PubResearcher est déjà ouvert (${url}), sans doute dans une autre fenêtre : ouverture du navigateur.\n`);
  openBrowser();
  await sleep(1500);
  process.exit(0);
}
// `other` : le serveur échouera sur « port déjà occupé » avec un message complet ; inutile de le doubler ici.

// Fermer la fenêtre envoie SIGHUP (sous Windows aussi : Node le simule à la fermeture de la console). Par défaut le
// processus s'arrêterait net ; on passe par l'arrêt ordonné du serveur (requêtes en cours, OCR, base).
process.on('SIGHUP', () => process.emit('SIGTERM', 'SIGTERM'));

await import(pathToFileURL(path.join(appDir, 'server', 'dist', 'index.js')).href);

// Le serveur démarre dans ce processus : on attend qu'il réponde (premier lancement : création de la base).
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  if ((await probe(1000)) === 'pubresearcher') {
    console.log(
      `\n${openBrowserWanted ? 'L’application s’ouvre dans votre navigateur' : 'L’application est prête'} : ${url}\n` +
        `Laissez cette fenêtre ouverte tant que vous travaillez ; fermez-la (ou Ctrl+C) pour arrêter PubResearcher.\n`,
    );
    openBrowser();
    break;
  }
  await sleep(300);
}
