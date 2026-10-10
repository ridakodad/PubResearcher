/**
 * Vérifie l'environnement avant que quoi que ce soit ne démarre (importé en premier par `boot-lock.ts` : les modules
 * s'évaluent dans l'ordre des imports, et celui de la configuration lit déjà certains réglages).
 */
import { environmentProblems } from './env-check.js';

const problems = environmentProblems();
if (problems.length > 0) {
  const list = problems.length === 1 ? ` ${problems[0]}` : `\n\n${problems.map((p) => `  • ${p}`).join('\n')}`;
  console.error(
    `\nConfiguration invalide :${list}\n\n` +
      `Corrigez ${problems.length === 1 ? 'ce réglage' : 'ces réglages'} (variable d'environnement, voir le guide de l'administrateur, § 4), puis relancez.\n`,
  );
  process.exit(1);
}
