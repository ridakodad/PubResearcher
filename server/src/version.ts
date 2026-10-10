import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from './config.js';

/**
 * Version de l'outil, lue dans le `package.json` de la racine.
 * Elle est consignée avec chaque passe d'extraction : un résultat se rapporte à la version qui l'a produit.
 */
function read(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const appVersion = read();
