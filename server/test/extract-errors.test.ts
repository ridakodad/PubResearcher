/**
 * Messages d'échec de lecture : en français, avec ce qu'on peut faire. Les messages bruts des bibliothèques
 * (« Invalid PDF structure. ») ne disent ni ce qui est en cause ni quoi faire.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

process.env.OCR_ENABLED = '0';
const { explainParseError, parseDocument } = await import('../src/extract/index.js');
const { makeDicom, makeDocx, makePdf } = await import('./fixtures.js');

describe('traduction des messages des bibliothèques', () => {
  const cases: [string, 'pdf' | 'docx' | 'dicom' | 'image', RegExp][] = [
    ['No password given', 'pdf', /protégé par mot de passe/],
    ['Invalid PDF structure.', 'pdf', /PDF corrompu ou illisible/],
    ['Pages tree contains circular reference.', 'pdf', /PDF corrompu/],
    ['Missing PDF header.', 'pdf', /PDF corrompu/],
    ['The PDF file is empty, i.e. its size is zero bytes.', 'pdf', /Fichier vide/],
    ['Invalid XRef stream header', 'pdf', /PDF corrompu/],
    ["Can't find end of central directory : is this a zip file ?", 'docx', /Fichier Word illisible/],
    ['Corrupted zip: can\'t find end of central directory', 'docx', /Fichier Word illisible/],
    ['End of data reached (data length = 2103, asked index = 2113). Corrupted zip ?', 'docx', /Fichier Word illisible/],
    ['error: [xmldom error]\tentity not found:&f;', 'docx', /références externes/],
    ['Maximum call stack size exceeded', 'docx', /trop profonde ou trop complexe/],
    ['dicomParser.parseDicom: missing required meta header attribute 0002,0010', 'dicom', /DICOM illisible/],
    ['dicomParser.readFixedString: attempt to read past end of buffer', 'dicom', /DICOM tronqué/],
  ];
  for (const [raw, kind, expected] of cases) {
    test(`« ${raw.slice(0, 50)} » → ${expected}`, () => {
      assert.match(explainParseError(raw, kind), expected);
    });
  }

  test('les messages déjà rédigés par l’outil passent tels quels', () => {
    for (const message of [
      'Format non pris en charge (a.doc). Ancien format Word (.doc) : enregistrez-le en .docx ou en PDF, puis réimportez-le.',
      'Document Word trop volumineux une fois décompressé (74 Mo de texte structuré, limite 32 Mo). Exportez-le en PDF.',
      'Archive Word trop volumineuse (format ZIP64) : un compte rendu n’en a pas besoin.',
    ]) {
      assert.equal(explainParseError(message, 'docx'), message);
    }
  });

  test('une erreur inconnue reste lisible et garde le détail technique', () => {
    const out = explainParseError('quelque chose d’inattendu', 'pdf');
    assert.match(out, /Lecture impossible \(quelque chose d’inattendu\)/);
    assert.match(out, /réexportez-le/);
  });
});

describe('fichiers défectueux, de bout en bout', () => {
  test('un fichier de 0 octet est refusé comme tel, quelle que soit sa nature', async () => {
    for (const [name, mime] of [['v.pdf', 'application/pdf'], ['v.docx', ''], ['v.dcm', 'application/dicom'], ['v.jpg', 'image/jpeg'], ['v.png', 'image/png'], ['v.txt', 'text/plain']] as const) {
      const r = await parseDocument(Buffer.alloc(0), name, mime);
      assert.equal(r.status, 'error', name);
      assert.match(r.error ?? '', /Fichier vide \(0 octet\)/, name);
      assert.equal(r.text, '');
    }
  });

  test('un PDF corrompu donne un message en français, le message de la bibliothèque est gardé à part', async () => {
    const r = await parseDocument(Buffer.from('%PDF-1.4\nce n’est pas un vrai PDF'), 'cassé.pdf', 'application/pdf');
    assert.equal(r.status, 'error');
    assert.match(r.error ?? '', /PDF corrompu ou illisible/);
    assert.match(String(r.metadata['technicalError']), /Invalid PDF structure|XRef|Missing/i);
  });

  test('un faux .docx, un DICOM tronqué : messages en clair', async () => {
    const notZip = await parseDocument(Buffer.from('ceci n’est pas une archive'), 'faux.docx', '');
    assert.match(notZip.error ?? '', /Fichier Word illisible/);
    const cut = makeDicom().subarray(0, 140);
    const dicom = await parseDocument(Buffer.from(cut), 'coupe.dcm', 'application/dicom');
    assert.equal(dicom.status, 'error');
    assert.match(dicom.error ?? '', /DICOM/);
  });

  test('les fichiers sains ne sont pas touchés', async () => {
    assert.equal((await parseDocument(makePdf(['Âge : 54 ans']), 'ok.pdf', 'application/pdf')).status, 'ok');
    assert.equal((await parseDocument(await makeDocx(['Âge : 54 ans']), 'ok.docx', '')).status, 'ok');
    assert.equal((await parseDocument(Buffer.from('Âge : 54 ans'), 'ok.txt', 'text/plain')).status, 'ok');
  });
});
