/**
 * Logique pure de l'interface, testée ici faute de banc de test côté web : saisie des nombres et regroupement
 * des fichiers déposés. Ces fonctions n'ont aucune dépendance au navigateur.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatUsd, guessLang, modelLabel, parseNumberInput, numberToInput, sameValue } from '../../web/src/lib/format.js';
import { PRICES } from '../src/engine/pricing.js';
import { api, onDataWrite } from '../../web/src/lib/api.js';
import { EXPORTS } from '../../web/src/lib/exports.js';
import { detectStructure, groupItems, patientCodeOf } from '../../web/src/lib/grouping.js';

describe('saisie d’un nombre', () => {
  test('virgule française et point anglais donnent la même valeur, quelle que soit la langue du navigateur', () => {
    assert.deepEqual(parseNumberInput('36,6', false), { ok: true, value: 36.6 });
    assert.deepEqual(parseNumberInput('36.6', false), { ok: true, value: 36.6 });
    assert.deepEqual(parseNumberInput(' 12 ', true), { ok: true, value: 12 });
    assert.deepEqual(parseNumberInput('-3,2', false), { ok: true, value: -3.2 });
    assert.deepEqual(parseNumberInput('−3,2', false), { ok: true, value: -3.2 });
  });

  test('vide = pas de valeur ; signe seul ou virgule finale = saisie en cours, pas une faute', () => {
    assert.deepEqual(parseNumberInput('', false), { ok: true, value: null });
    assert.deepEqual(parseNumberInput('  ', false), { ok: true, value: null });
    assert.deepEqual(parseNumberInput('-', false), { ok: true, value: null });
    assert.deepEqual(parseNumberInput('12,', false), { ok: true, value: 12 });
  });

  test('ce qui n’est pas un nombre est refusé avec un message, jamais deviné', () => {
    for (const bad of ['12x', 'abc', '1e3', '0x10', '1 000', '1,2,3', '--3', 'Infinity', '12,5kg']) {
      const r = parseNumberInput(bad, false);
      assert.equal(r.ok, false, `« ${bad} » aurait dû être refusé`);
    }
    const decimal = parseNumberInput('12,5', true);
    assert.equal(decimal.ok, false);
    assert.match((decimal as { message: string }).message, /Entier/);
  });

  test('l’affichage reprend la virgule, et les choix multiples se comparent sans ordre', () => {
    assert.equal(numberToInput(12.5), '12,5');
    assert.equal(numberToInput(null), '');
    assert.equal(numberToInput('abc'), '');
    assert.equal(sameValue(['a', 'b'], ['a', 'b']), true);
    assert.equal(sameValue(null, null), true);
    assert.equal(sameValue(1, 2), false);
  });
});

const files = (paths: string[]) => paths.map((path) => ({ path }));

describe('regroupement des fichiers déposés', () => {
  const cohort = files([
    'cohorte/PAT-001/cr.pdf',
    'cohorte/PAT-001/bio/bilan.docx',
    'cohorte/PAT-002/cr.pdf',
    'cohorte/PAT-010/cr.pdf',
  ]);

  test('plusieurs dossiers déposés ensemble = un patient chacun, sans ambiguïté', () => {
    const items = files(['PAT-001/a.pdf', 'PAT-002/a.pdf', 'PAT-002/b.pdf']);
    assert.equal(detectStructure(items), null);
    assert.deepEqual(groupItems(items, null, 'cohort').map((g) => [g.code, g.files.length]), [
      ['PAT-001', 1],
      ['PAT-002', 2],
    ]);
  });

  test('un dossier qui contient des sous-dossiers est signalé, avec leurs noms', () => {
    const s = detectStructure(cohort);
    assert.ok(s);
    assert.equal(s.root, 'cohorte');
    assert.deepEqual(s.subfolders, ['PAT-001', 'PAT-002', 'PAT-010']);
  });

  test('lecture « cohorte » : chaque sous-dossier est un patient, dans l’ordre naturel', () => {
    const s = detectStructure(cohort);
    const groups = groupItems(cohort, s, 'cohort');
    assert.deepEqual(groups.map((g) => [g.code, g.files.length]), [['PAT-001', 2], ['PAT-002', 1], ['PAT-010', 1]]);
  });

  test('lecture « un seul patient » : tout va sous le nom du dossier déposé', () => {
    const groups = groupItems(cohort, detectStructure(cohort), 'single');
    assert.deepEqual(groups.map((g) => [g.code, g.files.length]), [['cohorte', 4]]);
  });

  test('les fichiers posés directement dans la racine attendent un code', () => {
    const items = files(['cohorte/lisez-moi.pdf', 'cohorte/A/x.pdf', 'cohorte/B/x.pdf']);
    const groups = groupItems(items, detectStructure(items), 'cohort');
    assert.deepEqual(groups.map((g) => g.code), ['', 'A', 'B']);
  });

  test('un dossier patient avec un seul sous-dossier n’est pas pris pour une cohorte', () => {
    const items = files(['PAT-001/scans/a.pdf', 'PAT-001/scans/b.pdf', 'PAT-001/cr.pdf']);
    // La question est posée, mais la lecture proposée est « un seul patient ».
    const structure = detectStructure(items)!;
    assert.equal(structure.suggested, 'single');
    assert.deepEqual(groupItems(items, structure, structure.suggested).map((g) => [g.code, g.files.length]), [['PAT-001', 3]]);
  });

  test('une cohorte d’un seul patient ne devient pas un dossier nommé « cohorte »', () => {
    const items = files(['cohorte/PAT-001/cr.pdf', 'cohorte/PAT-001/bio.docx']);
    const structure = detectStructure(items)!;
    assert.equal(structure.suggested, 'cohort');
    assert.deepEqual(groupItems(items, structure, structure.suggested).map((g) => g.code), ['PAT-001']);
  });

  test('des PDF posés dans un dossier « cohorte » : un fichier = un patient, nommé d’après le fichier', () => {
    const items = files(['cohorte/PAT-001.pdf', 'cohorte/PAT-002.pdf', 'cohorte/PAT-003.pdf']);
    const structure = detectStructure(items)!;
    assert.equal(structure.suggested, 'files');
    assert.deepEqual(groupItems(items, structure, 'files').map((g) => g.code), ['PAT-001', 'PAT-002', 'PAT-003']);
    // Et l'utilisateur peut toujours choisir « un seul patient ».
    assert.deepEqual(groupItems(items, structure, 'single').map((g) => g.code), ['cohorte']);
  });

  test('un fichier déposé seul (sans dossier) reste hors dossier', () => {
    const items = files(['a.pdf', 'b.pdf']);
    assert.equal(detectStructure(items), null);
    assert.equal(patientCodeOf('a.pdf', null, 'cohort'), '');
    assert.deepEqual(groupItems(items, null, 'cohort').map((g) => g.code), ['']);
  });
});

describe('langue d’un titre ou d’un résumé', () => {
  test('anglais et français reconnus, le doute ne déclare rien', () => {
    assert.equal(guessLang('Holmium laser enucleation of the prostate versus transurethral resection: a randomised trial'), 'en');
    assert.equal(guessLang('Outcomes of patients with type 2 diabetes in a cohort study'), 'en');
    assert.equal(guessLang('Étude du diabète de type 2 chez l’enfant dans une cohorte rétrospective'), 'fr');
    assert.equal(guessLang('Les résultats après énucléation de la prostate au laser'), 'fr');
    assert.equal(guessLang('Prostate'), undefined, 'trop court');
    assert.equal(guessLang('MeSH PMID 33445566 doi'), undefined, 'aucun mot grammatical');
    assert.equal(guessLang(null), undefined);
  });
});

describe('écran d’export', () => {
  test('la liste des exports est la source du compteur du plan de travail', () => {
    assert.equal(EXPORTS.length, 7);
    assert.equal(new Set(EXPORTS).size, EXPORTS.length);
  });
});

describe('coût et modèle affichés', () => {
  // Les espaces insécables de la typographie française (avant « $US », entre les milliers) comptent pour un espace.
  const usd = (n: number) => formatUsd(n).replace(/\s/gu, ' ');

  test('montants en dollars à la française, au centime', () => {
    assert.equal(usd(0.14), '0,14 $US');
    assert.equal(usd(2.91), '2,91 $US');
    assert.equal(usd(1234.5), '1 234,50 $US');
    assert.equal(usd(0), '0,00 $US');
  });

  test('sous le demi-centime, « moins de 0,01 $US » plutôt qu’un zéro trompeur', () => {
    assert.equal(usd(0.0049), 'moins de 0,01 $US');
    assert.equal(usd(0.0001), 'moins de 0,01 $US');
    assert.equal(usd(0.005), '0,01 $US');
  });

  test('chaque modèle du barème du serveur a un nom lisible ; un inconnu reste tel quel', () => {
    for (const id of Object.keys(PRICES)) assert.notEqual(modelLabel(id), id, `${id} sans nom lisible`);
    assert.equal(modelLabel('claude-opus-5-5'), 'Claude Opus 5.5');
    assert.equal(modelLabel('claude-futur-9'), 'claude-futur-9');
    assert.equal(modelLabel(null), 'Claude');
  });
});

describe('compteurs de l’espace de travail après une écriture', () => {
  test('une écriture réussie prévient l’espace de travail ; une lecture, un essai de règle ou un échec, non', async () => {
    const real = globalThis.fetch;
    let status = 200;
    globalThis.fetch = (async () =>
      status === 204
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify(status === 200 ? { patients: [] } : { error: 'refus' }), {
            status,
            headers: { 'content-type': 'application/json' },
          })) as typeof fetch;
    let writes = 0;
    const unsubscribe = onDataWrite(() => {
      writes += 1;
    });
    try {
      await api.listPatients();
      assert.equal(writes, 0, 'une lecture ne recompte rien');
      await api.testRule({ field: { key: 'x', label: 'X', type: 'text' }, sampleText: 'X : 1' });
      assert.equal(writes, 0, 'essayer une règle ne change aucune donnée');
      status = 204;
      await api.deletePatient(1);
      assert.equal(writes, 1, 'une suppression (204) recompte');
      status = 200;
      await api.createPatient({ code: 'PAT-1' });
      assert.equal(writes, 2, 'une création recompte');
      status = 400;
      await assert.rejects(api.createPatient({ code: '' }));
      assert.equal(writes, 2, 'une écriture refusée ne recompte pas');
      unsubscribe();
      status = 200;
      await api.createPatient({ code: 'PAT-2' });
      assert.equal(writes, 2, 'désabonné : plus de signal');
    } finally {
      unsubscribe();
      globalThis.fetch = real;
    }
  });
});
