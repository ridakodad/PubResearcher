/**
 * Unités : une valeur écrite dans une autre unité que celle de la variable ne passe pas pour une valeur de la bonne unité.
 * « Créatinine : 85 µmol/L » dans une variable en mg/L était lue 85 mg/L, sans qu'aucun contrôle ne s'en aperçoive.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { coerce } from '../src/engine/coerce.js';

const number = (text: string, unit: string | null, post?: Parameters<typeof coerce>[3]) => coerce(text, 'number', [], post, unit);

describe('unité différente de celle de la variable', () => {
  test('µmol/L pour une variable en mg/L : écarté, avec les deux unités dans la raison', () => {
    const r = number('85 µmol/L', 'mg/L');
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /unité « µmol\/L » différente de « mg\/L »/);
    assert.match((r as { reason: string }).reason, /convertir/);
  });

  test('g/L pour une variable en g/dL, mg/dL pour mg/L, mmol/L pour µmol/L', () => {
    assert.equal(number('135 g/L', 'g/dL').ok, false);
    assert.equal(number('1,2 mg/dL', 'mg/L').ok, false);
    assert.equal(number('5 mmol/L', 'µmol/L').ok, false);
    assert.equal(number('98,6 °F', '°C').ok, false);
    assert.equal(number('12 mg', 'mg/L').ok, false, 'une dose n’est pas une concentration');
  });

  test('la même unité, quelle que soit l’écriture, passe', () => {
    assert.deepEqual(number('12 mg/L', 'mg/L'), { ok: true, value: 12 });
    assert.deepEqual(number('12 mg/l', 'mg/L'), { ok: true, value: 12 });
    assert.deepEqual(number('12 MG / L', 'mg/L'), { ok: true, value: 12 });
    assert.deepEqual(number('13,5 g/dL', 'g/dL'), { ok: true, value: 13.5 });
    assert.deepEqual(number('85 μmol/L', 'µmol/L'), { ok: true, value: 85 }, 'micro grec et micro latin');
    assert.deepEqual(number('37,5 °C', '°C'), { ok: true, value: 37.5 });
    assert.deepEqual(number('37,5 ºC', '°C'), { ok: true, value: 37.5 }, 'indicateur ordinal pris pour un degré');
    assert.deepEqual(number('98 %', '%'), { ok: true, value: 98 });
    assert.deepEqual(number('70 kg', 'kg'), { ok: true, value: 70 });
    assert.deepEqual(number('120 U/L', 'UI/L'), { ok: true, value: 120 }, 'U et UI désignent la même unité');
  });

  test('sans unité dans le texte, ou sans unité sur la variable, ou d’une unité inconnue : rien n’est refusé', () => {
    assert.deepEqual(number('12', 'mg/L'), { ok: true, value: 12 });
    assert.deepEqual(number('85 µmol/L', null), { ok: true, value: 85 });
    assert.deepEqual(number('85 µmol/L', ''), { ok: true, value: 85 });
    assert.deepEqual(number('4,7', '10³/mm³'), { ok: true, value: 4.7 });
    assert.deepEqual(number('4,7 G/L', '10³/mm³'), { ok: true, value: 4.7 }, 'unité de variable inconnue : pas de contrôle');
    assert.deepEqual(number('72 battements', 'mg/L'), { ok: true, value: 72 }, 'mot qui n’est pas une unité connue');
    assert.deepEqual(number('3 jours', 'mg/L'), { ok: true, value: 3 }, 'un mot de durée n’est pas une unité de concentration connue');
  });

  test('une unité composée qu’on ne sait pas lire d’un bloc ne fait rien refuser', () => {
    assert.deepEqual(number('12 mg.L-1', 'mg/L'), { ok: true, value: 12 });
    assert.deepEqual(number('12 mg·L⁻¹', 'mg/L'), { ok: true, value: 12 });
    assert.deepEqual(number('0,5 g/24h', 'g/L'), { ok: true, value: 0.5 });
    assert.deepEqual(number('12 mg/1', 'mg/L'), { ok: true, value: 12 }, 'le L lu 1 par la reconnaissance optique');
  });

  test('un facteur de conversion déclaré dit que la conversion est prise en charge : plus de contrôle', () => {
    assert.deepEqual(number('0,012 g/L', 'mg/L', { scale: 1000 }), { ok: true, value: 12 });
    assert.equal(number('0,012 g/L', 'mg/L').ok, false, 'sans facteur, la discordance est refusée');
  });

  test('les entiers et les bornes suivent le même chemin', () => {
    assert.equal(coerce('85 µmol/L', 'integer', [], undefined, 'mg/L').ok, false);
    assert.deepEqual(coerce('85 mg/L', 'integer', [], { min: 0, max: 200 }, 'mg/L'), { ok: true, value: 85 });
    const r = coerce('250 mg/L', 'integer', [], { min: 0, max: 200 }, 'mg/L');
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /au-dessus du maximum/);
  });

  test('les unités de temps gardent leur contrôle propre', () => {
    const r = coerce('6 mois', 'integer', [], undefined, 'ans');
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /unité « mois » différente de « ans »/);
  });
});
