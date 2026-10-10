import { escapeXml, makeZip, type ZipEntry } from './zip.js';

/**
 * Écriture de présentations `.pptx`.
 *
 * Une distribution finit presque toujours dans un diaporama : réunion de
 * service, comité de thèse, congrès. La refaire à la main sous PowerPoint à
 * partir d'une capture d'écran fait perdre la netteté et introduit des erreurs
 * de recopie. Ici chaque graphique est dessiné en formes natives — des
 * rectangles et du texte — donc net à toute échelle, modifiable, et rendu à
 * l'identique partout sans dépendre d'un moteur de rendu d'images.
 *
 * Le choix des formes plutôt que d'un graphique PowerPoint natif est délibéré :
 * le graphique natif embarque son propre classeur et sa propre feuille de
 * style, dont le rendu varie d'une version à l'autre. Des formes ne varient
 * pas, et c'est une figure d'article qu'on produit, pas un tableau de bord.
 */

/** Unité interne de PowerPoint : 914 400 par pouce. */
const EMU = 914_400;
/** Format 16/9, 33,87 × 19,05 cm. */
const SLIDE_W = Math.round(13.333 * EMU);
const SLIDE_H = Math.round(7.5 * EMU);

const cm = (value: number): number => Math.round((value / 2.54) * EMU);
/** Taille de police : PowerPoint compte en centièmes de point. */
const pt = (value: number): number => Math.round(value * 100);

export interface ChartBar {
  label: string;
  value: number;
}

export interface ChartSlide {
  /** Titre de la variable, tel qu'il figure dans la fiche. */
  title: string;
  /** Effectif décrit et manquants, affichés sous le titre. */
  subtitle: string;
  bars: ChartBar[];
  /** Note de bas de figure : moyenne, médiane, extrêmes. */
  note?: string;
}

export interface Deck {
  title: string;
  subtitle: string;
  slides: ChartSlide[];
}

/** Couleurs de la charte, en hexadécimal sans dièse comme l'exige le format. */
const INK = '0C0A26';
const MUTED = '5A6184';
const BRAND = '3D55C0';
const RULE = 'DDE4FF';

let shapeId = 1;

function textBox(
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  opts: { size: number; bold?: boolean; color?: string; align?: 'l' | 'r' | 'ctr' } = {
    size: 12,
  },
): string {
  const id = ++shapeId;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="t${id}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr>` +
    `<p:txBody><a:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0" anchor="ctr"/><a:lstStyle/>` +
    `<a:p><a:pPr algn="${opts.align ?? 'l'}"/><a:r><a:rPr lang="fr-FR" sz="${pt(opts.size)}"` +
    ` b="${opts.bold ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${opts.color ?? INK}"/></a:solidFill>` +
    `<a:latin typeface="Calibri"/></a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp>`
  );
}

function rect(x: number, y: number, w: number, h: number, color: string): string {
  const id = ++shapeId;
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="r${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${Math.max(w, 0)}" cy="${h}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
    `<a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>`
  );
}

/**
 * Un diagramme en barres horizontales, dessiné forme par forme.
 *
 * Barres horizontales et non verticales : les libellés de variables cliniques
 * sont longs, et se lisent de gauche à droite sans rotation.
 */
function chartShapes(slide: ChartSlide, index: number): string {
  const left = cm(2.2);
  const top = cm(4.2);
  const labelW = cm(6.5);
  const trackW = cm(19);
  const maxValue = Math.max(...slide.bars.map((b) => b.value), 1);

  // Au-delà d'une douzaine de classes, les barres deviennent des traits : on
  // garde les plus fournies et on l'indique dans la note.
  const bars = slide.bars.slice(0, 12);
  const rowH = cm(Math.min(1.05, 9 / Math.max(bars.length, 1)));
  const barH = Math.round(rowH * 0.55);

  const shapes = bars.map((bar, i) => {
    const y = top + i * rowH;
    const width = Math.round((bar.value / maxValue) * trackW);
    return (
      textBox(left, y, labelW, barH, bar.label, { size: 11, align: 'r', color: MUTED }) +
      rect(left + labelW + cm(0.3), y, trackW, barH, RULE) +
      rect(left + labelW + cm(0.3), y, width, barH, BRAND) +
      textBox(
        left + labelW + cm(0.3) + width + cm(0.2),
        y,
        cm(2),
        barH,
        String(bar.value),
        { size: 11, bold: true },
      )
    );
  });

  const omitted = slide.bars.length - bars.length;
  const note = [slide.note, omitted > 0 ? `${omitted} classes moins fournies non représentées` : '']
    .filter(Boolean)
    .join(' · ');

  return (
    textBox(left, cm(1.6), cm(26), cm(1.2), slide.title, { size: 24, bold: true }) +
    textBox(left, cm(3), cm(26), cm(0.8), slide.subtitle, { size: 12, color: MUTED }) +
    shapes.join('') +
    (note ? textBox(left, cm(16.4), cm(26), cm(0.8), note, { size: 11, color: MUTED }) : '') +
    // Numéro de figure et de page : c'est ce qui rend une figure citable dans
    // le texte d'un article.
    textBox(left, cm(17.4), cm(20), cm(0.8), `Figure ${index}`, { size: 11, bold: true, color: BRAND }) +
    textBox(cm(28), cm(17.4), cm(3.5), cm(0.8), String(index + 1), {
      size: 11,
      align: 'r',
      color: MUTED,
    })
  );
}

function slideXml(body: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
    `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>` +
    `<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>` +
    body +
    `</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" ` +
    `accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" ` +
    `accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`
  );
}

const RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PML = 'application/vnd.openxmlformats-officedocument.presentationml';

export function makePptx(deck: Deck): Buffer {
  shapeId = 1;

  const cover =
    textBox(cm(2.2), cm(6), cm(28), cm(2), deck.title, { size: 32, bold: true }) +
    textBox(cm(2.2), cm(8.4), cm(28), cm(1), deck.subtitle, { size: 14, color: MUTED });

  const slides = [slideXml(cover), ...deck.slides.map((s, i) => slideXml(chartShapes(s, i + 1)))];

  const entries: ZipEntry[] = [
    {
      path: '[Content_Types].xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/ppt/presentation.xml" ContentType="${PML}.presentation.main+xml"/>` +
        `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${PML}.slideMaster+xml"/>` +
        `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="${PML}.slideLayout+xml"/>` +
        `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
        slides
          .map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="${PML}.slide+xml"/>`)
          .join('') +
        `</Types>`,
    },
    {
      path: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="${RELS}/officeDocument" Target="ppt/presentation.xml"/>` +
        `</Relationships>`,
    },
    {
      path: 'ppt/presentation.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
        `xmlns:r="${RELS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst>` +
        `<p:sldIdLst>` +
        slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rIdSlide${i + 1}"/>`).join('') +
        `</p:sldIdLst>` +
        `<p:sldSz cx="${SLIDE_W}" cy="${SLIDE_H}"/><p:notesSz cx="${SLIDE_H}" cy="${SLIDE_W}"/>` +
        `</p:presentation>`,
    },
    {
      path: 'ppt/_rels/presentation.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdMaster" Type="${RELS}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
        `<Relationship Id="rIdTheme" Type="${RELS}/theme" Target="theme/theme1.xml"/>` +
        slides
          .map(
            (_, i) =>
              `<Relationship Id="rIdSlide${i + 1}" Type="${RELS}/slide" Target="slides/slide${i + 1}.xml"/>`,
          )
          .join('') +
        `</Relationships>`,
    },
    {
      path: 'ppt/slideMasters/slideMaster1.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
        `xmlns:r="${RELS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
        `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/></p:spTree></p:cSld>` +
        `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ` +
        `accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
        `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rIdLayout"/></p:sldLayoutIdLst>` +
        `</p:sldMaster>`,
    },
    {
      path: 'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdLayout" Type="${RELS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `<Relationship Id="rIdTheme" Type="${RELS}/theme" Target="../theme/theme1.xml"/>` +
        `</Relationships>`,
    },
    {
      path: 'ppt/slideLayouts/slideLayout1.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
        `xmlns:r="${RELS}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">` +
        `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
        `<p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`,
    },
    {
      path: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdMaster" Type="${RELS}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
        `</Relationships>`,
    },
    { path: 'ppt/theme/theme1.xml', data: themeXml() },
    ...slides.map((xml, i) => ({ path: `ppt/slides/slide${i + 1}.xml`, data: xml })),
    ...slides.map((_, i) => ({
      path: `ppt/slides/_rels/slide${i + 1}.xml.rels`,
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rIdLayout" Type="${RELS}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
        `</Relationships>`,
    })),
  ];

  return makeZip(entries);
}

/** Thème minimal, mais obligatoire : sans lui, PowerPoint refuse le fichier. */
function themeXml(): string {
  const scheme = (name: string, value: string) =>
    `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`;
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="PubResearcher">` +
    `<a:themeElements><a:clrScheme name="Charte">` +
    `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
    `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
    scheme('dk2', INK) + scheme('lt2', 'F5F7FB') +
    scheme('accent1', BRAND) + scheme('accent2', '5B3FD0') + scheme('accent3', 'B3262F') +
    scheme('accent4', '7A5A06') + scheme('accent5', '2F4299') + scheme('accent6', '6A90FB') +
    scheme('hlink', BRAND) + scheme('folHlink', MUTED) +
    `</a:clrScheme>` +
    `<a:fontScheme name="Calibri"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/>` +
    `<a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/>` +
    `<a:cs typeface=""/></a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Simple">` +
    `<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>` +
    `<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
    `<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
    `<a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>` +
    `<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle>` +
    `<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>` +
    `<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
    `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>` +
    `</a:fmtScheme></a:themeElements></a:theme>`
  );
}
