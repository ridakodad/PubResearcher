import type { Rejection, TemplateWithFields } from '../domain/types.js';
import { loadSourceDocs } from '../repo/documents.js';
import {
  applyAutomaticValues,
  ensureRecord,
  protectedFieldIds,
  type ValueInput,
} from '../repo/records.js';
import { extractFieldDetailed } from './rules.js';
import { LlmError, extractWithLlm, type LlmUsage } from './llm.js';

/**
 * Mode d'extraction.
 *
 * - `rules` : moteur de règles seul. Déterministe, gratuit, reproductible.
 * - `llm`   : Claude seul. Traite le texte rédigé, où aucun libellé n'annonce
 *             la valeur.
 * - `hybrid`: les règles d'abord, Claude uniquement sur ce qu'elles n'ont pas
 *             trouvé. Conserve le déterminisme là où il est possible et
 *             réduit le volume soumis au modèle.
 */
export type ExtractionMode = 'rules' | 'llm' | 'hybrid';

export interface FieldOutcome {
  fieldId: number;
  key: string;
  label: string;
  status: 'extracted' | 'not-found' | 'kept-manual' | 'disabled';
  /** Origine de la valeur retenue. */
  by: 'rules' | 'llm' | null;
  confidence: number | null;
  /**
   * Première valeur que les règles ont trouvée puis écartée, quand la variable
   * reste vide : « CRP < 5 » n'est pas une variable absente, c'est une valeur
   * qu'un humain doit trancher.
   */
  rejected: Rejection | null;
}

export interface PatientExtractionReport {
  patientId: number;
  patientCode: string;
  documentCount: number;
  extracted: number;
  notFound: number;
  keptManual: number;
  /** Valeurs trouvées par les règles puis écartées (seuil, bornes, unité), variable restée vide. */
  rejected: number;
  /** Valeurs proposées par le modèle puis écartées faute de justification. */
  unverified: number;
  /** Valeurs proposées par le modèle puis écartées car incompatibles avec la fiche. */
  invalid: number;
  /** Message d'erreur si l'appel au modèle a échoué pour ce dossier. */
  llmError: string | null;
  usage: LlmUsage | null;
  fields: FieldOutcome[];
}

/**
 * Rend une fonction à appeler dans une boucle : elle cède la boucle d'événements si plus de `slice` ms de calcul se
 * sont écoulées depuis la dernière fois, et ne coûte rien sinon.
 */
export function createYielder(slice = 40): () => Promise<void> {
  let last = performance.now();
  return async () => {
    if (performance.now() - last < slice) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    last = performance.now();
  };
}

export interface RunOptions {
  mode?: ExtractionMode;
  overwriteManual?: boolean;
  /** Passe du journal à laquelle rattacher les changements de valeur. */
  runId?: number | null;
}

/**
 * Applique la fiche d'exploitation aux documents d'un patient.
 *
 * Les valeurs corrigées à la main sont préservées : relancer l'extraction
 * après une mise à jour de la fiche ne détruit jamais le travail de relecture.
 * `overwriteManual` permet de forcer la réécriture complète.
 */
export async function runExtractionForPatient(
  template: TemplateWithFields,
  patient: { id: number; code: string },
  options: RunOptions = {},
): Promise<PatientExtractionReport> {
  const mode = options.mode ?? 'rules';
  const record = ensureRecord(template.id, patient.id);
  // Décisions des relecteurs et valeurs importées d'un tableau : une passe ne les remplace que sur demande expresse.
  const protectedFields = options.overwriteManual ? new Set<number>() : protectedFieldIds(record.id);
  const docs = loadSourceDocs(patient.id);

  const values: ValueInput[] = [];
  const outcomes = new Map<number, FieldOutcome>();
  const rejections = new Map<number, Rejection | null>();
  /** Variables encore à pourvoir après le passage des règles. */
  const remaining: typeof template.fields = [];

  // Un document volumineux fait durer chaque variable : on cède la main entre deux variables, sans quoi
  // le serveur ne répondrait plus à personne le temps de la passe.
  const yielder = createYielder();
  for (const field of template.fields) {
    await yielder();
    if (protectedFields.has(field.id)) {
      outcomes.set(field.id, outcome(field, 'kept-manual', null, null));
      continue;
    }

    const rulesApply = mode !== 'llm' && field.extraction.enabled && field.extraction.rules.length > 0;
    const found = rulesApply ? extractFieldDetailed(field, docs) : null;
    const hit = found?.hit ?? null;
    rejections.set(field.id, found?.rejected[0] ?? null);

    if (hit) {
      values.push({
        fieldId: field.id,
        value: hit.value,
        source: 'auto',
        confidence: hit.confidence,
        evidence: hit.evidence,
      });
      outcomes.set(field.id, outcome(field, 'extracted', 'rules', hit.confidence));
      continue;
    }

    if (mode === 'rules') {
      const status = field.extraction.enabled && field.extraction.rules.length > 0 ? 'not-found' : 'disabled';
      outcomes.set(field.id, outcome(field, status, null, null));
    } else {
      // Soumise au modèle : le statut définitif dépend de sa réponse.
      remaining.push(field);
      outcomes.set(field.id, outcome(field, 'not-found', null, null));
    }
  }

  let unverified = 0;
  let invalid = 0;
  let llmError: string | null = null;
  let usage: LlmUsage | null = null;

  if (mode !== 'rules' && remaining.length > 0) {
    try {
      const result = await extractWithLlm(remaining, docs, template.name);
      usage = result.usage;
      unverified = result.unverified.length;
      invalid = result.invalid.length;

      for (const found of result.values) {
        values.push({
          fieldId: found.fieldId,
          value: found.value,
          source: 'llm',
          confidence: found.confidence,
          evidence: found.evidence,
        });
        const field = remaining.find((f) => f.id === found.fieldId)!;
        outcomes.set(field.id, outcome(field, 'extracted', 'llm', found.confidence));
      }
    } catch (error) {
      // L'échec du modèle sur un dossier ne doit pas annuler ce que les
      // règles ont déjà trouvé, ni interrompre la passe sur les suivants.
      llmError = error instanceof LlmError ? error.message : String(error);
    }
  }

  // Une variable qui n'est plus trouvée perd sa valeur automatique au lieu de la
  // conserver en silence ; une valeur retrouvée à l'identique ne change rien.
  // Une seule transaction pour les valeurs, le journal et la date de passe : un arrêt brutal au milieu laisse
  // la fiche telle qu'elle était, jamais à moitié effacée avec une date de passe toute neuve.
  // Une passe ne retire que ce qu'elle a pu produire : les règles ne savent pas retrouver une valeur de Claude, et un
  // appel au modèle en échec (limite de débit, panne) n'est pas un « rien trouvé ». Relancer les règles après une passe
  // par le modèle — payante — ne doit donc pas effacer ses valeurs non relues.
  const rulesRan = mode !== 'llm';
  const modelRan = mode !== 'rules' && llmError === null;
  const withdraw: ('auto' | 'llm')[] = [];
  // Mode « Claude seul » : le modèle a la main sur toute la fiche, les valeurs de règles d'une passe antérieure aussi.
  if (rulesRan || modelRan) withdraw.push('auto');
  if (modelRan) withdraw.push('llm');
  applyAutomaticValues(record.id, values, { runId: options.runId ?? null, markExtracted: true, withdraw });

  // La valeur écartée n'est conservée que si la variable est restée vide : si le modèle
  // ou une règle de repli a finalement trouvé mieux, elle n'apporte plus rien.
  const fields = template.fields.map((f) => {
    const o = outcomes.get(f.id)!;
    return o.status === 'extracted' ? o : { ...o, rejected: rejections.get(f.id) ?? null };
  });

  return {
    patientId: patient.id,
    patientCode: patient.code,
    documentCount: docs.length,
    extracted: fields.filter((o) => o.status === 'extracted').length,
    notFound: fields.filter((o) => o.status === 'not-found').length,
    keptManual: fields.filter((o) => o.status === 'kept-manual').length,
    rejected: fields.filter((o) => o.rejected !== null).length,
    unverified,
    invalid,
    llmError,
    usage,
    fields,
  };
}

function outcome(
  field: { id: number; key: string; label: string },
  status: FieldOutcome['status'],
  by: FieldOutcome['by'],
  confidence: number | null,
): FieldOutcome {
  return { fieldId: field.id, key: field.key, label: field.label, status, by, confidence, rejected: null };
}
