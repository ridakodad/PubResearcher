import { useState } from 'react';
import { formatNumber } from '../../lib/format';
import type { HistogramBin } from '../../lib/types';
import { ChartTooltip, barPath, niceTicks, useMeasuredWidth } from './primitives';

/**
 * Histogramme de distribution d'une variable quantitative.
 *
 * Série unique, teinte unique, pas de légende. Contrairement aux barres de
 * catégories, la forme de la distribution prime sur la lecture des effectifs
 * exacts : on garde donc une grille en filet et on n'étiquette que la classe
 * modale, les autres valeurs étant accessibles au survol.
 */
export function Histogram({
  bins,
  unit,
  height = 190,
}: {
  bins: HistogramBin[];
  unit?: string | null;
  height?: number;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  const margin = { top: 16, right: 12, bottom: 34, left: 38 };
  const plotWidth = Math.max(40, width - margin.left - margin.right);
  const plotHeight = height - margin.top - margin.bottom;

  const maxCount = Math.max(1, ...bins.map((b) => b.count));
  const ticks = niceTicks(maxCount);
  const scaleMax = Math.max(maxCount, ticks[ticks.length - 1] ?? maxCount);

  const slot = plotWidth / Math.max(1, bins.length);
  // Écart de 2 px entre marques voisines + plafond d'épaisseur.
  const barWidth = Math.max(3, Math.min(24, slot - 2));
  const modalIndex = bins.reduce((best, b, i) => (b.count > (bins[best]?.count ?? -1) ? i : best), 0);

  return (
    <div ref={ref} style={{ width: '100%' }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Histogramme : ${bins.map((b) => `${b.label} : ${b.count}`).join(', ')}`}
          onMouseLeave={() => setHover(null)}
        >
          {/* Grille en filet, volontairement discrète */}
          {ticks.map((tick) => {
            const y = margin.top + plotHeight - (tick / scaleMax) * plotHeight;
            return (
              <g key={tick}>
                <line
                  x1={margin.left}
                  x2={margin.left + plotWidth}
                  y1={y}
                  y2={y}
                  stroke="var(--gridline)"
                  strokeWidth={1}
                />
                <text
                  x={margin.left - 8}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={11}
                  fill="var(--text-muted)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {tick}
                </text>
              </g>
            );
          })}

          {bins.map((bin, i) => {
            const barHeight = (bin.count / scaleMax) * plotHeight;
            const x = margin.left + i * slot + (slot - barWidth) / 2;
            const y = margin.top + plotHeight - barHeight;
            const isHover = hover?.index === i;

            return (
              <g
                key={`${bin.from}-${bin.to}-${i}`}
                onMouseMove={(e) => setHover({ index: i, x: e.clientX, y: e.clientY })}
              >
                <rect
                  x={margin.left + i * slot}
                  y={margin.top}
                  width={slot}
                  height={plotHeight}
                  fill="transparent"
                />
                {bin.count > 0 && (
                  <path
                    d={barPath(x, y, barWidth, barHeight, 4, 'up')}
                    fill="var(--series-1)"
                    opacity={isHover ? 0.85 : 1}
                  />
                )}
                {/* Seule la classe modale porte son effectif en clair. */}
                {i === modalIndex && bin.count > 0 && (
                  <text
                    x={x + barWidth / 2}
                    y={y - 5}
                    textAnchor="middle"
                    fontSize={11.5}
                    fill="var(--text-primary)"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {bin.count}
                  </text>
                )}
              </g>
            );
          })}

          {/* Ligne de base */}
          <line
            x1={margin.left}
            x2={margin.left + plotWidth}
            y1={margin.top + plotHeight}
            y2={margin.top + plotHeight}
            stroke="var(--border-strong)"
            strokeWidth={1}
          />

          {/* Bornes extrêmes seulement : l'axe reste lisible quel que soit le nombre de classes. */}
          {bins.length > 0 && (
            <>
              <text
                x={margin.left}
                y={height - 12}
                fontSize={11}
                fill="var(--text-muted)"
                textAnchor="start"
              >
                {formatNumber(bins[0]!.from)}
              </text>
              <text
                x={margin.left + plotWidth}
                y={height - 12}
                fontSize={11}
                fill="var(--text-muted)"
                textAnchor="end"
              >
                {formatNumber(bins[bins.length - 1]!.to)}
                {unit ? ` ${unit}` : ''}
              </text>
            </>
          )}
        </svg>
      )}

      {hover && bins[hover.index] && (
        <ChartTooltip x={hover.x} y={hover.y}>
          <div>
            {bins[hover.index]!.label}
            {unit ? ` ${unit}` : ''}
          </div>
          <div>
            <span className="val">{bins[hover.index]!.count}</span>{' '}
            <span className="secondary">
              observation{bins[hover.index]!.count > 1 ? 's' : ''}
            </span>
          </div>
        </ChartTooltip>
      )}
    </div>
  );
}
