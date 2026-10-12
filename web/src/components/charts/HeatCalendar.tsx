import { motion, useReducedMotion } from 'motion/react';
import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { formatNumber } from '../../lib/format';
import { EASE_OUT } from './motion';
import { Tip } from './Tip';

/**
 * Calendrier de chaleur (adapté du « Heat Calendar » de beui, licence MIT) : la répartition d'une variable date
 * (admission, intervention…) dans le temps, une seule teinte dont l'intensité dit l'effectif.
 *
 * Sur quatre mois au plus, une case par jour (colonnes = semaines, lundi en haut) ; au-delà, une case par mois (lignes =
 * années). Les cases ne sont pas des arrêts de tabulation : le calendrier se parcourt aux flèches une fois atteint.
 */
interface Cell {
  key: string;
  label: string;
  count: number;
  col: number;
  row: number;
}

const DAY_MS = 86_400_000;
const STEPS = [0, 22, 45, 70, 95] as const;
const fmtDay = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
const fmtMonth = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const fmtShortMonth = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', month: 'short' });
const MONTHS = Array.from({ length: 12 }, (_, m) => fmtShortMonth.format(new Date(Date.UTC(2024, m, 1))).replace('.', ''));
const WEEKDAYS = ['lun', '', 'mer', '', 'ven', '', ''];

function parse(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function build(dates: Date[]): { mode: 'day' | 'month'; cells: Cell[]; cols: number; rows: number; rowLabels: string[]; colLabels: (string | null)[] } {
  const times = dates.map((d) => d.getTime());
  const min = Math.min(...times);
  const max = Math.max(...times);
  // Un jour par case tant que la période est courte (une saison) ; au-delà, des cases quasi vides se liraient mal.
  if (max - min <= 120 * DAY_MS) {
    // Une case par jour, du lundi de la première date au dimanche de la dernière.
    const start = min - ((new Date(min).getUTCDay() + 6) % 7) * DAY_MS;
    const weeks = Math.floor((max - start) / DAY_MS / 7) + 1;
    const counts = new Map<number, number>();
    for (const t of times) counts.set(t, (counts.get(t) ?? 0) + 1);
    const cells: Cell[] = [];
    const colLabels: (string | null)[] = [];
    for (let w = 0; w < weeks; w++) {
      const monday = new Date(start + w * 7 * DAY_MS);
      colLabels.push(w === 0 || monday.getUTCDate() <= 7 ? MONTHS[monday.getUTCMonth()]! : null);
      for (let d = 0; d < 7; d++) {
        const t = start + (w * 7 + d) * DAY_MS;
        if (t > max + 6 * DAY_MS) continue;
        cells.push({ key: String(t), label: fmtDay.format(new Date(t)), count: counts.get(t) ?? 0, col: w, row: d });
      }
    }
    return { mode: 'day', cells, cols: weeks, rows: 7, rowLabels: WEEKDAYS, colLabels };
  }
  // Une case par mois : lignes = années.
  const first = new Date(min).getUTCFullYear();
  const last = new Date(max).getUTCFullYear();
  const counts = new Map<string, number>();
  for (const d of dates) {
    const k = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const cells: Cell[] = [];
  const rowLabels: string[] = [];
  for (let y = first; y <= last; y++) {
    rowLabels.push(String(y));
    for (let m = 0; m < 12; m++) {
      cells.push({ key: `${y}-${m}`, label: fmtMonth.format(new Date(Date.UTC(y, m, 1))), count: counts.get(`${y}-${m}`) ?? 0, col: m, row: y - first });
    }
  }
  return { mode: 'month', cells, cols: 12, rows: last - first + 1, rowLabels, colLabels: MONTHS };
}

export function HeatCalendar({ values, unit = 'dossier' }: { values: string[]; unit?: string }) {
  const reduce = useReducedMotion();
  const tipId = useId();
  const anchor = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const dates = useMemo(() => values.map(parse).filter((d): d is Date => d !== null), [values]);
  const model = useMemo(() => (dates.length ? build(dates) : null), [dates]);
  if (!model) return <p className="small muted">Aucune date lisible.</p>;

  const max = Math.max(1, ...model.cells.map((c) => c.count));
  const step = (count: number) => (count === 0 ? 0 : Math.min(4, 1 + Math.floor(((count - 1) / max) * 4)));
  const fill = (count: number) =>
    count === 0 ? 'var(--heat-empty)' : `color-mix(in srgb, var(--series-1) ${STEPS[step(count)]}%, var(--surface-1))`;
  const cell = active !== null ? model.cells[active] : null;
  const plural = (n: number) => `${formatNumber(n)} ${unit}${n > 1 ? 's' : ''}`;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = active ?? model.cells.findIndex((c) => c.count > 0);
    const at = model.cells[i];
    if (!at) return;
    const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (e.key === 'Escape') return setActive(null);
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      return setActive(e.key === 'Home' ? 0 : model.cells.length - 1);
    }
    const d = delta[e.key];
    if (!d) return;
    e.preventDefault();
    const next = model.cells.findIndex((c) => c.col === at.col + d[0] && c.row === at.row + d[1]);
    setActive(next >= 0 ? next : i);
  };

  const size = model.mode === 'day' ? 14 : 30;
  const gap = model.mode === 'day' ? 3 : 4;

  return (
    <div className="heat">
      <div className="heat-scroll">
        <div
          ref={anchor}
          className="heat-grid"
          tabIndex={0}
          role="img"
          aria-label={`Répartition dans le temps : ${plural(dates.length)}, ${model.mode === 'day' ? 'par jour' : 'par mois'}. Flèches pour parcourir.`}
          aria-describedby={cell ? tipId : undefined}
          onKeyDown={onKey}
          onFocus={() => active === null && setActive(Math.max(0, model.cells.findIndex((c) => c.count > 0)))}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
          style={{
            gridTemplateColumns: `auto repeat(${model.cols}, ${size}px)`,
            gridTemplateRows: `auto repeat(${model.rows}, ${size}px)`,
            gap,
          }}
        >
          <span />
          {model.colLabels.map((l, c) => (
            <span key={`c${c}`} className="heat-col-label" style={{ gridColumn: c + 2, gridRow: 1 }}>
              {l ?? ''}
            </span>
          ))}
          {model.rowLabels.map((l, r) => (
            <span key={`r${r}`} className="heat-row-label" style={{ gridColumn: 1, gridRow: r + 2 }}>
              {l}
            </span>
          ))}
          {model.cells.map((c, i) => (
            <motion.span
              key={c.key}
              className={active === i ? 'heat-cell is-active' : 'heat-cell'}
              style={{ gridColumn: c.col + 2, gridRow: c.row + 2, background: fill(c.count) }}
              initial={reduce ? false : { opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: active === i ? 1.25 : 1 }}
              transition={{ duration: 0.22, ease: EASE_OUT, delay: reduce ? 0 : Math.min(0.35, (c.col / model.cols) * 0.35) }}
              onPointerEnter={() => setActive(i)}
            />
          ))}
        </div>
      </div>
      <Tip
        anchorRef={anchor}
        id={tipId}
        open={cell !== null}
        point={cell ? { x: (cell.col + 0.5) / model.cols, y: (cell.row + 0.5) / (model.rows + 1) } : { x: 0, y: 0 }}
      >
        {cell && (
          <span className="chart-tip-body">
            <span className="muted">{cell.label}</span>
            <strong className="tabular">{plural(cell.count)}</strong>
          </span>
        )}
      </Tip>
      <div className="heat-legend small muted" aria-hidden="true">
        <span>Moins</span>
        {[0, 1, 2, 3, 4].map((s) => (
          <span key={s} className="heat-cell" style={{ background: s === 0 ? 'var(--heat-empty)' : `color-mix(in srgb, var(--series-1) ${STEPS[s]}%, var(--surface-1))` }} />
        ))}
        <span>Plus</span>
        <span style={{ marginLeft: 'auto' }}>Maximum : {plural(max)} {model.mode === 'day' ? 'le même jour' : 'le même mois'}</span>
      </div>
    </div>
  );
}
