/** Statistiques descriptives et agrégats servant aux graphiques. */

export interface NumericSummary {
  n: number;
  mean: number;
  sd: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

export interface HistogramBin {
  /** Étiquette de l'intervalle, ex. « 40 – 50 ». */
  label: string;
  from: number;
  to: number;
  count: number;
}

export interface CategoryCount {
  label: string;
  count: number;
  /** Part parmi les valeurs renseignées, en pourcentage. */
  percent: number;
}

/** Quantile par interpolation linéaire, sur un tableau déjà trié. */
export function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function summarize(values: number[]): NumericSummary | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;

  const n = clean.length;
  const mean = clean.reduce((s, v) => s + v, 0) / n;
  // Écart-type d'échantillon (n-1) : c'est celui attendu dans une publication.
  const variance =
    n > 1 ? clean.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) : 0;

  return {
    n,
    mean: round(mean),
    sd: round(Math.sqrt(variance)),
    min: clean[0]!,
    q1: round(quantile(clean, 0.25)),
    median: round(quantile(clean, 0.5)),
    q3: round(quantile(clean, 0.75)),
    max: clean[n - 1]!,
  };
}

/** Histogramme à bornes « rondes », plus lisible qu'un découpage brut. */
export function histogram(values: number[], maxBins = 10): HistogramBin[] {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return [];

  const min = clean[0]!;
  const max = clean[clean.length - 1]!;
  if (min === max) {
    return [{ label: formatNumber(min), from: min, to: min, count: clean.length }];
  }

  // Règle de Sturges bornée, puis arrondi de la largeur à un pas lisible.
  const targetBins = Math.max(3, Math.min(maxBins, Math.ceil(Math.log2(clean.length) + 1)));
  const width = niceStep((max - min) / targetBins);
  const start = Math.floor(min / width) * width;
  const binCount = Math.max(1, Math.ceil((max - start) / width + 1e-9));

  const bins: HistogramBin[] = [];
  for (let i = 0; i < binCount; i++) {
    const from = round(start + i * width);
    const to = round(from + width);
    bins.push({ label: `${formatNumber(from)} – ${formatNumber(to)}`, from, to, count: 0 });
  }
  for (const v of clean) {
    let idx = Math.floor((v - start) / width);
    // La borne supérieure est incluse dans le dernier intervalle.
    if (idx >= bins.length) idx = bins.length - 1;
    if (idx < 0) idx = 0;
    bins[idx]!.count++;
  }
  return bins;
}

/** Largeur d'intervalle « ronde » : 1, 2, 2.5 ou 5 fois une puissance de dix. */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/** Effectifs par catégorie, triés du plus fréquent au moins fréquent. */
export function countCategories(values: string[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const total = values.length;
  return [...counts.entries()]
    .map(([label, count]) => ({
      label,
      count,
      percent: total > 0 ? round((count / total) * 100, 1) : 0,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'fr'));
}

function round(n: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/** Étiquette de classe : virgule décimale, comme tout ce que l'interface affiche (le CSV, lui, suit son propre réglage). */
function formatNumber(n: number): string {
  return (Number.isInteger(n) ? String(n) : String(round(n, 2))).replace('.', ',');
}

/**
 * Intervalle de confiance de Wilson d'une proportion (95 % par défaut).
 *
 * C'est l'intervalle qu'il faut pour une concordance mesurée sur quelques dizaines de valeurs : celui
 * de Wald (p ± 1,96·√(p(1−p)/n)) sort de [0 ; 1] et s'effondre à 0 quand tous les cas concordent.
 */
export function wilsonInterval(successes: number, total: number, z = 1.96): { low: number; high: number } | null {
  if (total <= 0) return null;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = (p + z2 / (2 * total)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}
