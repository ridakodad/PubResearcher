import { Router } from 'express';
import { asyncHandler, badRequest, intParam, intQuery, notFound, unprocessable } from '../lib/http.js';
import { extractionRunSchema, valueUpdateSchema } from '../lib/schemas.js';
import { getActiveTemplate, getTemplate } from '../repo/templates.js';
import { getPatient, listPatients } from '../repo/patients.js';
import { applyHumanEdits, ensureRecord, type HumanEdit } from '../repo/records.js';
import { finishRun, listRuns, startRun } from '../repo/runs.js';
import { listEventsForRecord } from '../repo/events.js';
import { runExtractionForPatient, type PatientExtractionReport } from '../engine/run.js';
import { llmStatus } from '../engine/llm.js';
import { costOf } from '../engine/pricing.js';
import type { FieldValue, TemplateField, TemplateWithFields } from '../domain/types.js';

export const recordsRouter = Router();

function resolveTemplate(id: number | null): TemplateWithFields {
  const template = id ? getTemplate(id) : getActiveTemplate();
  if (!template) throw notFound("Aucune fiche d'exploitation disponible.");
  return template;
}

/** Fiche remplie d'un patient, avec le modèle et les documents disponibles. */
recordsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const patientId = intQuery(req, 'patientId');
    if (!patientId) throw badRequest('Paramètre « patientId » requis.');
    const patient = getPatient(patientId);
    if (!patient) throw notFound('Dossier patient introuvable.');

    const template = resolveTemplate(intQuery(req, 'templateId'));
    res.json({ template, patient, record: ensureRecord(template.id, patientId) });
  }),
);

/**
 * Enregistre les décisions d'un relecteur : valeurs saisies ou corrigées, valeurs
 * confirmées telles quelles, ou variables rendues à l'extraction.
 * Ces valeurs sont marquées `manual` et survivent aux extractions suivantes.
 */
recordsRouter.put(
  '/:templateId/:patientId/values',
  asyncHandler(async (req, res) => {
    const templateId = intParam(req, 'templateId');
    const patientId = intParam(req, 'patientId');

    const template = getTemplate(templateId);
    if (!template) throw notFound("Fiche d'exploitation introuvable.");
    if (!getPatient(patientId)) throw notFound('Dossier patient introuvable.');

    const { values, acceptOutOfBounds } = valueUpdateSchema.parse(req.body);
    const byId = new Map(template.fields.map((f) => [f.id, f]));
    const record = ensureRecord(templateId, patientId);
    const stored = new Map(record.values.map((v) => [v.fieldId, v]));

    const outOfBounds: OutOfBounds[] = [];
    const edits: HumanEdit[] = values.map(({ fieldId, value, mode }) => {
      const field = byId.get(fieldId);
      if (!field) throw badRequest(`Variable ${fieldId} absente de cette fiche.`);

      if (mode === 'confirm') {
        const current = stored.get(fieldId);
        const machine = current && (current.source === 'auto' || current.source === 'llm');
        if (!current || (!machine && current.source !== 'manual') || current.value === null) {
          throw badRequest(`Rien à confirmer pour « ${field.label} » : la variable n'a pas de valeur.`);
        }
        return { fieldId, value: current.value, mode };
      }
      if (mode === 'release') return { fieldId, value: null, mode };

      const checked = validateManualValue(field, value);
      if (checked.outOfBounds) outOfBounds.push(checked.outOfBounds);
      return { fieldId, value: checked.value, mode };
    });

    if (outOfBounds.length > 0 && !acceptOutOfBounds) {
      throw unprocessable(
        outOfBounds.map((o) => `« ${o.label} » : ${readable(o.value)} est hors des bornes attendues (${describeBounds(o)}).`).join(' '),
        outOfBounds,
        'out_of_bounds',
      );
    }

    applyHumanEdits(record.id, edits);
    res.json({ record: ensureRecord(templateId, patientId) });
  }),
);

/** Historique des changements d'une fiche (ou d'une seule variable), du plus récent au plus ancien. */
recordsRouter.get(
  '/:templateId/:patientId/history',
  asyncHandler(async (req, res) => {
    const templateId = intParam(req, 'templateId');
    const patientId = intParam(req, 'patientId');
    if (!getTemplate(templateId)) throw notFound("Fiche d'exploitation introuvable.");
    if (!getPatient(patientId)) throw notFound('Dossier patient introuvable.');
    const record = ensureRecord(templateId, patientId);
    res.json({ events: listEventsForRecord(record.id, intQuery(req, 'fieldId'), intQuery(req, 'limit') ?? 200) });
  }),
);

/** Passes d'extraction passées, de la plus récente à la plus ancienne. */
recordsRouter.get(
  '/runs',
  asyncHandler(async (req, res) => {
    res.json({ runs: listRuns(intQuery(req, 'limit') ?? 50) });
  }),
);

/**
 * Lance l'extraction automatique.
 * Sans `patientIds`, la passe couvre l'ensemble des dossiers.
 */
recordsRouter.post(
  '/extraction/run',
  asyncHandler(async (req, res) => {
    const input = extractionRunSchema.parse(req.body ?? {});
    const template = resolveTemplate(input.templateId ?? null);

    const targets = input.patientIds
      ? input.patientIds.map((id) => {
          const p = getPatient(id);
          if (!p) throw notFound(`Dossier patient ${id} introuvable.`);
          return p;
        })
      : listPatients();

    if (targets.length === 0) throw badRequest('Aucun dossier patient à traiter.');

    const mode = input.mode ?? 'rules';
    if (mode !== 'rules' && !llmStatus().available) {
      throw badRequest(
        `Extraction par Claude indisponible : ${llmStatus().reason ?? 'configuration incomplète'}`,
      );
    }

    const runId = startRun({
      template,
      mode,
      model: mode === 'rules' ? null : llmStatus().model,
      overwriteManual: input.overwriteManual === true,
    });

    // Les dossiers sont traités en série : l'extraction par modèle est
    // soumise à une limite de débit, et la progression reste lisible.
    const reports: PatientExtractionReport[] = [];
    try {
      for (const patient of targets) {
        reports.push(
          await runExtractionForPatient(template, patient, {
            mode,
            overwriteManual: input.overwriteManual,
            runId,
          }),
        );
        // Les règles tournent sans attendre : sans cette pause, une passe sur des milliers
        // de dossiers occuperait le serveur d'un bloc, et plus rien d'autre ne lui répondrait.
        await yieldToEventLoop();
      }
    } catch (error) {
      finishRun(runId, 'failed', totalsOf(reports));
      throw error;
    }
    finishRun(runId, 'done', totalsOf(reports));

    const sum = (pick: (r: PatientExtractionReport) => number) =>
      reports.reduce((total, r) => total + pick(r), 0);
    const usage = mode === 'rules' ? null : {
      inputTokens: sum((r) => r.usage?.inputTokens ?? 0),
      outputTokens: sum((r) => r.usage?.outputTokens ?? 0),
      cacheReadTokens: sum((r) => r.usage?.cacheReadTokens ?? 0),
      cacheWriteTokens: sum((r) => r.usage?.cacheWriteTokens ?? 0),
    };

    res.json({
      runId,
      templateId: template.id,
      mode,
      patientsProcessed: reports.length,
      totals: {
        extracted: sum((r) => r.extracted),
        notFound: sum((r) => r.notFound),
        keptManual: sum((r) => r.keptManual),
        rejected: sum((r) => r.rejected),
        unverified: sum((r) => r.unverified),
        invalid: sum((r) => r.invalid),
      },
      // Consommation cumulée, et son prix en dollars sur le compte Anthropic de l'utilisateur.
      usage,
      model: mode === 'rules' ? null : llmStatus().model,
      costUsd: costOf(mode === 'rules' ? null : llmStatus().model, usage),
      errors: reports.filter((r) => r.llmError).map((r) => ({ patientCode: r.patientCode, message: r.llmError })),
      reports,
    });
  }),
);

interface OutOfBounds {
  fieldId: number;
  key: string;
  label: string;
  /** Nombre pour une variable numérique, date ISO pour une date. */
  value: number | string;
  min: number | string | null;
  max: number | string | null;
}

/** `2024-03-15` -> `15/03/2024` (les nombres restent tels quels). */
const readable = (v: number | string): string => {
  const m = typeof v === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : String(v);
};

const describeBounds = (o: { min: number | string | null; max: number | string | null }): string =>
  o.min !== null && o.max !== null
    ? `${readable(o.min)} à ${readable(o.max)}`
    : o.min !== null
      ? `au moins ${readable(o.min)}`
      : `au plus ${readable(o.max!)}`;

/** Une date saisie avant 1900 ou plus d'un an dans l'avenir est presque toujours une faute de frappe (0024 pour 2024). */
const EARLIEST_DATE = '1900-01-01';
function latestDate(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function totalsOf(reports: PatientExtractionReport[]) {
  const sum = (pick: (r: PatientExtractionReport) => number) => reports.reduce((total, r) => total + pick(r), 0);
  return {
    patients: reports.length,
    documents: sum((r) => r.documentCount),
    extracted: sum((r) => r.extracted),
    notFound: sum((r) => r.notFound),
    keptManual: sum((r) => r.keptManual),
    rejected: sum((r) => r.rejected),
  };
}

/** Nombre saisi : chiffres, signe, virgule ou point décimal. Rien d'autre (pas de « 1e3 », pas de « 0x10 »). */
const NUMERIC_INPUT = /^\s*([-+\u2212]?\d+(?:[.,]\d+)?)\s*$/;

/** Date du calendrier réel : le 31 février n'existe pas. */
function isCalendarDate(iso: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return false;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // `Date.UTC(24, …)` lirait l'an 1924 (héritage de l'an 2000) : on fixe l'année après coup.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/**
 * Contrôle qu'une valeur saisie manuellement respecte le type déclaré.
 * La saisie manuelle fait autorité : on n'essaie pas de la « corriger » (un entier à
 * virgule n'est pas arrondi), on refuse ce qui est incohérent. Les bornes de
 * plausibilité ne sont pas une interdiction : elles sont signalées pour confirmation.
 */
function validateManualValue(
  field: TemplateField,
  value: FieldValue,
): { value: FieldValue; outOfBounds: OutOfBounds | null } {
  const plain = (v: FieldValue) => ({ value: v, outOfBounds: null });
  if (value === null || value === '') return plain(null);

  switch (field.type) {
    case 'text': {
      if (Array.isArray(value)) throw badRequest(`« ${field.label} » attend un texte.`);
      const text = String(value);
      if (text.length > 20_000) throw badRequest(`« ${field.label} » : texte trop long (20 000 caractères au plus).`);
      return plain(text);
    }

    case 'number':
    case 'integer': {
      let n: number;
      if (typeof value === 'number') {
        n = value;
      } else if (typeof value === 'string') {
        const m = NUMERIC_INPUT.exec(value);
        n = m ? Number(m[1]!.replace(',', '.').replace('\u2212', '-')) : Number.NaN;
      } else {
        n = Number.NaN;
      }
      if (!Number.isFinite(n)) {
        throw badRequest(`« ${field.label} » attend un nombre.`);
      }
      if (field.type === 'integer' && !Number.isInteger(n)) {
        throw badRequest(`« ${field.label} » attend un nombre entier (reçu ${String(value)}).`);
      }
      const min = field.extraction.postProcess?.min ?? null;
      const max = field.extraction.postProcess?.max ?? null;
      const outside = (min !== null && n < min) || (max !== null && n > max);
      return {
        value: n,
        outOfBounds: outside ? { fieldId: field.id, key: field.key, label: field.label, value: n, min, max } : null,
      };
    }

    case 'date': {
      const s = String(value);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        throw badRequest(`« ${field.label} » attend une date au format AAAA-MM-JJ.`);
      }
      if (!isCalendarDate(s)) {
        throw badRequest(`« ${field.label} » : le ${s} n'existe pas au calendrier.`);
      }
      const latest = latestDate();
      const implausible = s < EARLIEST_DATE || s > latest;
      return {
        value: s,
        outOfBounds: implausible
          ? { fieldId: field.id, key: field.key, label: field.label, value: s, min: EARLIEST_DATE, max: latest }
          : null,
      };
    }

    case 'boolean': {
      if (typeof value === 'boolean') return plain(value);
      const s = String(value).toLowerCase();
      if (['true', 'oui', '1'].includes(s)) return plain(true);
      if (['false', 'non', '0'].includes(s)) return plain(false);
      throw badRequest(`« ${field.label} » attend Oui ou Non.`);
    }

    case 'enum': {
      const s = String(value);
      if (!field.options.includes(s)) {
        throw badRequest(`« ${s} » n'est pas une option de « ${field.label} ».`);
      }
      return plain(s);
    }

    case 'multi': {
      const list = [...new Set(Array.isArray(value) ? value.map(String) : [String(value)])];
      const invalid = list.filter((v) => !field.options.includes(v));
      if (invalid.length > 0) {
        throw badRequest(
          `Options inconnues pour « ${field.label} » : ${invalid.join(', ')}.`,
        );
      }
      return plain(list);
    }

    default:
      return plain(value);
  }
}
