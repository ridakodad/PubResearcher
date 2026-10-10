/**
 * Restaure une sauvegarde créée par `npm run backup`. L'outil doit être arrêté.
 *
 *   npm run restore --workspace server -- /chemin/research-tool-sauvegarde-20261008-231500
 *   npm run restore --workspace server -- /chemin/... --force   # remplace les données actuelles (mises de côté)
 *   npm run restore --workspace server -- /chemin/... --verify  # contrôle seulement, ne restaure rien
 */
import path from 'node:path';
import { dbPath, uploadsDir } from '../src/config.js';
import { restoreBackup, verifyBackup } from '../src/lib/backup.js';

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('Usage : npm run restore --workspace server -- <dossier-de-sauvegarde> [--force] [--verify]');
  process.exit(2);
}
const backupDir = path.resolve(target);

try {
  if (args.includes('--verify')) {
    const check = await verifyBackup(backupDir);
    if (!check.ok) throw new Error(`Sauvegarde refusée :\n  - ${check.problems.join('\n  - ')}`);
    console.log(`Sauvegarde intacte : ${check.manifest!.files.length} fichiers, empreintes conformes.`);
  } else {
    const { manifest, aside } = await restoreBackup({ backupDir, dbPath, uploadsDir, force: args.includes('--force') });
    console.log(`Restauration faite : ${manifest.counts.patients} dossiers, ${manifest.counts.documents} documents.`);
    for (const p of aside) console.log(`  Données précédentes mises de côté : ${p}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
