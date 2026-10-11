/**
 * Sert un dossier compilé comme le ferait Vercel : fichiers statiques d'abord, puis réécriture vers `index.html`,
 * avec les en-têtes de `vercel.json` — dont la politique de sécurité du contenu, qui est donc testée pour de vrai
 * (une ressource qu'elle interdit fait échouer le parcours, et la console du navigateur le dit).
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain',
  '.json': 'application/json',
};

function headersFor(source) {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  const entry = config.headers.find((h) => h.source === source);
  return Object.fromEntries((entry?.headers ?? []).map((h) => [h.key, h.value]));
}

/** Démarre le serveur sur un port libre ; renvoie son adresse et une fonction d'arrêt. */
export async function serveDist(dir) {
  const dist = path.resolve(ROOT, dir);
  const global = headersFor('/(.*)');
  const assets = headersFor('/assets/(.*)');

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(dist, decodeURIComponent(url.pathname));
    if (!file.startsWith(dist)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      // Comme la réécriture de vercel.json : toute adresse inconnue sert la page… sauf sous /assets/, où un fichier
      // manquant est une vraie erreur 404 (et non une page HTML mise en cache un an sous un nom de script).
      if (url.pathname.startsWith('/assets/')) {
        res.writeHead(404, { ...global, 'Content-Type': 'text/plain' }).end('404');
        return;
      }
      file = path.join(dist, 'index.html');
    }
    const headers = { ...global, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' };
    if (url.pathname.startsWith('/assets/')) Object.assign(headers, assets);
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}
