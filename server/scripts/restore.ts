/**
 * Restaure une sauvegarde créée par `npm run backup`. L'outil doit être arrêté.
 *
 *   npm run restore --workspace server -- /chemin/research-tool-sauvegarde-20261008-231500
 *   npm run restore --workspace server -- /chemin/... --force   # remplace les données actuelles (mises de côté)
 *   npm run restore --workspace server -- /chemin/... --verify  # contrôle seulement, ne restaure rien
 *   npm run restore --workspace server -- /chemin/.../projets/<id>/<sauvegarde> --project <id>   # un autre projet
 */
import path from 'node:path';
import fs from 'node:fs';
import { dataDir, dbPath as mainDb, uploadsDir as mainUploads } from '../src/config.js';
import { restoreBackup, verifyBackup } from '../src/lib/backup.js';

const args = process.argv.slice(2);
const projectFlag = args.indexOf('--project');
const projectId = projectFlag >= 0 ? args[projectFlag + 1] : undefined;
if (projectId !== undefined && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(projectId)) {
  console.error('Identifiant de projet invalide.');
  process.exit(2);
}
const target = args.find((a, i) => !a.startsWith('--') && i !== projectFlag + 1);
const projectRoot = projectId && projectId !== 'principal' ? path.join(dataDir, 'projects', projectId) : null;
const dbPath = projectRoot ? path.join(projectRoot, 'research-tool.db') : mainDb;
const uploadsDir = projectRoot ? path.join(projectRoot, 'uploads') : mainUploads;
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
    if (projectId && projectId !== 'principal') {
      // Le projet restauré réapparaît dans la liste, même s'il en avait été retiré.
      const registryPath = path.join(dataDir, 'projects.json');
      const registry = fs.existsSync(registryPath)
        ? (JSON.parse(fs.readFileSync(registryPath, 'utf8')) as { projects: { id: string; name: string; description: string | null; createdAt: string }[] })
        : { projects: [] };
      if (!registry.projects.some((p) => p.id === projectId)) {
        registry.projects.push({ id: projectId, name: `${projectId} (restauré)`, description: null, createdAt: new Date().toISOString() });
        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
