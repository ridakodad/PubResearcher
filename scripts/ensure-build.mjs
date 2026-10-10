// Lancé par `npm start` (script `prestart`) : vérifie la version de Node, puis compile l'application si elle ne
// l'est pas encore. Sans cela, `npm start` juste après `npm ci` échoue sur « Cannot find module … dist/index.js »,
// une trace que rien n'explique à qui n'est pas développeur.
//
// `RT_ROOT` et `RT_FAKE_NODE_VERSION` n'existent que pour les tests (server/test/start-script.test.ts).
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN = [22, 13];
const root = process.env.RT_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detected = process.env.RT_FAKE_NODE_VERSION ?? process.versions.node;

// Une version illisible ne bloque pas (même règle que le démarrage du serveur).
const parts = detected.replace(/^v/, '').split('.').map(Number);
if (parts.length >= 2 && parts.every(Number.isFinite) && (parts[0] < MIN[0] || (parts[0] === MIN[0] && parts[1] < MIN[1]))) {
  console.error(
    `\nCette application demande Node.js ${MIN.join('.')} ou plus récent ; la version détectée est ${detected.replace(/^v/, '')}.\n` +
      'Installez la version « LTS » depuis https://nodejs.org, puis relancez.\n',
  );
  process.exit(1);
}

const outputs = ['server/dist/index.js', 'web/dist/index.html'];
const built = () => outputs.every((file) => existsSync(path.join(root, file)));
if (built()) process.exit(0);

console.log('\nPremière utilisation : l’application n’est pas encore compilée. Compilation en cours (environ une minute)…\n');
const result = spawnSync('npm run build', { cwd: root, stdio: 'inherit', shell: true });
if (result.status !== 0 || !built()) {
  console.error(
    '\nLa compilation a échoué (le détail est ci-dessus). Causes fréquentes :\n' +
      '  • les dépendances ne sont pas installées : lancez d’abord « npm ci » ;\n' +
      '  • elles l’ont été sans les outils de compilation (« --omit=dev », NODE_ENV=production) : relancez « npm ci » sans ces options ;\n' +
      '  • le dossier du projet n’est pas inscriptible, ou le disque est plein.\n',
  );
  process.exit(1);
}
console.log('\nCompilation terminée.\n');
