import { z } from 'zod';
import './zod-fr.js';
import { normalizePatientCode } from './patient-code.js';
import { FIELD_TYPES } from '../domain/types.js';

const docKind = z.enum(['pdf', 'docx', 'image', 'dicom', 'text', 'unknown']);
const ruleSource = z.enum(['text', 'dicom', 'filename']);
/** Identifiant de ligne : entier positif que SQLite et JavaScript représentent tous deux sans perte. */
export const idNumber = z.number().int().positive().max(2_147_483_647);

const confidence = z.number().min(0).max(1).optional();

/**
 * Libellé ou mot-clé : une expression, pas un paragraphe. Les règles en font des motifs d'expression
 * régulière, et au-delà de quelques milliers de caractères le moteur refuse de les compiler.
 */
const term = z.string().trim().min(1).max(200, 'Deux cents caractères au maximum.');

const labelRule = z.object({
  kind: z.literal('label'),
  labels: z.array(term).min(1, 'Au moins un libellé est requis.').max(50, 'Cinquante libellés au maximum.'),
  maxLength: z.number().int().min(1).max(500).optional(),
  source: ruleSource.optional(),
  docKinds: z.array(docKind).optional(),
  confidence,
});

const regexRule = z.object({
  kind: z.literal('regex'),
  pattern: z
    .string()
    .min(1)
    .max(500)
    .refine((p) => {
      try {
        new RegExp(p, 'iu');
        return true;
      } catch {
        try {
          new RegExp(p, 'i');
          return true;
        } catch {
          return false;
        }
      }
    }, 'Expression régulière invalide.'),
  flags: z.string().regex(/^[gimsuy]*$/, 'Drapeaux invalides.').optional(),
  group: z.number().int().min(0).max(20).optional(),
  source: ruleSource.optional(),
  docKinds: z.array(docKind).optional(),
  confidence,
});

const fieldValue = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
  z.null(),
]);

const keywordRule = z.object({
  kind: z.literal('keyword'),
  any: z.array(term).min(1, 'Au moins un mot-clé est requis.').max(100, 'Cent mots-clés au maximum.'),
  none: z.array(term).max(100, 'Cent termes au maximum.').optional(),
  noneWindow: z.number().int().min(0).max(500).optional(),
  skip: z.array(term).max(100, 'Cent termes au maximum.').optional(),
  skipWindow: z.number().int().min(0).max(500).optional(),
  emit: fieldValue,
  emitIfNegated: fieldValue.optional(),
  source: ruleSource.optional(),
  docKinds: z.array(docKind).optional(),
  confidence,
});

const dicomRule = z.object({
  kind: z.literal('dicom'),
  tag: z.string().trim().min(1).max(60),
  confidence,
});

export const extractionRuleSchema = z.discriminatedUnion('kind', [
  labelRule,
  regexRule,
  keywordRule,
  dicomRule,
]);

export const fieldExtractionSchema = z.object({
  enabled: z.boolean(),
  rules: z.array(extractionRuleSchema).max(30, 'Trente règles au maximum par variable.'),
  postProcess: z
    .object({
      valueMap: z.record(z.string()).optional(),
      scale: z.number().finite().optional(),
      min: z.number().finite().optional(),
      max: z.number().finite().optional(),
    })
    .optional(),
});

/** La clé sert d'en-tête de colonne CSV : on impose un identifiant simple. */
const fieldKey = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    'La clé doit commencer par une lettre minuscule et ne contenir que des lettres, chiffres et « _ ».',
  );

export const fieldInputSchema = z.object({
  key: fieldKey,
  label: z.string().trim().min(1).max(200),
  type: z.enum(FIELD_TYPES as [string, ...string[]]),
  section: z.string().trim().min(1).max(80).optional(),
  unit: z.string().trim().max(40).nullable().optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  required: z.boolean().optional(),
  options: z.array(z.string().trim().min(1).max(120)).max(100).optional(),
  position: z.number().int().min(0).max(100_000).optional(),
  extraction: fieldExtractionSchema.optional(),
});

export const fieldUpdateSchema = fieldInputSchema.partial();

export const templateInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  isActive: z.boolean().optional(),
});

export const templateUpdateSchema = templateInputSchema.partial();

/** Duplication d'une fiche : le nom de la copie est facultatif (« <nom> (copie) » par défaut). */
export const templateDuplicateSchema = z.object({ name: z.string().trim().max(200).optional() });

/** Fiche complète telle que produite par `GET /api/export/template.json`. */
export const templateImportSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  fields: z.array(fieldInputSchema).max(500, 'Cinq cents variables au maximum.'),
});

export const patientInputSchema = z.object({
  code: z
    .string()
    .transform(normalizePatientCode)
    .pipe(z.string().min(1, 'Le code du dossier ne peut pas être vide.').max(80, 'Le code du dossier est limité à 80 caractères.')),
  label: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(4000).nullable().optional(),
});

export const patientUpdateSchema = patientInputSchema.partial();

/**
 * Renommage d'un document.
 *
 * Le nom est affiché tel quel et sert de titre d'onglet : on refuse donc toute
 * composante de chemin, qui n'aurait aucun sens ici et brouillerait la lecture.
 * Le fichier sur disque garde son nom généré, ce nom n'est qu'une étiquette.
 */
export const documentUpdateSchema = z.object({
  filename: z
    .string()
    .trim()
    .min(1, 'Le nom ne peut pas être vide.')
    .max(255)
    .refine((v) => !v.includes('/') && !v.includes('\\'), {
      message: 'Le nom ne peut pas contenir de séparateur de chemin.',
    }),
});

/**
 * Décisions humaines sur les valeurs d'une fiche.
 *
 * - `set` (défaut) : fixe la valeur ; `null` la vide. Une valeur vidée reste vide
 *   aux extractions suivantes, comme une valeur corrigée.
 * - `confirm` : valide telle quelle la valeur proposée par la machine.
 * - `release` : retire la décision humaine, l'extraction pourra de nouveau remplir la variable.
 *
 * Une valeur hors des bornes de plausibilité de la variable est refusée (422) tant que
 * l'appelant n'a pas indiqué `acceptOutOfBounds` : une faute de frappe se rattrape, une valeur
 * extraordinaire mais vraie se confirme.
 */
export const valueUpdateSchema = z.object({
  values: z
    .array(
      z.object({
        fieldId: idNumber,
        value: fieldValue.default(null),
        mode: z.enum(['set', 'confirm', 'release']).default('set'),
      }),
    )
    .min(1)
    .max(1000),
  acceptOutOfBounds: z.boolean().optional(),
});

export const extractionRunSchema = z.object({
  templateId: idNumber.optional(),
  /** Restreint la passe à certains dossiers ; sinon tous les patients. */
  patientIds: z.array(idNumber).max(100_000).optional(),
  /** Écrase aussi les valeurs corrigées manuellement. */
  overwriteManual: z.boolean().optional(),
  /** Moteur employé : règles seules, Claude seul, ou les règles puis Claude. */
  mode: z.enum(['rules', 'llm', 'hybrid']).optional(),
});

export const reorderSchema = z.object({
  fieldIds: z.array(idNumber).max(10_000),
});

export const testRuleSchema = z.object({
  field: fieldInputSchema,
  patientId: idNumber.optional(),
  /** Texte libre pour tester une règle sans dossier réel. */
  sampleText: z.string().max(200_000).optional(),
});

/* ───────────────────────── Import de tableaux de cohorte ───────────────── */

/** Feuille et ligne d'en-tête d'un tableau importé. */
export const tableStructureSchema = z.object({
  /** Nom de la feuille ; absent ou `null` pour un CSV (une seule feuille). */
  sheet: z.string().max(255).nullable().optional(),
  headerRow: z.number().int().min(1, 'La ligne d’en-tête commence à 1.').max(10_000_000),
  templateId: z.number().int().positive().optional(),
});

export const tableImportSchema = tableStructureSchema.extend({
  codeColumn: z.number().int().min(0).max(100_000),
  mapping: z
    .array(z.object({ column: z.number().int().min(0).max(100_000), fieldId: z.number().int().positive() }))
    .max(2000),
  options: z
    .object({
      createPatients: z.boolean().optional(),
      overwriteExtracted: z.boolean().optional(),
      overwriteManual: z.boolean().optional(),
    })
    .optional(),
  /** Empreinte du plan montré par la simulation : l'écriture refuse si ce qu'elle ferait a changé depuis. */
  expectedPlan: z.string().regex(/^[0-9a-f]{32}$/).optional(),
});
