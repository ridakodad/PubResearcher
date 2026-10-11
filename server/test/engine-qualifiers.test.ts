/**
 * Précision avant rappel : ce que le moteur de règles ne doit plus affirmer.
 *
 * Chaque groupe fige une famille d'erreurs silencieuses relevée par un audit sur des comptes rendus difficiles :
 * hypothèse lue « Oui », ancien fumeur lu fumeur, antécédent lu épisode en cours, chiffre tronqué par l'OCR,
 * « non renseigné » lu « Non », négation contredite, option prise au hasard de l'ordre de la liste, et valeur de
 * sortie retenue à la place de celle d'entrée parce que le compte rendu de sortie avait été importé le premier.
 * La règle commune : dans le doute, la variable reste vide et la valeur trouvée est signalée.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coerce, ocrSuspect, parseBoolean, parseNumber } from '../src/engine/coerce.js';
import { foldText } from '../src/engine/fold.js';
import { qualifyAnswer, qualifyMention } from '../src/engine/qualifiers.js';
import { extractField, extractFieldDetailed, type SourceDoc } from '../src/engine/rules.js';
import { fieldExtractionSchema } from '../src/lib/schemas.js';
import type { ExtractionRule, FieldExtraction, TemplateField } from '../src/domain/types.js';

function field(overrides: Partial<TemplateField>): TemplateField {
  return {
    id: 1, templateId: 1, key: 'test', label: 'Test', type: 'boolean', section: 'Test',
    unit: null, description: null, required: false, options: [], position: 0,
    extraction: { enabled: true, rules: [] },
    ...overrides,
  };
}
const doc = (text: string, id = 1, name = 'cr.txt'): SourceDoc => ({ id, name, kind: 'text', text, dicomTags: {} });
const NEG = ['pas de', 'absence de', 'sans', 'aucun', 'aucune', 'non', 'ni', 'jamais'];
/** Variable oui/non au paramétrage de la fiche par défaut : libellé puis mot-clé. */
const yesNo = (terms: string[], extra: Partial<ExtractionRule> = {}, extraction: Partial<FieldExtraction> = {}) =>
  field({
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: [terms[0]!], maxLength: 30 },
        { kind: 'keyword', any: terms, none: NEG, emit: true, emitIfNegated: false, ...extra } as ExtractionRule,
      ],
      ...extraction,
    },
  });
const diabete = yesNo(['diabète', 'diabétique']);
const tabac = yesNo(['tabagisme', 'fumeur', 'fumeuse']);
const value = (f: TemplateField, ...texts: string[]) =>
  extractField(f, texts.map((t, i) => doc(t, i + 1, `doc${i + 1}.txt`)))?.value ?? null;

/** Qualifie la première occurrence de `term` dans `text`. */
function qualify(text: string, term: string, negated = false, excludeHistory = false) {
  const ft = foldText(text);
  const at = ft.folded.indexOf(term);
  assert.notEqual(at, -1, `terme « ${term} » absent de « ${text} »`);
  return qualifyMention(ft.folded, at, at + term.length, { negated, excludeHistory });
}

describe('1. hypothèse et incertitude : jamais « Oui »', () => {
  test('les marques d’hypothèse avant ou après le terme', () => {
    assert.equal(qualify('Suspicion de diabète devant une glycémie à 1,30 g/L.', 'diabete'), 'uncertain');
    assert.equal(qualify('HTA ? (à confirmer)', 'hta'), 'uncertain');
    assert.equal(qualify('HTA probable, MAPA prévue.', 'hta'), 'uncertain');
    assert.equal(qualify('Diabète à éliminer.', 'diabete'), 'uncertain');
    assert.equal(qualify('Un diabète est évoqué.', 'diabete'), 'uncertain');
    assert.equal(qualify('Diabète non exclu.', 'diabete'), 'uncertain');
  });

  test('l’hypothèse porte sur ses voisins immédiats, pas sur toute la phrase', () => {
    assert.equal(
      qualify("Suspicion d'embolie pulmonaire massive et étendue chez un patient diabétique", 'diabetique'),
      'affirmed',
    );
  });

  test('la variable reste vide et la mention est signalée', () => {
    for (const phrase of ['Suspicion de diabète.', 'Diabète probable.', 'Diabète ?', 'Diabète à éliminer.']) {
      const r = extractFieldDetailed(diabete, [doc(phrase)]);
      assert.equal(r.hit, null, phrase);
      assert.ok(r.rejected.some((x) => /incertaine/.test(x.reason)), phrase);
    }
  });

  test('en réponse à un libellé : « probable », « ? », « suspecté » ne sont ni oui ni non', () => {
    for (const answer of ['probable', '?', 'oui ?', 'suspecté', 'à confirmer']) {
      assert.equal(parseBoolean(answer), null, answer);
      assert.equal(coerce(answer, 'boolean', []).ok, false, answer);
    }
  });
});

describe('2. absence établie, état passé : jamais un « Oui » actuel', () => {
  test('« éliminé », « ex- », « ancien », « sevré » valent négation', () => {
    assert.equal(qualify('Diabète éliminé.', 'diabete'), 'ruled-out');
    assert.equal(qualify('Ex-fumeur.', 'fumeur'), 'ruled-out');
    assert.equal(qualify('Ancien fumeur, 30 PA.', 'fumeur'), 'ruled-out');
    assert.equal(qualify('Tabagisme sevré depuis 2015.', 'tabagisme'), 'ruled-out');
    assert.equal(qualify('Sevrage tabagique en 2015.', 'tabagique'), 'ruled-out');
  });

  test('avec `emitIfNegated`, l’absence établie donne « Non »', () => {
    assert.equal(value(diabete, 'Diabète éliminé par HGPO.'), false);
    assert.equal(value(tabac, 'Ex-fumeuse.'), false);
    assert.equal(value(tabac, 'Ancien fumeur.'), false);
    assert.equal(value(tabac, 'Tabagisme : oui, sevré depuis 2 ans'), false);
    assert.equal(value(tabac, 'Tabagisme : ancien'), false);
  });

  test('sans `emitIfNegated`, ni « Oui » ni « Non »', () => {
    const bare = field({ extraction: { enabled: true, rules: [{ kind: 'keyword', any: ['fumeur'], emit: true }] } });
    assert.equal(value(bare, 'Ex-fumeur.'), null);
  });

  test('« ancien » après une maladie est ambigu (de longue date ? arrêté ?) : rien n’est retenu', () => {
    assert.equal(value(yesNo(['hta']), 'HTA ancienne, sous bithérapie.'), null);
  });

  test('« à éliminer » n’est pas « éliminé »', () => {
    assert.equal(value(diabete, 'Diabète à éliminer.'), null);
    assert.equal(value(diabete, 'Diabète éliminé.'), false);
  });
});

describe('3. antécédent et épisode passé : pas l’épisode en cours', () => {
  const fievre = yesNo(['fièvre', 'fébrile'], { history: 'exclude' } as Partial<ExtractionRule>);

  test('un épisode daté et clos n’est pas actuel', () => {
    assert.equal(qualify('Pneumopathie fébrile en 2019.', 'febrile'), 'past');
    assert.equal(qualify('Diabète gestationnel en 2010, résolutif.', 'diabete'), 'past');
    assert.equal(qualify('HTA gravidique lors de sa deuxième grossesse.', 'hta'), 'past');
    assert.equal(qualify('Tuberculose il y a 10 ans, fébrile alors.', 'febrile'), 'affirmed', 'portée : la proposition');
  });

  test('une date qui ouvre un état toujours présent ne le clôt pas', () => {
    assert.equal(qualify('Diabète depuis 2010.', 'diabete'), 'affirmed');
    assert.equal(qualify('Diabète découvert en 2015, sous insuline.', 'diabete'), 'affirmed');
    assert.equal(qualify('Admis en mars 2024 pour fièvre prolongée.', 'fievre'), 'affirmed');
  });

  test('`history: exclude` écarte la rubrique des antécédents, et seulement elle', () => {
    assert.equal(value(fievre, 'Antécédents : pneumopathie fébrile. Pas de fièvre ce jour.'), false);
    assert.equal(value(fievre, 'ATCD de fièvre typhoïde.'), null);
    assert.equal(value(fievre, 'Sans antécédent notable, admise pour fièvre.'), true);
    assert.equal(value(fievre, 'Antécédents : appendicectomie ; motif : fièvre.'), true, 'un nouveau libellé ferme la rubrique');
  });

  test('par défaut (`include`), une maladie chronique se lit dans les antécédents', () => {
    assert.equal(value(diabete, 'Antécédents : diabète de type 2, HTA.'), true);
    assert.equal(value(diabete, 'ATCD : diabétique sous metformine.'), true);
  });
});

describe('4. lettres de l’OCR dans un nombre : jamais un nombre tronqué', () => {
  test('la lettre collée au nombre est repérée', () => {
    assert.equal(ocrSuspect('1O mg/L'), '1O');
    assert.equal(ocrSuspect('7l ans'), '7l');
    assert.equal(ocrSuspect('1O5 µmol/L'), '1O5');
    assert.equal(ocrSuspect('l2,3 g/dL'), 'l2,3');
  });

  test('une unité collée ou une lettre qui appartient à un mot ne sont pas suspectes', () => {
    for (const text of ['10mg/L', '10 mg/L', 'PaO2 80 mmHg', 'HbA1c 7 %', '11,2 G/L', '54 ans']) {
      assert.equal(ocrSuspect(text), null, text);
    }
  });

  test('la valeur est écartée et signalée, pas lue 1 ni 7', () => {
    for (const [text, type, unit] of [['1O mg/L', 'number', 'mg/L'], ['7l ans', 'integer', 'ans']] as const) {
      const r = coerce(text, type, [], undefined, unit);
      assert.equal(r.ok, false, text);
      assert.match((r as { reason: string }).reason, /ambigu/, text);
    }
  });

  test('une capture d’expression régulière coupée par la lettre est écartée aussi', () => {
    const crp = field({
      type: 'number',
      unit: 'mg/L',
      extraction: { enabled: true, rules: [{ kind: 'regex', pattern: 'CRP\\s*:?\\s*(\\d+)' }] },
    });
    const r = extractFieldDetailed(crp, [doc('CRP : 1O mg/L')]);
    assert.equal(r.hit, null);
    assert.match(r.rejected[0]!.reason, /ambigu/);
    assert.equal(extractField(crp, [doc('CRP : 10 mg/L')])?.value, 10);
  });

  test('le contrôle d’unité n’est pas contourné : une unité écrite plus loin compte', () => {
    for (const text of ['8O µmol/L', '98 (N : 60-110) µmol/L']) {
      assert.equal(coerce(text, 'number', [], undefined, 'mg/L').ok, false, text);
    }
    assert.deepEqual(coerce('45 (N < 5) mg/L', 'number', [], undefined, 'mg/L'), { ok: true, value: 45 });
  });
});

describe('5. « non renseigné » : vide, jamais « Non »', () => {
  test('en réponse à un libellé', () => {
    for (const answer of ['non renseigné', 'NR', 'non précisé', 'inconnu', 'Non documenté']) {
      assert.equal(parseBoolean(answer), null, answer);
      const r = coerce(answer, 'boolean', []);
      assert.equal(r.ok, false, answer);
      assert.match((r as { reason: string }).reason, /non renseigné/, answer);
    }
    assert.equal(parseBoolean('non'), false, 'un « non » seul reste un « Non »');
  });

  test('après un mot-clé', () => {
    assert.equal(qualify('tabagisme non renseigné', 'tabagisme'), 'not-documented');
    assert.equal(value(tabac, 'Antécédents : HTA, tabagisme non renseigné.'), null);
    assert.equal(value(tabac, 'Statut tabagique inconnu.'), null);
  });

  test('qualifyAnswer distingue les cas', () => {
    assert.equal(qualifyAnswer('nr'), 'not-documented');
    assert.equal(qualifyAnswer('probable'), 'uncertain');
    assert.equal(qualifyAnswer('sevre en 2015 (30 pa)'), 'ruled-out');
    assert.equal(qualifyAnswer('aucune, mais reprise chirurgicale'), 'contradicted');
    assert.equal(qualifyAnswer('oui'), null);
  });
});

describe('6. négation contredite ou restreinte : pas de « Non » sûr', () => {
  const complications = yesNo(['complication']);

  test('« pas de … mais … » dans la même phrase', () => {
    assert.equal(value(complications, "Pas de complication post-opératoire mais pneumopathie d'inhalation à J2."), null);
    assert.equal(value(complications, 'Aucune complication, cependant reprise au bloc à J3.'), null);
  });

  test('une négation limitée dans le temps', () => {
    assert.equal(value(complications, 'Pas de complication immédiate.'), null);
    assert.equal(value(complications, 'Pas de complication per-opératoire.'), null);
  });

  test('une négation simple reste un « Non », la mention affirmée suivante un « Oui »', () => {
    assert.equal(value(complications, 'Pas de complication.'), false);
    const fievre = yesNo(['fièvre']);
    assert.equal(value(fievre, 'Pas de fièvre mais frissons, puis fièvre à 39 °C à J2.'), true);
  });
});

describe('7. plusieurs options citées : signalé, pas la première de la liste', () => {
  const evolution = field({
    type: 'enum',
    options: ['Favorable', 'Stationnaire', 'Défavorable', 'Décès'],
    extraction: {
      enabled: true,
      rules: [
        { kind: 'label', labels: ['Évolution'], maxLength: 80 },
        { kind: 'keyword', any: ['décès', 'décédé'], none: ['pas de'], emit: 'Décès' },
      ],
      postProcess: { valueMap: { simple: 'Favorable', bonne: 'Favorable' } },
    },
  });

  test('« favorable puis décès » : aucune valeur, ni par le libellé ni par une règle de repli', () => {
    const r = extractFieldDetailed(evolution, [doc('Évolution : favorable puis décès le 22/03.')]);
    assert.equal(r.hit, null);
    assert.equal(r.rejected[0]!.conflict, true);
    assert.match(r.rejected[0]!.reason, /Favorable, Décès/);
  });

  test('une option niée, ou citée par la table de correspondances, ne compte qu’une fois', () => {
    assert.equal(value(evolution, 'Évolution : favorable, sans décès.'), 'Favorable');
    assert.equal(value(evolution, 'Évolution : simple et favorable.'), 'Favorable');
    assert.equal(value(evolution, 'Évolution : défavorable.'), 'Défavorable');
  });
});

describe('8. plusieurs mentions, plusieurs documents', () => {
  const hb = (select?: FieldExtraction['select']) =>
    field({
      type: 'number',
      unit: 'g/dL',
      extraction: {
        enabled: true,
        rules: [{ kind: 'label', labels: ['Hémoglobine', 'Hb'], maxLength: 25 }],
        ...(select ? { select } : {}),
      },
    });
  const sortie = 'Compte rendu de sortie. Hémoglobine : 8,1 g/dL.';
  const entree = 'Admission. Hémoglobine : 12,6 g/dL.';

  test('sans règle de sélection, des valeurs discordantes sont signalées, pas choisies par l’ordre d’import', () => {
    const r = extractFieldDetailed(hb(), [doc(sortie, 1, 'sortie.txt'), doc(entree, 2, 'entree.txt')]);
    assert.equal(r.hit, null);
    assert.equal(r.rejected[0]!.conflict, true);
    assert.match(r.rejected[0]!.reason, /8,1 \(sortie\.txt\).*12,6 \(entree\.txt\)/);
  });

  test('dans un même document aussi', () => {
    assert.equal(value(hb(), 'Hb : 12,6 g/dL à l’entrée. Hb : 8,1 g/dL à J3.'), null);
  });

  test('des mentions concordantes donnent leur valeur, sans baisse de confiance', () => {
    const r = extractFieldDetailed(hb(), [doc(entree, 1), doc('Hb : 12,6 g/dL', 2)]);
    assert.equal(r.hit?.value, 12.6);
    assert.equal(r.hit?.evidence.alternatives, undefined);
    assert.equal(r.hit?.confidence, 0.85);
  });

  test('une règle de sélection tranche, et la justification garde les autres valeurs', () => {
    const docs = [doc(sortie, 1, 'sortie.txt'), doc(entree, 2, 'entree.txt')];
    const first = extractFieldDetailed(hb('first'), docs).hit!;
    assert.equal(first.value, 8.1);
    assert.deepEqual(first.evidence.alternatives?.map((a) => [a.value, a.documentName]), [[12.6, 'entree.txt']]);
    assert.match(first.evidence.selection!, /première/);
    assert.ok(first.confidence < 0.85, 'un choix entre valeurs discordantes est moins sûr');
    assert.equal(extractField(hb('last'), docs)?.value, 12.6);
    assert.equal(extractField(hb('max'), docs)?.value, 12.6);
    assert.equal(extractField(hb('min'), docs)?.value, 8.1);
  });

  test('`max` / `min` sur des dates ; `any` sur un oui/non et un choix multiple', () => {
    const date = (select: FieldExtraction['select']) =>
      field({ type: 'date', extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Date'] }], select } });
    const docs = [doc('Date : 14/03/2024'), doc('Date : 02/03/2024', 2)];
    assert.equal(extractField(date('min'), docs)?.value, '2024-03-02');
    assert.equal(extractField(date('max'), docs)?.value, '2024-03-14');

    const fievre = yesNo(['fièvre'], {}, { select: 'any' });
    assert.equal(value(fievre, 'Pas de fièvre à l’entrée.', 'Fièvre à 39 °C à J3.'), true);
    assert.equal(value(yesNo(['fièvre']), 'Pas de fièvre à l’entrée.', 'Fièvre à 39 °C à J3.'), null, 'sans `any` : signalé');

    const imagerie = field({
      type: 'multi',
      options: ['Scanner', 'IRM'],
      extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Imagerie'] }], select: 'any' },
    });
    assert.deepEqual(value(imagerie, 'Imagerie : scanner', 'Imagerie : IRM'), ['Scanner', 'IRM']);
  });

  test('oui/non : libellé et mot-clé de deux documents se contredisent', () => {
    assert.equal(value(diabete, 'Diabète : oui', 'Pas de diabète.'), null);
    assert.equal(value(diabete, 'Diabète : oui', 'Patient diabétique.'), true);
  });

  test('oui/non : le mot-clé ne relit pas la réponse d’un libellé', () => {
    assert.equal(value(yesNo(['complication']), 'Complications : non'), false);
    assert.equal(value(yesNo(['complication']), 'Complications : aucune.'), false);
  });

  test('dans un même document, une mention affirmée l’emporte sur une négation large', () => {
    const kw = field({
      extraction: {
        enabled: true,
        rules: [{ kind: 'keyword', any: ['diabete', 'diabétique'], none: ['pas de'], emit: true, emitIfNegated: false }],
      },
    });
    assert.equal(value(kw, 'Pas de diabète dans la famille. Le patient est diabétique depuis 2015.'), true);
  });

  test('le texte libre retient la première mention et cite les autres', () => {
    const motif = field({ type: 'text', extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Motif'] }] } });
    const hit = extractField(motif, [doc('Motif : douleur thoracique'), doc('Motif : dyspnée', 2, 'b.txt')])!;
    assert.equal(hit.value, 'douleur thoracique');
    assert.equal(hit.evidence.alternatives?.[0]?.documentName, 'b.txt');
  });

  test('une fiche enregistrée sans `select` reste valide et prudente', () => {
    const stored = JSON.parse('{"enabled":true,"rules":[{"kind":"label","labels":["Hb"]}]}');
    const parsed = fieldExtractionSchema.parse(stored);
    assert.equal(parsed.select, undefined);
    assert.equal(value(field({ type: 'number', extraction: parsed as FieldExtraction }), 'Hb : 12', 'Hb : 9'), null);
  });

  test('le schéma accepte `select` et `history`, refuse une valeur inconnue', () => {
    const ok = fieldExtractionSchema.parse({
      enabled: true,
      rules: [{ kind: 'keyword', any: ['fièvre'], emit: true, history: 'exclude' }],
      select: 'any',
    });
    assert.equal(ok.select, 'any');
    assert.equal((ok.rules[0] as { history?: string }).history, 'exclude');
    assert.throws(() => fieldExtractionSchema.parse({ enabled: true, rules: [], select: 'median' }));
    assert.throws(() =>
      fieldExtractionSchema.parse({ enabled: true, rules: [{ kind: 'keyword', any: ['x'], emit: true, history: 'skip' }] }),
    );
  });
});

describe('9. lectures manquées qui ne coûtaient rien', () => {
  test('« 38°5 » vaut 38,5', () => {
    assert.deepEqual(coerce('38°5', 'number', [], undefined, '°C'), { ok: true, value: 38.5 });
    assert.deepEqual(coerce('38 ° 5 ce matin', 'number', [], undefined, '°C'), { ok: true, value: 38.5 });
    assert.deepEqual(coerce('38,5 °C', 'number', [], undefined, '°C'), { ok: true, value: 38.5 });
    assert.deepEqual(coerce('37°', 'number', [], undefined, '°C'), { ok: true, value: 37 });
  });

  test('parseNumber n’a pas changé', () => {
    assert.equal(parseNumber('12,5 g/dL'), 12.5);
    assert.equal(parseNumber('1 250'), 1250);
  });
});
