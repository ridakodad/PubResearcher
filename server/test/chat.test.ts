/**
 * Tests de l'assistant de rédaction.
 *
 * L'appel réseau n'est pas exercé. Ce qui l'est, c'est le relevé transmis au
 * modèle et la consigne qui l'encadre — car c'est là que se joue la justesse
 * d'un article : un chiffre absent du relevé ne peut pas être rapporté, et une
 * ligne patient qui s'y glisserait sortirait de la machine sans nécessité.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCohortBrief, buildSystemPrompt } from '../src/engine/chat.js';
import type { TemplateField, TemplateWithFields } from '../src/domain/types.js';
import type { FieldStats } from '../src/routes/analytics.js';

function field(overrides: Partial<TemplateField> & { key: string }): TemplateField {
  return {
    id: 1,
    templateId: 1,
    label: overrides.key,
    type: 'text',
    section: 'Identité',
    unit: null,
    description: null,
    required: false,
    options: [],
    position: 0,
    extraction: { enabled: true, rules: [] },
    ...overrides,
  };
}

const template: TemplateWithFields = {
  id: 1,
  name: 'Cohorte pilote',
  description: 'Étude rétrospective monocentrique',
  isActive: true,
  createdAt: '',
  updatedAt: '',
  fields: [
    field({ key: 'age', label: 'Âge', type: 'integer', unit: 'ans' }),
    field({
      key: 'sexe',
      label: 'Sexe',
      type: 'enum',
      options: ['Masculin', 'Féminin', 'Non précisé'],
      id: 2,
    }),
    field({
      key: 'stade',
      label: 'Stade',
      type: 'enum',
      options: ['I', 'II'],
      id: 3,
      description: 'Classification au diagnostic',
    }),
  ],
};

const stats: FieldStats[] = [
  {
    key: 'age',
    label: 'Âge',
    type: 'integer',
    unit: 'ans',
    section: 'Identité',
    n: 24,
    missing: 0,
    chart: 'histogram',
    summary: { n: 24, mean: 48.54, sd: 16.19, median: 48, q1: 39.25, q3: 60.75, min: 22, max: 79 },
    bins: [],
  },
  {
    key: 'sexe',
    label: 'Sexe',
    type: 'enum',
    unit: null,
    section: 'Identité',
    n: 24,
    missing: 0,
    chart: 'categories',
    categories: [
      { label: 'Masculin', count: 16 },
      { label: 'Féminin', count: 8 },
    ],
  },
  {
    key: 'stade',
    label: 'Stade',
    type: 'enum',
    unit: null,
    section: 'Identité',
    n: 20,
    missing: 4,
    chart: 'categories',
    categories: [{ label: 'I', count: 20 }],
  },
];

const context = { template, patientCount: 24, completeness: 95, stats };

describe('relevé de cohorte transmis au modèle', () => {
  test('porte les effectifs et les indicateurs de position', () => {
    const brief = buildCohortBrief(context);
    assert.match(brief, /Effectif : 24 dossiers/);
    assert.match(brief, /moyenne 48\.54 ± 16\.19/);
    assert.match(brief, /médiane 48 \[39\.25 – 60\.75\]/);
    assert.match(brief, /extrêmes 22 – 79/);
  });

  test('les effectifs par modalité sont accompagnés de leur pourcentage', () => {
    // Un article rapporte « n (%) » : le pourcentage doit venir du relevé,
    // pas d'un calcul que le modèle ferait de tête.
    const brief = buildCohortBrief(context);
    assert.match(brief, /Masculin 16 \(67 %\)/);
    assert.match(brief, /Féminin 8 \(33 %\)/);
  });

  test('les données manquantes sont annoncées', () => {
    // Sans cette mention, un effectif de 20 sur une cohorte de 24 passerait
    // pour l'effectif total et fausserait tous les pourcentages du texte.
    const brief = buildCohortBrief(context);
    assert.match(brief, /Stade.*n = 20, 4 manquantes/);
  });

  test('une modalité prévue mais jamais observée est signalée', () => {
    // Son absence du tableau pourrait passer pour un oubli de recueil.
    const brief = buildCohortBrief(context);
    assert.match(brief, /modalités déclarées jamais observées : II/);
    assert.match(brief, /modalités déclarées jamais observées : Non précisé/);
  });

  test('les définitions de variables accompagnent les chiffres', () => {
    const brief = buildCohortBrief(context);
    assert.match(brief, /Stade : Classification au diagnostic/);
  });

  test('les valeurs d’une variable en texte libre (numéros de dossier, antécédents) ne partent pas : seuls les effectifs', () => {
    // Le serveur calcule les valeurs les plus fréquentes d'une variable texte pour l'écran des distributions ; elles
    // sont celles des dossiers. Le relevé envoyé au modèle ne doit en retenir aucune.
    const texte: FieldStats = {
      key: 'antecedents_libre',
      label: 'Antécédents (texte libre)',
      type: 'text',
      unit: null,
      section: 'Clinique',
      n: 22,
      missing: 2,
      chart: 'none',
      topValues: [
        { label: 'Diabète de type 2 depuis 2011, mère décédée d’un cancer du sein', count: 3 },
        { label: 'DOSSIER-2024-0417', count: 1 },
      ],
    };
    const brief = buildCohortBrief({ ...context, stats: [...stats, texte] });
    assert.match(brief, /Antécédents \(texte libre\) \[Clinique\] — n = 22, 2 manquantes ; texte libre, valeurs non transmises/);
    assert.ok(!/Diabète|cancer du sein|DOSSIER-2024/.test(brief), 'aucune valeur de texte libre dans le relevé');
  });

  test('aucune donnée individuelle ne figure dans le relevé', () => {
    // Le relevé est bâti sur des agrégats seuls : ni code de dossier, ni
    // valeur ligne à ligne. C'est ce qui garantit qu'écrire un article
    // n'expose aucun patient.
    const brief = buildCohortBrief(context);
    assert.ok(!/PAT-/.test(brief), 'aucun code de dossier');
    assert.ok(!/patientCode|patientId/.test(brief));
  });
});

describe('consigne donnée au modèle', () => {
  const prompt = buildSystemPrompt(buildCohortBrief(context));

  test('interdit d’inventer un chiffre', () => {
    assert.match(prompt, /n'en inventes aucun/);
    assert.match(prompt, /Tu n'emploies que les chiffres présents/);
  });

  test('interdit de produire un test statistique sans données individuelles', () => {
    // C'est la faute la plus tentante et la plus grave : un p inventé a
    // l'apparence d'un résultat.
    assert.match(prompt, /Tu ne calcules aucun test statistique/);
    assert.match(prompt, /tu ne peux pas en donner le résultat/);
  });

  test('interdit les références bibliographiques', () => {
    assert.match(prompt, /Tu ne cites aucune référence/);
  });

  test('impose les usages de la publication médicale', () => {
    assert.match(prompt, /IMRaD/);
    assert.match(prompt, /STROBE/);
  });

  test('le relevé est bien inclus dans la consigne', () => {
    assert.match(prompt, /Cohorte pilote/);
    assert.match(prompt, /Masculin 16/);
  });
});
