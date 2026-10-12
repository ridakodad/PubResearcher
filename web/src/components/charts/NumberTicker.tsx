import { animate, useInView, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { formatNumber } from '../../lib/format';

/**
 * Nombre qui défile jusqu'à sa valeur quand il entre à l'écran (adapté de beui, licence MIT). Le texte final est
 * toujours celui de `format(value)` : seule l'animation passe par des valeurs intermédiaires, et elle est
 * supprimée quand l'utilisateur a demandé moins de mouvement.
 */
export function NumberTicker({
  value,
  format = formatNumber,
  duration = 0.8,
  suffix = '',
}: {
  value: number;
  format?: (n: number) => string;
  duration?: number;
  suffix?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const inView = useInView(ref, { once: true, margin: '-10% 0px' });
  const reduce = useReducedMotion();
  const decimals = Number.isInteger(value) ? 0 : 1;
  const [shown, setShown] = useState(reduce ? value : 0);
  const from = useRef(0);

  useEffect(() => {
    if (!inView) return;
    if (reduce) {
      setShown(value);
      return;
    }
    const controls = animate(from.current, value, {
      duration,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setShown(Number(v.toFixed(decimals))),
    });
    from.current = value;
    return () => controls.stop();
  }, [value, inView, reduce, duration, decimals]);

  return (
    <span ref={ref} className="tabular" aria-label={`${format(value)}${suffix}`}>
      <span aria-hidden="true">
        {format(shown)}
        {suffix}
      </span>
    </span>
  );
}
