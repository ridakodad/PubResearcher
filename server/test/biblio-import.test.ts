/**
 * Lecteurs d'import : RIS, MEDLINE (.nbib), BibTeX, CSV.
 *
 * Les échantillons reprennent ce que les bases exportent vraiment, défauts
 * compris : fins de ligne Windows, marque d'ordre des octets, Latin-1 et
 * UTF-16, lignes de continuation, balises propres à chaque base, notices sans
 * titre, entrées BibTeX mal fermées.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ImportError,
  decodeText,
  detectFormat,
  latexToText,
  normalizeAuthor,
  parseBibtex,
  parseCsv,
  parseImport,
  parseNbib,
  parseRis,
  splitCsvAuthors,
} from '../src/biblio/importers.js';

const CRLF = (lines: string[]) => lines.join('\r\n');
const BOM = String.fromCodePoint(0xfeff);

describe('encodage', () => {
  test('UTF-8 avec ou sans marque, Windows-1252, UTF-16', () => {
    assert.deepEqual(decodeText(Buffer.from(`${BOM}Étude`, 'utf8')), { text: 'Étude', encoding: 'UTF-8' });
    assert.deepEqual(decodeText(Buffer.from('Étude', 'utf8')), { text: 'Étude', encoding: 'UTF-8' });
    // « Étude œsophagienne » en Windows-1252 : É = 0xC9, œ = 0x9C.
    assert.deepEqual(decodeText(Buffer.from([0xc9, 0x74, 0x75, 0x64, 0x65, 0x20, 0x9c])), { text: 'Étude œ', encoding: 'Windows-1252' });
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('TY  - JOUR', 'utf16le')]);
    assert.deepEqual(decodeText(utf16), { text: 'TY  - JOUR', encoding: 'UTF-16' });
  });
});

describe('noms d’auteurs', () => {
  test('« Nom, Prénom » devient « Nom Initiales », comme PubMed', () => {
    assert.equal(normalizeAuthor('Dupont, Jean-Pierre'), 'Dupont JP');
    assert.equal(normalizeAuthor('Smith, J. A.'), 'Smith JA');
    assert.equal(normalizeAuthor('Smith, JA'), 'Smith JA');
    assert.equal(normalizeAuthor('van der Berg, Anna'), 'van der Berg A');
    assert.equal(normalizeAuthor('Ritter M'), 'Ritter M', 'sans virgule : inchangé');
    assert.equal(normalizeAuthor('Collectif HAS'), 'Collectif HAS');
  });

  test('listes d’auteurs d’un CSV : PubMed, Scopus, point-virgule', () => {
    assert.deepEqual(splitCsvAuthors('Smith J, Doe AB, Lefèvre C'), ['Smith J', 'Doe AB', 'Lefèvre C']);
    assert.deepEqual(splitCsvAuthors('Smith, J.; Doe, A.B.'), ['Smith J', 'Doe AB']);
    assert.deepEqual(splitCsvAuthors('Smith J.; Doe A.'), ['Smith J', 'Doe A']);
    assert.deepEqual(splitCsvAuthors('Dupont, Jean'), ['Dupont J'], 'une virgule seule : un auteur « Nom, Prénom »');
  });
});

describe('RIS', () => {
  const embase = CRLF([
    `${BOM}TY  - JOUR`,
    'T1  - Antibiotics versus appendectomy for uncomplicated appendicitis in children',
    'A1  - Dupont, Jean-Pierre',
    'A1  - Müller, Hans',
    'Y1  - 2021//',
    'T2  - Archives de Pédiatrie',
    'JF  - Archives de Pediatrie',
    'VL  - 28',
    'IS  - 3',
    'SP  - 215',
    'EP  - 221',
    'N2  - Background: non-operative management is debated.',
    '      Methods: retrospective cohort of 212 children.',
    'KW  - appendicitis; antibiotic therapy; child',
    'KW  - appendectomy',
    'M3  - Article',
    'DO  - https://doi.org/10.1016/J.ARCPED.2021.02.004',
    'UR  - https://www.embase.com/search/results?id=L2011234567',
    'N1  - PMID: 33789012',
    'ER  - ',
    '',
    'TY  - JOUR',
    'TI  - Conservative treatment of appendicitis: congress abstract',
    'AU  - Lefèvre, C.',
    'PY  - 2022',
    'T2  - Journal of Visceral Surgery',
    'M3  - Conference Abstract',
    'ER  -',
    '',
    'TY  - JOUR',
    'AU  - Sans Titre, A',
    'PY  - 2020',
    'ER  - ',
    'TY  - CHAP',
    'TI  - Appendicitis in adults',
    'T2  - Textbook of Surgery',
    'AU  - Martin, Paul',
    'PY  - 2019',
    'SP  - 101-130',
    // Pas de « ER » final : la notice est close par la fin du fichier.
  ]);

  test('notices Embase : auteurs, revue, pages, résumé sur plusieurs lignes, mots-clés, DOI, PMID cité', () => {
    const { refs, skipped } = parseRis(embase, 'embase');
    assert.equal(refs.length, 3);
    assert.equal(skipped, 1, 'la notice sans titre est écartée');
    const [a, b, c] = refs;
    assert.equal(a!.source, 'embase');
    assert.equal(a!.title, 'Antibiotics versus appendectomy for uncomplicated appendicitis in children');
    assert.deepEqual(a!.authors, ['Dupont JP', 'Müller H']);
    assert.equal(a!.year, 2021);
    assert.equal(a!.journal, 'Archives de Pédiatrie');
    assert.equal(a!.pages, '215-221');
    assert.equal(a!.abstract, 'Background: non-operative management is debated. Methods: retrospective cohort of 212 children.');
    assert.deepEqual(a!.keywords, ['appendicitis', 'antibiotic therapy', 'child', 'appendectomy']);
    assert.equal(a!.doi, '10.1016/j.arcped.2021.02.004');
    assert.equal(a!.pmid, '33789012', 'PMID cité en note');
    assert.equal(a!.refType, 'JOUR');
    assert.equal(a!.url, 'https://www.embase.com/search/results?id=L2011234567');
    assert.equal(b!.refType, 'CONF', '« Conference Abstract » d’Embase');
    assert.equal(b!.journal, 'Journal of Visceral Surgery');
    assert.equal(c!.refType, 'CHAP');
    assert.equal(c!.journal, 'Textbook of Surgery');
    assert.equal(c!.pages, '101-130');
  });

  test('AN n’est un PMID que dans un export PubMed/MEDLINE ; PMCID lu dans C2', () => {
    const zotero = CRLF(['TY  - JOUR', 'TI  - Titre', 'AN  - 26069886', 'DB  - PubMed', 'C2  - PMC4446381', 'ER  - ']);
    assert.equal(parseRis(zotero, 'other').refs[0]!.pmid, '26069886');
    assert.equal(parseRis(zotero, 'other').refs[0]!.pmcid, 'PMC4446381');
    const wos = CRLF(['TY  - JOUR', 'TI  - Titre', 'AN  - 000412345600012', 'DB  - Web of Science', 'ER  - ']);
    assert.equal(parseRis(wos, 'wos').refs[0]!.pmid, null, 'le numéro d’accès WoS n’est pas un PMID');
  });

  test('détection et lecture complète d’un fichier : format, encodage, avertissements', () => {
    const parsed = parseImport(Buffer.from(embase, 'utf8'), 'embase.ris', 'embase');
    assert.equal(parsed.format, 'ris');
    assert.equal(parsed.encoding, 'UTF-8');
    assert.equal(parsed.refs.length, 3);
    assert.deepEqual(parsed.warnings, ['1 notice sans titre ou illisible, écartée.']);
  });

  test('RIS en Windows-1252 : accents rendus, avertissement', () => {
    const latin1 = Buffer.from(CRLF(['TY  - JOUR', 'TI  - Appendicite aiguë de l’enfant', 'AU  - Lefèvre, Céline', 'ER  - ']).replace('’', "'"), 'latin1');
    const parsed = parseImport(latin1, 'lissa.ris', 'lissa');
    assert.equal(parsed.refs[0]!.title, "Appendicite aiguë de l'enfant");
    assert.deepEqual(parsed.refs[0]!.authors, ['Lefèvre C']);
    assert.equal(parsed.encoding, 'Windows-1252');
    assert.match(parsed.warnings[0] ?? '', /Windows-1252/);
  });
});

describe('MEDLINE (.nbib)', () => {
  const nbib = [
    'PMID- 30985725',
    'OWN - NLM',
    'STAT- MEDLINE',
    'DP  - 2019 Apr',
    'TI  - Transurethral resection versus holmium laser enucleation of the prostate: A',
    '      prospective randomized trial.',
    'LID - 10.1097/MD.0000000000015223 [doi]',
    'LID - e15223',
    'AB  - OBJECTIVES: The purpose of this study was to compare HoLEP and TURP. METHODS:',
    '      Patients were randomized.',
    'FAU - Bai, Fan',
    'AU  - Bai F',
    'FAU - Feng, Shanyu',
    'AU  - Feng S',
    'CN  - HoLEP Study Group',
    'LA  - eng',
    'PT  - Comparative Study',
    'PT  - Journal Article',
    'PT  - Randomized Controlled Trial',
    'TA  - Medicine (Baltimore)',
    'JT  - Medicine',
    'VI  - 98',
    'IP  - 15',
    'PG  - e15223',
    'MH  - Aged',
    'MH  - Holmium',
    'MH  - *Lasers, Solid-State/therapeutic use',
    'MH  - Prostatic Hyperplasia/*surgery',
    'OT  - HoLEP',
    'PMC - PMC6485898',
    'AID - 10.1097/MD.0000000000015223 [doi]',
    '',
    'PMID- 20301446',
    'STAT- Publisher',
    'DP  - 1993',
    'TI  - Gaucher Disease',
    'BTI - GeneReviews(R)',
    'FAU - Hughes, Derralynn A',
    'PT  - Review',
    '',
    'PMID- 99999999',
    'DP  - 2020',
    'AU  - Sans Titre A',
    '',
  ].join('\n');

  test('articles et chapitres, continuations, MeSH sans qualificatifs, PMC, DOI', () => {
    const { refs, skipped } = parseNbib(nbib, 'pubmed');
    assert.equal(refs.length, 2);
    assert.equal(skipped, 1);
    const [a, chap] = refs;
    assert.equal(a!.pmid, '30985725');
    assert.equal(a!.title, 'Transurethral resection versus holmium laser enucleation of the prostate: A prospective randomized trial');
    assert.deepEqual(a!.authors, ['Bai F', 'Feng S', 'HoLEP Study Group']);
    assert.equal(a!.year, 2019);
    assert.equal(a!.journal, 'Medicine');
    assert.equal(a!.volume, '98');
    assert.equal(a!.issue, '15');
    assert.equal(a!.pages, 'e15223');
    assert.equal(a!.doi, '10.1097/md.0000000000015223');
    assert.equal(a!.pmcid, 'PMC6485898');
    assert.ok(a!.abstract?.endsWith('METHODS: Patients were randomized.'));
    assert.deepEqual(a!.meshTerms, ['Aged', 'Holmium', 'Lasers, Solid-State', 'Prostatic Hyperplasia']);
    assert.deepEqual(a!.keywords, ['HoLEP']);
    assert.equal(a!.refType, 'JOUR');
    assert.equal(a!.url, 'https://pubmed.ncbi.nlm.nih.gov/30985725/');
    assert.equal(chap!.refType, 'CHAP');
    assert.equal(chap!.journal, 'GeneReviews(R)');
    assert.deepEqual(chap!.authors, ['Hughes DA'], 'FAU quand AU manque');
  });

  test('fins de ligne Windows et détection par le contenu, quelle que soit l’extension', () => {
    const crlf = Buffer.from(nbib.replace(/\n/g, '\r\n'), 'utf8');
    const parsed = parseImport(crlf, 'pubmed-export.txt', 'pubmed');
    assert.equal(parsed.format, 'nbib');
    assert.equal(parsed.refs.length, 2);
    assert.equal(parsed.refs[0]!.title.includes('\r'), false);
  });
});

describe('BibTeX', () => {
  const bib = String.raw`
@comment{Exporté par Zotero}
@string{ejs = "European Journal of Surgery"}

@article{dupont2021,
  author = {Dupont, Jean-Pierre and M{\"u}ller, Hans and {World Health Organization}},
  title = {{Appendicite} de l'enfant : {\'e}tude r{\'e}trospective {\`a} 5~ans},
  journal = ejs # " (Paris)",
  year = 2021,
  month = mar,
  volume = {12},
  number = {3},
  pages = {266--274},
  doi = {https://doi.org/10.1000/ABC.123},
  eprint = {33789012}, eprinttype = {pubmed},
  keywords = {appendicitis, antibiotics; child},
  abstract = {Taux de r\'eussite de 85\,\% \& plus.}
}

@inproceedings{martin2019,
  author = "Paul Martin and Anne-Sophie Lefèvre",
  title = "Non-operative management: {A} multicentre study",
  booktitle = {Proceedings of the French Surgical Congress},
  year = {2019}
}

@article{casse2020,
  author = {Untel, A},
  title = {Accolade jamais fermée,
  year = {2020}

@phdthesis{these2018,
  author = {Durand, Marie},
  title = {Th{\`e}se sur l'appendicite},
  school = {Université de Lyon},
  year = {2018}
}
`;

  test('accents LaTeX, macros, concaténation, auteurs collectifs, PMID par eprint, types', () => {
    const { refs, skipped } = parseBibtex(bib, 'other');
    assert.equal(refs.length, 3);
    assert.equal(skipped, 1, 'l’entrée mal fermée est sautée, la suivante est lue');
    const [a, b, c] = refs;
    assert.equal(a!.title, "Appendicite de l'enfant : étude rétrospective à 5 ans");
    assert.deepEqual(a!.authors, ['Dupont JP', 'Müller H', 'World Health Organization']);
    assert.equal(a!.journal, 'European Journal of Surgery (Paris)');
    assert.equal(a!.year, 2021);
    assert.equal(a!.pages, '266-274');
    assert.equal(a!.doi, '10.1000/abc.123');
    assert.equal(a!.pmid, '33789012');
    assert.deepEqual(a!.keywords, ['appendicitis', 'antibiotics', 'child']);
    assert.equal(a!.abstract, 'Taux de réussite de 85 % & plus.');
    assert.equal(a!.refType, 'JOUR');
    assert.equal(b!.refType, 'CONF');
    assert.deepEqual(b!.authors, ['Martin P', 'Lefèvre AS']);
    assert.equal(b!.journal, 'Proceedings of the French Surgical Congress');
    assert.equal(c!.refType, 'THES');
    assert.equal(c!.title, "Thèse sur l'appendicite");
  });

  test('LaTeX → texte', () => {
    assert.equal(latexToText(String.raw`Gr{\"o}{\ss}e \c{c}a \v{S}koda {\o}re \'{\i}le`), 'Größe ça Škoda øre íle');
    assert.equal(latexToText(String.raw`\emph{in vivo} 10\% \& \$5`), 'in vivo 10% & $5');
  });
});

describe('CSV', () => {
  test('export PubMed : virgules, guillemets, auteurs « Nom Initiales »', () => {
    const csv = [
      'PMID,Title,Authors,Citation,First Author,Journal/Book,Publication Year,Create Date,PMCID,NIHMS ID,DOI',
      '30985725,"Transurethral resection versus holmium laser enucleation of the prostate: A prospective randomized trial.","Bai F, Feng S, Mo C","Medicine (Baltimore). 2019 Apr;98(15):e15223.",Bai F,Medicine (Baltimore),2019,2019/04/16,PMC6485898,,10.1097/MD.0000000000015223',
    ].join('\n');
    const { refs } = parseCsv(csv, 'pubmed');
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.pmid, '30985725');
    assert.deepEqual(refs[0]!.authors, ['Bai F', 'Feng S', 'Mo C']);
    assert.equal(refs[0]!.journal, 'Medicine (Baltimore)');
    assert.equal(refs[0]!.year, 2019);
    assert.equal(refs[0]!.pmcid, 'PMC6485898');
    assert.equal(refs[0]!.doi, '10.1097/md.0000000000015223');
  });

  test('export Scopus : résumé sur plusieurs lignes, pages en deux colonnes, type de document', () => {
    const csv = [
      'Authors,Title,Year,Source title,Volume,Issue,Page start,Page end,DOI,Abstract,Author Keywords,Document Type',
      '"Smith, J.; Doe, A.B.","Antibiotics first for appendicitis",2020,"The Lancet",395,"10235","1–2","9","10.1016/S0140-6736(20)30001-1","Ligne 1',
      'ligne 2 avec ""guillemets""","appendicitis; antibiotics",Conference Paper',
    ].join('\r\n');
    const { refs } = parseCsv(csv, 'scopus');
    assert.equal(refs.length, 1);
    const [r] = refs;
    assert.deepEqual(r!.authors, ['Smith J', 'Doe AB']);
    assert.equal(r!.journal, 'The Lancet');
    assert.equal(r!.pages, '1–2');
    assert.equal(r!.abstract, 'Ligne 1 ligne 2 avec "guillemets"');
    assert.deepEqual(r!.keywords, ['appendicitis', 'antibiotics']);
    assert.equal(r!.refType, 'CONF');
  });

  test('export de cette application : marque d’ordre, point-virgule, en-têtes français', () => {
    const csv = `${BOM}Sources;Titre;Auteurs;Année;Revue;Volume;Numéro;Pages;DOI;PMID;PMCID;Lien;Cité par;Décision;Motif d’exclusion;Note;Résumé ou extrait\r\nPubMed;Étude;"Ritter M; Stein J";2026;Eur Urol;12;2;266-274;10.1016/j.euf.2026.01.006;41638951;;https://pubmed.ncbi.nlm.nih.gov/41638951/;;Retenue;;;Résumé.\r\n`;
    const parsed = parseImport(Buffer.from(csv, 'utf8'), 'references.csv', 'other');
    assert.equal(parsed.format, 'csv');
    assert.equal(parsed.refs[0]!.title, 'Étude');
    assert.equal(parsed.refs[0]!.pmid, '41638951');
    assert.equal(parsed.refs[0]!.abstract, 'Résumé.');
  });

  test('sans colonne de titre : refusé avec ce qu’il faut', () => {
    assert.throws(() => parseCsv('auteur;année\nX;2020', 'other'), (e: unknown) => e instanceof ImportError && /colonne de titre/.test(e.message));
  });
});

describe('fichiers refusés', () => {
  test('format non reconnu, fichier binaire', () => {
    assert.equal(detectFormat('Bonjour, ceci est une lettre.', 'lettre.docx'), null);
    assert.throws(() => parseImport(Buffer.from('Juste du texte'), 'notes.md', 'other'), (e: unknown) => e instanceof ImportError && /Format non reconnu/.test(e.message));
    assert.throws(() => parseImport(Buffer.from([0x25, 0x50, 0x44, 0x46, 0, 0, 1, 2]), 'article.pdf', 'other'), /pas un fichier texte/);
  });

  test('champs démesurés bornés, adresses non http écartées', () => {
    const ris = CRLF(['TY  - JOUR', `TI  - ${'x'.repeat(5000)}`, 'UR  - javascript:alert(1)', 'L1  - file:///etc/passwd', 'ER  - ']);
    const [ref] = parseRis(ris, 'other').refs;
    assert.ok(ref!.title.length <= 2000);
    assert.equal(ref!.url, null);
    assert.equal(ref!.pdfUrl, null);
  });
});
