import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { maxUploadBytes } from '../config.js';
import { keepProject, projectOf } from '../lib/project-scope.js';
import { db } from '../db/index.js';
import type { TemplateWithFields } from '../domain/types.js';
import { readTableIsolated } from '../extract/isolation.js';
import { limits } from '../extract/limits.js';
import { HttpError, asyncHandler, badRequest, conflict, intParam, intQuery, notFound, unprocessable } from '../lib/http.js';
import { createLimiter } from '../lib/limiter.js';
import { tableImportSchema, tableStructureSchema } from '../lib/schemas.js';
import { ensurePatient } from '../repo/patients.js';
import { ensureRecord, writeImportedValues, type ImportedValue } from '../repo/records.js';
import {
  DEFAULT_IMPORT_OPTIONS,
  completeImport,
  createImportDraft,
  deleteImportDraft,
  findImportsBySha,
  getImport,
  getImportFile,
  importFilePath,
  listImports,
  type ImportOptions,
  type TableImport,
} from '../repo/imports.js';
import { templateFingerprint } from '../repo/runs.js';
import { getActiveTemplate, getTemplate } from '../repo/templates.js';
import { cellText, describeColumns, suggestHeaderRow, suggestMapping } from '../table/mapping.js';
import { ImportInputError, planImport, type PlanInput } from '../table/plan.js';
import { tableFormat, tableFormatProblem } from '../table/read.js';
import { TableReadError, type TableWorkbook } from '../table/types.js';

/**
 * Import d'un tableau de cohorte (classeur Excel, CSV) : une ligne par patient, une colonne par variable.
 *
 * Le parcours, en quatre appels :
 * 1. `POST /` reçoit le fichier, le conserve (avec son empreinte), le lit dans un fil isolé et décrit ses feuilles ;
 * 2. `POST /:id/columns` décrit les colonnes d'une feuille sous une ligne d'en-tête, et propose la colonne des codes
 *    et les correspondances colonne -> variable ;
 * 3. `POST /:id/dry-run` simule l'import cellule par cellule, sans rien écrire ;
 * 4. `POST /:id/commit` écrit exactement ce que la simulation a montré, ou refuse si l'état a changé entre-temps.
 *
 * Tant qu'il n'est pas confirmé, l'import est un brouillon (`DELETE /:id` l'abandonne ; les brouillons oubliés sont
 * effacés au démarrage suivant). Un import confirmé ne se supprime pas : il justifie les valeurs qu'il a posées.
 */
export const importsRouter = Router();

/** Lectures de tableaux menées de front, en plus des analyses de documents. */
const readSlot = createLimiter(limits.parseConcurrency);

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => cb(null, projectOf(req).incomingDir),
    filename: (_req, _file, cb) => cb(null, crypto.randomUUID()),
  }),
  limits: { fileSize: maxUploadBytes, files: 1 },
  defParamCharset: 'utf8',
} as multer.Options);

/** Nom d'affichage du fichier reçu, sans chemin ni caractère invisible (voir `routes/documents.ts`). */
function displayName(filename: string): string {
  const cleaned = filename.replace(/\\/g, '/').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '');
  return path.basename(cleaned).trim().slice(0, 255) || 'tableau';
}

/** Les derniers classeurs lus, gardés en mémoire le temps du parcours : chaque étape n'a pas à relire le fichier. */
const cache = new Map<number, { sha256: string; workbook: TableWorkbook }>();
const CACHE_SIZE = 4;

function remember(id: number, sha256: string, workbook: TableWorkbook): void {
  cache.delete(id);
  cache.set(id, { sha256, workbook });
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
}

async function loadWorkbook(item: TableImport): Promise<TableWorkbook> {
  const hit = cache.get(item.id);
  if (hit && hit.sha256 === item.sha256) return hit.workbook;
  const file = getImportFile(item.id);
  const buffer = file ? await fs.readFile(file.path).catch(() => null) : null;
  if (!file || !buffer) throw notFound('Fichier du tableau absent du disque : réimportez-le.');
  const workbook = await readSlot(() => readTableIsolated(buffer, file.filename)).catch((error: unknown) => {
    if (error instanceof TableReadError) throw unprocessable(error.message, undefined, 'table_unreadable');
    throw error;
  });
  remember(item.id, item.sha256, workbook);
  return workbook;
}

function resolveTemplate(id: number | undefined): TemplateWithFields {
  const template = id ? getTemplate(id) : getActiveTemplate();
  if (!template) throw notFound("Aucune fiche d'exploitation disponible : créez-en une avant d'importer un tableau.");
  return template;
}

function draftOr404(id: number): TableImport {
  const item = getImport(id);
  if (!item) throw notFound('Import introuvable (abandonné, ou effacé au redémarrage) : réimportez le fichier.');
  return item;
}

/** Aperçu d'une feuille : les premières lignes, en texte, pour choisir la ligne d'en-tête. */
const PREVIEW_ROWS = 30;
const PREVIEW_COLUMNS = 40;

function describeWorkbook(workbook: TableWorkbook) {
  return {
    format: workbook.format,
    delimiter: workbook.delimiter ?? null,
    charset: workbook.charset ?? null,
    date1904: workbook.date1904 ?? false,
    warnings: workbook.warnings,
    sheets: workbook.sheets.map((sheet) => ({
      name: sheet.name,
      hidden: sheet.hidden,
      rows: sheet.rows.length,
      columns: sheet.columns,
      merges: sheet.merges.length,
      formulas: sheet.formulas,
      formulasWithoutValue: sheet.formulasWithoutValue,
      error: sheet.error,
      suggestedHeaderRow: sheet.error ? 1 : suggestHeaderRow(sheet),
      preview: sheet.rows
        .slice(0, PREVIEW_ROWS)
        .map((row) => row.slice(0, PREVIEW_COLUMNS).map((cell) => (cell?.k === 'formula-no-value' ? '⚠ formule' : cellText(cell).slice(0, 60)))),
    })),
  };
}

/** Réception du fichier : conservé dans `uploads/imports/`, lu dans un fil isolé, décrit feuille par feuille. */
importsRouter.post(
  '/',
  keepProject((req: Request, res: Response, next: NextFunction) => upload.single('file')(req, res, next)),
  asyncHandler(async (req, res) => {
    const file = req.file;
    if (!file) throw badRequest('Aucun fichier reçu (champ « file »).');
    let kept: string | null = null;
    try {
      const name = displayName(file.originalname);
      const buffer = await fs.readFile(file.path);
      if (buffer.length === 0) throw unprocessable(`Fichier vide (0 octet) : ${name}.`, undefined, 'table_unreadable');
      const format = tableFormat(buffer, name);
      if (!format) throw unprocessable(tableFormatProblem(buffer, name), undefined, 'table_unreadable');

      const workbook = await readSlot(() => readTableIsolated(buffer, name)).catch((error: unknown) => {
        if (error instanceof TableReadError) throw unprocessable(error.message, undefined, 'table_unreadable');
        throw error;
      });
      if (workbook.sheets.every((s) => s.error || s.rows.length === 0)) {
        const reason = workbook.sheets.find((s) => s.error)?.error;
        throw unprocessable(reason ? `Aucune feuille lisible : ${reason}` : 'Le tableau est vide : aucune ligne à importer.', undefined, 'table_unreadable');
      }

      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      await fs.mkdir(projectOf(req).importsDir, { recursive: true });
      const storedName = `${crypto.randomUUID()}.${format === 'xlsx' ? 'xlsx' : format}`;
      kept = importFilePath(storedName);
      await fs.rename(file.path, kept);
      const draft = createImportDraft({ filename: name, storedName, format, size: buffer.length, sha256 });
      kept = null;
      remember(draft.id, sha256, workbook);

      res.status(201).json({
        import: draft,
        workbook: describeWorkbook(workbook),
        previousImports: findImportsBySha(sha256).map((i) => ({ id: i.id, filename: i.filename, committedAt: i.committedAt, written: i.written })),
      });
    } finally {
      // Données de patients : rien ne reste dans le dépôt provisoire, ni à moitié rangé.
      await fs.rm(file.path, { force: true });
      if (kept) await fs.rm(kept, { force: true });
    }
  }),
);

/** Imports confirmés (les plus récents d'abord), éventuellement d'une seule fiche. */
importsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ imports: listImports(intQuery(req, 'templateId') ?? undefined) });
  }),
);

importsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    res.json({ import: draftOr404(intParam(req, 'id')) });
  }),
);

/** Fichier d'origine d'un import : la pièce qui justifie les valeurs importées. Toujours en téléchargement. */
importsRouter.get(
  '/:id/file',
  asyncHandler(async (req, res) => {
    const file = getImportFile(intParam(req, 'id'));
    if (!file) throw notFound('Import introuvable.');
    const types: Record<string, string> = {
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv: 'text/csv; charset=utf-8',
      tsv: 'text/tab-separated-values; charset=utf-8',
    };
    res.type(types[file.format] ?? 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`);
    res.sendFile(file.path, (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'Fichier absent du disque.' });
    });
  }),
);

/** Colonnes d'une feuille sous la ligne d'en-tête choisie, et propositions de correspondance avec la fiche. */
importsRouter.post(
  '/:id/columns',
  asyncHandler(async (req, res) => {
    const item = draftOr404(intParam(req, 'id'));
    const input = tableStructureSchema.parse(req.body ?? {});
    const template = resolveTemplate(input.templateId);
    const workbook = await loadWorkbook(item);
    const sheet = input.sheet ? workbook.sheets.find((s) => s.name === input.sheet) : workbook.sheets[0];
    if (!sheet) throw badRequest(`Feuille « ${input.sheet ?? ''} » introuvable dans ce fichier.`);
    if (sheet.error) throw unprocessable(`Feuille « ${sheet.name} » illisible : ${sheet.error}`, undefined, 'table_unreadable');
    if (input.headerRow > sheet.rows.length) throw badRequest(`Ligne d’en-tête ${input.headerRow} hors du tableau (${sheet.rows.length} ligne(s)).`);

    const columns = describeColumns(sheet, input.headerRow);
    res.json({
      template: { id: template.id, name: template.name },
      sheet: sheet.name,
      headerRow: input.headerRow,
      dataRows: sheet.rows.length - input.headerRow,
      columns,
      suggestion: suggestMapping(columns, template.fields),
    });
  }),
);

function planInput(item: TableImport, workbook: TableWorkbook, body: unknown): PlanInput & { options: ImportOptions } {
  const input = tableImportSchema.parse(body ?? {});
  const template = resolveTemplate(input.templateId);
  return {
    workbook,
    sheet: input.sheet ?? null,
    headerRow: input.headerRow,
    codeColumn: input.codeColumn,
    mapping: input.mapping,
    options: { ...DEFAULT_IMPORT_OPTIONS, ...input.options },
    template,
    file: { importId: item.id, fileName: item.filename, sha256: item.sha256 },
  };
}

function plan(input: PlanInput) {
  try {
    return planImport(input);
  } catch (error) {
    if (error instanceof ImportInputError) throw badRequest(error.message);
    throw error;
  }
}

/** Simulation : ce que l'import écrirait, refuserait ou laisserait en place. Rien n'est écrit. */
importsRouter.post(
  '/:id/dry-run',
  asyncHandler(async (req, res) => {
    const item = draftOr404(intParam(req, 'id'));
    if (item.status !== 'draft') throw conflict('Cet import a déjà été confirmé : réimportez le fichier pour recommencer.');
    const workbook = await loadWorkbook(item);
    res.json({ report: plan(planInput(item, workbook, req.body)).report });
  }),
);

/** Écriture : la simulation est refaite dans la transaction, et doit donner le plan que l'écran a montré. */
importsRouter.post(
  '/:id/commit',
  asyncHandler(async (req, res) => {
    const id = intParam(req, 'id');
    const item = draftOr404(id);
    if (item.status !== 'draft') throw conflict('Cet import a déjà été confirmé : ses valeurs sont en place.');
    const workbook = await loadWorkbook(item);
    const input = planInput(item, workbook, req.body);
    const expected = tableImportSchema.parse(req.body ?? {}).expectedPlan;

    const report = db.transaction(() => {
      // Relu dans la transaction : deux confirmations simultanées n'écrivent pas deux fois.
      if (getImport(id)?.status !== 'draft') throw conflict('Cet import a déjà été confirmé : ses valeurs sont en place.');
      const { report, writes, create } = plan(input);
      if (expected && report.planHash !== expected) {
        throw new HttpError(
          409,
          'Les données ont changé depuis la simulation (extraction, relecture ou autre import) : relancez la simulation avant de confirmer.',
          undefined,
          'plan_changed',
        );
      }
      const patientIds = new Map<string, number>();
      for (const code of create) patientIds.set(code, ensurePatient(code).id);
      const recordIds = new Map<number, number>();
      const values: ImportedValue[] = writes.map((w) => {
        const patientId = w.patientId ?? patientIds.get(w.code)!;
        let recordId = recordIds.get(patientId);
        if (recordId === undefined) {
          recordId = ensureRecord(input.template.id, patientId).id;
          recordIds.set(patientId, recordId);
        }
        return { recordId, fieldId: w.fieldId, value: w.value, evidence: w.evidence };
      });
      writeImportedValues(values, id);
      completeImport(id, {
        template: { id: input.template.id, name: input.template.name, fingerprint: templateFingerprint(input.template) },
        sheet: report.sheet,
        headerRow: input.headerRow,
        codeColumn: input.codeColumn,
        mapping: input.mapping,
        options: input.options,
        dataRows: report.dataRows,
        patientsCreated: report.patients.created,
        patientsExisting: report.patients.existing,
        written: report.values.write,
        unchanged: report.values.unchanged,
        rejected: report.values.rejected,
        conflicts: report.values.conflicts,
      });
      return report;
    })();

    cache.delete(id);
    res.json({ import: getImport(id), report });
  }),
);

/** Abandon d'un brouillon : la ligne et le fichier sont effacés. */
importsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = intParam(req, 'id');
    const item = draftOr404(id);
    if (item.status !== 'draft') throw conflict('Un import confirmé ne se supprime pas : il justifie les valeurs qu’il a posées.');
    deleteImportDraft(id);
    cache.delete(id);
    res.status(204).end();
  }),
);
