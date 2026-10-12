import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { EASE_OUT } from './motion';

/**
 * Infobulle de graphique ancrée sur un point d'un élément (fraction x/y de sa boîte), portée hors du flux pour
 * n'être jamais rognée, et ramenée dans la fenêtre. Elle apparaît et glisse d'un point à l'autre sans clignoter.
 */
export function Tip({
  anchorRef,
  point,
  open,
  id,
  children,
}: {
  anchorRef: RefObject<HTMLElement | null>;
  /** Position dans l'ancre, de 0 à 1 sur chaque axe. */
  point: { x: number; y: number };
  open: boolean;
  id?: string;
  children: ReactNode;
}) {
  const reduce = useReducedMotion();
  const bubble = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; below: boolean } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const box = anchorRef.current.getBoundingClientRect();
    const width = bubble.current?.offsetWidth ?? 220;
    const height = bubble.current?.offsetHeight ?? 60;
    const x = box.left + box.width * point.x;
    const y = box.top + box.height * point.y;
    const below = y - height - 12 < 8;
    setPos({
      left: Math.min(window.innerWidth - width - 8, Math.max(8, x - width / 2)),
      top: below ? y + 14 : y - height - 12,
      below,
    });
  }, [open, point.x, point.y, anchorRef, children]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          ref={bubble}
          id={id}
          role="tooltip"
          className="chart-tip"
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4, scale: 0.97 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          transition={{ duration: 0.16, ease: EASE_OUT }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
