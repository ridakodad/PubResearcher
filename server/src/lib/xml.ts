/**
 * Lecteur XML minimal, sans dépendance.
 *
 * Il ne sert qu'à lire des documents dont on connaît la forme (les notices
 * PubMed d'`efetch`) : pas d'espaces de noms, pas de validation, pas d'entités
 * déclarées dans la DTD. Il est en revanche tolérant — une balise orpheline, une
 * entité inconnue ou un document tronqué ne le font pas échouer : il rend ce
 * qu'il a pu lire, et chaque notice se juge ensuite sur ses propres champs.
 *
 * Les balises de mise en forme que PubMed laisse dans les titres et les résumés
 * (`<i>`, `<sup>`, `<b>`…) sont des éléments comme les autres : `textOf` les
 * aplatit en texte.
 */

export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}
export type XmlNode = XmlElement | string;

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** Remplace les entités : numériques (`&#x2265;`, `&#160;`) et les cinq entités XML. Une entité inconnue reste telle quelle. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      // Un point de code hors Unicode, ou un caractère de contrôle autre qu'un blanc, n'a rien à faire dans une notice.
      if (!Number.isFinite(code) || code > 0x10ffff || (code < 0x20 && code !== 9 && code !== 10 && code !== 13)) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return '';
      }
    }
    return NAMED[body.toLowerCase()] ?? whole;
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of source.matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    attrs[m[1] as string] = decodeEntities(m[2] ?? m[3] ?? '');
  }
  return attrs;
}

/** Lit un document et rend sa racine — un élément `#document` qui contient tout ce qui a été lu. */
export function parseXml(source: string): XmlElement {
  const root: XmlElement = { name: '#document', attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1] as XmlElement;
  let i = 0;
  const n = source.length;

  while (i < n) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      const tail = source.slice(i);
      if (tail.trim()) top().children.push(decodeEntities(tail));
      break;
    }
    if (lt > i) {
      const text = source.slice(i, lt);
      // Les blancs d'indentation entre deux balises ne portent rien.
      if (text.trim() || stack.length > 1) top().children.push(decodeEntities(text));
    }

    if (source.startsWith('<!--', lt)) {
      const end = source.indexOf('-->', lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', lt)) {
      const end = source.indexOf(']]>', lt + 9);
      top().children.push(source.slice(lt + 9, end === -1 ? n : end));
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (source.startsWith('<?', lt)) {
      const end = source.indexOf('?>', lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (source.startsWith('<!', lt)) {
      // DOCTYPE, avec un éventuel sous-ensemble interne entre crochets.
      let j = lt + 2;
      let depth = 0;
      while (j < n) {
        const c = source[j];
        if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
        j++;
      }
      i = j + 1;
      continue;
    }

    // Balise ouvrante, fermante ou vide. Un « > » dans une valeur d'attribut entre guillemets ne la ferme pas.
    let j = lt + 1;
    let quote: string | null = null;
    while (j < n) {
      const c = source[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
      j++;
    }
    const inner = source.slice(lt + 1, j);
    i = j + 1;

    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      // Fermeture : on remonte jusqu'à l'élément du même nom ; une fermeture orpheline est ignorée.
      for (let k = stack.length - 1; k > 0; k--) {
        if ((stack[k] as XmlElement).name === name) {
          stack.length = k;
          break;
        }
      }
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const nameMatch = /^[^\s/>]+/.exec(body);
    if (!nameMatch) continue;
    const element: XmlElement = { name: nameMatch[0], attrs: parseAttrs(body.slice(nameMatch[0].length)), children: [] };
    top().children.push(element);
    if (!selfClosing) stack.push(element);
  }
  return root;
}

export const isElement = (node: XmlNode | undefined): node is XmlElement => typeof node === 'object' && node !== null;

/** Enfants directs portant ce nom. */
export function childrenOf(el: XmlElement | null | undefined, name: string): XmlElement[] {
  if (!el) return [];
  return el.children.filter((c): c is XmlElement => isElement(c) && c.name === name);
}

/** Premier enfant direct portant ce nom. */
export function childOf(el: XmlElement | null | undefined, name: string): XmlElement | null {
  if (!el) return null;
  for (const c of el.children) if (isElement(c) && c.name === name) return c;
  return null;
}

/** Descend un chemin d'enfants directs : `pathOf(article, 'Journal', 'JournalIssue', 'Volume')`. */
export function pathOf(el: XmlElement | null | undefined, ...names: string[]): XmlElement | null {
  let current: XmlElement | null = el ?? null;
  for (const name of names) {
    current = childOf(current, name);
    if (!current) return null;
  }
  return current;
}

/** Tous les descendants portant ce nom, à n'importe quelle profondeur. */
export function descendantsOf(el: XmlElement | null | undefined, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const walk = (node: XmlElement) => {
    for (const c of node.children) {
      if (!isElement(c)) continue;
      if (c.name === name) out.push(c);
      else walk(c);
    }
  };
  if (el) walk(el);
  return out;
}

/** Texte d'un élément, balises de mise en forme comprises, espaces resserrés. */
export function textOf(el: XmlElement | null | undefined): string {
  if (!el) return '';
  const parts: string[] = [];
  const walk = (node: XmlElement) => {
    for (const c of node.children) {
      if (typeof c === 'string') parts.push(c);
      else walk(c);
    }
  };
  walk(el);
  return parts.join('').replace(/\s+/g, ' ').trim();
}
