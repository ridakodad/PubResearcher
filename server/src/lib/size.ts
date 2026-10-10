/**
 * Taille en clair pour les messages : « 500 o », « 20 ko », « 3,4 Mo », « 210 Mo ».
 *
 * Un arrondi au mégaoctet seul afficherait « 0 Mo » pour une limite réglée petite, et la virgule décimale
 * suit l'usage français de l'interface.
 */
export function formatSize(bytes: number): string {
  const KB = 1024;
  const MB = KB * KB;
  if (bytes < KB) return `${Math.max(0, Math.round(bytes))} o`;
  if (bytes < MB) return `${Math.round(bytes / KB)} ko`;
  const mb = bytes / MB;
  const tenths = Math.round(mb * 10) / 10;
  return `${tenths < 10 ? tenths.toFixed(1).replace('.', ',') : Math.round(mb)} Mo`;
}
