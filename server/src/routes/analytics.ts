import { Router } from 'express';
import { asyncHandler, intQuery, notFound } from '../lib/http.js';
import { getActiveTemplate, getTemplate } from '../repo/templates.js';
import { listPatients } from '../repo/patients.js';
import { listRecordsForTemplate } from '../repo/records.js';
import { listDocuments } from '../repo/documents.js';
import { computeQuality } from '../repo/quality.js';
import { countCategories, histogram, summarize } from '../lib/stats.js';
import type {
  FieldValue,
  TemplateField,
  TemplateWithFields,
  ValueSource,
} from '../domain/types.js';

export const analyticsRouter = Router();

/** Une ligne du tableau de résultats : un patient, toutes ses variables. */
export interface DatasetRow {
  patientId: number;
  patientCode: string;
  patientLabel: string | null;
  documentCount: number;
  /** Valeurs indexées par clé de variable. */
  values: Record<string, FieldValue>;
  /** Origine de chaque valeur, pour distinguer l'automatique du relu. */
  sources: Record<string, ValueSource>;
  confidences: Record<string, number | null>;
  /** Nombre de variables renseignées, pour la complétude du dossier. */
  filled: number;
}

function resolveTemplate(id: number | null): TemplateWithFields {
  const template = id ? getTemplate(id) : getActiveTemplate();
  if (!template) throw notFound("Aucune fiche d'exploitation disponible.");
  return template;
}

/** Construit le jeu de données complet : un enregistrement par dossier patient. */
export function buildDataset(template: TemplateWithFields): DatasetRow[] {
  const patients = listPatients();
  const records = listRecordsForTemplate(template.id, { withEvidence: false });
  const byPatient = new Map(records.map((r) => [r.patientId, r]));
  const fieldById = new Map(template.fields.map((f) => [f.id, f]));

  return patients.map((patient) => {
    const record = byPatient.get(patient.id);
    const values: Record<string, FieldValue> = {};
    const sources: Record<string, ValueSource> = {};
    const confidences: Record<string, number | null> = {};

    for (const field of template.fields) {
      values[field.key] = null;
      sources[field.key] = 'empty';
      confidences[field.key] = null;
    }

    let filled = 0;
    for (const value of record?.values ?? []) {
      const field = fieldById.get(value.fieldId);
      if (!field) continue;
      values[field.key] = value.value;
      sources[field.key] = value.source;
      confidences[field.key] = value.confidence;
      if (!isEmpty(value.value)) filled++;
    }

    return {
      patientId: patient.id,
      patientCode: patient.code,
      patientLabel: patient.label,
      documentCount: patient.documentCount,
      values,
      sources,
      confidences,
      filled,
    };
  });
}

function isEmpty(v: FieldValue): boolean {
  return v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

const MONTHS_FR = [
  'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
  'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
];

/** `2024-03` -> `mars 2024`, en conservant un préfixe triable. */
function formatMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-');
  const index = Number(month) - 1;
  const name = MONTHS_FR[index];
  return name ? `${name} ${year}` : yearMonth;
}

const MONTH_INDEX = new Map(MONTHS_FR.map((name, i) => [name, i]));

/** Trie des étiquettes « mars 2024 » ou « 2024 » dans l'ordre du temps. */
function sortChronologically<T extends { label: string }>(items: T[]): T[] {
  const key = (label: string): number => {
    const parts = label.split(' ');
    if (parts.length === 2) {
      const month = MONTH_INDEX.get(parts[0]!) ?? 0;
      return Number(parts[1]) * 12 + month;
    }
    return Number(parts[0]) * 12;
  };
  return [...items].sort((a, b) => key(a.label) - key(b.label));
}

/** Jeu de données brut, affiché tel quel dans le tableau des résultats. */
analyticsRouter.get(
  '/dataset',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const rows = buildDataset(template);
    res.json({
      template,
      rows,
      summary: {
        patients: rows.length,
        fields: template.fields.length,
        /** Taux de remplissage global du tableau. */
        completeness:
          template.fields.length > 0 && rows.length > 0
            ? Math.round(
                (rows.reduce((s, r) => s + r.filled, 0) /
                  (rows.length * template.fields.length)) *
                  100,
              )
            : 0,
      },
    });
  }),
);

export type FieldStats =
  | {
      key: string;
      label: string;
      type: TemplateField['type'];
      unit: string | null;
      section: string;
      n: number;
      missing: number;
      chart: 'histogram';
      summary: ReturnType<typeof summarize>;
      bins: ReturnType<typeof histogram>;
    }
  | {
      key: string;
      label: string;
      type: TemplateField['type'];
      unit: string | null;
      section: string;
      n: number;
      missing: number;
      chart: 'categories';
      categories: ReturnType<typeof countCategories>;
    }
  | {
      key: string;
      label: string;
      type: TemplateField['type'];
      unit: string | null;
      section: string;
      n: number;
      missing: number;
      chart: 'none';
      /** Valeurs les plus fréquentes, à titre indicatif pour le texte libre. */
      topValues: ReturnType<typeof countCategories>;
    };

/**
 * Statistiques par variable.
 *
 * Le type de graphique découle du type de la variable : histogramme pour le
 * quantitatif, effectifs par catégorie pour le qualitatif, regroupement par
 * année pour les dates.
 */
/**
 * Statistiques descriptives, variable par variable.
 *
 * Extrait de la route qui les servait : l'export en diaporama a besoin des
 * mêmes calculs, et deux implémentations divergeraient tôt ou tard — une
 * figure ne doit pas contredire le tableau dont elle est tirée.
 */
export function buildFieldStats(
  template: TemplateWithFields,
  rows: DatasetRow[],
): FieldStats[] {
  return template.fields.map((field) => {
    const raw = rows.map((r) => r.values[field.key] ?? null);
    const present = raw.filter((v) => !isEmpty(v));
    const base = {
      key: field.key,
      label: field.label,
      type: field.type,
      unit: field.unit,
      section: field.section,
      n: present.length,
      missing: rows.length - present.length,
    };

    switch (field.type) {
      case 'number':
      case 'integer': {
        const numbers = present
          .map((v) => (typeof v === 'number' ? v : Number(v)))
          .filter((v) => Number.isFinite(v));
        return {
          ...base,
          n: numbers.length,
          missing: rows.length - numbers.length,
          chart: 'histogram',
          summary: summarize(numbers),
          bins: histogram(numbers),
        };
      }

      case 'boolean': {
        const labels = present.map((v) => (v === true ? 'Oui' : 'Non'));
        return { ...base, chart: 'categories', categories: countCategories(labels) };
      }

      case 'enum': {
        return {
          ...base,
          chart: 'categories',
          categories: countCategories(present.map((v) => String(v))),
        };
      }

      case 'multi': {
        // Une observation peut cocher plusieurs options : les effectifs
        // portent sur les citations, le total peut dépasser l'effectif.
        const flat = present.flatMap((v) => (Array.isArray(v) ? v : [String(v)]));
        return { ...base, chart: 'categories', categories: countCategories(flat) };
      }

      case 'date': {
        const dates = present
          .map((v) => String(v))
          .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
        // Un seul bâton « 2024 » n'apprend rien : on descend au mois tant que
        // le nombre de classes reste lisible, et on remonte à l'année sinon.
        const months = new Set(dates.map((d) => d.slice(0, 7)));
        const buckets =
          months.size <= 24
            ? dates.map((d) => formatMonth(d.slice(0, 7)))
            : dates.map((d) => d.slice(0, 4));
        return {
          ...base,
          n: dates.length,
          missing: rows.length - dates.length,
          chart: 'categories',
          // Ordre chronologique : une distribution temporelle ne se trie pas
          // par effectif.
          categories: sortChronologically(countCategories(buckets)),
        };
      }

    default: {
      const values = present.map((v) => String(v));
      return { ...base, chart: 'none', topValues: countCategories(values).slice(0, 10) };
    }
  }
  });
}

analyticsRouter.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const rows = buildDataset(template);
    res.json({ template, patientCount: rows.length, stats: buildFieldStats(template, rows) });
  }),
);

/**
 * Rendement de l'extraction, dossier par dossier et fichier par fichier.
 *
 * Le taux de complétude dit *combien* manque, pas *pourquoi*. Cette vue
 * répond à la seconde question : elle attribue chaque valeur au document qui
 * l'a justifiée, et met en regard les fichiers qui n'ont rien produit. Un
 * document sans texte exploitable, un compte rendu dont aucune règle
 * n'accroche le vocabulaire, un dossier resté vide — le paramétrage se corrige
 * à partir de là, pas à partir d'un pourcentage global.
 */
analyticsRouter.get(
  '/extraction',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const patients = listPatients();
    const records = new Map(
      listRecordsForTemplate(template.id).map((record) => [record.patientId, record]),
    );
    const fieldById = new Map(template.fields.map((f) => [f.id, f]));

    const rows = patients.map((patient) => {
      const record = records.get(patient.id);
      const documents = listDocuments(patient.id);

      const perDocument = new Map<number, { name: string; values: string[] }>();
      const bySource = { auto: 0, llm: 0, manual: 0 };
      /** Valeurs sans justification : saisies à la main, ou justification perdue. */
      let sansJustification = 0;
      let filled = 0;

      for (const value of record?.values ?? []) {
        const field = fieldById.get(value.fieldId);
        if (!field || isEmpty(value.value)) continue;
        filled++;
        if (value.source === 'manual') bySource.manual++;
        else if (value.source === 'llm') bySource.llm++;
        else bySource.auto++;

        if (!value.evidence) {
          sansJustification++;
          continue;
        }
        const entry = perDocument.get(value.evidence.documentId) ?? {
          name: value.evidence.documentName,
          values: [],
        };
        entry.values.push(field.label);
        perDocument.set(value.evidence.documentId, entry);
      }

      return {
        patientId: patient.id,
        patientCode: patient.code,
        patientLabel: patient.label,
        lastExtractionAt: record?.lastExtractionAt ?? null,
        filled,
        total: template.fields.length,
        bySource,
        sansJustification,
        documents: documents.map((doc) => {
          const found = perDocument.get(doc.id);
          return {
            documentId: doc.id,
            filename: doc.filename,
            kind: doc.kind,
            parseStatus: doc.parseStatus,
            textLength: doc.textLength,
            // Les libellés plutôt qu'un simple compte : on veut savoir quelles
            // variables viennent de quel document.
            fields: found?.values ?? [],
          };
        }),
      };
    });

    res.json({
      template,
      rows,
      summary: {
        patients: rows.length,
        /** Dossiers dont aucune variable n'a pu être renseignée. */
        emptyPatients: rows.filter((r) => r.filled === 0).length,
        /** Fichiers importés qui n'ont justifié aucune valeur. */
        barrenDocuments: rows.reduce(
          (sum, r) => sum + r.documents.filter((d) => d.fields.length === 0).length,
          0,
        ),
        documents: rows.reduce((sum, r) => sum + r.documents.length, 0),
      },
    });
  }),
);

/** Complétude par variable : où porter l'effort de relecture. */
analyticsRouter.get(
  '/completeness',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const rows = buildDataset(template);

    const fields = template.fields.map((field) => {
      let auto = 0;
      let llm = 0;
      let manual = 0;
      let empty = 0;
      for (const row of rows) {
        const source = row.sources[field.key];
        if (isEmpty(row.values[field.key] ?? null)) empty++;
        else if (source === 'manual') manual++;
        else if (source === 'llm') llm++;
        else auto++;
      }
      return {
        key: field.key,
        label: field.label,
        section: field.section,
        required: field.required,
        auto,
        llm,
        manual,
        empty,
        rate: rows.length > 0 ? Math.round(((auto + llm + manual) / rows.length) * 100) : 0,
      };
    });

    res.json({ patientCount: rows.length, fields });
  }),
);

/**
 * Fiabilité de l'extraction automatique, mesurée sur les valeurs que les relecteurs ont confirmées,
 * corrigées ou vidées (voir `repo/quality.ts`).
 */
analyticsRouter.get(
  '/quality',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    res.json({ quality: computeQuality(template) });
  }),
);
