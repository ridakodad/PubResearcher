/**
 * Échecs de démarrage dus à l'environnement (dossier de données inutilisable, base illisible) : une phrase qui
 * dit quoi corriger, à la place d'une trace de pile de vingt lignes. Cette application s'adresse à des chercheurs.
 */

const FILE_REASONS: Record<string, string> = {
  ENOTDIR: 'un élément du chemin est un fichier, pas un dossier',
  ENOENT: 'le chemin est introuvable',
  EACCES: 'accès refusé : l’utilisateur qui lance l’outil n’a pas le droit d’y écrire',
  EPERM: 'opération refusée par le système',
  EROFS: 'le disque est en lecture seule',
  ENOSPC: 'le disque est plein',
  ENAMETOOLONG: 'le chemin est trop long',
  EMFILE: 'trop de fichiers ouverts par le système',
};

/** Raison, en clair, d'une erreur du système de fichiers ou de SQLite. */
export function explainStartupError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code && FILE_REASONS[code]) return FILE_REASONS[code]!;
  const message = error instanceof Error ? error.message : String(error);
  if (/not a database|malformed|corrupt/i.test(message)) {
    return 'le fichier n’est pas une base de données lisible (corrompu, tronqué, ou ce n’est pas la bonne base)';
  }
  if (/unable to open database/i.test(message)) return 'la base ne peut pas être ouverte à cet endroit (dossier absent ou droits insuffisants)';
  if (/locked|busy/i.test(message)) return 'la base est verrouillée par un autre programme';
  if (/disk I\/O|readonly database/i.test(message)) return 'la base est en lecture seule ou le disque ne répond pas';
  return message.split('\n')[0]!.slice(0, 200);
}

/** Affiche l'échec et arrête le processus : un serveur sans données ne démarre pas à moitié. */
export function fatalStartup(title: string, error: unknown, advice: string): never {
  console.error(`\n${title}\n  Cause : ${explainStartupError(error).replace(/[.\s]+$/, '')}.\n\n${advice}\n`);
  process.exit(1);
}
