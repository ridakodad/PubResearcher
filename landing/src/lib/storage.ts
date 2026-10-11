/**
 * Accès au stockage du navigateur qui ne casse jamais la page : `localStorage` lève une exception en navigation
 * privée stricte, quand les données de site sont bloquées ou quand le quota est atteint. Ici, seul le choix du thème
 * y est gardé — un confort, pas une donnée.
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
