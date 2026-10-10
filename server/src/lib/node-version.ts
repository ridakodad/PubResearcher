/**
 * Version de Node exigée.
 *
 * Le stockage s'appuie sur le module SQLite intégré à Node (`node:sqlite`), qui n'existe pas avant Node 22.5 et ne
 * s'utilise sans option de lancement qu'à partir de Node 22.13. Sur une version plus ancienne, l'import échoue par
 * « No such built-in module: node:sqlite » suivi d'une trace de pile — peu parlant pour qui n'a pas installé Node
 * lui-même. On le détecte avant d'importer quoi que ce soit.
 */
export const MIN_NODE: readonly [number, number, number] = [22, 13, 0];

/** Une phrase qui dit quoi faire si la version de Node ne convient pas, `null` si elle convient (ou si elle est illisible). */
export function nodeVersionProblem(version: string = process.versions.node): string | null {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!parts) return null;
  const found = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  for (let i = 0; i < 3; i++) {
    if (found[i]! > MIN_NODE[i]!) return null;
    if (found[i]! < MIN_NODE[i]!) {
      return (
        `Cette application demande Node.js ${MIN_NODE.join('.')} ou plus récent ; la version détectée est ${version.trim().replace(/^v/, '')}.\n` +
        `Installez la version « LTS » actuelle de Node.js (https://nodejs.org), ouvrez un nouveau terminal, puis relancez.`
      );
    }
  }
  return null;
}
