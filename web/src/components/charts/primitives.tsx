import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Primitives graphiques.
 *
 * Les graphiques sont dessinés à la main en SVG : les spécifications de
 * marques (épaisseur plafonnée, extrémité arrondie côté donnée et carrée
 * sur la ligne de base, écart de 2 px entre marques voisines, grille en
 * filet) se contrôlent mal via une bibliothèque généraliste.
 */

/** Mesure la largeur disponible pour rendre un SVG fluide. */
export function useMeasuredWidth<T extends HTMLElement>(): [
  React.RefObject<T>,
  number,
] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/**
 * Rectangle dont seule l'extrémité « donnée » est arrondie ; le côté posé sur
 * la ligne de base reste carré, pour que la longueur lue corresponde à la
 * valeur.
 */
export function barPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  direction: 'up' | 'right',
): string {
  if (width <= 0 || height <= 0) return '';
  const r = Math.max(0, Math.min(radius, direction === 'up' ? height : width, direction === 'up' ? width / 2 : height / 2));

  if (direction === 'up') {
    // Base en bas, sommet arrondi.
    return `M${x},${y + height} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height} Z`;
  }
  // Base à gauche, extrémité droite arrondie.
  return `M${x},${y} L${x + width - r},${y} Q${x + width},${y} ${x + width},${y + r} L${x + width},${y + height - r} Q${x + width},${y + height} ${x + width - r},${y + height} L${x},${y + height} Z`;
}

/** Infobulle suivant le pointeur, hors flux pour ne jamais être rognée. */
export function ChartTooltip({
  x,
  y,
  children,
}: {
  x: number;
  y: number;
  children: ReactNode;
}) {
  // Décalage pour que le pointeur ne masque pas le contenu, et repli à gauche
  // quand la bulle sortirait de la fenêtre.
  const offset = 14;
  const left = x + offset > window.innerWidth - 220 ? x - offset - 200 : x + offset;
  return (
    <div className="chart-tooltip" style={{ left: Math.max(8, left), top: y + offset }}>
      {children}
    </div>
  );
}

/** Titre et sous-titre d'un graphique. */
export function ChartHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="row" style={{ marginBottom: 12, alignItems: 'flex-start' }}>
      <div style={{ minWidth: 0 }}>
        <h2 style={{ fontSize: '0.95rem' }}>{title}</h2>
        {subtitle && (
          <div className="small secondary" style={{ marginTop: 2 }}>
            {subtitle}
          </div>
        )}
      </div>
      {actions && <div style={{ marginLeft: 'auto' }}>{actions}</div>}
    </div>
  );
}

/** Graduations « rondes » pour un axe de comptage. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0];
  const rawStep = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 1000) / 1000);
  return ticks;
}
