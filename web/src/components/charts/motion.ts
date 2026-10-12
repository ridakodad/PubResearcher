/**
 * Jetons de mouvement des graphiques, repris de la bibliothèque beui (github.com/starc007/ui-components, licence MIT)
 * dont les graphiques sont adaptés ici aux jetons de PubResearcher. Courbes franches plutôt que `ease-out` par défaut.
 */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/** Retour d'appui et entrée des petites marques. */
export const SPRING_PRESS = { type: 'spring', stiffness: 500, damping: 30, mass: 0.6 } as const;

/** Glissements de mise en page : tuiles qui se redimensionnent, curseur qui suit. */
export const SPRING_LAYOUT = { type: 'spring', stiffness: 360, damping: 32, mass: 0.8 } as const;

/** Palette catégorielle (six teintes lisibles sous un texte blanc, dans les deux thèmes). */
export const CATEGORY_COLORS = ['var(--cat-1)', 'var(--cat-2)', 'var(--cat-3)', 'var(--cat-4)', 'var(--cat-5)', 'var(--cat-6)'] as const;
