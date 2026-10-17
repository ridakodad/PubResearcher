import path from 'node:path';
import { suggestExtraction } from '../engine/suggest-rules.js';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { db } from '../db/index.js';
import { FIELD_TYPES, type FieldExtraction, type FieldType } from '../domain/types.js';
import {
  CLAUDE_FORM_PROMPT,
  DEFAULT_SECTION,
  claudeDraftSchema,
  claudeOutputSchema,
  normalizeClaudeDraft,
  parseFormText,
  parseFormWorkbook,
  uniqueKeys,
  workbookToText,
  type DraftField,
  type ParsedForm,
} from '../engine/form-parser.js';
import { LlmError } from '../engine/llm.js';
import { generateStructured, ModelCallError, routeFor, shouldPseudonymize, taskAvailable } from '../engine/model-router.js';
import { pseudonymize } from '../engine/pseudonymize.js';
import { parseIsolated, readTableIsolated } from '../extract/isolation.js';
import { limits } from '../extract/limits.js';
import { asyncHandler, badRequest, unprocessable } from '../lib/http.js';
import { createLimiter } from '../lib/limiter.js';
import { keepProject } from '../lib/project-scope.js';
import { createField, createTemplate, getTemplate, setActiveTemplate } from '../repo/templates.js';
import { TableReadError, type TableWorkbook } from '../table/types.js';

/**
 * Import d'une fiche d'exploitation existante (Word, Excel, CSV) : le chercheur dépose le document qu'il utilisait
 * sur papier, l'outil en propose les variables, il les relit, puis la fiche est créée d'un coup.
 *
 * Deux appels :
 * 1. `POST /` lit le document (dans un fil isolé : le fichier vient de l'extérieur) et rend une proposition
 *    `{ name, fields, method, warnings }`, sans rien écrire ni conserver ;
 * 2. `POST /commit` crée la fiche et ses variables, dans une seule transaction, dans le projet de la requête.
 *
 * L'analyse se fait par règles (`engine/form-parser.ts`), ou par Claude si l'utilisateur le demande et qu'une clé est
 * disponible. Le document est une trame, pas un dossier de patient ; il passe tout de même par la pseudonymisation
 * avant l'envoi, au cas où un exemple rempli y traînerait. Toute défaillance de Claude ramène aux règles, avec un
 * avertissement.
 */
export const templateImportRouter = Router();

const readSlot = createLimiter(limits.parseConcurrency);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  defParamCharset: 'utf8',
} as multer.Options);

/** Plafond du texte transmis à Claude : une fiche tient en quelques pages. */
const MAX_CLAUDE_CHARS = 60_000;

type Kind = 'docx' | 'table';

function kindOf(filename: string): Kind | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xls' || ext === '.csv' || ext === '.tsv') return 'table';
  return null;
}

/** Nom proposé pour la fiche : celui du fichier, sans extension ni caractère invisible. */
function nameFromFile(filename: string): string {
  const base = path.basename(filename.replace(/\\/g, '/')).replace(/\.[^.]+$/, '');
  return base.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/[_]+/g, ' ').trim().slice(0, 200) || 'Fiche importée';
}

// ---------------------------------------------------------------- Claude

/** Appel du modèle : rend le texte JSON de sa réponse. Remplaçable dans les tests (aucun appel réseau). */
export type FormModelCaller = (system: string, user: string, schema: Record<string, unknown>) => Promise<string>;

let callerOverride: FormModelCaller | null = null;

/** Tests : substitue un faux modèle à l'API (et le considère disponible). `null` rétablit l'API. */
export function setFormModelCaller(caller: FormModelCaller | null): void {
  callerOverride = caller;
}

const claudeAvailable = (): boolean => callerOverride !== null || taskAvailable('form-import');

/** Appel par l'aiguillage : Claude ou modèle local, selon la page « Modèles d'IA ». */
const callRouted: FormModelCaller = async (system, user, schema) => {
  try {
    return (await generateStructured({ task: 'form-import', system, user, schema, maxTokens: 16_000 })).text;
  } catch (error) {
    if (error instanceof ModelCallError) throw new LlmError(error.message.slice(0, 300), error.retryable);
    throw error;
  }
};

async function parseWithClaude(text: string): Promise<ParsedForm> {
  const masked = callerOverride !== null || shouldPseudonymize(routeFor('form-import')) ? pseudonymize(text).text : text;
  const body = masked.length > MAX_CLAUDE_CHARS ? `${masked.slice(0, MAX_CLAUDE_CHARS)}\n[document tronqué]` : masked;
  const raw = await (callerOverride ?? callRouted)(CLAUDE_FORM_PROMPT, `<document>\n${body}\n</document>`, claudeOutputSchema);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmError('réponse illisible (JSON invalide)', true);
  }
  const parsed = claudeDraftSchema.safeParse(json);
  if (!parsed.success) throw new LlmError('réponse non conforme au format attendu', true);
  const result = normalizeClaudeDraft(parsed.data);
  if (result.fields.length === 0) throw new LlmError('aucune variable proposée', true);
  return result;
}

// ---------------------------------------------------------------- analyse

templateImportRouter.post(
  '/',
  keepProject(upload.single('file')),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('Aucun fichier reçu : choisissez un document Word (.docx) ou un classeur (.xlsx, .csv).');
    const kind = kindOf(file.originalname);
    if (!kind) {
      throw badRequest(
        /\.doc$/i.test(file.originalname)
          ? 'Ancien format Word (.doc) : enregistrez-le en .docx depuis Word ou LibreOffice, puis réimportez-le.'
          : 'Format non pris en charge : la fiche doit être un document Word (.docx) ou un classeur (.xlsx, .csv).',
      );
    }
    if (file.size === 0) throw badRequest(`Fichier vide (0 octet) : ${file.originalname}.`);

    let text = '';
    let workbook: TableWorkbook | null = null;
    if (kind === 'docx') {
      const parsed = await readSlot(() => parseIsolated(file.buffer, file.originalname, file.mimetype || 'application/octet-stream'));
      if (parsed.status === 'error') throw unprocessable(parsed.error ?? 'Document illisible.', undefined, 'document_unreadable');
      text = parsed.text;
      if (!text.trim()) throw unprocessable('Aucun texte lisible dans ce document : la fiche est peut-être une image. Saisissez les variables à la main.');
    } else {
      workbook = await readSlot(() => readTableIsolated(file.buffer, file.originalname)).catch((error: unknown) => {
        if (error instanceof TableReadError) throw unprocessable(error.message, undefined, 'table_unreadable');
        throw error;
      });
    }

    const rules = (): ParsedForm => (workbook ? parseFormWorkbook(workbook) : parseFormText(text));
    const warnings: string[] = [];
    let result: ParsedForm;
    let method: 'claude' | 'rules' = 'rules';
    const wantsClaude = req.body?.useClaude === '1' || req.body?.useClaude === 'true';
    if (wantsClaude && !claudeAvailable()) {
      warnings.push('Claude n’est pas activé (aucune clé d’API) et aucun modèle local n’est choisi pour l’import de fiche : analyse par règles.');
      result = rules();
    } else if (wantsClaude) {
      try {
        result = await parseWithClaude(workbook ? workbookToText(workbook) : text);
        method = 'claude';
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        warnings.push(`${routeFor('form-import').provider === 'local' ? 'Le modèle local' : 'Claude'} n’a pas pu analyser le document (${reason}) : analyse par règles à la place.`);
        result = rules();
      }
    } else {
      result = rules();
    }
    if (result.fields.length === 0) {
      warnings.push('Aucune variable reconnue : vérifiez que le document suit une mise en page de fiche (« Libellé : ____ », cases à cocher, tableau de variables).');
    }

    res.json({ name: nameFromFile(file.originalname), fields: result.fields, method, warnings: [...warnings, ...result.warnings] });
  }),
);

// ---------------------------------------------------------------- création

const draftFieldSchema = z.object({
  label: z.string().trim().min(1).max(200),
  key: z.string().trim().max(80).optional().nullable(),
  type: z.enum(FIELD_TYPES as [FieldType, ...FieldType[]]),
  section: z.string().trim().max(80).optional().nullable(),
  unit: z.string().trim().max(40).optional().nullable(),
  options: z.array(z.string().trim().max(120)).max(100).optional(),
  required: z.boolean().optional(),
  description: z.string().trim().max(1000).optional().nullable(),
});

const commitSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).nullable().optional(),
  fields: z.array(draftFieldSchema).min(1).max(500),
  activate: z.boolean().optional(),
});

// Règles d'extraction proposées pour chaque variable, à partir de son libellé (lexique médical, voir engine/suggest-rules.ts).

templateImportRouter.post(
  '/commit',
  asyncHandler(async (req, res) => {
    const input = commitSchema.parse(req.body);
    const keys = uniqueKeys(input.fields.map((f) => ({ key: f.key ?? null, label: f.label })));
    const drafts: DraftField[] = input.fields.map((f, i) => {
      const options = f.type === 'enum' || f.type === 'multi' ? [...new Set((f.options ?? []).filter(Boolean))] : [];
      return {
        label: f.label,
        key: keys[i]!,
        type: f.type,
        section: f.section?.trim() || DEFAULT_SECTION,
        unit: f.unit?.trim() || null,
        options,
        required: f.required ?? false,
        description: f.description?.trim() || null,
      };
    });
    const extractions = drafts.map((d) => {
      try {
        return suggestExtraction({ label: d.label, type: d.type, options: d.options, unit: d.unit, key: d.key });
      } catch {
        // Un libellé que le lexique ne sait pas traiter : la variable part sans règle, à compléter dans l’éditeur.
        return { enabled: true, rules: [] };
      }
    });

    const create = db.transaction((): number => {
      const template = createTemplate({ name: input.name, description: input.description ?? null });
      drafts.forEach((d, position) => {
        createField(template.id, { ...d, position, extraction: extractions[position] });
      });
      if (input.activate) setActiveTemplate(template.id);
      return template.id;
    });
    const id = create();
    res.status(201).json({ template: getTemplate(id) });
  }),
);
