/**
 * Mesure la précision d'un modèle (Claude ou modèle local servi par Ollama) sur l'extraction, avec le corpus de
 * démonstration : 24 patients fictifs dont chaque valeur est connue (`demo-corpus.ts`).
 *
 *   npm run eval:models --workspace server -- qwen3.5:9b
 *   npm run eval:models --workspace server -- ollama:qwen3.5:4b --limit 6
 *   npm run eval:models --workspace server -- claude          # clé Anthropic requise (payant)
 *
 * Le modèle passe par le chemin réel de l'outil (`extractWithLlm`) : même consigne, même schéma, puis les mêmes
 * garde-fous — citation retrouvée dans le document, citation qui ne contredit pas la valeur, typage par la fiche.
 * Ce qui est compté est donc ce qui entrerait réellement dans le jeu de données.
 *
 *  - précision : valeurs retenues exactes / valeurs retenues (une valeur fausse retenue est le pire défaut) ;
 *  - rappel : valeurs retenues exactes / valeurs attendues ;
 *  - JSON invalide : part des dossiers dont la réponse n'était pas exploitable ;
 *  - citations non vérifiées : part des valeurs proposées puis écartées par la vérification ;
 *  - latence moyenne par dossier.
 *
 * Le résultat est enregistré dans le dossier de données (`model-evaluations.json`) et affiché sur la page
 * « Modèles d'IA ». Ce n'est pas une validation clinique : le corpus est synthétique et régulier ; sur de vrais
 * comptes rendus, mesurez sur un échantillon relu (voir docs/validation.md).
 */
import { DEFAULT_FIELDS } from '../src/db/seed.js';
import { coerce } from '../src/engine/coerce.js';
import { extractWithLlm, LlmError } from '../src/engine/llm.js';
import { explicitRoute } from '../src/engine/model-router.js';
import { evaluationStore, type ModelEvaluation } from '../src/engine/model-settings.js';
import type { FieldValue, TemplateField } from '../src/domain/types.js';
import type { SourceDoc } from '../src/engine/rules.js';
import { DEMO_COUNT, DEMO_SEED, compteRendu, makeRandom, patientFactory, type DemoPatient } from './demo-corpus.js';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const modelArg = args.find((a, i) => !a.startsWith('--') && !['--limit'].includes(args[i - 1] ?? ''));
if (!modelArg) {
  console.error('Usage : npm run eval:models --workspace server -- <modèle> [--limit N] [--no-save]\n  ex. qwen3.5:9b, ollama:qwen3.5:4b, claude');
  process.exit(2);
}
const limit = Math.max(1, Math.min(DEMO_COUNT, Number(flag('--limit') ?? DEMO_COUNT) || DEMO_COUNT));
const save = !args.includes('--no-save');

/** Les variables dont le corpus connaît la valeur. */
const SCORED = [
  'numero_dossier', 'age', 'sexe', 'date_admission', 'diabete', 'hta', 'tabagisme', 'temperature', 'hemoglobine',
  'globules_blancs', 'crp', 'creatinine', 'traitement', 'duree_hospitalisation', 'complications', 'evolution',
] as const;

const fields: TemplateField[] = SCORED.map((key, i) => {
  const f = DEFAULT_FIELDS.find((x) => x.key === key)!;
  return {
    ...f,
    id: i + 1,
    templateId: 0,
    position: i,
    unit: f.unit ?? null,
    description: f.description ?? null,
    required: false,
    options: f.options ?? [],
    section: f.section ?? 'Évaluation',
  } as TemplateField;
});

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function truth(p: DemoPatient): Record<string, string> {
  return {
    numero_dossier: p.code,
    age: String(p.age),
    sexe: p.sexe,
    date_admission: p.admission,
    diabete: p.diabete ? 'oui' : 'non',
    hta: p.hta ? 'oui' : 'non',
    tabagisme: p.tabac ? 'oui' : 'non',
    temperature: String(p.temperature),
    hemoglobine: String(p.hemoglobine),
    globules_blancs: String(p.gb),
    crp: String(p.crp),
    creatinine: String(p.creatinine),
    traitement: cap(p.traitement === 'médical' ? 'Médical' : p.traitement === 'chimiothérapie' ? 'Chimiothérapie' : p.traitement),
    duree_hospitalisation: String(p.duree),
    complications: p.complications ? 'oui' : 'non',
    evolution: cap(p.evolution === 'défavorable' ? 'Défavorable' : p.evolution === 'décès' ? 'Décès' : p.evolution),
  };
}

/** La vérité passe par le même typage que la réponse du modèle : on compare des valeurs, pas des écritures. */
function expected(field: TemplateField, raw: string): FieldValue {
  const typed = coerce(raw, field.type, field.options, undefined, field.unit);
  if (!typed.ok) throw new Error(`Vérité non typable pour ${field.key} : ${raw} (${typed.reason})`);
  return typed.value;
}

function same(a: FieldValue, b: FieldValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x) => b.includes(x));
  return a === b;
}

/** Le texte des trois documents, tel que l'outil le lit (le bilan est un tableau Word : une cellule par ligne). */
function documents(p: DemoPatient, between: (a: number, b: number) => number): SourceDoc[] {
  return [
    { id: 1, name: 'compte-rendu.pdf', kind: 'pdf', dicomTags: {}, text: compteRendu(p).join('\n') },
    {
      id: 2,
      name: 'observation.docx',
      kind: 'docx',
      dicomTags: {},
      text: [
        `Observation médicale — ${p.code}`,
        `Motif de consultation : ${p.motif}`,
        `Délai de consultation : ${between(1, 21)} jours`,
        p.complications ? 'Suites marquées par une complication infectieuse.' : 'Suites simples, sans complication.',
      ].join('\n'),
    },
    {
      id: 3,
      name: 'bilan-biologique.docx',
      kind: 'docx',
      dicomTags: {},
      text: [
        ['Globules blancs', String(p.gb).replace('.', ',')],
        ['Créatinine', String(p.creatinine).replace('.', ',')],
        ['Hémoglobine', String(p.hemoglobine).replace('.', ',')],
      ]
        .map((row) => row.join(' | '))
        .join('\n'),
    },
  ];
}

async function main(): Promise<void> {
  const route = explicitRoute('extraction', modelArg!);
  const random = makeRandom(DEMO_SEED);
  const between = (min: number, max: number) => Math.floor(min + random() * (max - min + 1));
  const make = patientFactory(random);
  const patients = Array.from({ length: DEMO_COUNT }, (_, i) => make(i)).slice(0, limit);

  console.log(`Évaluation de ${route.label} sur ${patients.length} dossier(s) fictif(s), ${fields.length} variables chacun.\n`);
  let correct = 0;
  let extracted = 0;
  let expectedCount = 0;
  let invalidJson = 0;
  let errors = 0;
  let unverified = 0;
  let proposed = 0;
  const latencies: number[] = [];
  const mistakes: string[] = [];

  for (const p of patients) {
    const docs = documents(p, between);
    const want = truth(p);
    expectedCount += fields.length;
    const started = Date.now();
    try {
      const result = await extractWithLlm(fields, docs, 'Évaluation (corpus de démonstration)', fields, { route });
      const ms = Date.now() - started;
      latencies.push(ms);
      unverified += result.unverified.length;
      proposed += result.values.length + result.unverified.length + result.invalid.length;
      let ok = 0;
      for (const value of result.values) {
        const field = fields.find((f) => f.id === value.fieldId)!;
        extracted++;
        const exp = expected(field, want[field.key]!);
        if (same(value.value, exp)) {
          correct++;
          ok++;
        } else {
          mistakes.push(`${p.code} ${field.key} : attendu ${JSON.stringify(exp)}, obtenu ${JSON.stringify(value.value)}`);
        }
      }
      console.log(`${p.code}  ${ok}/${fields.length} exactes, ${result.values.length} retenues, ${result.unverified.length} citation(s) écartée(s), ${result.invalid.length} invalide(s) — ${(ms / 1000).toFixed(1)} s`);
    } catch (error) {
      latencies.push(Date.now() - started);
      const message = error instanceof Error ? error.message : String(error);
      if (/JSON|tronquée|fields/i.test(message)) invalidJson++;
      else errors++;
      console.log(`${p.code}  échec : ${message}`);
      if (error instanceof LlmError && !error.retryable && /n’est pas téléchargé|ne répond pas|aucune clé|n'est pas activé/i.test(message)) break;
    }
  }

  const rate = (a: number, b: number) => (b === 0 ? null : Math.round((a / b) * 1000) / 1000);
  const evaluation: ModelEvaluation = {
    model: route.label,
    provider: route.provider,
    measuredAt: new Date().toISOString(),
    corpus: `démonstration (${patients.length}/${DEMO_COUNT} patients fictifs, ${fields.length} variables)`,
    patients: patients.length,
    precision: rate(correct, extracted),
    recall: rate(correct, expectedCount),
    correct,
    extracted,
    expected: expectedCount,
    invalidJsonRate: rate(invalidJson, patients.length) ?? 0,
    unverifiedRate: rate(unverified, proposed) ?? 0,
    errors,
    meanLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
  };

  const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)} %`);
  console.log(`\nPrécision ${pct(evaluation.precision)} (${correct}/${extracted}) · rappel ${pct(evaluation.recall)} (${correct}/${expectedCount})`);
  console.log(`JSON invalide ${pct(evaluation.invalidJsonRate)} · citations écartées ${pct(evaluation.unverifiedRate)} · échecs ${errors} · ${(evaluation.meanLatencyMs / 1000).toFixed(1)} s par dossier`);
  if (mistakes.length) console.log(`\nValeurs retenues fausses :\n  ${mistakes.slice(0, 30).join('\n  ')}`);
  if (save && latencies.length > 0 && errors < patients.length) {
    evaluationStore.save(evaluation);
    console.log('\nRésultat enregistré : il s’affiche sur la page « Modèles d’IA ».');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
