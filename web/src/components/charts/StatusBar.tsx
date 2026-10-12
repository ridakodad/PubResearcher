import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useId, useRef, useState } from 'react';
import { EASE_OUT, SPRING_PRESS } from './motion';
import { Tip } from './Tip';

/**
 * Barre d'états (adaptée du « Status Bar » de beui, licence MIT) : une pastille par élément, colorée selon son état,
 * qu'on inspecte au pointeur ou au clavier (flèches, Début, Fin). Ici, une pastille par variable de la fiche, colorée
 * selon son taux de remplissage : la complétude de toute l'étude se lit d'un coup d'œil.
 *
 * Les données complètes restent lisibles par un lecteur d'écran (tableau masqué), sans une tabulation par pastille.
 */
export interface StatusItem {
  id: string;
  label: string;
  status: string;
  description?: string;
}
export interface StatusDef {
  id: string;
  label: string;
  color: string;
}

const ENTRANCE_SPAN = 0.22;

export function StatusBar({
  items,
  statuses,
  label,
  startLabel,
  endLabel,
}: {
  items: readonly StatusItem[];
  statuses: readonly StatusDef[];
  label: string;
  startLabel?: string;
  endLabel?: string;
}) {
  const reduce = useReducedMotion();
  const plot = useRef<HTMLDivElement | null>(null);
  const tipId = useId();
  const [index, setIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const pointer = useRef(false);
  const byId = new Map(statuses.map((s) => [s.id, s]));
  if (items.length === 0) return null;
  const current = items[Math.min(index, items.length - 1)]!;
  const currentStatus = byId.get(current.status);

  const inspect = (clientX: number, el: HTMLElement) => {
    const box = el.getBoundingClientRect();
    if (!box.width) return;
    const f = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    setIndex(Math.min(items.length - 1, Math.floor(f * items.length)));
    setOpen(true);
  };

  return (
    <section className="status-bar" aria-label={label}>
      <div ref={plot} className="status-bar-plot">
        <div className="status-bar-row" aria-hidden="true">
          {items.map((item, i) => {
            const status = byId.get(item.status);
            const delay = reduce ? 0 : (i / Math.max(items.length - 1, 1)) * ENTRANCE_SPAN;
            return (
              <motion.span
                key={item.id}
                className="status-bar-pill"
                initial={{ opacity: 0 }}
                whileInView={reduce ? { opacity: 1 } : { opacity: 1, transform: ['translateY(4px) scaleY(0.85)', 'translateY(0px) scaleY(1)'] }}
                viewport={{ once: true }}
                transition={{ opacity: { duration: 0.24, ease: EASE_OUT, delay }, transform: { ...SPRING_PRESS, delay } }}
              >
                <AnimatePresence initial={false}>
                  <motion.span
                    key={item.status}
                    className="status-bar-fill"
                    style={{ background: status?.color }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.16, ease: EASE_OUT }}
                  />
                </AnimatePresence>
                <motion.span
                  className="status-bar-ring"
                  initial={false}
                  animate={{ opacity: open && index === i ? 1 : 0 }}
                  transition={{ duration: 0.1 }}
                />
              </motion.span>
            );
          })}
        </div>
        <input
          type="range"
          className="status-bar-input"
          aria-label={`${label} : parcourir les variables`}
          min={0}
          max={items.length - 1}
          step={1}
          value={index}
          aria-valuetext={[current.label, currentStatus?.label, current.description].filter(Boolean).join('. ')}
          aria-describedby={open ? tipId : undefined}
          onFocus={() => !pointer.current && setOpen(true)}
          onBlur={() => {
            pointer.current = false;
            setOpen(false);
          }}
          onPointerEnter={(e) => e.pointerType !== 'touch' && inspect(e.clientX, e.currentTarget)}
          onPointerMove={(e) => (e.pointerType !== 'touch' || e.buttons === 1) && inspect(e.clientX, e.currentTarget)}
          onPointerLeave={() => setOpen(false)}
          onPointerDown={(e) => {
            pointer.current = true;
            inspect(e.clientX, e.currentTarget);
          }}
          onClick={() => {
            pointer.current = false;
          }}
          onKeyDown={(e) => {
            pointer.current = false;
            if (e.key === 'Escape') setOpen(false);
          }}
          onChange={(e) => {
            if (pointer.current) return;
            setIndex(Number(e.target.value));
            setOpen(true);
          }}
        />
      </div>
      {(startLabel || endLabel) && (
        <div className="status-bar-ends small muted">
          <span>{startLabel}</span>
          <span>{endLabel}</span>
        </div>
      )}
      <Tip anchorRef={plot} id={tipId} open={open} point={{ x: (index + 0.5) / items.length, y: 0.1 }}>
        <span className="chart-tip-body">
          <span className="chart-tip-title">{current.label}</span>
          <span className="chart-tip-title">
            <span className="chart-tip-dot" style={{ background: currentStatus?.color }} />
            <strong>{currentStatus?.label}</strong>
          </span>
          {current.description && <span className="muted">{current.description}</span>}
        </span>
      </Tip>
      <ul className="chart-legend chart-legend-inline">
        {statuses.map((s) => {
          const n = items.filter((i) => i.status === s.id).length;
          return (
            <li key={s.id}>
              <span className="status-bar-key" style={{ background: s.color }} aria-hidden="true" />
              <span className="chart-legend-label">{s.label}</span>
              <span className="chart-legend-value tabular">({n})</span>
            </li>
          );
        })}
      </ul>
      <table className="sr-only">
        <caption>{label}</caption>
        <tbody>
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row">{item.label}</th>
              <td>{byId.get(item.status)?.label}</td>
              <td>{item.description ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
