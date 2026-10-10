/**
 * Expressions régulières saisies dans une fiche : une règle maladroite ne fige pas l'outil.
 *
 * Les motifs ci-dessous sont les cas d'école de l'explosion exponentielle ou polynomiale.
 * Aucun n'a besoin d'être « méchant » pour arriver dans une fiche : `(\w+\s?)+:` est ce qu'écrit
 * quelqu'un qui veut « des mots, puis deux-points ».
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pubresearcher-regex-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.OCR_ENABLED = '0';
process.env.REGEX_BUDGET_MS = '100';

const { riskOf, matchesOf, RegexTimeout, resetRegexGuard, isTripped } = await import('../src/engine/safe-regex.js');
const { extractFieldDetailed } = await import('../src/engine/rules.js');
const { createApp } = await import('../src/app.js');
const { seedIfEmpty } = await import('../src/db/seed.js');
import type { SourceDoc } from '../src/engine/rules.js';
import type { TemplateField } from '../src/domain/types.js';

let server: Server;
let baseUrl = '';

before(async () => {
  seedIfEmpty();
  await new Promise<void>((resolve) => {
    server = createApp().listen(0, () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { db } = await import('../src/db/index.js');
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => resetRegexGuard());

const compile = (pattern: string, flags = 'giu'): RegExp => new RegExp(pattern, flags);

describe('repérage des motifs à risque', () => {
  const risky: [string, string][] = [
    ['(a+)+$', 'imbriqués'],
    ['(\\w+\\s?)+:', 'imbriqués'],
    ['(a*)*b', 'imbriqués'],
    ['(.*a){12}', 'motif lui-même ouvert'],
    ['(a|aa)+$', 'alternative'],
    ['(?:foo|foobar)*x', 'alternative'],
    ['(a)\\1', 'référence arrière'],
    ['\\d+\\d+\\d+\\d+\\d+y', 'qui s’enchaînent'],
    ['.*a.*b.*c.*d', '« .\\* » dans un même motif'],
    ['(?=(a+)+)x', 'imbriqués'],
  ];
  for (const [pattern, why] of risky) {
    test(`/${pattern}/ est signalé (${why})`, () => {
      const reason = riskOf(pattern, 'giu');
      assert.ok(reason, `/${pattern}/ aurait dû être signalé`);
      assert.match(reason, new RegExp(why, 'i'));
    });
  }

  const safe = [
    'Âge\\s*:\\s*(\\d+)',
    '(\\d{1,3}(?:[  ]\\d{3})+(?:[.,]\\d+)?)',
    '\\b(?:oui|non)\\b',
    '^[A-Z]{2}\\d{6}$',
    '(\\d+)[.,](\\d+)',
    'poids\\s*[:=]\\s*(\\d+(?:[.,]\\d+)?)\\s*kg',
    '(\\d{3})+',
    '(?:\\d{2}/){2}\\d{4}',
    '[^\\n]*:',
    'tabac(?:isme)?\\s*:?\\s*(actif|sevr[ée])',
  ];
  for (const pattern of safe) {
    test(`/${pattern}/ passe sans surveillance`, () => {
      assert.equal(riskOf(pattern, 'giu'), null);
    });
  }

  test('« .* » répété n’inquiète qu’avec le drapeau s, où il traverse les lignes', () => {
    assert.equal(riskOf('a.*b.*c', 'giu'), null);
    assert.match(riskOf('a.*b.*c', 'gius') ?? '', /drapeau s/);
  });

  test('les classes, échappements et accolades littérales ne sont pas pris pour des quantificateurs', () => {
    assert.equal(riskOf('[+*?]+\\+\\*\\?', 'giu'), null);
    assert.equal(riskOf('\\p{L}+\\s{1,3}\\p{N}+', 'giu'), null);
    assert.equal(riskOf('a{,3}b', 'gi'), null, '« {,3} » est un texte, pas un quantificateur');
  });
});

describe('exécution sous chronomètre', () => {
  test('un motif exponentiel est interrompu dans le délai, pas au bout de plusieurs heures', () => {
    const text = 'a'.repeat(60) + '!';
    const started = Date.now();
    assert.throws(
      () => matchesOf(compile('(a+)+$'), '(a+)+$', text),
      (error: unknown) => error instanceof RegexTimeout && /interrompue après 100 ms.*imbriqués/.test(error.message),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1500, `interrompu en ${elapsed} ms`);
  });

  test('le motif interrompu est disjoncté : les évaluations suivantes échouent aussitôt', () => {
    const text = 'a'.repeat(60) + '!';
    const re = compile('(a+)+$');
    assert.throws(() => matchesOf(re, '(a+)+$', text), RegexTimeout);
    assert.ok(isTripped('(a+)+$', re.flags));
    const started = performance.now();
    for (let i = 0; i < 50; i++) assert.throws(() => matchesOf(re, '(a+)+$', text), RegexTimeout);
    assert.ok(performance.now() - started < 50, 'cinquante refus doivent coûter presque rien');
  });

  test('un motif à risque qui réussit rend ses correspondances comme un autre', () => {
    const found = matchesOf(compile('(\\d+)(?:[.,]\\d+)?\\s*(?:mg|g)/(?:L|dL)'), '(\\d+)(?:[.,]\\d+)?\\s*(?:mg|g)/(?:L|dL)', 'CRP 12,5 mg/L puis 3 g/dL');
    assert.deepEqual(found.map((m) => m[0]), ['12,5 mg/L', '3 g/dL']);

    const alt = matchesOf(compile('(?:oui|non)+', 'giu'), '(?:oui|non)+', 'oui non ouinon');
    assert.deepEqual(alt.map((m) => m[0]), ['oui', 'non', 'ouinon']);
  });

  test('un motif de largeur nulle ne boucle pas', () => {
    const found = matchesOf(compile('x*'), 'x*', 'aaxbb');
    assert.ok(found.length > 0 && found.length < 10);
  });

  test('un motif qui se révèle lent alors que l’analyse le croyait sain passe sous surveillance pour la suite', () => {
    // Trois quantificateurs ouverts : sous le seuil de l'analyse, mais en O(n⁴) sur une longue suite de chiffres.
    // 250 chiffres coûtent environ 1,5 s ici (900 en coûtaient plus de 4 minutes : un test qui fige la suite ne prouve rien).
    const pattern = '\\d*\\d*\\d*x';
    assert.equal(riskOf(pattern, 'giu'), null);
    const text = '1'.repeat(250) + 'y';
    const re = compile(pattern);
    const first = performance.now();
    matchesOf(re, pattern, text); // subie : l'analyse ne l'a pas vu venir
    const firstMs = performance.now() - first;
    assert.ok(firstMs > 100, `la première évaluation devait dépasser le budget de 100 ms pour que ce test prouve quelque chose (${Math.round(firstMs)} ms)`);
    assert.throws(() => matchesOf(re, pattern, text), RegexTimeout, 'la seconde évaluation doit être interrompue');
  });
});

describe('dans une fiche', () => {
  const field = (rules: TemplateField['extraction']['rules'], type: TemplateField['type'] = 'integer'): TemplateField => ({
    id: 1,
    templateId: 1,
    key: 'age',
    label: 'Âge',
    type,
    section: 'Général',
    unit: 'ans',
    description: null,
    required: false,
    options: [],
    position: 0,
    extraction: { enabled: true, rules },
  });
  const doc = (text: string, id = 1): SourceDoc => ({
    id,
    name: `cr-${id}.txt`,
    kind: 'text',
    text,
    dicomTags: {},
  });

  test('une règle qui s’emballe est écartée avec sa raison, la règle suivante trouve la valeur', () => {
    const started = Date.now();
    const result = extractFieldDetailed(
      field([
        { kind: 'regex', pattern: '(\\w+\\s?)+:' },
        { kind: 'label', labels: ['Âge'] },
      ]),
      [doc('mot '.repeat(40) + 'sans deux-points\nÂge : 54 ans')],
    );
    assert.ok(Date.now() - started < 2000);
    assert.equal(result.hit?.value, 54, 'la règle de repli doit avoir répondu');
    assert.deepEqual(result.rejected, [], 'une valeur trouvée par la suite efface les écarts');
  });

  test('sans règle de repli, la variable reste vide mais l’interruption est visible', () => {
    const result = extractFieldDetailed(
      field([{ kind: 'regex', pattern: '(a+)+$' }], 'text'),
      [doc('a'.repeat(60) + '!', 1), doc('a'.repeat(60) + '!', 2)],
    );
    assert.equal(result.hit, null);
    assert.ok(result.rejected.length >= 1);
    assert.match(result.rejected[0]!.reason, /interrompue.*imbriqués.*Simplifiez/);
    assert.match(result.rejected[0]!.rule, /expression régulière/);
  });

  test('sur cinq cents documents, le motif disjoncté ne coûte pas cinq cents délais', () => {
    const docs = Array.from({ length: 500 }, (_, i) => doc('a'.repeat(60) + '!', i + 1));
    const started = Date.now();
    const result = extractFieldDetailed(field([{ kind: 'regex', pattern: '(a+)+$' }], 'text'), docs);
    const elapsed = Date.now() - started;
    assert.equal(result.hit, null);
    assert.ok(elapsed < 2000, `${elapsed} ms : le disjoncteur n’a pas joué`);
  });

  test('les motifs ordinaires donnent les mêmes résultats qu’avant', () => {
    const rule = { kind: 'regex' as const, pattern: 'âge\\s*[:=]?\\s*(\\d{1,3})\\s*ans' };
    const result = extractFieldDetailed(field([rule]), [doc('Patient, âge : 61 ans, adressé pour toux.')]);
    assert.equal(result.hit?.value, 61);
    assert.match(result.hit!.evidence.snippet, /61 ans/);
  });
});

describe('par l’API', () => {
  test('le banc d’essai répond vite avec un motif catastrophique, puis le serveur reste disponible', async () => {
    const started = Date.now();
    const res = await fetch(`${baseUrl}/api/templates/fields/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        field: {
          key: 'redos',
          label: 'Test',
          type: 'text',
          extraction: { enabled: true, rules: [{ kind: 'regex', pattern: '(a+)+$' }] },
        },
        sampleText: 'a'.repeat(60) + '!',
      }),
    });
    const elapsed = Date.now() - started;
    assert.equal(res.status, 200);
    const data = (await res.json()) as { found: boolean; rejected?: { reason: string }[] };
    assert.equal(data.found, false);
    assert.match(JSON.stringify(data.rejected ?? []), /interrompue/);
    assert.ok(elapsed < 3000, `réponse en ${elapsed} ms`);
    assert.equal((await fetch(`${baseUrl}/api/health`)).status, 200);
  });
});
