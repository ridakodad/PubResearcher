/**
 * Entrée du fil d'analyse quand le serveur tourne depuis les sources TypeScript (tests, `npm run dev`).
 *
 * Node ne transmet pas le chargeur TypeScript (tsx) aux fils qu'il crée : sans lui, le fil ne sait lire ni
 * les imports en « .js » qui désignent des fichiers « .ts », ni la syntaxe TypeScript que Node n'efface pas
 * seul. Le serveur installé, lui, tourne depuis le JavaScript compilé et lance `worker.js` directement.
 */
import { register } from 'tsx/esm/api';

register();
await import('./worker.ts');
