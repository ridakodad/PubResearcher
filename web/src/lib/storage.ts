/**
 * Accès au stockage du navigateur qui ne casse jamais la page.
 *
 * `localStorage` lève une exception en navigation privée stricte, quand les données de site sont bloquées
 * ou quand le quota est atteint. Lu sans précaution au montage d'un composant, cela donne une page blanche.
 * Ces réglages (thème, rail replié) sont un confort : s'ils ne se retiennent pas, rien d'autre n'en souffre.
 */
export function readSetting(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Sans stockage, le réglage vaut pour la session en cours.
  }
}
