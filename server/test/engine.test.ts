import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coerce, parseDate, parseNumber, parseBoolean } from '../src/engine/coerce.js';
import { fold, foldText, toOriginalRange, makeSnippet } from '../src/engine/fold.js';
import { extractField, type SourceDoc } from '../src/engine/rules.js';
import type { TemplateField } from '../src/domain/types.js';

function field(overrides: Partial<TemplateField>): TemplateField {
  return {
    id: 1,
    templateId: 1,
    key: 'test',
    label: 'Test',
    type: 'text',
    section: 'Test',
    unit: null,
    description: null,
    required: false,
    options: [],
    position: 0,
    extraction: { enabled: true, rules: [] },
    ...overrides,
  };
}

function doc(text: string, overrides: Partial<SourceDoc> = {}): SourceDoc {
  return { id: 1, name: 'cr.pdf', kind: 'pdf', text, dicomTags: {}, ...overrides };
}

describe('repliage du texte', () => {
  test('supprime les accents et met en minuscules', () => {
    assert.equal(fold('Âge Écrit Œuvre'), 'age ecrit œuvre');
  });

  test('conserve la correspondance avec les positions d’origine', () => {
    const original = 'Âge : 54 ans';
    const ft = foldText(original);
    assert.equal(ft.folded, 'age : 54 ans');
    const idx = ft.folded.indexOf('54');
    const range = toOriginalRange(ft, idx, idx + 2);
    assert.equal(original.slice(range.start, range.end), '54');
  });

  test('reste aligné malgré les caractères décomposés en plusieurs unités', () => {
    // « ﬁ » se décompose, « é » perd sa marque : les index doivent suivre.
    const original = 'Créatinine élevée';
    const ft = foldText(original);
    const idx = ft.folded.indexOf('elevee');
    const range = toOriginalRange(ft, idx, idx + 'elevee'.length);
    assert.equal(original.slice(range.start, range.end), 'élevée');
  });

  test('l’extrait cité entoure la correspondance', () => {
    const text = 'Le patient présente une fièvre à 39 degrés depuis trois jours.';
    const snippet = makeSnippet(text, 33, 35, 10);
    assert.ok(snippet.includes('39'));
  });
});

describe('conversion des nombres', () => {
  test('accepte la virgule décimale', () => {
    assert.equal(parseNumber('12,5 g/dL'), 12.5);
  });
  test('accepte le point décimal', () => {
    assert.equal(parseNumber('CRP 145.8 mg/L'), 145.8);
  });
  test('gère les séparateurs de milliers', () => {
    assert.equal(parseNumber('12 500'), 12500);
  });
  test('renvoie null sans nombre', () => {
    assert.equal(parseNumber('non renseigné'), null);
  });
});

describe('conversion des dates', () => {
  test('format francophone jour/mois/année', () => {
    assert.equal(parseDate('15/03/2024'), '2024-03-15');
  });
  test('format ISO', () => {
    assert.equal(parseDate('2024-03-15'), '2024-03-15');
  });
  test('mois écrit en toutes lettres', () => {
    assert.equal(parseDate('12 mars 2021'), '2021-03-12');
  });
  test('format DICOM compact', () => {
    assert.equal(parseDate('20240315'), '2024-03-15');
  });
  test('année sur deux chiffres', () => {
    assert.equal(parseDate('15/03/98'), '1998-03-15');
  });
  test('rejette une date impossible', () => {
    assert.equal(parseDate('31/02/2024'), null);
  });
});

describe('conversion des booléens', () => {
  test('reconnaît les formulations positives', () => {
    assert.equal(parseBoolean('Oui'), true);
    assert.equal(parseBoolean('présent'), true);
  });
  test('reconnaît les formulations négatives', () => {
    assert.equal(parseBoolean('non'), false);
    assert.equal(parseBoolean('absence de'), false);
    assert.equal(parseBoolean('pas de'), false);
  });
});

describe('typage des valeurs', () => {
  test('un entier n’est jamais arrondi en silence : 54,6 ans n’est ni 54 ni 55', () => {
    // Arrondir donnerait 55 ans à une patiente de 54 ans et demi ; tronquer ne vaut pas pour
    // une durée. Le moteur n'invente pas : il écarte la valeur et dit pourquoi.
    const result = coerce('54,6 ans', 'integer', []);
    assert.equal(result.ok, false);
    assert.match(String((result as { reason?: string }).reason), /décimale 54\.6.*entière/);
  });

  test('un entier écrit avec une décimale nulle reste un entier', () => {
    assert.deepEqual(coerce('61,0 ans', 'integer', []), { ok: true, value: 61 });
    assert.deepEqual(coerce('3', 'integer', []), { ok: true, value: 3 });
  });

  test('un entier mis à l’échelle garde son exactitude (0,1 x 30 n’est pas 3.0000000000000004)', () => {
    assert.deepEqual(coerce('30', 'integer', [], { scale: 0.1 }), { ok: true, value: 3 });
  });

  test('les séparateurs de milliers sans ambiguïté sont lus comme tels, l’ambigu reste décimal', () => {
    assert.equal(parseNumber('1.200,5'), 1200.5, 'usage français : point de milliers, virgule décimale');
    assert.equal(parseNumber('12.500,75 /mm3'), 12500.75);
    assert.equal(parseNumber('1,200.5'), 1200.5, 'usage anglais');
    assert.equal(parseNumber('12 500,5'), 12500.5);
    assert.equal(parseNumber('-1.200,5'), -1200.5);
    assert.equal(parseNumber('12,5'), 12.5);
    assert.equal(parseNumber('3.5 puis 1.200,5'), 3.5, 'le premier nombre du texte l’emporte');
    // Trois chiffres après un point : milliers ou décimales, le contexte ne le dit pas. Lu comme un décimal.
    assert.equal(parseNumber('1.200'), 1.2);
  });

  test('le signe moins collé au chiffre est conservé, la puce ne l’est pas', () => {
    assert.deepEqual(coerce('-3,2 mmol/L', 'number', []), { ok: true, value: -3.2 });
    assert.deepEqual(coerce('\u22123,2', 'number', []), { ok: true, value: -3.2 });
    assert.deepEqual(coerce('- 54 ans', 'integer', []), { ok: true, value: 54 });
    assert.deepEqual(coerce(':= 54', 'integer', []), { ok: true, value: 54 });
    assert.equal(coerce('-', 'number', []).ok, false);
  });

  test('les bornes de plausibilité rejettent une valeur aberrante', () => {
    const result = coerce('300', 'integer', [], { min: 0, max: 120 });
    assert.equal(result.ok, false);
  });

  test('une option est reconnue malgré la casse et les accents', () => {
    assert.deepEqual(coerce('feminin', 'enum', ['Masculin', 'Féminin']), {
      ok: true,
      value: 'Féminin',
    });
  });

  test('le mapping ramène une abréviation vers l’option canonique', () => {
    const result = coerce('M', 'enum', ['Masculin', 'Féminin'], {
      valueMap: { M: 'Masculin', F: 'Féminin' },
    });
    assert.deepEqual(result, { ok: true, value: 'Masculin' });
  });

  test('le choix multiple découpe sur les séparateurs usuels', () => {
    const result = coerce('Scanner, IRM', 'multi', ['Scanner', 'IRM', 'Échographie']);
    assert.deepEqual(result, { ok: true, value: ['Scanner', 'IRM'] });
  });

  test('une valeur hors liste est refusée', () => {
    assert.equal(coerce('Tomographie', 'enum', ['Scanner', 'IRM']).ok, false);
  });
});

describe('règle « libellé : valeur »', () => {
  test('capture la valeur qui suit le libellé', () => {
    const hit = extractField(
      field({
        type: 'integer',
        extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Âge'] }] },
      }),
      [doc('Compte rendu\nÂge : 54 ans\nSexe : Masculin')],
    );
    assert.equal(hit?.value, 54);
  });

  test('fonctionne quand le libellé est écrit sans accent', () => {
    const hit = extractField(
      field({
        type: 'integer',
        extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Âge'] }] },
      }),
      [doc('Age: 61 ans')],
    );
    assert.equal(hit?.value, 61);
  });

  test('restitue la valeur avec sa casse et ses accents d’origine', () => {
    // La recherche est insensible à la casse et aux accents, mais la valeur
    // enregistrée doit être celle du document — sans quoi le jeu de données
    // exporté serait dégradé.
    const hit = extractField(
      field({
        type: 'text',
        extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Antécédents'] }] },
      }),
      [doc("Antécédents : Diabète type 2, pas d'HTA, IDM en 2019")],
    );
    assert.equal(hit?.value, "Diabète type 2, pas d'HTA, IDM en 2019");
  });

  test('l’extrait justificatif conserve le texte d’origine', () => {
    const hit = extractField(
      field({
        type: 'text',
        extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Motif'] }] },
      }),
      [doc('Motif : Œdème aigu du poumon')],
    );
    assert.equal(hit?.value, 'Œdème aigu du poumon');
    assert.match(hit!.evidence.snippet, /Œdème aigu du poumon/);
  });

  test('cite le document et l’extrait justificatif', () => {
    const hit = extractField(
      field({
        type: 'integer',
        extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Âge'] }] },
      }),
      [doc('Âge : 54 ans', { name: 'cr-hospitalisation.pdf' })],
    );
    assert.equal(hit?.evidence.documentName, 'cr-hospitalisation.pdf');
    assert.ok(hit?.evidence.snippet.includes('54'));
  });

  test('couvre les variantes d’apostrophe du libellé', () => {
    // Un même libellé saisi une fois doit fonctionner sur les trois formes
    // rencontrées en pratique, l’extraction PDF perdant souvent l’apostrophe.
    const f = field({
      type: 'integer',
      extraction: {
        enabled: true,
        rules: [{ kind: 'label', labels: ["Durée d'hospitalisation"] }],
      },
    });
    for (const variant of [
      "Durée d'hospitalisation : 12 jours",
      'Durée d’hospitalisation : 12 jours',
      'Duree d hospitalisation : 12 jours',
      'DUREE DHOSPITALISATION : 12 jours',
    ]) {
      assert.equal(extractField(f, [doc(variant)])?.value, 12, `échec sur « ${variant} »`);
    }
  });

  test('n’attrape pas un libellé inclus dans un autre mot', () => {
    // « Âge » ne doit pas être trouvé dans « Dépistage : 12 ».
    const hit = extractField(
      field({
        type: 'integer',
        extraction: { enabled: true, rules: [{ kind: 'label', labels: ['age'] }] },
      }),
      [doc('Dépistage : 12')],
    );
    assert.equal(hit, null);
  });
});

describe('règle mot-clé', () => {
  test('détecte un antécédent mentionné', () => {
    const hit = extractField(
      field({
        type: 'boolean',
        extraction: {
          enabled: true,
          rules: [{ kind: 'keyword', any: ['diabete', 'diabétique'], emit: true }],
        },
      }),
      [doc('Patient diabétique sous metformine.')],
    );
    assert.equal(hit?.value, true);
  });

  test('la négation empêche le faux positif', () => {
    const hit = extractField(
      field({
        type: 'boolean',
        extraction: {
          enabled: true,
          rules: [
            {
              kind: 'keyword',
              any: ['diabete', 'diabétique'],
              none: ['pas de', 'absence de'],
              emit: true,
            },
          ],
        },
      }),
      [doc('Antécédents : pas de diabète, pas d’HTA.')],
    );
    assert.equal(hit, null);
  });

  test('une occurrence niée n’empêche pas d’en trouver une valide plus loin', () => {
    // Le radical « diabet » couvre « diabète » comme « diabétique » : la
    // première occurrence est niée, la seconde doit être retenue.
    const hit = extractField(
      field({
        type: 'boolean',
        extraction: {
          enabled: true,
          rules: [{ kind: 'keyword', any: ['diabet'], none: ['pas de'], emit: true }],
        },
      }),
      [doc('Pas de diabète dans la famille. Le patient est diabétique depuis 2015.')],
    );
    assert.equal(hit?.value, true);
  });

  test('la négation est reconnue malgré l’élision et l’apostrophe', () => {
    // « pas d'HTA », « pas d’HTA » et « pas de HTA » expriment la même chose ;
    // le terme d'exclusion « pas de » doit couvrir les trois.
    const f = field({
      type: 'boolean',
      extraction: {
        enabled: true,
        rules: [{ kind: 'keyword', any: ['hta'], none: ['pas de'], emit: true }],
      },
    });
    for (const variant of ["Antécédents : pas d'HTA.", 'Antécédents : pas d’HTA.', 'Pas de HTA.']) {
      assert.equal(extractField(f, [doc(variant)]), null, `négation manquée sur « ${variant} »`);
    }
    // Une mention affirmée reste bien détectée.
    assert.equal(extractField(f, [doc('Patient suivi pour HTA.')])?.value, true);
  });

  test('une absence documentée peut valoir « Non » plutôt que vide', () => {
    const f = field({
      type: 'boolean',
      extraction: {
        enabled: true,
        rules: [
          {
            kind: 'keyword',
            any: ['diabete', 'diabétique'],
            none: ['pas de', 'absence de'],
            emit: true,
            emitIfNegated: false,
          },
        ],
      },
    });
    const negated = extractField(f, [doc('Antécédents : pas de diabète.')]);
    assert.equal(negated?.value, false, 'l’absence documentée doit être enregistrée');
    // La justification doit pointer sur la mention niée.
    assert.match(negated!.evidence.snippet, /pas de diabète/i);

    assert.equal(extractField(f, [doc('Patient diabétique.')])?.value, true);
    // Sans mention du tout, la variable reste vide : donnée manquante.
    assert.equal(extractField(f, [doc('Rien à signaler.')]), null);
  });

  test('la négation ne déborde pas sur l’élément suivant de la liste', () => {
    // Cas très fréquent : une liste d'antécédents où seul le premier est nié.
    // Sans limitation à la proposition, « pas de » contaminerait « HTA ».
    const text = 'Antécédents : pas de diabète, HTA sous traitement, pas de tabagisme.';
    const rule = (terms: string[]) =>
      field({
        type: 'boolean',
        extraction: {
          enabled: true,
          rules: [
            {
              kind: 'keyword',
              any: terms,
              none: ['pas de', 'absence de'],
              emit: true,
              emitIfNegated: false,
            },
          ],
        },
      });

    assert.equal(extractField(rule(['diabete', 'diabétique']), [doc(text)])?.value, false);
    assert.equal(extractField(rule(['hta']), [doc(text)])?.value, true);
    assert.equal(extractField(rule(['tabagisme', 'tabagique']), [doc(text)])?.value, false);
  });

  test('« ni » prolonge la négation à l’élément suivant', () => {
    const hit = extractField(
      field({
        type: 'boolean',
        extraction: {
          enabled: true,
          rules: [
            {
              kind: 'keyword',
              any: ['hta'],
              none: ['pas de'],
              emit: true,
              emitIfNegated: false,
            },
          ],
        },
      }),
      [doc("Antécédents : pas de diabète, ni d'HTA.")],
    );
    assert.equal(hit?.value, false);
  });

  test('une mention affirmée l’emporte sur une mention niée ailleurs', () => {
    const f = field({
      type: 'boolean',
      extraction: {
        enabled: true,
        rules: [
          {
            kind: 'keyword',
            any: ['diabete', 'diabétique'],
            none: ['pas de'],
            emit: true,
            emitIfNegated: false,
          },
        ],
      },
    });
    const hit = extractField(f, [
      doc('Pas de diabète dans la famille. Le patient est diabétique depuis 2015.'),
    ]);
    assert.equal(hit?.value, true);
  });

  test('les formes fléchies doivent être listées explicitement', () => {
    // « diabete » n’est pas contenu dans « diabetique » : le paramétrage doit
    // citer les deux formes, ce que fait la fiche livrée par défaut.
    const withOneForm = extractField(
      field({
        type: 'boolean',
        extraction: { enabled: true, rules: [{ kind: 'keyword', any: ['diabète'], emit: true }] },
      }),
      [doc('Patient diabétique.')],
    );
    assert.equal(withOneForm, null);

    const withBothForms = extractField(
      field({
        type: 'boolean',
        extraction: {
          enabled: true,
          rules: [{ kind: 'keyword', any: ['diabète', 'diabétique'], emit: true }],
        },
      }),
      [doc('Patient diabétique.')],
    );
    assert.equal(withBothForms?.value, true);
  });
});

describe('règles de repli', () => {
  test('la seconde règle prend le relais si la première ne trouve rien', () => {
    const hit = extractField(
      field({
        type: 'integer',
        extraction: {
          enabled: true,
          rules: [
            { kind: 'label', labels: ['Âge'] },
            { kind: 'regex', pattern: 'patient de (\\d{1,3}) ans' },
          ],
        },
      }),
      [doc('Il s’agit d’un patient de 47 ans admis en urgence.')],
    );
    assert.equal(hit?.value, 47);
    // La règle de repli est signalée comme légèrement moins fiable.
    assert.ok(hit!.confidence < 0.8);
  });

  test('une correspondance non typable laisse la main à la règle suivante', () => {
    const hit = extractField(
      field({
        type: 'integer',
        extraction: {
          enabled: true,
          rules: [
            { kind: 'label', labels: ['Âge'] },
            { kind: 'regex', pattern: '(\\d{1,3}) ans' },
          ],
        },
      }),
      [doc('Âge : non renseigné\nLe patient a 62 ans.')],
    );
    assert.equal(hit?.value, 62);
  });
});

describe('règle DICOM', () => {
  const dicomDoc = doc('', {
    kind: 'dicom',
    name: 'image.dcm',
    dicomTags: { PatientAge: '54', Modality: 'CT', StudyDate: '2024-03-15' },
  });

  test('lit un tag par son mot-clé', () => {
    const hit = extractField(
      field({
        type: 'integer',
        extraction: { enabled: true, rules: [{ kind: 'dicom', tag: 'PatientAge' }] },
      }),
      [dicomDoc],
    );
    assert.equal(hit?.value, 54);
  });

  test('convertit un code de modalité vers l’option de la fiche', () => {
    const hit = extractField(
      field({
        type: 'enum',
        options: ['Scanner', 'IRM'],
        extraction: {
          enabled: true,
          rules: [{ kind: 'dicom', tag: 'Modality' }],
          postProcess: { valueMap: { CT: 'Scanner', MR: 'IRM' } },
        },
      }),
      [dicomDoc],
    );
    assert.equal(hit?.value, 'Scanner');
  });

  test('une règle DICOM ignore les documents non DICOM', () => {
    const hit = extractField(
      field({
        extraction: { enabled: true, rules: [{ kind: 'dicom', tag: 'PatientAge' }] },
      }),
      [doc('PatientAge: 54')],
    );
    assert.equal(hit, null);
  });
});

describe('filtrage par nature de document', () => {
  test('la règle ne s’applique qu’aux natures autorisées', () => {
    const rules = field({
      extraction: {
        enabled: true,
        rules: [{ kind: 'label', labels: ['Âge'], docKinds: ['docx'] }],
      },
    });
    assert.equal(extractField(rules, [doc('Âge : 54', { kind: 'pdf' })]), null);
    assert.ok(extractField(rules, [doc('Âge : 54', { kind: 'docx' })]));
  });
});

describe('robustesse du moteur', () => {
  test('une expression régulière invalide n’interrompt pas l’extraction', () => {
    const hit = extractField(
      field({
        extraction: {
          enabled: true,
          rules: [
            { kind: 'regex', pattern: '([' },
            { kind: 'label', labels: ['Âge'] },
          ],
        },
      }),
      [doc('Âge : 54 ans')],
    );
    assert.equal(hit?.value, '54 ans');
  });

  test('un motif de largeur nulle ne boucle pas indéfiniment', () => {
    const hit = extractField(
      field({ extraction: { enabled: true, rules: [{ kind: 'regex', pattern: 'a*' }] } }),
      [doc('bbb')],
    );
    assert.equal(hit, null);
  });

  test('l’extraction désactivée ne produit rien', () => {
    const hit = extractField(
      field({ extraction: { enabled: false, rules: [{ kind: 'label', labels: ['Âge'] }] } }),
      [doc('Âge : 54')],
    );
    assert.equal(hit, null);
  });
});
