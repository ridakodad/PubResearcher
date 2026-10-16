/**
 * Mise en page : la même valeur, écrite de toutes les façons qu'un compte rendu, un tableau Word, un PDF ou une
 * lecture optique la restituent. Une règle à libellé saisie une fois (« CRP ») doit les couvrir toutes, sans
 * qu'on ait à prévoir chaque séparateur — et sans lire une valeur là où il n'y en a pas.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractFieldDetailed, type SourceDoc } from '../src/engine/rules.js';
import { parseNumber } from '../src/engine/coerce.js';
import type { FieldExtraction, FieldType, TemplateField } from '../src/domain/types.js';

function field(type: FieldType, labels: string[], unit: string | null = null, extra: Partial<FieldExtraction> = {}): TemplateField {
  return {
    id: 1, templateId: 1, key: 'v', label: labels[0]!, type, section: 'Test', unit, description: null,
    required: false, options: [], position: 0,
    extraction: { enabled: true, rules: [{ kind: 'label', labels, maxLength: 30 }], ...extra },
  };
}
const doc = (text: string): SourceDoc => ({ id: 1, name: 'cr.pdf', kind: 'pdf', text, dicomTags: {} });
const crp = field('number', ['CRP', 'Protéine C réactive'], 'mg/L');
const value = (f: TemplateField, text: string) => extractFieldDetailed(f, [doc(text)]).hit?.value ?? null;

describe('séparateurs entre libellé et valeur', () => {
  const cases: [string, string][] = [
    ['deux-points', 'CRP : 142 mg/L'],
    ['égal', 'CRP = 142 mg/L'],
    ['sans séparateur', 'CRP 142 mg/L'],
    ['tiret', 'CRP - 142 mg/L'],
    ['tiret demi-cadratin', 'CRP – 142 mg/L'],
    ['points de conduite', 'CRP ........ 142 mg/L'],
    ['points de suspension typographiques', 'CRP……… 142'],
    ['points de conduite puis deux-points', 'CRP ..... : 142'],
    ['deux-points pleine chasse', 'CRP：142'],
    ['barre de tableau', 'CRP | 142 | mg/L | < 5'],
    ['tabulation', 'CRP\t142\tmg/L'],
    ['espaces multiples (tableau aligné)', 'CRP          142        mg/L'],
    ['espace insécable', 'CRP : 142 mg/L'],
    ['majuscules', 'PROTÉINE C RÉACTIVE : 142 MG/L'],
    ['puce', '• CRP : 142 mg/L'],
    ['tiret de liste', '- CRP 142'],
    ['espaces doublés par l’OCR dans le libellé', 'Protéine  C  réactive : 142'],
  ];
  for (const [name, text] of cases) {
    test(name, () => assert.equal(value(crp, text), 142));
  }
});

describe('unité dans l’en-tête', () => {
  test('« CRP (mg/L) : 142 »', () => assert.equal(value(crp, 'CRP (mg/L) : 142'), 142));
  test('« CRP (mg/L) 142 » sans deux-points', () => assert.equal(value(crp, 'CRP (mg/L) 142'), 142));
  test('une autre unité dans l’en-tête est signalée, pas lue', () => {
    const r = extractFieldDetailed(crp, [doc('CRP (mg/dL) : 14,2')]);
    assert.equal(r.hit, null);
    assert.match(r.rejected[0]!.reason, /mg\/dL/);
  });
  test('une parenthèse qui n’est pas une unité n’est pas collée à la valeur', () => {
    const cr = field('number', ['Créatinine'], 'mg/L');
    assert.equal(value(cr, 'Créatinine (J0) : 12'), 12);
  });
});

describe('valeur sur la ligne suivante', () => {
  test('« CRP⏎142 mg/L » (cellule de tableau sortie ligne par ligne)', () => {
    assert.equal(value(crp, 'Biologie\nCRP\n142 mg/L\nPCT\n0,8'), 142);
  });
  test('« Date d’admission⏎12/03/2024 »', () => {
    const f = field('date', ["Date d'admission"]);
    assert.equal(value(f, "DATE D'ADMISSION\n12/03/2024"), '2024-03-12');
  });
  test('la ligne suivante ne commence pas par un chiffre : rien', () => {
    assert.equal(value(crp, 'CRP\nnon dosée\nIonogramme : 140'), null);
  });
  test('le libellé au milieu d’une phrase ne va pas chercher la ligne suivante', () => {
    assert.equal(value(crp, 'Contrôle de la CRP prévu\n12 jours plus tard'), null);
  });
  test('la valeur sur la même ligne reste prioritaire', () => {
    assert.equal(value(crp, 'CRP\n80\nCRP : 142'), 142);
  });
});

describe('coupures et caractères du PDF', () => {
  test('mot coupé en fin de ligne : « Protéine C réac-⏎tive : 142 »', () => {
    assert.equal(value(crp, 'Protéine C réac-\ntive : 142 mg/L'), 142);
  });
  test('l’extrait cité reste celui du texte d’origine', () => {
    const hit = extractFieldDetailed(crp, [doc('Bilan : protéine C réac-\ntive : 142 mg/L')]).hit!;
    assert.match(hit.evidence.snippet, /réac- tive : 142/);
  });
  test('« Hb -⏎12 » n’est pas une coupure de mot', () => {
    const hb = field('number', ['Hb'], 'g/dL');
    assert.equal(value(hb, 'Hb -\n12,4 g/dL'), 12.4);
  });
});

describe('nombres', () => {
  const hb = field('number', ['Hémoglobine', 'Hb'], 'g/dL');
  const gb = field('number', ['Leucocytes', 'GB'], '/mm3');
  test('virgule et point décimaux', () => {
    assert.equal(value(hb, 'Hb : 12,4 g/dL'), 12.4);
    assert.equal(value(hb, 'Hb : 12.4 g/dL'), 12.4);
  });
  test('séparateurs de milliers', () => {
    assert.equal(value(gb, 'Leucocytes : 12 500 /mm3'), 12500);
    assert.equal(value(gb, 'Leucocytes : 12 500/mm3'), 12500);
    assert.equal(value(gb, 'GB\t12 500'), 12500);
    assert.equal(parseNumber('1.250,5'), 1250.5);
    assert.equal(parseNumber('1,250.5'), 1250.5);
  });
  test('signe moins typographique', () => {
    const be = field('number', ['Excès de base'], 'mmol/L');
    assert.equal(value(be, 'Excès de base : −3,2 mmol/L'), -3.2);
  });
});

describe('ce qui ne doit pas changer', () => {
  test('une valeur seuil reste écartée', () => assert.equal(value(crp, 'CRP ........ < 5 mg/L'), null));
  test('un libellé à l’intérieur d’un mot ne déclenche pas', () => {
    const pa = field('number', ['PA'], 'mmHg');
    assert.equal(value(pa, 'Capacité : 12'), null);
  });
  test('un oui/non en tableau', () => {
    const hta = field('boolean', ['HTA']);
    assert.equal(value(hta, 'HTA\t\tOui'), true);
    assert.equal(value(hta, 'HTA ....... non'), false);
  });
});

// Sans séparateur, un libellé peut être un mot de la phrase : « Suites marquées par une complication » n'est pas une valeur.
test('choix sans séparateur : la modalité doit ouvrir le texte qui suit le libellé', async () => {
  const { suggestExtraction } = await import('../src/engine/suggest-rules.js');
  const { extractFieldDetailed } = await import('../src/engine/rules.js');
  const options = ['Favorable', 'Complications', 'Décès'];
  const field = { id: 1, templateId: 1, key: 'evolution', label: 'Évolution', type: 'enum', section: 'x', unit: null, description: null, required: false, options, position: 0, extraction: suggestExtraction({ label: 'Évolution', type: 'enum', options }) } as never;
  const doc = (id: number, text: string) => ({ id, name: `d${id}`, kind: 'docx', text, dicom: null }) as never;
  const prose = extractFieldDetailed(field, [doc(1, 'Évolution : favorable.'), doc(2, 'Suites marquées par une complication infectieuse.')]);
  assert.equal(prose.hit?.value, 'Favorable');
  const plain = extractFieldDetailed(field, [doc(1, 'Évolution favorable, sortie à J5.')]);
  assert.equal(plain.hit?.value, 'Favorable');
});

// Une option citée seulement pour être écartée n'est pas la réponse : « favorable, sans complication » est favorable.
test('choix unique : les options niées ne l’emportent pas sur l’option affirmée', async () => {
  const { suggestExtraction } = await import('../src/engine/suggest-rules.js');
  const options = ['Favorable', 'Complications', 'Décès'];
  const field = { id: 1, templateId: 1, key: 'evolution', label: 'Évolution', type: 'enum', section: 'x', unit: null, description: null, required: false, options, position: 0, extraction: suggestExtraction({ label: 'Évolution', type: 'enum', options }) } as never;
  const read = (text: string) => extractFieldDetailed(field, [{ id: 1, name: 'd', kind: 'docx', text, dicom: null } as never]).hit?.value ?? null;
  assert.equal(read('Evolution : favorable, sans complication.'), 'Favorable');
  assert.equal(read('Évolution : pas de complication, favorable'), 'Favorable');
  assert.equal(read('Suites simples, sans complication.'), 'Favorable');
  assert.equal(read('Evolution : compliquée d’une pneumopathie'), 'Complications');
  assert.equal(read('Evolution : décès à J3'), 'Décès');
});
