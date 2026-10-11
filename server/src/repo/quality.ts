import { db, parseJson } from '../db/index.js';
import type { FieldType, FieldValue, TemplateWithFields } from '../domain/types.js';
import { wilsonInterval } from '../lib/stats.js';

/**
 * Fiabilité de l'extraction automatique, mesurée sur ce que les relecteurs en ont fait.
 *
 * Quand un relecteur confirme, corrige ou vide une valeur proposée par la machine, il produit sans effort
 * supplémentaire la mesure qu'une méthode d'extraction doit rapporter : parmi les valeurs relues, combien
 * étaient justes. Les décisions sont lues dans l'état courant des valeurs (voir `records.ts`) :
 *
 * - confirmée : la valeur retenue est celle que la machine avait proposée ;
 * - corrigée  : le relecteur l'a remplacée par une autre ;
 * - vidée     : le relecteur a jugé qu'il n'y avait pas de valeur ;
 * - ajoutée   : la machine n'avait rien trouvé, le relecteur a saisi une valeur ;
 * - vide confirmée : la machine n'avait rien trouvé, le relecteur confirme qu'il n'y a rien.
 *
 * Les valeurs importées d'un tableau de cohorte n'entrent pas dans ces mesures : ce ne sont pas des propositions de
 * l'extraction, et les confirmer ne dit rien de sa fiabilité.
 *
 * Ces mesures n'ont de portée que si les dossiers relus sont tirés au hasard : relire d'abord les valeurs
 * douteuses fait baisser la concordance affichée. Le rapport le rappelle.
 */

export interface QualityCounts {
  /** Valeurs encore telles que la machine les a produites, jamais relues. */
  unreviewed: number;
  confirmed: number;
  corrected: number;
  emptied: number;
  added: number;
  confirmedEmpty: number;
}

export interface Proportion {
  value: number;
  low: number;
  high: number;
  /** Dénominateur de la proportion. */
  of: number;
}

export interface FieldQuality extends QualityCounts {
  fieldId: number;
  key: string;
  label: string;
  type: FieldType;
  /** Propositions de la machine relues par un humain : confirmées + corrigées + vidées. */
  reviewed: number;
  /** Part des propositions relues qui étaient justes (précision). `null` tant que rien n'a été relu. */
  agreement: Proportion | null;
  /** Part des valeurs justes (selon les relecteurs) que la machine avait trouvées (rappel). */
  recall: Proportion | null;
}

export interface QualityReport {
  templateId: number;
  patients: number;
  /** Dossiers dont au moins une valeur a été relue. */
  patientsReviewed: number;
  overall: QualityCounts & { reviewed: number; agreement: Proportion | null; recall: Proportion | null };
  fields: FieldQuality[];
}

interface Row {
  record_id: number;
  field_id: number;
  value: string | null;
  source: string;
  origin_source: string | null;
  origin_value: string | null;
  reviewed_at: string | null;
}

/** Deux valeurs sont les mêmes si leur contenu l'est ; l'ordre d'un choix multiple n'y change rien. */
function sameValue(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  const left = parseJson<FieldValue>(a, null);
  const right = parseJson<FieldValue>(b, null);
  if (Array.isArray(left) && Array.isArray(right)) {
    return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

const empty = (): QualityCounts => ({ unreviewed: 0, confirmed: 0, corrected: 0, emptied: 0, added: 0, confirmedEmpty: 0 });

function proportion(successes: number, total: number): Proportion | null {
  const interval = wilsonInterval(successes, total);
  return interval ? { value: successes / total, low: interval.low, high: interval.high, of: total } : null;
}

function summarize(counts: QualityCounts): { reviewed: number; agreement: Proportion | null; recall: Proportion | null } {
  const reviewed = counts.confirmed + counts.corrected + counts.emptied;
  return {
    reviewed,
    agreement: proportion(counts.confirmed, reviewed),
    // Valeurs justes selon les relecteurs : celles que la machine a trouvées (confirmées), celles qu'elle a
    // mal trouvées (corrigées) et celles qu'elle a manquées (ajoutées).
    recall: proportion(counts.confirmed, counts.confirmed + counts.corrected + counts.added),
  };
}

export function computeQuality(template: TemplateWithFields): QualityReport {
  const rows = db
    .prepare(
      `SELECT rv.record_id, rv.field_id, rv.value, rv.source, rv.origin_source, rv.origin_value, rv.reviewed_at
         FROM record_values rv
         JOIN records r ON r.id = rv.record_id
        WHERE r.template_id = ?`,
    )
    .all(template.id) as Row[];

  const perField = new Map<number, QualityCounts>(template.fields.map((f) => [f.id, empty()]));
  const reviewedRecords = new Set<number>();

  for (const row of rows) {
    const counts = perField.get(row.field_id);
    if (!counts) continue;
    // Les valeurs importées d'un tableau — et les décisions prises sur elles — ne disent rien de la fiabilité de
    // l'extraction : elles ne sont comptées nulle part ici (le rapport « Méthodes » les dénombre à part).
    if (row.source === 'import' || row.origin_source === 'import') continue;
    if (row.source === 'auto' || row.source === 'llm') {
      counts.unreviewed++;
    } else if (row.source === 'manual') {
      if (row.reviewed_at) reviewedRecords.add(row.record_id);
      if (row.origin_source) {
        if (row.value === null) counts.emptied++;
        else if (sameValue(row.value, row.origin_value)) counts.confirmed++;
        else counts.corrected++;
      } else if (row.value === null) {
        counts.confirmedEmpty++;
      } else {
        counts.added++;
      }
    }
  }

  const total = empty();
  const fields: FieldQuality[] = template.fields.map((field) => {
    const counts = perField.get(field.id)!;
    for (const k of Object.keys(total) as (keyof QualityCounts)[]) total[k] += counts[k];
    return {
      fieldId: field.id,
      key: field.key,
      label: field.label,
      type: field.type,
      ...counts,
      ...summarize(counts),
    };
  });

  const patients = (db.prepare('SELECT COUNT(*) AS n FROM patients').get() as { n: number }).n;
  return {
    templateId: template.id,
    patients,
    patientsReviewed: reviewedRecords.size,
    overall: { ...total, ...summarize(total) },
    fields,
  };
}
