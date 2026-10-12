/**
 * Sauvegarde les données de l'étude (base + fichiers) dans un dossier daté.
 *
 *   npm run backup --workspace server                      # écrit dans data/sauvegardes
 *   npm run backup --workspace server -- /chemin/dossier   # ailleurs (un disque externe, par exemple)
 *
 * L'outil peut rester en marche : la base est copiée par un instantané cohérent.
 *
 * Tous les projets sont sauvegardés : le principal dans le dossier daté, chacun des autres dans
 * `projets/<identifiant>/` (une sauvegarde complète et vérifiée par projet), avec le registre `projects.json`.
 */
import fs from 'node:fs';
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
  const registry = path.join(dataDir, 'projects.json');
  if (fs.existsSync(registry)) {
    const { projects = [] } = JSON.parse(fs.readFileSync(registry, 'utf8')) as { projects?: { id: string; name: string }[] };
    fs.copyFileSync(registry, path.join(directory, 'projects.json'));
    for (const project of projects) {
      if (project.id === 'principal') continue;
      const root = path.join(dataDir, 'projects', project.id);
      if (!fs.existsSync(path.join(root, 'research-tool.db'))) continue;
      const saved = await createBackup({
        dbPath: path.join(root, 'research-tool.db'),
        uploadsDir: path.join(root, 'uploads'),
        destination: path.join(directory, 'projets', project.id),
        appVersion,
      });
      const ok = await verifyBackup(saved.directory);
      if (!ok.ok) throw new Error(`Projet « ${project.name} » : la sauvegarde ne se relit pas (${ok.problems.join(' ; ')})`);
      console.log(`  Projet « ${project.name} » : ${saved.manifest.counts.patients} dossiers, ${saved.manifest.counts.documents} documents.`);
    }
  }
  console.log('  Elle contient des données de patients : rangez-la et détruisez-la comme les dossiers eux-mêmes.');
} catch (error) {
  console.error(`Sauvegarde impossible : ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
