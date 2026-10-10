/**
 * Texte brut, RTF et HTML : les formats « texte » des exports de dossiers
 * hospitaliers, avec leurs pièges.
 *
 * Le piège principal est l'encodage. Un export de logiciel hospitalier est très
 * souvent en Windows-1252 : lu comme de l'UTF-8, « Âge » devient « �ge », et
 * aucune règle qui cherche « âge » ne trouve plus rien — sans qu'une erreur ne
 * soit signalée. On détecte donc l'encodage au lieu de le supposer.
 */

export interface DecodedText {
  text: string;
  /** Encodage retenu, conservé dans les métadonnées du document. */
  charset: 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';
}

/**
 * Windows-1252 : les octets 0x80 à 0x9F, ceux des « — », « œ », « ’ », « … », « € ». Le reste est de l'ISO-8859-1.
 *
 * Écrit à la main parce que `new TextDecoder('windows-1252')` n'est pas fiable d'une version de Node à l'autre :
 * sur les onze versions de Node 22.13.0 à 22.21.1 essayées, il rend ces octets tels quels, en caractères de contrôle
 * invisibles (« œdème » devient « \x9Cdème », l'apostrophe typographique de Word disparaît) et aucune règle ne
 * retrouve plus rien ; 22.22.2, 22.23.3, 24.21.0 et 26.11.1 rendent la bonne table.
 * Les points de code sont ceux de la table « windows-1252 » du standard d'encodage WHATWG ; les cinq octets
 * non définis (0x81, 0x8D, 0x8F, 0x90, 0x9D) donnent le caractère de contrôle de même numéro, comme dans les navigateurs.
 */
const WINDOWS_1252_C1 = [
  0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
  0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
].map((codePoint) => String.fromCodePoint(codePoint));

// [U+0080-U+009F] : bâti à partir des numéros, pour que le fichier source ne contienne aucun caractère de contrôle.
const C1_CONTROLS = new RegExp(`[${String.fromCharCode(0x80)}-${String.fromCharCode(0x9f)}]`, 'g');

/** Décode des octets Windows-1252 en texte (voir ci-dessus). */
export function decodeWindows1252(bytes: Uint8Array): string {
  // « latin1 » rend chaque octet par le point de code de même numéro : exact partout sauf pour 0x80-0x9F.
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString('latin1')
    .replace(C1_CONTROLS, (c) => WINDOWS_1252_C1[c.charCodeAt(0) - 0x80]!);
}

/** Décode un tampon en texte : nomenclature (BOM), UTF-16 sans BOM, UTF-8 strict, sinon Windows-1252. */
export function decodeText(buffer: Buffer): DecodedText {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.toString('utf8', 3), charset: 'utf-8' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.toString('utf16le', 2), charset: 'utf-16le' };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.from(buffer.subarray(2));
    swapped.swap16();
    return { text: swapped.toString('utf16le'), charset: 'utf-16be' };
  }
  // UTF-16 sans nomenclature : une lettre sur deux est un octet nul.
  const sample = buffer.subarray(0, Math.min(buffer.length, 400));
  let nulsEven = 0;
  let nulsOdd = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) (i % 2 === 0 ? nulsEven++ : nulsOdd++);
  }
  const half = sample.length / 2;
  if (sample.length >= 8 && nulsOdd > half * 0.4 && nulsEven < half * 0.05) {
    return { text: buffer.toString('utf16le'), charset: 'utf-16le' };
  }
  if (sample.length >= 8 && nulsEven > half * 0.4 && nulsOdd < half * 0.05) {
    const swapped = Buffer.from(buffer);
    swapped.swap16();
    return { text: swapped.toString('utf16le'), charset: 'utf-16be' };
  }

  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), charset: 'utf-8' };
  } catch {
    return { text: decodeWindows1252(buffer), charset: 'windows-1252' };
  }
}

/* ──────────────────────────────────── RTF ─────────────────────────────────── */

/** Groupes dont le contenu n'est pas du texte lisible. */
const RTF_SKIPPED = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl',
  'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'footnote', 'generator', 'listtable',
  'listoverridetable', 'revtbl', 'rsidtbl', 'themedata', 'colorschememapping', 'datastore',
  'latentstyles', 'xmlnstbl', 'mmathPr', 'fldinst', 'bkmkstart', 'bkmkend', 'shpinst', 'nonshppict',
]);

const RTF_SYMBOLS: Record<string, string> = {
  emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”',
  tab: '\t', line: '\n', par: '\n', page: '\n', sect: '\n', cell: ' : ', row: '\n', nestcell: ' : ',
  nestrow: '\n',
};

/** Octet \'hh de la page de codes ANSI (Windows-1252 par défaut) vers son caractère. */
function ansiChar(byte: number): string {
  return byte >= 0x80 && byte <= 0x9f ? WINDOWS_1252_C1[byte - 0x80]! : String.fromCharCode(byte);
}

export function looksLikeRtf(buffer: Buffer): boolean {
  return buffer.length > 5 && buffer.toString('latin1', 0, 5) === '{\\rtf';
}

/**
 * Convertit un document RTF en texte.
 *
 * Gère les groupes à ignorer (polices, tables de couleurs, images, en-têtes),
 * les accents `\'e9`, les caractères Unicode `\u233?` et leurs repli, les
 * paragraphes et les tableaux (une cellule devient « : », comme pour Word).
 */
export function rtfToText(rtf: string): string {
  const out: string[] = [];
  const stack: { skip: boolean; unicodeSkip: number }[] = [];
  let skip = false;
  let unicodeSkip = 1; // \ucN : nombre de caractères de repli qui suivent un \uN
  let pendingFallback = 0;
  let i = 0;
  let groupStart = false;

  while (i < rtf.length) {
    const ch = rtf[i]!;

    if (ch === '{') {
      stack.push({ skip, unicodeSkip });
      i++;
      groupStart = true;
      continue;
    }
    if (ch === '}') {
      const top = stack.pop();
      if (top) ({ skip, unicodeSkip } = top);
      i++;
      groupStart = false;
      continue;
    }

    if (ch === '\\') {
      const next = rtf[i + 1] ?? '';

      // Symboles : \\ \{ \} \~ \- \_ \* \' et fin de ligne échappée
      if (!/[a-zA-Z]/.test(next)) {
        i += 2;
        if (next === "'") {
          const hex = rtf.slice(i, i + 2);
          i += 2;
          if (pendingFallback > 0) { pendingFallback--; continue; }
          if (!skip && /^[0-9a-fA-F]{2}$/.test(hex)) out.push(ansiChar(parseInt(hex, 16)));
        } else if (next === '*') {
          // Destination facultative : on l'ignore entièrement si elle est inconnue.
          if (groupStart) skip = true;
        } else if (pendingFallback > 0) {
          pendingFallback--;
        } else if (!skip) {
          if (next === '~') out.push(' ');
          else if (next === '_') out.push('-');
          else if (next === '\n' || next === '\r') out.push('\n');
          else if (next === '\\' || next === '{' || next === '}') out.push(next);
        }
        groupStart = false;
        continue;
      }

      // Mot de contrôle : \mot, paramètre numérique facultatif, espace délimiteur
      const m = /^\\([a-zA-Z]+)(-?\d+)?[ ]?/.exec(rtf.slice(i, i + 40));
      if (!m) { i++; continue; }
      i += m[0].length;
      const word = m[1]!;
      const param = m[2] !== undefined ? Number(m[2]) : null;

      if (groupStart && RTF_SKIPPED.has(word)) skip = true;
      groupStart = false;

      if (word === 'uc' && param !== null) { unicodeSkip = param; continue; }
      if (skip) continue;

      if (word === 'u' && param !== null) {
        const code = param < 0 ? param + 65536 : param;
        out.push(String.fromCharCode(code));
        pendingFallback = unicodeSkip;
        continue;
      }
      const symbol = RTF_SYMBOLS[word];
      if (symbol !== undefined) out.push(symbol);
      continue;
    }

    groupStart = false;
    if (ch === '\r' || ch === '\n') { i++; continue; } // les sauts de ligne du fichier ne comptent pas
    if (pendingFallback > 0) { pendingFallback--; i++; continue; }
    if (!skip) out.push(ch);
    i++;
  }

  return out
    .join('')
    .replace(/ : \n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ──────────────────────────────────── HTML ────────────────────────────────── */

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", laquo: '«', raquo: '»',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', agrave: 'à', acirc: 'â', auml: 'ä',
  icirc: 'î', iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü', ccedil: 'ç',
  Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Agrave: 'À', Acirc: 'Â', Icirc: 'Î', Ocirc: 'Ô', Ucirc: 'Û',
  Ccedil: 'Ç', oelig: 'œ', OElig: 'Œ', deg: '°', micro: 'µ', plusmn: '±', euro: '€',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const n = parseInt(body.slice(2), 16);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    if (body.startsWith('#')) {
      const n = Number(body.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

/**
 * HTML vers texte, en conservant la structure utile à l'extraction : les
 * cellules d'un tableau deviennent « libellé : valeur », les blocs des lignes.
 * Les scripts, styles et commentaires n'apparaissent jamais dans le texte.
 */
export function htmlToText(html: string): string {
  // Dans <pre>, les sauts de ligne comptent ; partout ailleurs le HTML les traite comme des espaces.
  const preformatted: string[] = [];
  const withoutPre = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|head|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, body: string) => {
      preformatted.push(body);
      return `<p>\uE000${preformatted.length - 1}\uE000</p>`;
    })
    .replace(/\s+/g, ' ');

  const text = decodeEntities(
    withoutPre
      .replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' : ')
      .replace(/<\/tr>/gi, '\n')
      .replace(/<\/(p|div|li|ul|ol|h[1-6]|table|section|article|blockquote)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    // Espaces insécables et fines : une espace, pour les règles.
    .replace(/[\u00a0\u202f]/g, ' ');

  return (
    text
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      // Des blocs qui se ferment à la suite (fin de ligne de tableau, puis du tableau)
      // ne font pas de ligne vide : le texte est orienté ligne.
      .replace(/\n{2,}/g, '\n')
      .trim()
      // Le contenu de <pre> est restitué après le nettoyage, tel quel.
      .replace(/\uE000(\d+)\uE000/g, (_m, i: string) =>
        decodeEntities((preformatted[Number(i)] ?? '').replace(/<[^>]+>/g, '')).replace(/[\u00a0\u202f]/g, ' '),
      )
  );
}

export function looksLikeHtml(text: string): boolean {
  return /<(?:!doctype html|html|body|table|div|p|br|span|h[1-6])\b/i.test(text.slice(0, 2000));
}
