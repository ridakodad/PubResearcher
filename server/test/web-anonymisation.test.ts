/**
 * Charte d'anonymisation de l'interface (web/src/lib/anonymisation.ts) : la logique pure qui décide si l'engagement
 * a été pris, et ce que dit le texte. Le composant lui-même (AnonymisationGate) est vérifié dans le navigateur.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACK_KEY,
  ANONYMISATION_VERSION,
  CHARTER_ITEMS,
  CHARTER_LEAD,
  allConfirmed,
  isAcknowledged,
  parseAcknowledgement,
  serialiseAcknowledgement,
} from '../../web/src/lib/anonymisation.js';

describe('engagement d’anonymisation mémorisé', () => {
  test('ce qui vient d’être confirmé vaut engagement pour la version courante', () => {
    const raw = serialiseAcknowledgement(new Date('2026-10-10T12:00:00.000Z'));
    assert.equal(isAcknowledged(raw), true);
    assert.deepEqual(parseAcknowledgement(raw), { version: ANONYMISATION_VERSION, at: '2026-10-10T12:00:00.000Z' });
  });

  test('une version plus ancienne du texte est redemandée', () => {
    const raw = serialiseAcknowledgement(new Date('2026-10-10T12:00:00.000Z'), '2026-01-v0');
    assert.equal(isAcknowledged(raw), false);
    assert.equal(isAcknowledged(raw, '2026-01-v0'), true);
  });

  test('rien, du texte quelconque ou un objet mal formé ne valent jamais engagement', () => {
    for (const raw of [null, '', 'oui', '{', '[]', 'null', '42', '{"version":1,"at":"2026-10-10T12:00:00Z"}', `{"version":"${ANONYMISATION_VERSION}"}`, `{"version":"${ANONYMISATION_VERSION}","at":"pas une date"}`]) {
      assert.equal(isAcknowledged(raw), false, `« ${String(raw)} » ne doit pas valoir engagement`);
      assert.equal(parseAcknowledgement(raw), null);
    }
  });

  test('la clé de stockage ne change pas sans que les engagements déjà pris soient perdus en connaissance de cause', () => {
    assert.equal(ACK_KEY, 'anonymisation:ack');
  });
});

describe('charte', () => {
  test('chaque engagement est une phrase à la première personne, avec un identifiant unique', () => {
    const ids = CHARTER_ITEMS.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length >= 4, 'la charte ne doit pas être vidée');
    for (const item of CHARTER_ITEMS) {
      assert.match(item.id, /^[a-z-]+$/);
      assert.match(item.text, /\b(J’ai|Je|Chaque|Mon|Ma)\b/, `« ${item.id} » n’est pas formulé comme un engagement`);
    }
  });

  test('on ne continue que lorsque tout est coché', () => {
    const all = new Set(CHARTER_ITEMS.map((item) => item.id));
    assert.equal(allConfirmed(all), true);
    for (const item of CHARTER_ITEMS) {
      const missing = new Set(all);
      missing.delete(item.id);
      assert.equal(allConfirmed(missing), false, `sans « ${item.id} », la charte ne doit pas être confirmable`);
    }
    assert.equal(allConfirmed(new Set()), false);
    assert.equal(allConfirmed(new Set(['inconnu'])), false);
  });

  test('le texte dit ce qui compte : l’outil n’anonymise rien, et les identifiants à retirer sont nommés', () => {
    assert.match(CHARTER_LEAD, /n’anonymise rien/);
    const texte = CHARTER_ITEMS.map((item) => item.text).join('\n');
    for (const mot of ['nom et prénom', 'date de naissance', 'numéro de dossier', 'DICOM', 'Anthropic', 'comité d’éthique']) {
      assert.ok(texte.includes(mot), `la charte doit mentionner « ${mot} »`);
    }
  });
});
