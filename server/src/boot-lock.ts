/**
 * Pose le verrou du dossier de données avant que quoi que ce soit n'ouvre la base.
 *
 * Importé en premier par `index.ts` : les modules s'évaluent dans l'ordre des imports, et celui de la base
 * crée le fichier et applique les migrations dès qu'il est chargé. Un second processus doit s'arrêter avant.
 */
import './lib/env-guard.js';
import { dataDir, packageInfo, port } from './config.js';
import { launchHints } from './lib/data-dir.js';
import { DataInUseError, acquireDataLock } from './lib/data-lock.js';
import { nodeVersionProblem } from './lib/node-version.js';
import { fatalStartup } from './lib/startup-error.js';

// Avant la base : sur un Node trop ancien, l'import de `node:sqlite` échouerait par une trace de pile.
const versionProblem = nodeVersionProblem();
if (versionProblem) {
  console.error(`\n${versionProblem}\n`);
  process.exit(1);
}

try {
  const lock = acquireDataLock(dataDir, port);
  process.on('exit', () => lock.release());
} catch (error) {
  if (error instanceof DataInUseError) {
    console.error(
      `\n${error.message}\n\n` +
        `Deux instances sur les mêmes données se disputent la base. Deux possibilités :\n\n` +
        `  • Utiliser l'instance déjà ouverte (ou la fermer : Ctrl+C dans sa fenêtre), puis relancer.\n` +
        `  • Démarrer une seconde instance SÉPARÉE, avec ses propres données :\n` +
        launchHints(packageInfo !== null).secondInstance +
        `\nSi aucune instance n'est ouverte, supprimez le fichier ${error.lockFile} et relancez.\n`,
    );
    process.exit(1);
  }
  fatalStartup(
    `Le dossier de données est inutilisable : ${dataDir}`,
    error,
    'Choisissez un dossier où l’outil peut écrire (variable DATA_DIR), ou corrigez les droits de celui-ci, puis relancez.',
  );
}
