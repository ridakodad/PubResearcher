import { useState } from 'react';
import type { CategoryCount } from '../../lib/types';
import { formatNumber } from '../../lib/format';
import { ChartTooltip, barPath, useMeasuredWidth } from './primitives';

/**
 * Barres horizontales : effectifs par catégorie.
 *
 * Une seule série (le comptage) : teinte unique, pas de légende — le titre du
 * graphique dit ce qui est représenté. Les catégories étant peu nombreuses,
 * la valeur est écrite en bout de barre et la grille devient inutile.
 * L'orientation horizontale accepte des libellés longs sans les incliner.
 */
export function CategoryBars({
  data,
  total,
  maxRows = 24,
}: {
  data: CategoryCount[];
  /** Effectif de référence pour le calcul des pourcentages affichés. */
  total: number;
  maxRows?: number;
}) {
  const [ref, width] = useMeasuredWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  const shown = data.slice(0, maxRows);
  const hidden = data.length - shown.length;

  const rowHeight = 30;
  const barThickness = Math.min(24, rowHeight - 8);
  const labelWidth = Math.min(180, Math.max(90, width * 0.32));
  const valueWidth = 62;
  const chartWidth = Math.max(40, width - labelWidth - valueWidth);
  const height = shown.length * rowHeight;
  const maxCount = Math.max(1, ...shown.map((d) => d.count));

  return (
    <div ref={ref} style={{ width: '100%' }}>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`Effectifs par catégorie : ${shown
            .map((d) => `${d.label} ${d.count}`)
            .join(', ')}`}
          onMouseLeave={() => setHover(null)}
        >
          {shown.map((item, i) => {
            const y = i * rowHeight;
            const barY = y + (rowHeight - barThickness) / 2;
            const barWidth = (item.count / maxCount) * chartWidth;
            const isHover = hover?.index === i;

            return (
              <g
                key={item.label}
                onMouseMove={(e) => setHover({ index: i, x: e.clientX, y: e.clientY })}
              >
                {/* Zone de survol plus large que la marque elle-même. */}
                <rect x={0} y={y} width={width} height={rowHeight} fill="transparent" />
                <text
                  x={labelWidth - 10}
                  y={y + rowHeight / 2}
                  textAnchor="end"
                  dominantBaseline="central"
                  fontSize={12.5}
                  fill="var(--text-secondary)"
                >
                  {truncate(item.label, Math.floor(labelWidth / 7))}
                </text>
                <path
                  d={barPath(labelWidth, barY, Math.max(2, barWidth), barThickness, 4, 'right')}
                  fill="var(--series-1)"
                  opacity={isHover ? 0.85 : 1}
                />
                <text
                  x={labelWidth + Math.max(2, barWidth) + 8}
                  y={y + rowHeight / 2}
                  dominantBaseline="central"
                  fontSize={12.5}
                  fill="var(--text-primary)"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {item.count}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {hidden > 0 && (
        <div className="small muted" style={{ marginTop: 6 }}>
          {hidden} autre{hidden > 1 ? 's' : ''} modalité{hidden > 1 ? 's' : ''} non affichée
          {hidden > 1 ? 's' : ''} — voir le tableau brut.
        </div>
      )}

      {hover && shown[hover.index] && (
        <ChartTooltip x={hover.x} y={hover.y}>
          <div>{shown[hover.index]!.label}</div>
          <div>
            <span className="val">{formatNumber(shown[hover.index]!.count)}</span>{' '}
            <span className="secondary">
              sur {total} ({shown[hover.index]!.percent} %)
            </span>
          </div>
        </ChartTooltip>
      )}
    </div>
  );
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, Math.max(1, max - 1))}…` : s;
}
