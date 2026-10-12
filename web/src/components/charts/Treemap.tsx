import { motion, useReducedMotion } from 'motion/react';
import { useId, useMemo, useRef, useState } from 'react';
import type { CategoryCount } from '../../lib/types';
import { formatNumber } from '../../lib/format';
import { CATEGORY_COLORS, EASE_OUT, SPRING_LAYOUT } from './motion';
import { Tip } from './Tip';
import { useMeasuredWidth } from './primitives';

/**
 * Mosaïque des effectifs d'une variable à modalités (adaptée du « Treemap » de beui, licence MIT) : chaque modalité
 * est une tuile dont l'aire est proportionnelle à son effectif. Le découpage binaire équilibré garde l'ordre des
 * modalités (de la plus fréquente à la moins fréquente), et les tuiles glissent quand les effectifs changent.
 *
 * Les tuiles trop petites pour porter leur libellé le gardent dans la légende ; la couleur n'est jamais la seule
 * façon de lire la mosaïque (tableau pour les lecteurs d'écran, infobulle au clavier).
 */
interface Tile {
  item: CategoryCount;
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

function layout(items: CategoryCount[], width: number, height: number): Tile[] {
  const tiles: Tile[] = [];
  const indexed = items.map((item, index) => ({ item, index })).filter((d) => d.item.count > 0);
  const split = (nodes: typeof indexed, x: number, y: number, w: number, h: number) => {
    if (nodes.length === 0) return;
    if (nodes.length === 1) {
      tiles.push({ ...nodes[0]!, x, y, w, h });
      return;
    }
    const total = nodes.reduce((s, n) => s + n.item.count, 0);
    let cut = 1;
    let sub = nodes[0]!.item.count;
    for (let i = 1; i < nodes.length - 1; i++) {
      const next = sub + nodes[i]!.item.count;
      if (Math.abs(next - total / 2) > Math.abs(sub - total / 2)) break;
      cut = i + 1;
      sub = next;
    }
    const f = sub / total;
    if (w >= h) {
      split(nodes.slice(0, cut), x, y, w * f, h);
      split(nodes.slice(cut), x + w * f, y, w * (1 - f), h);
    } else {
      split(nodes.slice(0, cut), x, y, w, h * f);
      split(nodes.slice(cut), x, y + h * f, w, h * (1 - f));
    }
  };
  split(indexed, 0, 0, width, height);
  return tiles;
}

export function Treemap({
  data,
  total,
  multiple = false,
  height = 260,
}: {
  data: CategoryCount[];
  /** Dossiers renseignés : base des pourcentages. */
  total: number;
  /** Plusieurs réponses possibles : les aires restent proportionnelles aux effectifs, les % dépassent 100 en somme. */
  multiple?: boolean;
  height?: number;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const reduce = useReducedMotion();
  const [active, setActive] = useState<number | null>(null);
  const anchor = useRef<HTMLDivElement | null>(null);
  const tipId = useId();
  const tiles = useMemo(() => (width > 0 ? layout(data, width, height) : []), [data, width, height]);
  const color = (i: number) => CATEGORY_COLORS[i % CATEGORY_COLORS.length];
  const activeTile = tiles.find((t) => t.index === active) ?? null;
  const pct = (c: CategoryCount) => `${formatNumber(c.percent)} %`;

  return (
    <div className="treemap">
      <div ref={ref} style={{ width: '100%' }}>
        <div
          ref={anchor}
          className="treemap-plot"
          style={{ height }}
          role="group"
          aria-label={`Effectifs par modalité${multiple ? ' (plusieurs réponses possibles)' : ''}`}
          onPointerLeave={() => setActive(null)}
        >
          {tiles.map((t, order) => {
            const roomy = t.w > 74 && t.h > 44;
            return (
              <motion.button
                type="button"
                key={t.item.label}
                className="treemap-tile"
                aria-label={`${t.item.label} : ${t.item.count} dossiers, ${pct(t.item)}`}
                aria-describedby={active === t.index ? tipId : undefined}
                style={{ background: color(t.index) }}
                initial={reduce ? false : { opacity: 0, scale: 0.94 }}
                animate={{
                  left: t.x,
                  top: t.y,
                  width: Math.max(0, t.w - 3),
                  height: Math.max(0, t.h - 3),
                  opacity: active === null || active === t.index ? 1 : 0.45,
                  scale: 1,
                }}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { ...SPRING_LAYOUT, opacity: { duration: 0.18, ease: EASE_OUT }, delay: order * 0.025 }
                }
                onPointerEnter={() => setActive(t.index)}
                onFocus={() => setActive(t.index)}
                onBlur={() => setActive(null)}
              >
                {roomy && (
                  <span className="treemap-text">
                    <span className="treemap-label">{t.item.label}</span>
                    <span className="treemap-value">
                      {formatNumber(t.item.count)} · {pct(t.item)}
                    </span>
                  </span>
                )}
              </motion.button>
            );
          })}
        </div>
      </div>
      <Tip
        anchorRef={anchor}
        id={tipId}
        open={activeTile !== null}
        point={
          activeTile && width > 0
            ? { x: (activeTile.x + activeTile.w / 2) / width, y: activeTile.y / height }
            : { x: 0.5, y: 0 }
        }
      >
        {activeTile && (
          <span className="chart-tip-body">
            <span className="chart-tip-title">
              <span className="chart-tip-dot" style={{ background: color(activeTile.index) }} />
              {activeTile.item.label}
            </span>
            <strong className="tabular">
              {formatNumber(activeTile.item.count)} dossier{activeTile.item.count > 1 ? 's' : ''}
            </strong>
            <span className="muted">
              {pct(activeTile.item)} des {formatNumber(total)} dossiers renseignés
            </span>
          </span>
        )}
      </Tip>
      <ul className="chart-legend" aria-hidden="true">
        {data.map((c, i) => (
          <li key={c.label} className={active === i ? 'is-active' : undefined}>
            <span className="chart-legend-swatch" style={{ background: color(i) }} />
            <span className="chart-legend-label">{c.label}</span>
            <span className="chart-legend-value tabular">
              {formatNumber(c.count)} · {pct(c)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
