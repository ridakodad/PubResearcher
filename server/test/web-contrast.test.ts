/**
 * Contrastes des jetons de couleur de l'interface (WCAG 2.2 AA), vérifiés sur la feuille de style elle-même — celle de
 * l'application et celle de la page d'accueil (landing/), qui en reprend les jetons.
 *
 * L'audit axe-core ne voit que les états affichés pendant l'audit ; ce test regarde les jetons, donc tous les couples
 * possibles : chaque encre de texte contre chaque surface, dans les deux thèmes (4,5:1), et la bordure des champs de
 * saisie contre leurs surfaces (3:1, critère 1.4.11 des composants d'interface).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Les deux feuilles de style qui portent les jetons : l'application, et la page d'accueil qui en reprend l'identité. */
const SHEETS: [sheet: string, file: string][] = [
  ['application', '../../web/src/styles.css'],
  ['page d’accueil', '../../landing/src/styles.css'],
];

for (const [sheet, file] of SHEETS) {
  const css = fs.readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');

  /** Contenu du bloc `{ … }` qui suit `opening` (accolades équilibrées). */
  function blockAfter(opening: string): string {
    const start = css.indexOf(opening);
    assert.ok(start >= 0, `bloc introuvable : ${opening}`);
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
    }
    throw new Error(`bloc non refermé : ${opening}`);
  }

  function tokens(block: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
    return out;
  }

  const light = tokens(blockAfter(':root {'));
  const darkExplicit = tokens(blockAfter(":root[data-theme='dark'] {"));
  const darkSystem = tokens(blockAfter("@media (prefers-color-scheme: dark) {").replace(/^[\s\S]*?\{/, ''));
  const dark = { ...light, ...darkExplicit };

  function channel(c: number): number {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }
  function luminance(hex: string): number {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  }
  function contrast(a: string, b: string): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  }

  /** Les arrêts hexadécimaux d'un dégradé : chacun est un fond possible sous le texte. */
  function stops(value: string | undefined): string[] {
    return value?.match(/#[0-9a-f]{6}/gi) ?? [];
  }

  /** Encres qui portent du texte, et surfaces sur lesquelles ce texte peut se trouver. */
  const INKS = [
    'text-primary', 'text-secondary', 'text-muted', 'brand', 'brand-strong', 'accent', 'accent-strong',
    'series-2', 'good-text', 'warning', 'serious', 'critical',
  ];
  const GROUNDS = ['plane', 'surface-1', 'surface-2', 'surface-3', 'brand-soft', 'accent-soft'];
  const FIELD_GROUNDS = ['plane', 'surface-1', 'surface-2', 'surface-3'];

  /** Couples encre / fond propres à un composant (pastille d'état, icône d'outil). */
  const PAIRS: [ink: string, ground: string][] = [
    ['critical', 'critical-soft'],
    ['violet', 'violet-soft'],
    ['brand-strong', 'series-1-soft'],
  ];

  for (const [name, theme] of [['clair', light], ['sombre', dark]] as const) {
    describe(`${sheet} : thème ${name}`, () => {
      test('chaque encre de texte atteint 4,5:1 sur chaque surface', () => {
        const below: string[] = [];
        for (const ink of INKS) {
          for (const ground of GROUNDS) {
            const [a, b] = [theme[ink], theme[ground]];
            assert.ok(a?.startsWith('#') && b?.startsWith('#'), `jeton manquant : ${ink} ou ${ground}`);
            const ratio = contrast(a!, b!);
            if (ratio < 4.5) below.push(`${ink} sur ${ground} : ${ratio.toFixed(2)}:1`);
          }
        }
        assert.deepEqual(below, []);
      });

      test('les couples propres aux composants atteignent 4,5:1 (état critique, icône d’outil, série)', () => {
        for (const [ink, ground] of PAIRS) {
          const [a, b] = [theme[ink], theme[ground]];
          assert.ok(a?.startsWith('#') && b?.startsWith('#'), `jeton manquant : ${ink} ou ${ground}`);
          assert.ok(contrast(a!, b!) >= 4.5, `${ink} sur ${ground} : ${contrast(a!, b!).toFixed(2)}:1`);
        }
      });

      test('le texte des boutons pleins atteint 4,5:1 sur chaque arrêt du dégradé de marque', () => {
        const grounds = stops(theme['brand-grad']);
        assert.ok(grounds.length >= 2, 'dégradé --brand-grad introuvable');
        for (const ground of grounds) {
          assert.ok(contrast(theme['on-brand']!, ground) >= 4.5, `${ground} : ${contrast(theme['on-brand']!, ground).toFixed(2)}:1`);
        }
      });

      test('la bordure d’un champ de saisie atteint 3:1 sur chaque surface (WCAG 1.4.11)', () => {
        const border = theme['control-border'];
        assert.ok(border?.startsWith('#'), 'jeton --control-border manquant');
        for (const ground of FIELD_GROUNDS) {
          assert.ok(contrast(border!, theme[ground]!) >= 3, `${ground} : ${contrast(border!, theme[ground]!).toFixed(2)}:1`);
        }
      });

      test('l’anneau de focus (la teinte de marque) atteint 3:1 sur chaque surface', () => {
        for (const ground of FIELD_GROUNDS) {
          assert.ok(contrast(theme['brand']!, theme[ground]!) >= 3, `${ground} : ${contrast(theme['brand']!, theme[ground]!).toFixed(2)}:1`);
        }
      });
    });
  }

  /*
   * Le rail et la carte d'en-tête sont sombres dans les deux thèmes : leurs encres sont donc les mêmes, et se
   * vérifient une fois, contre les fonds les plus clairs sur lesquels du texte peut se poser.
   */
  describe(`${sheet} : rail d’outils et carte d’en-tête (identiques dans les deux thèmes)`, () => {
    test('les encres du rail atteignent 4,5:1 sur le fond du rail, et le texte de l’outil actif sur son dégradé', () => {
      const night = light['night']!;
      for (const ink of ['rail-ink', 'rail-label']) {
        assert.ok(contrast(light[ink]!, night) >= 4.5, `${ink} : ${contrast(light[ink]!, night).toFixed(2)}:1`);
      }
      const active = stops(light['rail-active']);
      assert.ok(active.length >= 2, 'dégradé --rail-active introuvable');
      for (const ground of active) {
        assert.ok(contrast(light['rail-ink-strong']!, ground) >= 4.5, `${ground} : ${contrast(light['rail-ink-strong']!, ground).toFixed(2)}:1`);
      }
    });

    test('les encres de la carte d’en-tête atteignent 4,5:1 sur le point le plus clair du fond', () => {
      const ground = light['hero-ground']!;
      for (const ink of ['hero-ink', 'hero-ink-strong']) {
        assert.ok(contrast(light[ink]!, ground) >= 4.5, `${ink} sur ${ground} : ${contrast(light[ink]!, ground).toFixed(2)}:1`);
      }
      // L'étiquette en or ne se pose que sur la partie sombre, à gauche.
      assert.ok(contrast(light['hero-label']!, light['night']!) >= 4.5);
    });
  });

  test(`${sheet} : le thème sombre « système » (media query) et le thème sombre choisi (attribut) définissent les mêmes couleurs`, () => {
    for (const [key, value] of Object.entries(darkExplicit)) {
      if (!value.startsWith('#')) continue;
      assert.equal(darkSystem[key], value, `--${key}`);
    }
  });
}
