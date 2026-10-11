import { TableReadError } from './types.js';

/**
 * Lecture XML minimale, pour les parties d'un classeur.
 *
 * Un classeur ne contient que du XML simple et régulier : pas besoin d'un analyseur complet, et surtout pas d'un
 * analyseur qui suit les entités déclarées dans un DOCTYPE (« billion laughs », lecture de fichiers locaux). Celui-ci
 * reconnaît les balises, le texte, les sections CDATA, et les cinq entités prédéfinies plus les références numériques —
 * rien d'autre. Un DOCTYPE est refusé : aucun tableur n'en écrit.
 */

export interface XmlHandlers {
  /** Balise ouvrante (ou auto-fermante). `name` est le nom local, sans préfixe d'espace de noms. */
  open?(name: string, attrs: string, selfClosing: boolean): void;
  close?(name: string): void;
  /** Texte brut entre deux balises, encore échappé (voir `decodeXml`). */
  text?(raw: string, cdata: boolean): void;
}

const TOKEN = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[^\s=>/]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<!([^>]*)>/g;

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

export function walkXml(xml: string, handlers: XmlHandlers): void {
  TOKEN.lastIndex = 0;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN.exec(xml)) !== null) {
    if (match.index > last && handlers.text) handlers.text(xml.slice(last, match.index), false);
    last = TOKEN.lastIndex;
    if (match[2] !== undefined) {
      const name = localName(match[2]);
      if (match[1] === '/') handlers.close?.(name);
      else {
        const selfClosing = match[4] === '/';
        handlers.open?.(name, match[3] ?? '', selfClosing);
        if (selfClosing) handlers.close?.(name);
      }
    } else if (match[5] !== undefined) {
      handlers.text?.(match[5], true);
    } else if (match[6] !== undefined && /^DOCTYPE/i.test(match[6].trim())) {
      throw new TableReadError('Classeur refusé : il déclare un DOCTYPE (entités XML), ce qu’aucun tableur n’écrit. Réenregistrez-le depuis Excel ou LibreOffice.');
    }
  }
  if (last < xml.length && handlers.text) handlers.text(xml.slice(last), false);
}

const attrPatterns = new Map<string, RegExp>();

/** Valeur d'un attribut (préfixe d'espace de noms ignoré : « r:id » répond à `id`), décodée ; `null` s'il est absent. */
export function attr(attrs: string, name: string): string | null {
  let pattern = attrPatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)(?:[\\w.-]+:)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attrPatterns.set(name, pattern);
  }
  const m = pattern.exec(attrs);
  if (!m) return null;
  return decodeXml(m[1] ?? m[2] ?? '');
}

const NAMED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Entités prédéfinies et références numériques ; toute autre entité reste telle quelle. */
export function decodeXml(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const n = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

/**
 * Échappements propres à Office (« _x000D_ » pour un retour chariot, « _x005F_ » pour un tiret bas littéral) :
 * Excel écrit ainsi, dans le texte des cellules, les caractères que XML ne sait pas porter.
 */
export function decodeOfficeEscapes(text: string): string {
  if (!text.includes('_x')) return text;
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
