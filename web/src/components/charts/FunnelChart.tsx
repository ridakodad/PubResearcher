import { motion, useReducedMotion } from 'motion/react';
import { useRef, useState } from 'react';
import { formatNumber } from '../../lib/format';
import { EASE_OUT } from './motion';
import { NumberTicker } from './NumberTicker';
import { Tip } from './Tip';

/**
 * Entonnoir (adapté du « Funnel Chart » de beui, licence MIT) : des étapes successives d'un même ensemble — par
 * exemple les références d'une revue, de l'identification à l'inclusion. La largeur de chaque étape encode son
 * effectif, les frontières se raccordent sans rupture, et l'infobulle dit la part conservée à chaque étape.
 */
export interface FunnelStage {
  id: string;
  label: string;
  value: number;
  /** Ce que l'étape représente, en une phrase (infobulle). */
  hint?: string;
}

const COLORS = ['var(--funnel-1)', 'var(--funnel-2)', 'var(--funnel-3)', 'var(--funnel-4)', 'var(--funnel-5)'];
const pct = (v: number | null) => (v === null ? '—' : `${v.toFixed(1).replace('.', ',')} %`);

function stagePath(p: number[], i: number): string {
  const v = p[i]!;
  const top = i === 0 ? v : (p[i - 1]! + v) / 2;
  const bottom = i === p.length - 1 ? v : (v + p[i + 1]!) / 2;
  const s = i / p.length;
  const e = (i + 1) / p.length;
  const m = (s + e) / 2;
  const q = (e - s) / 4;
  const pt = (cross: number, along: number) => `${along * 1000},${cross * 500}`;
  const L = (w: number) => 0.5 - w * 0.46;
  const R = (w: number) => 0.5 + w * 0.46;
  return `M${pt(L(top), s)} L${pt(R(top), s)} C${pt(R(top), s + q)} ${pt(R(v), m - q)} ${pt(R(v), m)} C${pt(R(v), m + q)} ${pt(R(bottom), e - q)} ${pt(R(bottom), e)} L${pt(L(bottom), e)} C${pt(L(bottom), e - q)} ${pt(L(v), m + q)} ${pt(L(v), m)} C${pt(L(v), m - q)} ${pt(L(top), s + q)} ${pt(L(top), s)} Z`;
}

export function FunnelChart({ stages, unit = 'références', label }: { stages: FunnelStage[]; unit?: string; label: string }) {
  const reduce = useReducedMotion();
  const anchor = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const valid = stages.filter((s) => Number.isFinite(s.value) && s.value >= 0);
  if (valid.length === 0) return null;
  const first = valid[0]!.value;
  const maximum = Math.max(1, ...valid.map((s) => s.value));
  // Une étape vide garde une épaisseur visible : un entonnoir qui disparaît ne se lit plus.
  const proportions = valid.map((s) => Math.max(0.04, s.value / maximum));
  const stage = active !== null ? valid[active] : null;

  return (
    <section className="funnel" aria-label={label}>
      <div className="funnel-scroll">
        <div ref={anchor} className="funnel-plot" style={{ minWidth: valid.length * 120 }}>
          <svg aria-hidden="true" viewBox="0 0 1000 500" preserveAspectRatio="none" className="funnel-svg">
            {valid.map((s, i) => (
              <motion.path
                key={s.id}
                fill={COLORS[i % COLORS.length]}
                d={stagePath(proportions, i)}
                initial={reduce ? false : { opacity: 0 }}
                animate={{ d: stagePath(proportions, i), opacity: active === null || active === i ? 1 : 0.55 }}
                transition={{ duration: reduce ? 0 : 0.3, ease: EASE_OUT, opacity: { duration: 0.15 } }}
              />
            ))}
          </svg>
          <ol className="funnel-stages" style={{ gridTemplateColumns: `repeat(${valid.length}, 1fr)` }}>
            {valid.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="funnel-hit"
                  aria-label={`${s.label} : ${formatNumber(s.value)} ${unit}, ${pct(first > 0 ? (s.value / first) * 100 : null)} du total de départ`}
                  onPointerEnter={() => setActive(i)}
                  onPointerLeave={() => setActive(null)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                >
                  <span className="funnel-value">
                    <NumberTicker value={s.value} />
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <Tip anchorRef={anchor} open={stage !== null} point={{ x: ((active ?? 0) + 0.5) / valid.length, y: 0.15 }}>
        {stage && active !== null && (
          <span className="chart-tip-body">
            <span className="chart-tip-title">
              <span className="chart-tip-dot" style={{ background: COLORS[active % COLORS.length] }} />
              {stage.label}
            </span>
            <strong className="tabular">
              {formatNumber(stage.value)} {unit}
            </strong>
            {active > 0 && (
              <span>
                {pct(valid[active - 1]!.value > 0 ? (stage.value / valid[active - 1]!.value) * 100 : null)} de l’étape
                précédente
              </span>
            )}
            <span className="muted">{pct(first > 0 ? (stage.value / first) * 100 : null)} du total de départ</span>
            {stage.hint && <span className="muted">{stage.hint}</span>}
          </span>
        )}
      </Tip>
      <ul className="chart-legend chart-legend-inline funnel-legend">
        {valid.map((s, i) => (
          <li key={s.id}>
            <span className="chart-legend-swatch" style={{ background: COLORS[i % COLORS.length] }} aria-hidden="true" />
            <span className="chart-legend-label">{s.label}</span>
            <span className="chart-legend-value tabular">{pct(first > 0 ? (s.value / first) * 100 : null)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
