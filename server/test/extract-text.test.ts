/**
 * Formats « texte » des exports hospitaliers : encodages, RTF, HTML.
 * Chaque cas reproduit un fichier réel qui, lu naïvement, faisait disparaître les accents
 * ou noyait le texte sous du balisage — et donc les valeurs que les règles cherchent.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decodeText, decodeWindows1252, htmlToText, looksLikeHtml, looksLikeRtf, rtfToText } from '../src/extract/text.js';
import { parseDocument } from '../src/extract/index.js';
import { extractField, type SourceDoc } from '../src/engine/rules.js';
import type { TemplateField } from '../src/domain/types.js';

const FRENCH = 'Âge : 54 ans — hémoglobine à 11,2 g/dL, œdème, ça va à l’été';

describe('détection de l’encodage', () => {
  test('UTF-8 sans nomenclature', () => {
    assert.deepEqual(decodeText(Buffer.from(FRENCH, 'utf8')), { text: FRENCH, charset: 'utf-8' });
  });

  test('UTF-8 avec nomenclature : la nomenclature n’apparaît pas dans le texte', () => {
    const r = decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(FRENCH, 'utf8')]));
    assert.equal(r.text, FRENCH);
    assert.equal(r.charset, 'utf-8');
  });

  test('Windows-1252 : « Âge » reste « Âge » au lieu de devenir « �ge »', () => {
    const latin = Buffer.from('Âge : 54 ans — hémoglobine à 11,2, œdème, ça va', 'latin1');
    // latin1 ne connaît ni « — » ni « œ » : on construit les octets Windows-1252 à la main.
    const cp1252 = Buffer.from([
      ...Buffer.from('Âge : 54 ans ', 'latin1'), 0x97, ...Buffer.from(' h', 'latin1'), 0xe9,
      ...Buffer.from('moglobine, ', 'latin1'), 0x9c, ...Buffer.from('d', 'latin1'), 0xe8, ...Buffer.from('me', 'latin1'),
    ]);
    const r = decodeText(cp1252);
    assert.equal(r.charset, 'windows-1252');
    assert.equal(r.text, 'Âge : 54 ans — hémoglobine, œdème');
    assert.ok(latin.length > 0);
  });

  // Les octets 0x80 à 0x9F de Windows-1252 : la table du standard d'encodage WHATWG, écrite ici en caractères (la source
  // la donne en numéros). Le TextDecoder de Node 22.13 à 22.21 rend ces octets en caractères de contrôle invisibles.
  const CP1252_OCTETS = [
    0x80, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8e,
    0x91, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9e, 0x9f,
  ];
  const CP1252_CARACTERES = ['€', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', 'Ž', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', 'ž', 'Ÿ'];

  test('Windows-1252 : chacun des octets 0x80 à 0x9F rend son caractère, quelle que soit la version de Node', () => {
    assert.equal(CP1252_OCTETS.length, CP1252_CARACTERES.length);
    CP1252_OCTETS.forEach((octet, i) => {
      const r = decodeText(Buffer.from([octet]));
      assert.equal(r.charset, 'windows-1252');
      assert.equal(r.text, CP1252_CARACTERES[i], `octet 0x${octet.toString(16)}`);
    });
    // Les cinq octets sans caractère restent le contrôle de même numéro ; au-dessus de 0xA0, c'est de l'ISO-8859-1.
    for (const octet of [0x81, 0x8d, 0x8f, 0x90, 0x9d]) assert.equal(decodeText(Buffer.from([octet])).text, String.fromCharCode(octet));
    for (let octet = 0xa0; octet <= 0xff; octet++) {
      assert.equal(decodeText(Buffer.from([octet])).text, String.fromCharCode(octet), `octet 0x${octet.toString(16)}`);
    }
  });

  test('Windows-1252 : mêmes 256 octets que le TextDecoder de la plateforme quand celui-ci applique la table', (t) => {
    const reference = new TextDecoder('windows-1252');
    if (reference.decode(Uint8Array.of(0x97)) !== '—') {
      t.skip('le TextDecoder « windows-1252 » de cette version de Node rend 0x97 en caractère de contrôle : référence inutilisable');
      return;
    }
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    assert.equal(decodeWindows1252(all), reference.decode(all));
  });

  test('Windows-1252 : l’apostrophe, les guillemets, le tiret et le « € » de Word survivent', () => {
    const latin1 = (text: string): number[] => [...Buffer.from(text, 'latin1')];
    const bytes = Buffer.from([
      ...latin1('L'), 0x92, ...latin1('examen '), 0x93, ...latin1('normal'), 0x94, ...latin1(' '), 0x96, ...latin1(' 12'), 0x85, ...latin1(' '), 0x80,
    ]);
    assert.equal(decodeText(bytes).text, 'L’examen “normal” – 12… €');
  });

  test('UTF-16 avec nomenclature, petit et gros boutiste', () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(FRENCH, 'utf16le')]);
    assert.deepEqual(decodeText(le), { text: FRENCH, charset: 'utf-16le' });
    const be = Buffer.from(FRENCH, 'utf16le');
    be.swap16();
    assert.deepEqual(decodeText(Buffer.concat([Buffer.from([0xfe, 0xff]), be])), { text: FRENCH, charset: 'utf-16be' });
  });

  test('UTF-16 sans nomenclature, reconnu aux octets nuls', () => {
    const r = decodeText(Buffer.from('Sexe : féminin. Âge : 54 ans.', 'utf16le'));
    assert.equal(r.charset, 'utf-16le');
    assert.equal(r.text, 'Sexe : féminin. Âge : 54 ans.');
  });

  test('de l’ASCII pur est de l’UTF-8', () => {
    assert.equal(decodeText(Buffer.from('Age: 54')).charset, 'utf-8');
  });
});

describe('RTF', () => {
  // Chaînes ordinaires, barres obliques doublées : `String.raw` n'est pas fiable sous le
  // transpileur des tests, qui l'évalue et rend « \u8211 » en un caractère.
  const rtf = [
    "{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\fnil Arial;}}{\\colortbl;\\red0\\green0\\blue0;}",
    "{\\*\\generator Msftedit 5.41;}\\viewkind4\\uc1\\pard\\f0\\fs20 COMPTE RENDU D'HOSPITALISATION\\par",
    "\\'c2ge : 54 ans\\par",
    "Diagnostic : \\u339?dème pulmonaire \\u8211? \\u27721?\\par",
    "H\\'e9moglobine : 11,2 g/dL\\par}",
  ].join('\n');

  test('reconnu à sa signature, quelle que soit l’extension', () => {
    assert.equal(looksLikeRtf(Buffer.from(rtf)), true);
    assert.equal(looksLikeRtf(Buffer.from('Age : 54')), false);
  });

  test('les accents (\\\'e9), l’Unicode (\\u339?) et ses caractères de repli sont décodés', () => {
    const text = rtfToText(rtf);
    assert.match(text, /Âge : 54 ans/);
    assert.match(text, /Diagnostic : œdème pulmonaire – 汉\n/); // le « ? » de repli après chaque \uN est avalé
    assert.match(text, /Hémoglobine : 11,2 g\/dL/);
  });

  test('les octets \\\'80 à \\\'9f (apostrophe, guillemets, tirets, œ, €) suivent la table Windows-1252', () => {
    const text = rtfToText("{\\rtf1\\ansi l\\'92examen \\'93normal\\'94 \\'96 \\'9cd\\'e8me \\'97 12\\'85 \\'80}");
    assert.equal(text, 'l’examen “normal” – œdème — 12… €');
  });

  test('les tables de polices, de couleurs et le générateur ne sont pas du texte', () => {
    const text = rtfToText(rtf);
    assert.doesNotMatch(text, /Arial|Msftedit|colortbl|fonttbl|viewkind/);
  });

  test('un tableau devient « libellé : valeur » ligne par ligne', () => {
    const table =
      "{\\rtf1\\ansi{\\trowd\\cellx3000\\cellx6000 Sexe\\cell F\\'e9minin\\cell\\row}{\\trowd\\cellx3000\\cellx6000 \\'c2ge\\cell 54\\cell\\row}}";
    assert.equal(rtfToText(table), 'Sexe : Féminin\nÂge : 54');
  });

  test('les accolades et barres obliques échappées sont du texte', () => {
    assert.equal(rtfToText('{\\rtf1 a \\{b\\} c \\\\ d}'), 'a {b} c \\ d');
  });

  test('un RTF vide ou tronqué ne plante pas', () => {
    assert.equal(rtfToText('{\\rtf1'), '');
    assert.equal(rtfToText('{\\rtf1 texte{\\b gras'), 'textegras');
  });

  test('\\uc0 : pas de caractère de repli à avaler', () => {
    assert.equal(rtfToText('{\\rtf1\\uc0 a\\u233 b}'), 'aéb');
  });
});

describe('HTML', () => {
  const html = `<!DOCTYPE html><html><head><title>CR</title><style>p{color:red}</style>
    <script>var secret = "Age : 99";</script></head>
    <body><h1>Compte rendu</h1><table><tr><td>Sexe</td><td>F&eacute;minin</td></tr>
    <tr><td>&Acirc;ge</td><td>54&nbsp;ans</td></tr></table>
    <!-- commentaire --><p>H&#233;moglobine&#160;: 11,2&nbsp;g/dL &amp; CRP &lt; 5</p></body></html>`;

  test('scripts, styles et commentaires disparaissent', () => {
    const text = htmlToText(html);
    assert.doesNotMatch(text, /secret|Age : 99|color:red|commentaire|<\/?[a-z]/i);
  });

  test('les entités nommées et numériques sont décodées', () => {
    const text = htmlToText(html);
    assert.match(text, /Féminin/);
    assert.match(text, /Hémoglobine : 11,2 g\/dL & CRP < 5/);
  });

  test('les cellules deviennent « libellé : valeur »', () => {
    const text = htmlToText(html);
    assert.match(text, /Sexe : Féminin\nÂge : 54 ans\n/);
  });

  test('un tableau indenté dans le source ne produit pas de lignes vides', () => {
    assert.doesNotMatch(htmlToText(html), /\n\n/);
  });

  test('<pre> garde ses sauts de ligne', () => {
    assert.equal(htmlToText('<pre>Age: 54\n  Sexe: F</pre>'), 'Age: 54\n  Sexe: F');
  });

  test('une entité inconnue reste telle quelle plutôt que de disparaître', () => {
    assert.equal(htmlToText('a &inconnue; b'), 'a &inconnue; b');
    assert.equal(htmlToText('&#x1F600;').codePointAt(0), 0x1f600);
    assert.equal(htmlToText('&#99999999;'), '&#99999999;');
  });

  test('reconnaissance du HTML dans un texte', () => {
    assert.equal(looksLikeHtml(html), true);
    assert.equal(looksLikeHtml('Age : 54 ans, TA < 12/8 et > 5'), false);
  });
});

describe('de bout en bout : un fichier .txt en Windows-1252 se lit comme un autre', () => {
  const field: TemplateField = {
    id: 1, templateId: 1, key: 'age', label: 'Âge', type: 'integer', section: 'x', unit: 'ans',
    description: null, required: false, options: [], position: 0,
    extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Âge'], maxLength: 20 }] },
  };

  async function ageFrom(buffer: Buffer, name: string): Promise<unknown> {
    const parsed = await parseDocument(buffer, name, 'application/octet-stream');
    const doc: SourceDoc = { id: 1, name, kind: parsed.kind, text: parsed.text, dicomTags: {} };
    return extractField(field, [doc])?.value ?? null;
  }

  test('Windows-1252', async () => {
    assert.equal(await ageFrom(Buffer.from('\xc2ge : 54 ans\nSexe : M', 'latin1'), 'cr.txt'), 54);
  });

  test('UTF-16 avec nomenclature', async () => {
    const b = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Âge : 61 ans', 'utf16le')]);
    assert.equal(await ageFrom(b, 'export.txt'), 61);
  });

  test('un RTF nommé « .txt »', async () => {
    assert.equal(await ageFrom(Buffer.from("{\\rtf1\\ansi \\'c2ge : 47 ans\\par}"), 'cr.txt'), 47);
  });

  test('un fichier .html', async () => {
    assert.equal(await ageFrom(Buffer.from('<p>&Acirc;ge&nbsp;: 33 ans</p>'), 'cr.html'), 33);
  });

  test('les métadonnées disent comment le texte a été lu', async () => {
    const r = await parseDocument(Buffer.from('\xc2ge : 54', 'latin1'), 'a.txt', '');
    assert.equal(r.metadata.charset, 'windows-1252');
    assert.equal(r.metadata.format, 'texte');
    const rtf = await parseDocument(Buffer.from('{\\rtf1 a}'), 'a.rtf', '');
    assert.equal(rtf.metadata.format, 'rtf');
  });
});
