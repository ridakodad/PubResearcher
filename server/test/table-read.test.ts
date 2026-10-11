/**
 * Lecture des tableaux de cohorte : classeurs .xlsx (lecteur maison, sur le lecteur ZIP de l'outil) et CSV.
 *
 * Les classeurs sont fabriqués ici même : par l'écrivain de l'outil (`lib/xlsx.ts`) pour le cas courant, et à la main,
 * partie XML par partie XML, pour ce que l'écrivain ne produit pas — chaînes partagées, formules, dates de 1904,
 * lignes clairsemées, plages fusionnées, archives piégées.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { makeXlsx } = await import('../src/lib/xlsx.js');
const { makeZip } = await import('../src/lib/zip.js');
const { readTable, tableFormat } = await import('../src/table/read.js');
const { readXlsx, excelSerialToIso, classifyNumberFormat } = await import('../src/table/xlsx-read.js');
const { readCsv, splitCsv, detectDelimiter } = await import('../src/table/csv-read.js');
const { parseHeader, suggestMapping, describeColumns, suggestHeaderRow } = await import('../src/table/mapping.js');
const { convertCell } = await import('../src/table/plan.js');
const { TableReadError } = await import('../src/table/types.js');

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

interface HandSheet {
  name: string;
  xml: string;
  state?: string;
  type?: 'worksheet' | 'chartsheet';
}

/** Classeur assemblé à la main : chaque partie XML est fournie telle quelle. */
function handmadeXlsx(options: { sheets: HandSheet[]; sharedStrings?: string[] | string; styles?: string; workbookPr?: string; extra?: { path: string; data: string }[] }): Buffer {
  const sst =
    options.sharedStrings === undefined
      ? null
      : typeof options.sharedStrings === 'string'
        ? options.sharedStrings
        : `<?xml version="1.0" encoding="UTF-8"?><sst ${NS} count="${options.sharedStrings.length}">${options.sharedStrings.map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join('')}</sst>`;
  const rels = options.sheets
    .map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${s.type ?? 'worksheet'}" Target="worksheets/sheet${i + 1}.xml"/>`)
    .join('');
  return makeZip([
    { path: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    {
      path: '_rels/.rels',
      data: '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    },
    {
      path: 'xl/workbook.xml',
      data: `<?xml version="1.0"?><workbook ${NS}>${options.workbookPr ?? ''}<sheets>${options.sheets
        .map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"${s.state ? ` state="${s.state}"` : ''}/>`)
        .join('')}</sheets></workbook>`,
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    },
    ...(options.styles ? [{ path: 'xl/styles.xml', data: options.styles }] : []),
    ...(sst ? [{ path: 'xl/sharedStrings.xml', data: sst }] : []),
    ...options.sheets.map((s, i) => ({ path: `xl/worksheets/sheet${i + 1}.xml`, data: s.xml })),
    ...(options.extra ?? []),
  ]);
}

const sheetXml = (body: string, tail = '') => `<?xml version="1.0"?><worksheet ${NS}><sheetData>${body}</sheetData>${tail}</worksheet>`;

/** Styles : 0 ordinaire, 1 date intégrée (14), 2 date personnalisée jj/mm/aaaa, 3 date et heure, 4 heure seule, 5 nombre décimal. */
const STYLES = `<?xml version="1.0"?><styleSheet ${NS}><numFmts count="3"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/><numFmt numFmtId="165" formatCode="[$-40C]d\\ mmmm\\ yyyy\\ hh:mm"/><numFmt numFmtId="166" formatCode="0.00"/></numFmts>
<cellStyleXfs count="1"><xf numFmtId="14"/></cellStyleXfs>
<cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="20"/><xf numFmtId="166"/></cellXfs></styleSheet>`;

const values = (wb: { sheets: { rows: ({ v: unknown } | null)[][] }[] }, sheet = 0) => wb.sheets[sheet]!.rows.map((r) => r.map((c) => (c ? c.v : null)));

describe('dates Excel', () => {
  test('numéros de série, calendrier de 1900 et ses pièges', () => {
    assert.equal(excelSerialToIso(1, false, 'date'), '1900-01-01');
    assert.equal(excelSerialToIso(59, false, 'date'), '1900-02-28');
    assert.equal(excelSerialToIso(60, false, 'date'), '1900-02-29', 'date fictive rendue telle quelle, pour être refusée');
    assert.equal(excelSerialToIso(61, false, 'date'), '1900-03-01');
    assert.equal(excelSerialToIso(45366, false, 'date'), '2024-03-15');
    assert.equal(excelSerialToIso(45366.75, false, 'datetime'), '2024-03-15 18:00');
    assert.equal(excelSerialToIso(45366.75, false, 'date'), '2024-03-15', 'format sans heure : la date seule');
    assert.equal(excelSerialToIso(0.5, false, 'time'), '12:00');
    assert.equal(excelSerialToIso(-1, false, 'date'), null);
  });

  test('calendrier de 1904 : quatre ans et un jour de décalage', () => {
    assert.equal(excelSerialToIso(0, true, 'date'), '1904-01-01');
    assert.equal(excelSerialToIso(43904, true, 'date'), '2024-03-15');
  });

  test('formats de nombre : date, date et heure, heure, nombre', () => {
    assert.equal(classifyNumberFormat('dd/mm/yyyy'), 'date');
    assert.equal(classifyNumberFormat('[$-40C]d mmmm yyyy'), 'date');
    assert.equal(classifyNumberFormat('yyyy-mm-dd hh:mm'), 'datetime');
    assert.equal(classifyNumberFormat('hh:mm:ss'), 'time');
    assert.equal(classifyNumberFormat('[h]:mm'), 'time');
    assert.equal(classifyNumberFormat('0.00'), null);
    assert.equal(classifyNumberFormat('#,##0 "jours"'), null, 'le texte entre guillemets ne compte pas');
    assert.equal(classifyNumberFormat('General'), null);
    assert.equal(classifyNumberFormat('[Red]0.0;[Blue]-0.0'), null);
  });
});

describe('lecteur .xlsx', () => {
  test('classeur produit par l’écrivain de l’outil : texte en ligne, nombres, dates, booléens', () => {
    const buf = makeXlsx([
      {
        name: 'Cohorte',
        columns: [{ header: 'Code' }, { header: 'Âge (ans)', type: 'number' }, { header: 'Admission', type: 'date' }, { header: 'Diabète' }],
        rows: [
          ['P-001', 54, '2024-03-15', true],
          ['P-002', 61.5, '2023-12-01', false],
          ['P-003', null, 'inconnue', 'a < b & "c"'],
        ],
      },
    ]);
    const wb = readTable(buf, 'cohorte.xlsx');
    assert.equal(wb.format, 'xlsx');
    assert.equal(wb.sheets[0]!.name, 'Cohorte');
    assert.deepEqual(values(wb), [
      ['Code', 'Âge (ans)', 'Admission', 'Diabète'],
      ['P-001', 54, '2024-03-15', true],
      ['P-002', 61.5, '2023-12-01', false],
      ['P-003', null, 'inconnue', 'a < b & "c"'],
    ]);
    const date = wb.sheets[0]!.rows[1]![2]!;
    assert.equal(date.k, 'date');
    assert.equal(date.raw, '45366', 'le numéro de série reste le contenu brut');
  });

  test('chaînes partagées (riches et phonétiques), styles de date, booléens, erreurs, formules', () => {
    const wb = readXlsx(
      handmadeXlsx({
        sharedStrings: `<sst ${NS}><si><t>Code</t></si><si><r><t>CRP </t></r><r><rPr><b/></rPr><t>(mg/L)</t></r></si><si><t>東京</t><rPh sb="0" eb="2"><t>トウキョウ</t></rPh></si><si><t>ligne_x000D_suite</t></si><si><t></t></si></sst>`,
        styles: STYLES,
        sheets: [
          {
            name: 'Données',
            xml: sheetXml(
              `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>` +
                `<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="5"><v>12.5</v></c><c r="C2" s="1"><v>45366</v></c><c r="D2" s="2"><v>45000</v></c><c r="E2" s="3"><v>45366.5</v></c><c r="F2" s="4"><v>0.25</v></c></row>` +
                `<row r="3"><c r="A3" t="b"><v>1</v></c><c r="B3" t="e"><v>#DIV/0!</v></c><c r="C3"><f>B2*2</f><v>25</v></c><c r="D3"><f>A1&amp;B1</f></c><c r="E3" t="str"><f>"x"&amp;"y"</f><v>xy</v></c><c r="F3" t="s"><v>4</v></c><c r="G3" t="s"><v>99</v></c></row>`,
            ),
          },
        ],
      }),
    );
    const sheet = wb.sheets[0]!;
    const [header, row2, row3] = sheet.rows;
    assert.deepEqual(header!.map((c) => c?.v), ['Code', 'CRP (mg/L)', '東京'], 'texte riche recollé, phonétique ignorée');
    assert.equal(row2![0]!.v, 'ligne\rsuite', 'échappement _x000D_ d’Office');
    assert.equal(row2![1]!.v, 12.5);
    assert.equal(row2![2]!.v, '2024-03-15', 'format de date intégré (14)');
    assert.equal(row2![3]!.v, '2023-03-15', 'format personnalisé jj/mm/aaaa');
    assert.equal(row2![4]!.v, '2024-03-15 12:00', 'date et heure');
    assert.equal(row2![5]!.v, '06:00', 'heure seule');
    assert.equal(row3![0]!.v, true);
    assert.deepEqual([row3![1]!.k, row3![1]!.raw], ['error', '#DIV/0!']);
    assert.deepEqual([row3![2]!.v, row3![2]!.f, row3![2]!.k], [25, true, 'number'], 'formule : valeur enregistrée, jamais recalculée');
    assert.deepEqual([row3![3]!.v, row3![3]!.k], [null, 'formula-no-value'], 'formule sans valeur : signalée');
    assert.equal(row3![4]!.v, 'xy');
    assert.equal(row3![5], null, 'chaîne partagée vide : cellule vide');
    assert.equal(row3![6]!.k, 'error', 'index de chaîne partagée absent');
    assert.equal(sheet.formulas, 3);
    assert.equal(sheet.formulasWithoutValue, 1);
  });

  test('lignes clairsemées, cellules sans référence, plages fusionnées, lignes vides de fin', () => {
    const wb = readXlsx(
      handmadeXlsx({
        sheets: [
          {
            name: 'S',
            xml: sheetXml(
              `<row r="1"><c t="inlineStr"><is><t>A</t></is></c><c t="inlineStr"><is><t>B</t></is></c><c r="E1" t="inlineStr"><is><t>E</t></is></c></row>` +
                `<row r="4"><c r="B4"><v>2</v></c><c><v>3</v></c><c r="D4" s="0"/></row>` +
                `<row r="9" customFormat="1"><c r="A9" s="1"/></row>`,
              '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>',
            ),
          },
        ],
      }),
    );
    const sheet = wb.sheets[0]!;
    assert.deepEqual(values(wb), [['A', 'B', null, null, 'E'], [], [], [null, 2, 3]]);
    assert.equal(sheet.columns, 5);
    assert.deepEqual(sheet.merges, ['A1:B1']);
  });

  test('calendrier de 1904, feuille masquée, feuille graphique ignorée, préfixes d’espace de noms', () => {
    const wb = readXlsx(
      handmadeXlsx({
        workbookPr: '<workbookPr date1904="1"/>',
        styles: STYLES,
        sheets: [
          { name: 'Graphique', xml: '<chartsheet/>', type: 'chartsheet' },
          { name: 'Visible', xml: sheetXml('<row r="1"><c r="A1" s="1"><v>43904</v></c></row>') },
          {
            name: 'Cachée',
            state: 'hidden',
            xml: `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="2"><x:c r="B2" t="inlineStr"><x:is><x:t>ok</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`,
          },
        ],
      }),
    );
    assert.equal(wb.date1904, true);
    assert.deepEqual(wb.sheets.map((s) => [s.name, s.hidden]), [['Visible', false], ['Cachée', true]]);
    assert.equal(wb.sheets[0]!.rows[0]![0]!.v, '2024-03-15');
    assert.equal(wb.sheets[1]!.rows[1]![1]!.v, 'ok');
  });

  test('macros et liaisons externes : signalées, jamais suivies', () => {
    const wb = readXlsx(
      handmadeXlsx({
        sheets: [{ name: 'S', xml: sheetXml('<row r="1"><c r="A1"><v>1</v></c></row>') }],
        extra: [{ path: 'xl/vbaProject.bin', data: 'binaire' }, { path: 'xl/externalLinks/externalLink1.xml', data: '<externalLink/>' }],
      }),
    );
    assert.equal(wb.warnings.length, 2);
    assert.match(wb.warnings.join(' '), /macros : elles sont ignorées/);
    assert.match(wb.warnings.join(' '), /liaisons externes/);
  });

  test('un DOCTYPE (entités XML) est refusé', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><worksheet ${NS}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&lol2;</t></is></c></row></sheetData></worksheet>`;
    assert.throws(() => readXlsx(handmadeXlsx({ sheets: [{ name: 'S', xml: bomb }] })), (e: unknown) => e instanceof TableReadError && /DOCTYPE/.test((e as Error).message));
  });

  test('archive piégée : taille annoncée au-delà du plafond, refusée avant toute décompression', () => {
    // 40 Mo de XML répétitif, quelques dizaines de kilo-octets compressés.
    const rows = '<row><c t="inlineStr"><is><t>xxxxxxxxxxxxxxxxxxxxxxxx</t></is></c></row>'.repeat(600_000);
    const buf = handmadeXlsx({ sheets: [{ name: 'S', xml: sheetXml(rows) }] });
    assert.ok(buf.length < 2 * 1024 * 1024, `archive compacte (${buf.length} octets)`);
    const previous = process.env.TABLE_MAX_XML_MB;
    process.env.TABLE_MAX_XML_MB = '8';
    try {
      assert.throws(() => readXlsx(buf), /trop volumineux une fois décompressé .*TABLE_MAX_XML_MB/);
    } finally {
      if (previous === undefined) delete process.env.TABLE_MAX_XML_MB;
      else process.env.TABLE_MAX_XML_MB = previous;
    }
  });

  test('archive qui ment sur sa taille : la décompression s’arrête à la taille annoncée', () => {
    const big = sheetXml('<row r="1"><c r="A1"><v>1</v></c></row>' + ' '.repeat(5_000_000));
    const buf = Buffer.from(handmadeXlsx({ sheets: [{ name: 'S', xml: big }] }));
    // Réécrit la taille décompressée annoncée de la feuille dans l'annuaire central : 100 octets.
    const name = Buffer.from('xl/worksheets/sheet1.xml');
    for (let p = buf.length - 22; p > 0; p--) {
      if (buf.readUInt32LE(p) === 0x02014b50 && buf.subarray(p + 46, p + 46 + name.length).equals(name)) {
        buf.writeUInt32LE(100, p + 24);
        break;
      }
    }
    assert.throws(() => readXlsx(buf), /Archive piégée/);
  });

  test('plafonds de lignes et de cellules : la feuille trop longue est écartée, avec le motif', () => {
    const previous = process.env.TABLE_MAX_ROWS;
    process.env.TABLE_MAX_ROWS = '5';
    try {
      const wb = readXlsx(
        handmadeXlsx({
          sheets: [
            { name: 'Longue', xml: sheetXml('<row r="1000"><c r="A1000"><v>1</v></c></row>') },
            { name: 'Courte', xml: sheetXml('<row r="1"><c r="A1"><v>1</v></c></row>') },
          ],
        }),
      );
      assert.match(wb.sheets[0]!.error ?? '', /Plus de 5 lignes \(TABLE_MAX_ROWS\)/);
      assert.equal(wb.sheets[1]!.error, null);
    } finally {
      if (previous === undefined) delete process.env.TABLE_MAX_ROWS;
      else process.env.TABLE_MAX_ROWS = previous;
    }
  });

  test('fichiers qui ne sont pas des classeurs : messages en clair', () => {
    const ole = Buffer.concat([Buffer.from('d0cf11e0a1b11ae1', 'hex'), Buffer.alloc(100)]);
    assert.throws(() => readTable(ole, 'ancien.xls'), /Ancien format Excel \(\.xls\).*enregistrez-le en \.xlsx/);
    assert.throws(() => readTable(ole, 'protege.xlsx'), /protégé par mot de passe/);
    assert.throws(() => readTable(Buffer.from('PK\u0003\u0004 tronqué'), 'cassé.xlsx'), /archive ZIP|tronqué/);
    assert.throws(() => readTable(makeZip([{ path: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet' }]), 'a.ods'), /OpenDocument/);
    assert.throws(() => readTable(Buffer.from('%PDF-1.4'), 'a.pdf'), /Format non reconnu/);
    assert.throws(() => readTable(Buffer.alloc(0), 'vide.csv'), /Fichier vide/);
    assert.equal(tableFormat(Buffer.from('a;b'), 'x.CSV'), 'csv');
    assert.equal(tableFormat(Buffer.from('a\tb'), 'x.tsv'), 'tsv');
  });
});

describe('lecteur CSV', () => {
  test('guillemets RFC 4180 : séparateur, saut de ligne et guillemet doublé dans une cellule', () => {
    const { rows, warnings } = splitCsv('a;"b;c";"d ""e"""\r\n"x\r\ny";2;\r\n', ';');
    assert.deepEqual(rows, [['a', 'b;c', 'd "e"'], ['x\r\ny', '2', '']]);
    assert.deepEqual(warnings, []);
  });

  test('guillemet jamais refermé, guillemet mal placé : lus et signalés', () => {
    const open = splitCsv('a;"b\nc;d\n', ';');
    assert.match(open.warnings.join(' '), /Guillemet ouvert ligne 1 et jamais refermé/);
    const stray = splitCsv('a;"b"c;d\n', ';');
    assert.deepEqual(stray.rows[0], ['a', 'bc', 'd']);
    assert.match(stray.warnings.join(' '), /Guillemet mal placé ligne 1/);
  });

  test('séparateur reconnu : point-virgule, virgule, tabulation, barre ; ligne « sep= » d’Excel', () => {
    assert.equal(detectDelimiter('Code;Âge;CRP\nP1;54;12,5\nP2;61;3,2\n'), ';', 'les virgules décimales ne trompent pas');
    assert.equal(detectDelimiter('Code,Age,CRP\nP1,54,12.5\nP2,61,3.2\n'), ',');
    assert.equal(detectDelimiter('Code\tAge\nP1\t54\n'), '\t');
    assert.equal(detectDelimiter('Code|Age\nP1|54\n'), '|');
    const wb = readCsv(Buffer.from('sep=,\r\nCode,Note\r\nP1,"a;b"\r\n'), 'csv');
    assert.equal(wb.delimiter, ',');
    assert.deepEqual(values(wb), [['Code', 'Note'], ['P1', 'a;b']]);
  });

  test('encodages : UTF-8 avec BOM, Windows-1252, UTF-16 ; lignes vides et fins de ligne mêlées', () => {
    const utf8 = readCsv(Buffer.from('﻿Âge;Sexe\r\n54;F\r\n\r\n', 'utf8'), 'csv');
    assert.equal(utf8.charset, 'utf-8');
    assert.deepEqual(values(utf8), [['Âge', 'Sexe'], ['54', 'F']], 'BOM retiré du premier en-tête, ligne vide de fin retirée');

    const cp1252 = readCsv(Buffer.from([0xc2, 0x67, 0x65, 0x3b, 0x9c, 0x64, 0xe8, 0x6d, 0x65, 0x0d, 0x0a, 0x35, 0x34, 0x3b, 0x6f, 0x75, 0x69]), 'csv');
    assert.equal(cp1252.charset, 'windows-1252');
    assert.deepEqual(values(cp1252), [['Âge', 'œdème'], ['54', 'oui']]);

    const utf16 = readCsv(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Âge\t€\n54\t3\n', 'utf16le')]), 'tsv');
    assert.equal(utf16.charset, 'utf-16le');
    assert.deepEqual(values(utf16), [['Âge', '€'], ['54', '3']]);

    const mixed = readCsv(Buffer.from('a;b\rc;d\ne;f\r\n\n;\ng;h'), 'csv');
    assert.deepEqual(values(mixed), [['a', 'b'], ['c', 'd'], ['e', 'f'], [], [], ['g', 'h']], 'les lignes vides gardent la numérotation');
  });

  test('un fichier binaire n’est pas un CSV', () => {
    assert.throws(() => readCsv(Buffer.from([0x50, 0x4b, 0, 0, 1, 2, 3, 0, 0]), 'csv'), /pas un tableau texte/);
  });
});

describe('en-têtes et propositions de correspondance', () => {
  test('unité lue dans l’en-tête, reconnue ou non', () => {
    assert.deepEqual(parseHeader('CRP (mg/L)'), { text: 'CRP (mg/L)', label: 'CRP', unit: 'mg/L', knownUnit: 'mg/L' });
    assert.deepEqual(parseHeader('Créatinine [µmol/l]'), { text: 'Créatinine [µmol/l]', label: 'Créatinine', unit: 'µmol/l', knownUnit: 'µmol/L' });
    assert.equal(parseHeader('Âge (années)').knownUnit, 'an');
    assert.equal(parseHeader('Sexe (M/F)').knownUnit, null);
    assert.equal(parseHeader('Sexe (M/F)').label, 'Sexe');
    assert.deepEqual(parseHeader('Hémoglobine en g/dL'), { text: 'Hémoglobine en g/dL', label: 'Hémoglobine', unit: 'g/dL', knownUnit: 'g/dL' });
    assert.equal(parseHeader('Motif en clair').label, 'Motif en clair', 'une fin qui n’est pas une unité reste dans le libellé');
  });

  const field = (id: number, key: string, label: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ id, templateId: 1, key, label, type, section: 'S', unit: null, description: null, required: false, options: [], position: id, extraction: { enabled: true, rules: [] }, ...extra }) as never;
  const fields = [
    field(1, 'age', 'Âge', 'integer', { unit: 'ans', extraction: { enabled: true, rules: [{ kind: 'label', labels: ['Âge', 'Age du patient'] }] } }),
    field(2, 'sexe', 'Sexe', 'enum', { options: ['Masculin', 'Féminin'] }),
    field(3, 'crp', 'CRP', 'number', { unit: 'mg/L' }),
    field(4, 'creatinine', 'Créatinine', 'number', { unit: 'mg/L' }),
    field(5, 'date_admission', "Date d'admission", 'date'),
    field(6, 'diabete', 'Diabète', 'boolean'),
  ];

  test('chaque colonne vers une variable au plus, unité comprise ; la colonne des codes est reconnue', () => {
    const wb = readCsv(
      Buffer.from(
        "Étude pilote 2024\n\nN° dossier;Age du patient;Sexe (M/F);CRP (mg/L);Créatinine (µmol/L);Date d’admission;Diabète;Commentaire\nP1;54;F;12,5;80;15/03/2024;oui;RAS\nP2;61;M;3;95;01/12/2023;non;\n",
      ),
      'csv',
    );
    const sheet = wb.sheets[0]!;
    assert.equal(suggestHeaderRow(sheet), 3, 'le titre et la ligne vide au-dessus du tableau sont sautés');
    const columns = describeColumns(sheet, 3);
    assert.deepEqual(columns.map((c) => c.letter), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']);
    assert.deepEqual(columns[3]!.sample, ['12,5', '3']);
    const suggestion = suggestMapping(columns, fields);
    assert.equal(suggestion.codeColumn, 0);
    const byColumn = Object.fromEntries(suggestion.mapping.map((m) => [m.column, m.fieldId]));
    assert.deepEqual(byColumn, { 1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6 }, 'commentaire laissé de côté');
    assert.match(suggestion.mapping.find((m) => m.fieldId === 3)!.reason, /même unité/);
    assert.match(suggestion.mapping.find((m) => m.fieldId === 4)!.unitWarning ?? '', /« µmol\/L ».*« mg\/L »/);
  });

  test('conversion d’une cellule : unité d’en-tête, décimales françaises, dates, nombres sans format de date', () => {
    const crp = fields[2]!;
    const text = (v: string) => ({ v, k: 'text' as const, raw: v });
    assert.deepEqual(convertCell(text('12,5'), crp, 'mg/L'), { ok: true, value: 12.5 });
    assert.deepEqual(convertCell({ v: 12.5, k: 'number', raw: '12.5' }, crp, 'mg/L'), { ok: true, value: 12.5 });
    const wrongUnit = convertCell(text('85'), fields[3]!, 'µmol/L');
    assert.equal(wrongUnit.ok, false);
    assert.match((wrongUnit as { reason: string }).reason, /unité « µmol\/L » différente de « mg\/L »/);
    assert.deepEqual(convertCell(text('15/03/2024'), fields[4]!, null), { ok: true, value: '2024-03-15' });
    assert.deepEqual(convertCell({ v: '2024-03-15', k: 'date', raw: '45366' }, fields[4]!, null), { ok: true, value: '2024-03-15' });
    assert.match((convertCell({ v: 45366, k: 'number', raw: '45366' }, fields[4]!, null) as { reason: string }).reason, /nombre sans format de date/);
    assert.match((convertCell({ v: null, k: 'formula-no-value', raw: '', f: true }, crp, null) as { reason: string }).reason, /formule sans valeur/);
    assert.deepEqual(convertCell({ v: true, k: 'boolean', raw: '1' }, fields[5]!, null), { ok: true, value: true });
    assert.deepEqual(convertCell(text('Féminin'), fields[1]!, null), { ok: true, value: 'Féminin' });
    assert.equal(convertCell(text('X'), fields[1]!, null).ok, false);
    assert.equal(convertCell(text('< 5'), crp, 'mg/L').ok, false, 'valeur seuil : à saisir à la main');
  });
});
