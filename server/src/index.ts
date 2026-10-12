import './boot-lock.js';
import fs from 'node:fs';
import { appPassword, dataDir, ensureDataDirs, host, packageInfo, port, webDistDir } from './config.js';
import { launchHints } from './lib/data-dir.js';
import { seedIfEmpty } from './db/seed.js';
import { createApp } from './app.js';
import { openAllProjects, setProjectInitializer } from './projects.js';
import { shutdownParsers } from './extract/isolation.js';
import { shutdownOcr } from './extract/ocr.js';
import { recoverInterruptedSearches } from './repo/biblio.js';
import { purgeIncoming } from './repo/documents.js';
import { purgeStaleImportDrafts } from './repo/imports.js';
import { recoverInterruptedRuns } from './repo/runs.js';
import { isLoopback } from './lib/security.js';
import { closeDatabase, migration } from './db/index.js';
import { applyHttpTimeouts } from './lib/http-timeouts.js';
import { appVersion } from './version.js';

ensureDataDirs();
// Chaque base de projet est remise en état à son ouverture : dépôt provisoire vidé, fiche par défaut, reprise des
// passes et recherches interrompues par un arrêt brutal.
setProjectInitializer(() => {
  purgeIncoming();
  seedIfEmpty();
  recoverInterruptedSearches();
  recoverInterruptedRuns();
  purgeStaleImportDrafts();
});
for (const problem of openAllProjects()) console.warn(`  Projet illisible, ignoré : ${problem}`);

const server = createApp().listen(port, host, () => {
  const shown = isLoopback(host) ? 'localhost' : host;
  console.log(`PubResearcher ${appVersion} — prêt sur http://${shown}:${port}`);
  console.log(`  Données : ${dataDir}`);
  if (migration.to !== migration.from) {
    console.log(`  Base mise à jour : version ${migration.from} -> ${migration.to}`);
  }
  if (!fs.existsSync(webDistDir)) {
    console.log("Front non compilé : lancez « npm run dev » à la racine pour le mode développement.");
  }
  // Des comptes rendus de patients, sur un réseau, sans mot de passe : on le dit sans détour.
  if (!isLoopback(host) && !appPassword) {
    console.warn(
      `\n  ATTENTION — l'outil écoute sur ${host}, donc depuis le réseau, et aucun mot de passe n'est défini.\n` +
        `  Toute personne qui atteint cette adresse peut lire et supprimer les dossiers.\n` +
        `  Définissez APP_PASSWORD (et placez l'outil derrière HTTPS), ou repassez sur HOST=127.0.0.1.\n`,
    );
  } else if (!isLoopback(host)) {
    console.log('  Accès protégé par mot de passe (HTTP Basic) : à placer derrière HTTPS si le réseau n’est pas sûr.');
  }
});

/*
 * Filets de sécurité du processus.
 *
 * Une promesse rejetée que personne n'attend ne doit pas faire tomber l'outil au milieu d'une passe
 * d'extraction : on la consigne. Une exception non rattrapée, en revanche, laisse le programme dans un
 * état inconnu : on la consigne puis on s'arrête, pour qu'un superviseur relance un processus sain.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[promesse rejetée non gérée]', reason);
});
process.on('uncaughtException', (error) => {
  console.error('[exception non rattrapée] arrêt du serveur :', error);
  process.exit(1);
});

applyHttpTimeouts(server);

/*
 * Échecs de démarrage.
 *
 * Sans cette écoute, Node affiche une trace de pile de vingt lignes pour un
 * problème que l'utilisateur peut régler en dix secondes. Cette application
 * s'adresse à des chercheurs, pas à des développeurs : elle doit dire ce qui
 * bloque et quoi faire.
 */
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `\nLe port ${port} est déjà occupé.\n\n` +
        `C'est presque toujours une instance de cette application restée ouverte\n` +
        `dans une autre fenêtre — ou un autre programme qui utilise ce port. Deux options :\n\n` +
        `  • Fermez l'autre fenêtre (Ctrl+C y suffit), puis ${launchHints(packageInfo !== null).relaunch}.\n` +
        `  • Ou démarrez sur un autre port, en gardant les mêmes données : impossible tant que l'autre\n` +
        `    instance tourne (les deux se disputeraient la base). Pour deux instances séparées, donnez\n` +
        `    aussi un dossier de données distinct :\n` +
        launchHints(packageInfo !== null).secondInstance,
    );
  } else if (error.code === 'EACCES') {
    console.error(
      `\nLe port ${port} est réservé par le système.\n` +
        `Choisissez un port au-dessus de 1024, par exemple PORT=4100.\n`,
    );
  } else {
    console.error(`\nDémarrage impossible : ${error.message}\n`);
  }
  process.exit(1);
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} reçu, arrêt en cours…`);
  // Plus de nouvelle connexion ; celles qui attendent au repos (keep-alive : 65 s) sont fermées tout de suite, et les
  // requêtes en cours disposent de cinq secondes pour finir.
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  let patience: NodeJS.Timeout | undefined;
  await Promise.race([closed, new Promise<void>((resolve) => (patience = setTimeout(resolve, 5000)))]);
  clearTimeout(patience);
  await shutdownParsers();
  await shutdownOcr();
  closeDatabase();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
