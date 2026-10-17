import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError } from '../lib/http.js';
import { keyStore } from '../engine/api-key.js';
import {
  CATALOG,
  MEDICAL_MODEL_NOTE,
  MODEL_TASKS,
  OLLAMA_INSTALL,
  RECOMMENDATIONS,
  TASK_LABELS,
  type ModelTask,
} from '../engine/model-catalog.js';
import { checkModelTag, evaluationStore, SettingsError } from '../engine/model-settings.js';
import { allRoutes, explicitRoute, generateStructured, ModelCallError, ollama, routeFor, routerSettings, streamLocalChat, taskAvailable } from '../engine/model-router.js';
import { interpret } from '../engine/llm.js';
import { buildOutputSchema, buildSystemPrompt, buildUserPrompt, documentAlias, type LlmResponse } from '../engine/llm-schema.js';
import { OllamaError, type InstalledModel } from '../engine/ollama.js';
import type { TemplateField } from '../domain/types.js';
import type { SourceDoc } from '../engine/rules.js';

/**
 * Modèles d'IA : qui sert quelle tâche, et gestion des modèles locaux (Ollama).
 *
 * Réglage du poste, commun à tous les projets : monté avant la portée de projet, comme `/api/projects`.
 * L'outil n'installe jamais Ollama lui-même (c'est un logiciel système) ; il télécharge des modèles *par* Ollama, à la
 * demande de l'utilisateur, et ne livre aucun poids de modèle dans ses paquets.
 */
export const modelsRouter = Router();

const taskEnum = z.enum(MODEL_TASKS as [ModelTask, ...ModelTask[]]);

async function ollamaState(): Promise<{ reachable: boolean; version: string | null; installed: InstalledModel[]; error: string | null }> {
  try {
    const [version, installed] = await Promise.all([ollama().version(), ollama().installed()]);
    return { reachable: true, version, installed, error: null };
  } catch (error) {
    return { reachable: false, version: null, installed: [], error: error instanceof Error ? error.message : String(error) };
  }
}

modelsRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    const settings = routerSettings();
    const endpoint = settings.endpoint();
    const state = await ollamaState();
    const routes = allRoutes();
    const evaluations = evaluationStore.all();
    res.json({
      ollama: { ...state, url: endpoint.url, remote: endpoint.remote, warning: endpoint.warning, install: OLLAMA_INSTALL },
      anthropic: { available: keyStore.active() !== null, keyHint: keyStore.status().hint },
      pseudonymizeLocal: settings.get().pseudonymizeLocal,
      tasks: MODEL_TASKS.map((task) => {
        const route = routes[task];
        const setting = settings.task(task);
        return {
          task,
          label: TASK_LABELS[task],
          provider: route.provider,
          model: route.label,
          localModel: settings.localModel(task),
          localModelChosen: setting.model,
          available: taskAvailable(task, route),
          installed: route.provider === 'local' ? state.installed.some((m) => sameTag(m.name, route.model)) : null,
          recommendation: RECOMMENDATIONS[task],
          evaluation: evaluations[route.label] ?? null,
        };
      }),
      catalog: CATALOG,
      evaluations,
      medicalNote: MEDICAL_MODEL_NOTE,
    });
  }),
);

/** `qwen3.5:9b` et `qwen3.5:9b` installé, `llama3` et `llama3:latest` : même modèle. */
function sameTag(installed: string, wanted: string): boolean {
  const norm = (t: string) => (t.includes(':') ? t : `${t}:latest`);
  return norm(installed) === norm(wanted);
}

const settingsSchema = z
  .object({
    tasks: z
      .record(taskEnum, z.object({ provider: z.enum(['anthropic', 'local']).optional(), model: z.string().max(200).nullable().optional() }).strict())
      .optional(),
    pseudonymizeLocal: z.boolean().optional(),
    ollamaUrl: z.string().max(300).nullable().optional(),
  })
  .strict();

modelsRouter.put(
  '/settings',
  asyncHandler(async (req, res) => {
    const patch = settingsSchema.parse(req.body ?? {});
    try {
      routerSettings().update(patch);
    } catch (error) {
      if (error instanceof SettingsError) throw new HttpError(400, error.message);
      throw error;
    }
    for (const [task, change] of Object.entries(patch.tasks ?? {})) {
      console.log(`[pubresearcher] modèle pour « ${task} » : ${change?.provider ?? '—'} ${change?.model ?? ''}`.trim());
    }
    res.json({ settings: routerSettings().get(), routes: allRoutes() });
  }),
);

/**
 * Téléchargement d'un modèle par Ollama. La progression part au fil de l'eau en NDJSON (une ligne JSON par étape),
 * lisible par le navigateur sans bibliothèque ; la dernière ligne est `{ "status": "success" }` ou `{ "error": … }`.
 */
modelsRouter.post(
  '/pull',
  asyncHandler(async (req, res) => {
    const { model } = z.object({ model: z.string().max(200) }).strict().parse(req.body ?? {});
    let tag: string;
    try {
      tag = checkModelTag(model);
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    const abort = new AbortController();
    let closed = false;
    res.on('close', () => {
      closed = true;
      abort.abort();
    });
    const send = (data: unknown) => {
      if (!closed) res.write(`${JSON.stringify(data)}\n`);
    };
    try {
      await ollama().pull(tag, (event) => send(event), abort.signal);
      send({ status: 'success', model: tag });
      console.log(`[pubresearcher] modèle local téléchargé : ${tag}`);
    } catch (error) {
      send({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      res.end();
    }
  }),
);

modelsRouter.delete(
  '/:model',
  asyncHandler(async (req, res) => {
    let tag: string;
    try {
      tag = checkModelTag(String(req.params.model ?? ''));
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
    try {
      await ollama().remove(tag);
    } catch (error) {
      if (error instanceof OllamaError) throw new HttpError(error.problem === 'model-missing' ? 404 : 502, error.message);
      throw error;
    }
    res.json({ deleted: tag });
  }),
);

// ------------------------------------------------------------------ essai

/** Petit dossier fictif dont la bonne réponse est connue : de quoi vérifier JSON, citations et valeurs. */
export const TEST_FIELDS: TemplateField[] = [
  { key: 'age', label: 'Âge', type: 'integer', unit: 'ans', options: [] },
  { key: 'sexe', label: 'Sexe', type: 'enum', unit: null, options: ['Masculin', 'Féminin'] },
  { key: 'crp', label: 'CRP', type: 'number', unit: 'mg/L', options: [] },
  { key: 'diabete', label: 'Diabète', type: 'boolean', unit: null, options: [] },
].map((f, i) => ({
  id: i + 1,
  templateId: 0,
  section: 'Essai',
  description: null,
  required: false,
  position: i,
  extraction: { enabled: true, rules: [] },
  ...f,
})) as TemplateField[];

export const TEST_DOC: SourceDoc = {
  id: 1,
  name: 'essai.txt',
  kind: 'text',
  dicomTags: {},
  text:
    'COMPTE RENDU D’HOSPITALISATION\nIl s’agit d’une patiente de 67 ans, admise pour douleurs abdominales.\nAntécédents : pas de diabète, HTA traitée.\nBiologie : CRP à 148 mg/L, hémoglobine 11,2 g/dL.',
};

export const TEST_EXPECTED: Record<string, unknown> = { age: 67, sexe: 'Féminin', crp: 148, diabete: false };

modelsRouter.post(
  '/test',
  asyncHandler(async (req, res) => {
    const { task, model } = z.object({ task: taskEnum, model: z.string().max(200).optional() }).strict().parse(req.body ?? {});
    const route = model ? explicitRoute(task, model) : routeFor(task);
    const started = Date.now();
    try {
      if (task === 'writing') {
        let text = '';
        if (route.provider === 'local') {
          await streamLocalChat({
            route,
            system: 'Tu réponds en français, en une phrase.',
            messages: [{ role: 'user', content: 'Écris une phrase de résultats : 42 patients, âge moyen 61 ans.' }],
            maxTokens: 200,
            onChunk: (t) => (text += t),
          });
        } else {
          throw new ModelCallError('L’essai de la rédaction ne concerne que les modèles locaux (Claude se vérifie sur la page « Activer Claude »).', false);
        }
        const pass = /42/.test(text) && text.trim().length > 10;
        res.json({ task, model: route.label, pass, latencyMs: Date.now() - started, details: text.slice(0, 400), checks: [] });
        return;
      }
      // Les autres tâches produisent une sortie structurée : l'essai fait relever 4 valeurs d'un compte rendu fictif,
      // puis passe la réponse par les mêmes contrôles que l'extraction (citation retrouvée, non contredite, typée).
      const result = await generateStructured({
        task,
        route,
        system: buildSystemPrompt(TEST_FIELDS, 'Essai'),
        user: buildUserPrompt([{ name: documentAlias(0), text: TEST_DOC.text }], 10_000),
        schema: buildOutputSchema(TEST_FIELDS),
        maxTokens: 2_000,
      });
      const parsed = result.json as LlmResponse;
      if (!parsed || typeof parsed.fields !== 'object' || parsed.fields === null) throw new ModelCallError('JSON sans champ « fields ».', false, true);
      for (const f of Object.values(parsed.fields)) if (f && f.document === documentAlias(0)) f.document = TEST_DOC.name;
      const outcome = interpret(TEST_FIELDS, [TEST_DOC], parsed, result.usage, result.model);
      const checks = TEST_FIELDS.map((f) => {
        const got = outcome.values.find((v) => v.key === f.key);
        return { key: f.key, expected: TEST_EXPECTED[f.key], got: got?.value ?? null, ok: got?.value === TEST_EXPECTED[f.key] };
      });
      res.json({
        task,
        model: route.label,
        pass: checks.every((c) => c.ok),
        latencyMs: Date.now() - started,
        validJson: true,
        unverified: outcome.unverified.length,
        checks,
        details: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      res.json({
        task,
        model: route.label,
        pass: false,
        latencyMs: Date.now() - started,
        validJson: !(error instanceof ModelCallError && error.invalidJson),
        checks: [],
        details: message,
      });
    }
  }),
);
