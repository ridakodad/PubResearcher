/**
 * Tests du mode d'extraction assisté par Claude.
 *
 * L'appel réseau lui-même n'est pas exercé : ce qui est vérifié ici, c'est
 * tout ce qui l'entoure — le schéma imposé au modèle, la vérification des
 * citations, et le tri entre valeurs retenues et valeurs écartées. C'est cette
 * couche qui protège le jeu de données d'une valeur inventée.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildOutputSchema, buildSystemPrompt, buildUserPrompt, documentAlias } from '../src/engine/llm-schema.js';
import { locateEvidence } from '../src/engine/llm-verify.js';
import { interpret } from '../src/engine/llm.js';
import type { TemplateField } from '../src/domain/types.js';
import type { SourceDoc } from '../src/engine/rules.js';

function field(overrides: Partial<TemplateField> & { key: string }): TemplateField {
  return {
    id: 1,
    templateId: 1,
    label: overrides.key,
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

const noUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

describe('schéma imposé au modèle', () => {
  const fields = [
    field({ key: 'age', label: 'Âge', type: 'integer', unit: 'ans' }),
    field({ key: 'sexe', label: 'Sexe', type: 'enum', options: ['Masculin', 'Féminin'], id: 2 }),
  ];

  test('chaque variable est obligatoire dans la réponse', () => {
    const schema = buildOutputSchema(fields) as any;
    assert.deepEqual(schema.properties.fields.required, ['age', 'sexe']);
    // Interdire les propriétés supplémentaires évite qu'une variable
    // inventée par le modèle se glisse dans le jeu de données.
    assert.equal(schema.properties.fields.additionalProperties, false);
  });

  test('chaque variable exige valeur, citation et document', () => {
    const schema = buildOutputSchema(fields) as any;
    const age = schema.properties.fields.properties.age;
    assert.deepEqual(age.required, ['value', 'quote', 'document']);
    assert.equal(age.additionalProperties, false);
  });

  test('les options d’une variable à choix sont transmises au modèle', () => {
    const schema = buildOutputSchema(fields) as any;
    const sexe = schema.properties.fields.properties.sexe.properties.value.description;
    assert.match(sexe, /Masculin \| Féminin/);
  });

  test('la consigne décrit toutes les variables et leurs sections', () => {
    const prompt = buildSystemPrompt(fields, 'Fiche test');
    assert.match(prompt, /Fiche test/);
    assert.match(prompt, /- age — Âge/);
    assert.match(prompt, /- sexe — Sexe/);
    // La règle anti-invention doit être présente : c'est elle qui rend la
    // vérification des citations exploitable.
    assert.match(prompt, /recopiée mot pour mot/);
  });

  test('les documents trop longs sont tronqués et signalés comme tels', () => {
    const prompt = buildUserPrompt([{ name: 'Document 1', text: 'a'.repeat(500) }], 100);
    assert.match(prompt, /\[document tronqué\]/);
    assert.ok(prompt.length < 400, 'le texte doit être coupé');
  });

  test('le message ne porte ni code de dossier ni nom de fichier : les documents sont présentés sous des alias', () => {
    const prompt = buildUserPrompt(
      [
        { name: documentAlias(0), text: 'Âge : 54 ans' },
        { name: documentAlias(1), text: 'Sexe : féminin' },
      ],
      1000,
    );
    assert.match(prompt, /<document nom="Document 1">\nÂge : 54 ans\n<\/document>/);
    assert.match(prompt, /<document nom="Document 2">/);
    assert.doesNotMatch(prompt, /PAT-|\.pdf|\.txt|DUPONT/);
  });
});

describe('vérification des citations', () => {
  const documents = [doc('Compte rendu.\nÂge : 54 ans.\nSexe : Masculin.')];

  test('une citation exacte est localisée', () => {
    const found = locateEvidence(documents, 'Âge : 54 ans', '54', 'cr.pdf');
    assert.ok(found);
    assert.equal(found.method, 'quote');
    assert.equal(found.documentName, 'cr.pdf');
    assert.match(found.snippet, /54 ans/);
  });

  test('les différences d’espaces et de casse sont tolérées', () => {
    // Un modèle recopie rarement les sauts de ligne d'un PDF à l'identique.
    const found = locateEvidence(documents, 'age :   54   ANS', '54', 'cr.pdf');
    assert.ok(found, 'la citation doit être retrouvée malgré la mise en forme');
    assert.equal(found.method, 'quote');
  });

  test('une citation inventée n’est pas localisée', () => {
    const found = locateEvidence(
      documents,
      'Le patient est diabétique depuis dix ans',
      'Oui',
      'cr.pdf',
    );
    assert.equal(found, null);
  });

  test('à défaut de citation, la valeur elle-même est recherchée', () => {
    const found = locateEvidence(documents, '', 'Masculin', 'cr.pdf');
    assert.ok(found);
    assert.equal(found.method, 'value');
  });

  test('la recherche couvre tous les documents du dossier', () => {
    const multi = [doc('Rien ici.'), doc('Créatinine : 9,8 mg/L', { id: 2, name: 'bio.docx' })];
    const found = locateEvidence(multi, 'Créatinine : 9,8', '9.8', 'bio.docx');
    assert.ok(found);
    assert.equal(found.documentId, 2);
  });

  test('l’extrait restitué vient du document, pas de la réponse du modèle', () => {
    // Le modèle a écrit la citation sans accent ; l'extrait affiché doit
    // rester celui du dossier.
    const found = locateEvidence(documents, 'Age : 54 ans', '54', 'cr.pdf');
    assert.ok(found);
    assert.match(found.snippet, /Âge/);
  });
});

describe('tri des valeurs proposées par le modèle', () => {
  const fields = [
    field({ key: 'age', label: 'Âge', type: 'integer', extraction: { enabled: true, rules: [], postProcess: { min: 0, max: 120 } } }),
    field({ key: 'sexe', label: 'Sexe', type: 'enum', options: ['Masculin', 'Féminin'], id: 2 }),
    field({ key: 'notes', label: 'Notes', type: 'text', id: 3 }),
  ];
  const documents = [doc('Âge : 54 ans. Sexe : Masculin.')];

  test('une valeur justifiée et typable est retenue', () => {
    const result = interpret(
      fields,
      documents,
      {
        fields: {
          age: { value: '54', quote: 'Âge : 54 ans', document: 'cr.pdf' },
          sexe: { value: 'Masculin', quote: 'Sexe : Masculin', document: 'cr.pdf' },
          notes: { value: '', quote: '', document: '' },
        },
      },
      noUsage,
    );

    assert.equal(result.values.length, 2);
    assert.equal(result.values[0]!.value, 54);
    assert.equal(result.values[1]!.value, 'Masculin');
    assert.deepEqual(result.notFound, ['notes']);
    assert.equal(result.values[0]!.evidence.rule.startsWith('Claude'), true);
  });

  test('une valeur sans citation retrouvable est écartée', () => {
    const result = interpret(
      fields,
      documents,
      {
        fields: {
          age: { value: '77', quote: 'Le patient a 77 ans', document: 'cr.pdf' },
          sexe: { value: '', quote: '', document: '' },
          notes: { value: '', quote: '', document: '' },
        },
      },
      noUsage,
    );

    assert.equal(result.values.length, 0, 'aucune valeur ne doit être enregistrée');
    assert.equal(result.unverified.length, 1);
    assert.equal(result.unverified[0]!.key, 'age');
  });

  test('une valeur hors des bornes de la fiche est écartée', () => {
    const result = interpret(
      fields,
      documents,
      {
        fields: {
          age: { value: '540', quote: 'Âge : 54 ans', document: 'cr.pdf' },
          sexe: { value: '', quote: '', document: '' },
          notes: { value: '', quote: '', document: '' },
        },
      },
      noUsage,
    );
    assert.equal(result.values.length, 0);
    assert.equal(result.invalid.length, 1);
    assert.match(result.invalid[0]!.reason, /maximum/);
  });

  test('une option hors liste est écartée', () => {
    const result = interpret(
      fields,
      documents,
      {
        fields: {
          age: { value: '', quote: '', document: '' },
          sexe: { value: 'Non binaire', quote: 'Sexe : Masculin', document: 'cr.pdf' },
          notes: { value: '', quote: '', document: '' },
        },
      },
      noUsage,
    );
    assert.equal(result.values.length, 0);
    assert.equal(result.invalid.length, 1);
    assert.equal(result.invalid[0]!.key, 'sexe');
  });

  test('une variable absente de la réponse compte comme non trouvée', () => {
    const result = interpret(fields, documents, { fields: {} } as never, noUsage);
    assert.equal(result.values.length, 0);
    assert.equal(result.notFound.length, 3);
  });

  test('la confiance distingue citation retrouvée et valeur seulement localisée', () => {
    const quoted = interpret(
      fields,
      documents,
      {
        fields: {
          age: { value: '', quote: '', document: '' },
          sexe: { value: 'Masculin', quote: 'Sexe : Masculin', document: 'cr.pdf' },
          notes: { value: '', quote: '', document: '' },
        },
      },
      noUsage,
    );
    const unquoted = interpret(
      fields,
      documents,
      {
        fields: {
          age: { value: '', quote: '', document: '' },
          sexe: { value: 'Masculin', quote: '', document: '' },
          notes: { value: '', quote: '', document: '' },
        },
      },
      noUsage,
    );
    assert.equal(quoted.values[0]!.confidence, 0.9);
    assert.equal(unquoted.values[0]!.confidence, 0.75);
  });

  test('une valeur courte sans citation est écartée', () => {
    // « 54 » se retrouverait n'importe où dans un compte rendu : le localiser
    // ne justifie rien. Une valeur courte exige une vraie citation.
    const result = interpret(
      fields,
      documents,
      {
        fields: {
          age: { value: '54', quote: '', document: '' },
          sexe: { value: '', quote: '', document: '' },
          notes: { value: '', quote: '', document: '' },
        },
      },
      noUsage,
    );
    assert.equal(result.values.length, 0);
    assert.equal(result.unverified.length, 1);
  });
});
