/**
 * Sauvegarde les données de l'étude (base + fichiers) dans un dossier daté.
 *
 *   npm run backup --workspace server                      # écrit dans data/sauvegardes
 *   npm run backup --workspace server -- /chemin/dossier   # ailleurs (un disque externe, par exemple)
 *
 * L'outil peut rester en marche : la base est copiée par un instantané cohérent.
 */
import path from 'node:path';
import { dataDir, dbPath, uploadsDir } from '../src/config.js';
import { createBackup, verifyBackup } from '../src/lib/backup.js';
import { appVersion } from '../src/version.js';

const destination = path.resolve(process.argv[2] ?? path.join(dataDir, 'sauvegardes'));

try {
  const { directory, manifest } = await createBackup({ dbPath, uploadsDir, destination, appVersion });
  const check = await verifyBackup(directory);
  if (!check.ok) throw new Error(`La sauvegarde écrite ne se relit pas correctement :\n  - ${check.problems.join('\n  - ')}`);
  const bytes = manifest.files.reduce((sum, f) => sum + f.bytes, 0);
  console.log(`Sauvegarde créée : ${directory}`);
  console.log(
    `  ${manifest.counts.patients} dossiers, ${manifest.counts.documents} documents, ${manifest.files.length} fichiers, ${(bytes / 1048576).toFixed(1)} Mo — empreintes vérifiées.`,
  );
  console.log('  Elle contient des données de patients : rangez-la et détruisez-la comme les dossiers eux-mêmes.');
} catch (error) {
  console.error(`Sauvegarde impossible : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
