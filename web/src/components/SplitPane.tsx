import { useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { readSetting, writeSetting } from '../lib/storage';

/**
 * Deux colonnes séparées par une poignée qu'on fait glisser (ou qu'on déplace aux flèches du clavier) : la fiche
 * du patient à gauche, le document d'origine à droite. La largeur choisie est retenue d'une visite à l'autre.
 * Sous 1100 px, les colonnes s'empilent (voir `.relecture` dans styles.css) et la poignée disparaît.
 */
const KEY = 'relecture:split';
const MIN = 30;
const MAX = 72;

export function SplitPane({ left, right }: { left: ReactNode; right: ReactNode }) {
  const [share, setShare] = useState(() => {
    const saved = Number(readSetting(KEY));
    return Number.isFinite(saved) && saved >= MIN && saved <= MAX ? saved : 55;
  });
  const box = useRef<HTMLDivElement | null>(null);
  const dragging = useRef(false);

  const commit = (value: number) => {
    const v = Math.round(Math.min(MAX, Math.max(MIN, value)));
    setShare(v);
    writeSetting(KEY, String(v));
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !box.current) return;
    const b = box.current.getBoundingClientRect();
    commit(((e.clientX - b.left) / b.width) * 100);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 10 : 3;
    if (e.key === 'ArrowLeft') commit(share - step);
    else if (e.key === 'ArrowRight') commit(share + step);
    else if (e.key === 'Home') commit(MIN);
    else if (e.key === 'End') commit(MAX);
    else return;
    e.preventDefault();
  };

  return (
    <div ref={box} className="relecture relecture-split" style={{ ['--split' as string]: `${share}%` }}>
      <div className="split-left">{left}</div>
      <div
        className="split-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="Largeur de la fiche et du document"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={share}
        tabIndex={0}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={onMove}
        onPointerUp={() => (dragging.current = false)}
        onPointerCancel={() => (dragging.current = false)}
        onDoubleClick={() => commit(55)}
        title="Glisser pour élargir la fiche ou le document (double-clic : réinitialiser)"
      >
        <span aria-hidden="true" />
      </div>
      <div className="split-right">{right}</div>
    </div>
  );
}
