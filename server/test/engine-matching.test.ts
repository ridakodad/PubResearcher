/**
 * Correspondance des mots-clés, contextes à ignorer, négations, valeurs écartées.
 * Chaque test fige un faux positif ou un faux négatif réellement rencontré en
 * lisant des comptes rendus : la phrase d'essai est celle qui l'a révélé.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coerce, parseBoolean, parseNumber } from '../src/engine/coerce.js';
import { findTerm, foldText } from '../src/engine/fold.js';
import { extractField, extractFieldDetailed, type SourceDoc } from '../src/engine/rules.js';
import type { TemplateField } from '../src/domain/types.js';

function field(overrides: Partial<TemplateField>): TemplateField {
  return {
    id: 1, templateId: 1, key: 'test', label: 'Test', type: 'boolean', section: 'Test',
    unit: null, description: null, required: false, options: [], position: 0,
    extraction: { enabled: true, rules: [] },
    ...overrides,
  };
}
const doc = (text: string): SourceDoc => ({ id: 1, name: 'cr.pdf', kind: 'pdf', text, dicomTags: {} });
const keyword = (rule: Record<string, unknown>, f: Partial<TemplateField> = {}) =>
  field({ extraction: { enabled: true, rules: [{ kind: 'keyword', emit: true, ...rule } as never] }, ...f });

describe('findTerm — frontières de mot', () => {
  test('un terme ne commence jamais au milieu d’un mot', () => {
    assert.equal(findTerm('un homme de 54 ans', 'mme'), -1);
    assert.equal(findTerm('il affirme que', 'irm'), -1);
    assert.equal(findTerm('prediabete', 'diabete'), -1);
    assert.equal(findTerm('mme dupont', 'mme'), 0);
  });

  test('un terme court est un mot entier : « hta » n’est pas « htap »', () => {
    assert.equal(findTerm('htap connue', 'hta'), -1);
    assert.equal(findTerm('hta connue', 'hta'), 0);
    assert.equal(findTerm('hta, diabete', 'hta'), 0);
    assert.equal(findTerm('sous hta+', 'hta'), 5);
  });

  test('un terme long reste une racine : « diabet » trouve « diabetique »', () => {
    assert.equal(findTerm('patient diabetique', 'diabet'), 8);
    assert.equal(findTerm('tabagisme actif', 'tabag'), 0);
  });

  test('un terme qui finit par une ponctuation n’exige pas de frontière à droite', () => {
    assert.equal(findTerm('mr. x', 'mr.'), 0);
    assert.equal(findTerm('tumeur de 5 cm. au scanner', 'm.'), -1);
  });

  test('cherche l’occurrence valide suivante après une occurrence rejetée', () => {
    assert.equal(findTerm('homme, mme x', 'mme'), 7);
  });
});

describe('règle mot-clé — contextes à ignorer (skip)', () => {
  const diabete = keyword({
    any: ['diabete', 'diabetique'],
    none: ['pas de', 'non'],
    skip: ['mere', 'pere', 'familial', 'familiaux'],
    emitIfNegated: false,
  });

  test('un antécédent familial n’est ni vrai ni faux pour le patient', () => {
    assert.equal(extractField(diabete, [doc('Sa mère est diabétique.')]), null);
    assert.equal(extractField(diabete, [doc('Père décédé, diabétique.')]), null);
  });

  test('la portée est la phrase : « familiaux : diabète, HTA » couvre les deux éléments', () => {
    const hta = keyword({ any: ['hta'], skip: ['familiaux'] });
    assert.equal(extractField(hta, [doc('Antécédents familiaux : diabète, HTA.')]), null);
  });

  test('un point ferme la portée : le patient lui-même reste lu', () => {
    const hit = extractField(diabete, [doc('Père diabétique. Le patient est diabétique depuis 2015.')]);
    assert.equal(hit?.value, true);
  });

  test('« père » ne se lit pas dans « opéré »', () => {
    const hit = extractField(diabete, [doc('Patient opéré, diabétique de type 2.')]);
    assert.equal(hit?.value, true);
  });
});

describe('règle mot-clé — négations après le terme', () => {
  const hta = keyword({ any: ['hta'], none: ['pas de'], emitIfNegated: false });

  test('« (-) », « exclue », « est exclue », « : non » nient', () => {
    for (const phrase of ['HTA (-).', 'HTA exclue.', "L'HTA est exclue.", 'HTA : non', 'HTA négative']) {
      assert.equal(extractField(hta, [doc(phrase)])?.value, false, phrase);
    }
  });

  test('« non traitée », « non équilibrée », « non insulinodépendant » AFFIRMENT', () => {
    for (const phrase of ['HTA non traitée.', 'HTA : non équilibrée.', 'HTA non contrôlée sous bithérapie']) {
      assert.equal(extractField(hta, [doc(phrase)])?.value, true, phrase);
    }
  });

  test('une règle sans négation déclarée ne lit pas ce qui suit (pas de régression)', () => {
    const bare = keyword({ any: ['hta'] });
    assert.equal(extractField(bare, [doc('HTA exclue.')])?.value, true);
  });
});

describe('typage — valeurs trompeuses', () => {
  test('une valeur seuil n’est jamais lue comme un nombre', () => {
    for (const text of ['< 5', '<5', '> 200', '≤ 0,1', '(< 5)']) {
      const r = coerce(text, 'number', []);
      assert.equal(r.ok, false, text);
      assert.match((r as { reason: string }).reason, /seuil/);
    }
    assert.deepEqual(coerce('5 mg/L', 'number', []), { ok: true, value: 5 });
  });

  test('le signe moins typographique est un moins', () => {
    assert.equal(parseNumber('−3,5'), -3.5);
  });

  test('« 6 mois » n’est pas 6 ans, « 2 semaines » n’est pas 2 jours', () => {
    assert.equal(coerce('6 mois', 'integer', [], undefined, 'ans').ok, false);
    assert.equal(coerce('2 semaines', 'number', [], undefined, 'jours').ok, false);
    assert.deepEqual(coerce('54 ans', 'integer', [], undefined, 'ans'), { ok: true, value: 54 });
    assert.deepEqual(coerce('12 jours', 'number', [], undefined, 'jours'), { ok: true, value: 12 });
  });

  test('une variable sans unité de temps n’est pas contrôlée', () => {
    assert.deepEqual(coerce('6 mois', 'integer', [], undefined, null), { ok: true, value: 6 });
  });

  test('« non » qualificatif n’est pas une réponse négative', () => {
    assert.equal(parseBoolean('non'), false);
    assert.equal(parseBoolean('non retrouvé'), false);
    assert.equal(parseBoolean('non insulinodépendant'), null);
    assert.equal(parseBoolean('non équilibré'), null);
  });

  test('notations de carnet', () => {
    assert.equal(parseBoolean('(+)'), true);
    assert.equal(parseBoolean('(-), HTA (+)'), false);
  });

  test('choix multiple : plusieurs options dans un fragment, liaisons, fragments niés', () => {
    const opts = ['Scanner', 'IRM', 'Échographie'];
    assert.deepEqual(coerce('scanner et IRM', 'multi', opts), { ok: true, value: ['Scanner', 'IRM'] });
    assert.deepEqual(coerce('IRM, pas de scanner', 'multi', opts), { ok: true, value: ['IRM'] });
    assert.deepEqual(coerce('scanner IRM', 'multi', opts), { ok: true, value: ['Scanner', 'IRM'] });
    assert.equal(coerce('pas de scanner', 'multi', opts).ok, false);
  });

  test('choix multiple : l’option la plus longue l’emporte sur celle qu’elle contient', () => {
    const opts = ['Diabète', 'Diabète gestationnel'];
    assert.deepEqual(coerce('diabète gestationnel', 'multi', opts), { ok: true, value: ['Diabète gestationnel'] });
  });

  test('choix multiple : une option qui contient « et » n’est pas coupée', () => {
    const opts = ['Douleur et fièvre', 'Toux'];
    assert.deepEqual(coerce('Douleur et fièvre, toux', 'multi', opts), {
      ok: true,
      value: ['Douleur et fièvre', 'Toux'],
    });
  });
});

describe('libellé — la valeur typée s’arrête à la fin de la phrase', () => {
  const age = field({
    type: 'integer',
    unit: 'ans',
    extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Âge'], maxLength: 20 }] },
  });

  test('« Âge : NR. Patient âgé de 61 ans » ne livre pas « 6 »', () => {
    const r = extractFieldDetailed(age, [doc('Âge : NR. Patient âgé de 61 ans.')]);
    assert.equal(r.hit, null);
    assert.equal(r.rejected.length, 1);
  });

  test('une décimale n’est pas une fin de phrase', () => {
    const hb = field({
      type: 'number',
      extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Hb'], maxLength: 25 }] },
    });
    assert.equal(extractField(hb, [doc('Hb : 11.2 g/dL. Suite du texte.')])?.value, 11.2);
  });

  test('une variable texte garde sa phrase entière', () => {
    const motif = field({
      type: 'text',
      extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Motif'], maxLength: 200 }] },
    });
    const hit = extractField(motif, [doc('Motif : fièvre. Douleurs abdominales aiguës.')]);
    assert.match(String(hit?.value), /Douleurs abdominales/);
  });
});

describe('apostrophes — droite ou typographique (Word), la recherche est la même', () => {
  const STRAIGHT = "d'insuffisance rénale";
  const CURLY = 'd\u2019insuffisance rénale';

  test('le repli ramène les apostrophes typographiques à l’apostrophe droite, un caractère pour un caractère', () => {
    for (const apostrophe of ['\u2018', '\u2019', '\u201b', '\u02bc', '\u00b4', '\u2032']) {
      const ft = foldText(`l${apostrophe}examen`);
      assert.equal(ft.folded, "l'examen", `U+${apostrophe.codePointAt(0)!.toString(16)}`);
      assert.deepEqual(Array.from(ft.map), [0, 1, 2, 3, 4, 5, 6, 7]);
    }
  });

  test('mot-clé : un terme tapé avec l’apostrophe droite trouve le texte de Word, et réciproquement', () => {
    const typedStraight = keyword({ any: [STRAIGHT] });
    const typedCurly = keyword({ any: [CURLY] });
    for (const text of [`Antécédent ${CURLY}.`, `Antécédent ${STRAIGHT}.`]) {
      assert.equal(extractField(typedStraight, [doc(text)])?.value, true, text);
      assert.equal(extractField(typedCurly, [doc(text)])?.value, true, text);
    }
  });

  test('mot-clé : l’extrait justificatif garde l’apostrophe d’origine', () => {
    const hit = extractField(keyword({ any: [STRAIGHT] }), [doc(`Antécédent ${CURLY}, connue.`)]);
    assert.ok(hit?.evidence.snippet.includes('d\u2019insuffisance'));
  });

  test('expression régulière : le motif tapé avec l’apostrophe droite trouve l’apostrophe de Word', () => {
    const f = field({
      type: 'text',
      extraction: { enabled: true, rules: [{ kind: 'regex', pattern: "(d'insuffisance \\w+)" } as never] },
    });
    // Le motif est lu dans le texte replié, la valeur rendue vient du texte d'origine.
    assert.equal(extractField(f, [doc(`Bilan : ${CURLY} aigue`)])?.value, CURLY);
  });

  test('libellé : « Durée d’hospitalisation » et « Durée d\'hospitalisation » se valent', () => {
    const f = field({
      type: 'integer',
      extraction: { enabled: true, rules: [{ kind: 'label', labels: ["Durée d'hospitalisation"] } as never] },
    });
    assert.equal(extractField(f, [doc('Durée d\u2019hospitalisation : 12 jours')])?.value, 12);
    assert.equal(extractField(f, [doc("Durée d'hospitalisation : 12 jours")])?.value, 12);
  });

  test('terme d’exclusion : « pas d’HTA » nie quelle que soit l’apostrophe du terme saisi', () => {
    const hta = keyword({ any: ['hta'], none: ["pas d'"], emitIfNegated: false });
    assert.equal(extractField(hta, [doc('Pas d\u2019HTA connue.')])?.value, false);
    const htaCurly = keyword({ any: ['hta'], none: ['pas d\u2019'], emitIfNegated: false });
    assert.equal(extractField(htaCurly, [doc("Pas d'HTA connue.")])?.value, false);
    assert.equal(extractField(hta, [doc('HTA sous traitement.')])?.value, true);
  });
});

describe('repliage — la table de correspondance reste exacte après les évolutions', () => {
  test('les positions renvoient au texte d’origine', () => {
    const ft = foldText('Père décédé');
    assert.equal(ft.folded, 'pere decede');
    assert.equal(ft.map.length, ft.folded.length);
  });
});
