import { z } from 'zod';
import type { FieldType } from '../domain/types.js';
import { FIELD_TYPES } from '../domain/types.js';
import type { TableCell, TableSheet, TableWorkbook } from '../table/types.js';

/**
 * Lecture d'une fiche d'exploitation existante (Word, Excel, CSV) : on en tire la liste des variables à proposer au
 * chercheur, qui la relit avant que la fiche ne soit créée.
 *
 * Deux voies mènent au même résultat (`DraftField[]`) :
 *
 *  - l'analyse par règles, ici, sans clé d'API : elle reconnaît les mises en page usuelles des fiches papier
 *    (« Libellé : ____ », cases « ☐ Oui ☐ Non », titres de section en capitales ou numérotés, tableaux Word
 *    « Variable | Oui | Non », dictionnaires de données Excel, feuilles de saisie vierges) ;
 *  - Claude (`routes/template-import.ts`), dont la réponse est validée ici (`claudeDraftSchema`) puis normalisée
 *    comme celle des règles. Toute réponse inexploitable ramène à l'analyse par règles.
 *
 * Rien n'est écrit à ce stade : ce n'est qu'une proposition, que l'interface fait relire variable par variable.
 * Les lignes que l'analyse n'a pas su interpréter sont rendues en avertissements, plutôt que devinées.
 */

export interface DraftField {
  label: string;
  key: string;
  type: FieldType;
  section: string;
  unit: string | null;
  options: string[];
  required: boolean;
  description: string | null;
}

export interface ParsedForm {
  fields: DraftField[];
  warnings: string[];
}

export const DEFAULT_SECTION = 'Général';
/** Au-delà, une fiche n'est plus une fiche : c'est probablement un document mal reconnu. */
const MAX_FIELDS = 500;
const MAX_WARNINGS = 30;

// ---------------------------------------------------------------- utilitaires

/** Minuscules sans accents : les en-têtes « Libellé », « LIBELLE », « libelle » se valent. */
export function fold(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/** Identifiant technique d'une variable : ASCII, snake_case, commence par une lettre, 60 caractères au plus. */
export function slugKey(label: string): string {
  let slug = fold(label)
    .replace(/œ/g, 'oe')
    .replace(/æ/g, 'ae')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50)
    .replace(/_+$/g, '');
  if (!slug) slug = 'variable';
  if (!/^[a-z]/.test(slug)) slug = `v_${slug}`;
  return slug;
}

/** Rend les clés uniques (`poids`, `poids_2`…) en partant de la clé proposée, ou du libellé à défaut. */
export function uniqueKeys<T extends { key?: string | null; label: string }>(fields: T[], taken: Iterable<string> = []): string[] {
  const used = new Set(taken);
  return fields.map((f) => {
    const base = slugKey(f.key && f.key.trim() ? f.key : f.label);
    let key = base;
    for (let i = 2; used.has(key); i++) key = `${base.slice(0, 55)}_${i}`;
    used.add(key);
    return key;
  });
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Cases à cocher des fiches : ☐ □ ☑ ☒ ❑ ○ ◯, « [ ] », « [x] », « ( ) ». */
const CHECKBOX = /[☐□☑☒❑❒○◯◻▢]|\[\s?[xX✓]?\s?\]|\(\s\)/u;
const CHECKBOX_SPLIT = /\s*(?:[☐□☑☒❑❒○◯◻▢]|\[\s?[xX✓]?\s?\]|\(\s\))\s*/gu;
/** Zone à remplir : soulignés, pointillés, points de suspension, « jj/mm/aaaa », « __/__/____ ». */
const BLANK = /^[\s_.…\-–—/|]*$/;
const DATE_BLANK = /(?:_+|\.+|…+)\s*\/\s*(?:_+|\.+|…+)\s*\/\s*(?:_+|\.+|…+)|\bjj\s*\/\s*mm(?:\s*\/\s*aa(?:aa)?)?\b/i;
const REQUIRED = /\s*(?:\(\s*obligatoire\s*\)|\*+)\s*/gi;
const MULTI_HINT = /\(?\s*(?:plusieurs réponses possibles|plusieurs choix possibles|choix multiples?|réponses? multiples?|cocher tout ce qui s['’]applique|cochez tout ce qui s['’]applique|cocher toutes? les cases? utiles?)\s*\)?/giu;

/** Mots entiers, accents compris (`\\b` ignore les lettres accentuées). */
const words = (alternatives: string) => new RegExp(String.raw`(?<![\p{L}\d])` + alternatives + String.raw`(?![\p{L}\d])`, 'iu');
const NUMBER_WORDS =
  words(String.raw`(?:poids|taille|imc|bmi|crp|hb|hémoglobine|hemoglobine|taux|dose|posologie|fréquence|frequence|fc|fr|pad|pam|tension|température|temperature|glycémie|glycemie|créatinine|creatinine|créatininémie|leucocytes|gb|plaquettes|pnn|lymphocytes|saturation|spo2|sao2|volume|diamètre|diametre|délai|delai|durée|duree|albumine|ferritine|natrémie|kaliémie|urée|uree|pct|procalcitonine|lactates?|ph|pao2|paco2|vs|tsh|inr|tp|bilirubine|asat|alat|ggt|clairance|dfg|hba1c|cholestérol|triglycérides|ldl|hdl|mesure|valeur|dosage|pression|poids de naissance|périmètre|perimetre|surface|longueur|largeur|épaisseur|epaisseur|fevg)`);
const INTEGER_WORDS = words(String.raw`(?:âge|age|nombre|nb|n°? de|score|nbre|parité|parite|gestité|gestite|apgar|glasgow|gcs|nihss|asa|stade|grade|rang|jours d['’]hospitalisation|séances|cures|cycles)`);
const DATE_WORDS = words(String.raw`(?:date|né\(?e?\)? le|née? le|le\s*$)`);

/** Unité entre parenthèses ou crochets en fin de libellé : « CRP (mg/L) », « Poids [kg] ». */
function splitUnit(label: string): { label: string; unit: string | null } {
  const m = /^(.*?)\s*[([]\s*([^()[\]]{1,15}?)\s*[)\]]\s*$/.exec(label);
  if (!m || !m[1]) return { label, unit: null };
  const unit = m[2]!.trim();
  if (!looksLikeUnit(unit)) return { label, unit: null };
  return { label: m[1].trim(), unit };
}

function looksLikeUnit(u: string): boolean {
  if (!u || u.split(/\s+/).length > 2) return false;
  if (/^(?:oui|non|o|n|m|f|si oui|facultatif|optionnel|en clair)$/i.test(u)) return false;
  // « /mm3 », « /µL », « x10^9/L » : numérations, écrites sans unité de masse devant la barre.
  if (/^(?:x?\s?10\^?\d+)?\/(?:mm3|mm³|µl|μl|ul|l|ml|min|h|j)$/i.test(u)) return true;
  return /^(?:%|‰|°c?|[a-zµμ]{1,4}(?:\/[a-zµμ0-9.²³]{1,6})*[²³]?|[a-zµμ]+\/[a-zµμ0-9.²³]+|ans|mois|jours?|semaines?|heures?|min|mmhg|bpm|cpm|ua|ui\/l|g\/dl|mmol\/l|µmol\/l|mg\/l|g\/l|kg\/m²|10\^?\d+\/l|giga\/l|g\/l|cm|mm|ml|l|kg|g)$/i.test(
    u,
  );
}

/** Unité notée après la zone à remplir : « Poids : ____ kg ». */
function unitAfterBlank(value: string): string | null {
  const m = /^[\s_.…]+([^\s_.…][^_.…]{0,12})$/.exec(value);
  if (!m) return null;
  const u = m[1]!.trim();
  return looksLikeUnit(u) ? u : null;
}

function guessType(label: string, unit: string | null, value = ''): FieldType {
  if (DATE_BLANK.test(value) || DATE_BLANK.test(label) || DATE_WORDS.test(label)) return 'date';
  if (INTEGER_WORDS.test(label) && !/\b(?:date|commentaire|précise?z?)\b/i.test(label)) return 'integer';
  if (unit && /^(?:ans|mois|jours?|semaines?)$/i.test(unit)) return 'integer';
  if (unit || NUMBER_WORDS.test(label)) return 'number';
  return 'text';
}

const BOOL_WORDS = new Set(['oui', 'non', 'o', 'n', 'yes', 'no', 'y', 'vrai', 'faux']);

/** Options « Oui / Non » (ou « O / N ») : une variable booléenne, sans liste d'options. */
function isBooleanOptions(options: string[]): boolean {
  if (options.length !== 2) return false;
  const set = new Set(options.map((o) => fold(o).replace(/[.:]$/, '')));
  return (set.has('oui') && set.has('non')) || (set.has('o') && set.has('n')) || (set.has('yes') && set.has('no')) || (set.has('vrai') && set.has('faux'));
}

/** Liste « A / B / C » en valeur d'un libellé : des mots courts, sans zone à remplir. */
function slashOptions(value: string): string[] | null {
  if (!/[/|]/.test(value) || /_{2,}|\.{3,}|…/.test(value)) return null;
  const parts = value.split(/\s*[/|]\s*/).map(clean).filter(Boolean);
  if (parts.length < 2 || parts.length > 15) return null;
  if (parts.some((p) => p.length > 40 || /^\d+$/.test(p))) return null;
  return parts;
}

/** Lecture d'un libellé : obligatoire, choix multiples, unité. */
function labelInfo(raw: string): { label: string; unit: string | null; required: boolean; multi: boolean } {
  let label = raw;
  const required = /\(\s*obligatoire\s*\)|\*/i.test(label);
  label = label.replace(REQUIRED, ' ');
  const multi = MULTI_HINT.test(label);
  MULTI_HINT.lastIndex = 0;
  label = label.replace(MULTI_HINT, ' ');
  label = clean(label)
    .replace(/^[-•·▪●◦*+]\s*/, '')
    .replace(/^(?:\d{1,2}[.)]|[a-z][.)])\s+/i, '')
    .replace(/\s*[:：?]\s*$/, '')
    .trim();
  const { label: bare, unit } = splitUnit(label);
  return { label: bare, unit, required, multi };
}

// ---------------------------------------------------------------- texte (Word)

/** Ligne de titre de section : capitales, numérotation « 1. », « I. », « A) », sans zone à remplir. */
function sectionTitle(line: string): string | null {
  if (CHECKBOX.test(line) || /_{2,}|\.{4,}|…/.test(line) || line.length > 90) return null;
  const numbered = /^(?:(?:\d{1,2}|[IVXLC]{1,5})[.)-]|[A-H][.)])\s+(.+)$/.exec(line);
  if (numbered) {
    const title = numbered[1]!.replace(/\s*:\s*$/, '').trim();
    if (!title.includes(':') && /\p{L}{3,}/u.test(title)) return title;
    return null;
  }
  const letters = line.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 3 && letters === letters.toUpperCase() && !/:\s*\S/.test(line)) {
    return line.replace(/\s*:\s*$/, '').trim();
  }
  return null;
}

/** En-tête de tableau Word sans intérêt : « Variable : Valeur », « Paramètre : Résultat ». */
const TABLE_HEADER = /^(?:variables?|paramètres?|parametres?|items?|questions?|critères?|criteres?|données?|donnees?|libellés?|libelles?)\s*:\s*(?:valeurs?|résultats?|resultats?|réponses?|reponses?|oui\s*:\s*non)?\s*$/i;

/**
 * Analyse le texte d'une fiche (Word converti en texte par `extract/docx.ts` : les cellules d'une ligne de tableau y
 * sont séparées par « : »).
 */
export function parseFormText(text: string): ParsedForm {
  // Une cellule de tableau Word se termine par un paragraphe : « Poids\n: ____ » est une seule ligne du tableau.
  const lines = text.replace(/\n(?=\s*:)/g, ' ').split(/\r?\n/).map((l) => l.replace(/[  \t]/g, ' ').replace(/ {2,}/g, ' ').trim());
  const fields: Omit<DraftField, 'key'>[] = [];
  const warnings: string[] = [];
  let section = DEFAULT_SECTION;
  /** Libellé seul (« Antécédents : ») : variable à options si des cases suivent, sinon titre ou champ texte. */
  let pending: { raw: string; info: ReturnType<typeof labelInfo>; section: string } | null = null;
  /** La ligne précédente était un tableau « Variable | Oui | Non » : ses lignes suivantes sont des booléens. */
  let yesNoTable = false;

  const add = (f: Omit<DraftField, 'key'>) => {
    if (fields.length < MAX_FIELDS && f.label) fields.push(f);
  };
  const warn = (line: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(`Ligne non interprétée : « ${line.slice(0, 120)} »`);
  };
  const flushPending = (asSection: boolean) => {
    if (!pending) return;
    if (asSection) section = pending.info.label || section;
    else {
      const { label, unit, required } = pending.info;
      add({ label, type: guessType(label, unit), section: pending.section, unit, options: [], required, description: null });
    }
    pending = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line || BLANK.test(line)) continue;

    // Tableau Word « Variable | Oui | Non » : la ligne d'en-tête annonce des booléens.
    if (/^[^:]{1,40}:\s*oui\s*:\s*non\s*$/i.test(line)) {
      flushPending(true);
      yesNoTable = true;
      continue;
    }
    if (TABLE_HEADER.test(line)) {
      flushPending(true);
      continue;
    }

    // Cases à cocher : « Sexe : ☐ Homme ☐ Femme », ou une ligne de cases seules sous un libellé.
    if (CHECKBOX.test(line)) {
      const parts = line.split(CHECKBOX_SPLIT);
      const head = parts.shift() ?? '';
      const options = parts.map((p) => clean(p.replace(/\s*:\s*$/, '').replace(/^:\s*/, ''))).filter((p) => p && !BLANK.test(p));
      // Dans un tableau Word, la cellule du libellé est suivie de « : » avant les cases.
      const headLabel = head.replace(/\s*:\s*$/, '');
      let target: { info: ReturnType<typeof labelInfo>; section: string } | null = null;
      if (headLabel && !BLANK.test(headLabel)) {
        flushPending(false);
        target = { info: labelInfo(headLabel), section };
      } else if (pending) {
        target = pending;
        pending = null;
      } else if (fields.length > 0 && options.length > 0) {
        // Cases sur une ligne à part, sous une variable déjà à options : on complète sa liste.
        const last = fields[fields.length - 1]!;
        if (last.type === 'enum' || last.type === 'multi') {
          last.options.push(...options.filter((o) => !last.options.includes(o)));
          continue;
        }
      }
      if (!target || options.length === 0) {
        warn(line);
        continue;
      }
      const multi = target.info.multi || MULTI_HINT.test(line);
      MULTI_HINT.lastIndex = 0;
      const opts = options.map((o) => clean(o.replace(MULTI_HINT, ' ').replace(REQUIRED, ' '))).filter(Boolean);
      MULTI_HINT.lastIndex = 0;
      const boolean = !multi && (isBooleanOptions(opts) || (opts.length === 1 && /^oui$/i.test(opts[0]!)));
      add({
        label: target.info.label,
        type: boolean ? 'boolean' : multi ? 'multi' : 'enum',
        section: target.section,
        unit: null,
        options: boolean ? [] : opts,
        required: target.info.required || /\(\s*obligatoire\s*\)|\*/.test(line),
        description: null,
      });
      continue;
    }

    // Puce sous un libellé seul : « - Diabète », « • HTA » (options d'une liste à choix).
    const bullet = /^[-•·▪●◦]\s+(.{1,60})$/.exec(line);
    if (bullet && pending && !bullet[1]!.includes(':')) {
      const info = pending.info;
      const options = [bullet[1]!.trim()];
      while (i + 1 < lines.length) {
        const next = /^[-•·▪●◦]\s+(.{1,60})$/.exec(lines[i + 1]!);
        if (!next || next[1]!.includes(':')) break;
        options.push(next[1]!.trim());
        i++;
      }
      add({ label: info.label, type: info.multi ? 'multi' : isBooleanOptions(options) ? 'boolean' : 'enum', section: pending.section, unit: null, options: isBooleanOptions(options) ? [] : options, required: info.required, description: null });
      pending = null;
      continue;
    }

    const title = sectionTitle(line);
    if (title) {
      flushPending(false);
      section = title;
      yesNoTable = false;
      continue;
    }

    // « Libellé : valeur » (texte ou ligne de tableau Word).
    const colon = /^(.+?)\s*[:：]\s*(.*)$/.exec(line);
    if (colon) {
      const rawLabel = colon[1]!;
      const value = colon[2]!.trim();
      if (!/\p{L}/u.test(rawLabel)) {
        warn(line);
        continue;
      }
      if (rawLabel.length > 120) {
        warn(line);
        continue;
      }
      // Libellé seul : on attend la ligne suivante pour savoir s'il annonce des options, une section, ou une saisie.
      if (!value) {
        if (pending) flushPending(looksLikeSectionFollow(lines, i));
        pending = { raw: rawLabel, info: labelInfo(rawLabel), section };
        if (yesNoTable) {
          const { label, required } = pending.info;
          add({ label, type: 'boolean', section, unit: null, options: [], required, description: null });
          pending = null;
        }
        continue;
      }
      flushPending(looksLikeSectionFollow(lines, i - 1));
      const info = labelInfo(rawLabel);
      // Ligne de tableau « Variable : Oui : Non » (cases vides ou « X » dans les colonnes) : booléen.
      if (yesNoTable && /^(?:[xX✓]?\s*:\s*[xX✓]?|[xX✓])$/.test(value)) {
        add({ label: info.label, type: 'boolean', section, unit: null, options: [], required: info.required, description: null });
        continue;
      }
      const options = slashOptions(value.replace(REQUIRED, ' '));
      if (options) {
        const boolean = !info.multi && isBooleanOptions(options);
        add({ label: info.label, type: boolean ? 'boolean' : info.multi ? 'multi' : 'enum', section, unit: null, options: boolean ? [] : options, required: info.required || /\(\s*obligatoire\s*\)|\*/.test(value), description: null });
        continue;
      }
      if (DATE_BLANK.test(value) || BLANK.test(value)) {
        const unit = info.unit;
        add({ label: info.label, type: guessType(info.label, unit, value), section, unit, options: [], required: info.required, description: null });
        continue;
      }
      const after = unitAfterBlank(value);
      if (after) {
        const unit = info.unit ?? after;
        const type = guessType(info.label, unit, value);
        add({ label: info.label, type: type === 'text' ? 'number' : type, section, unit, options: [], required: info.required, description: null });
        continue;
      }
      // Valeur déjà écrite (fiche remplie, exemple) : le libellé reste une variable, la valeur n'est pas reprise.
      if (value.length <= 60 && !/[.!?]$/.test(value)) {
        add({ label: info.label, type: guessType(info.label, info.unit, value), section, unit: info.unit, options: [], required: info.required, description: null });
        continue;
      }
      warn(line);
      continue;
    }

    // « Libellé ____ » sans deux-points.
    const blanked = /^(.{2,80}?)\s*(?:_{3,}|\.{4,}|…{2,})(.*)$/.exec(line);
    if (blanked && /\p{L}/u.test(blanked[1]!)) {
      flushPending(false);
      const info = labelInfo(blanked[1]!);
      const unit = info.unit ?? unitAfterBlank(`_${blanked[2]}`);
      add({ label: info.label, type: guessType(info.label, unit, line), section, unit, options: [], required: info.required, description: null });
      continue;
    }

    // Titre de document, consigne, paragraphe : rien à en tirer.
    if (fields.length === 0 && !pending) continue;
    if (pending) flushPending(false);
    warn(line);
  }
  flushPending(false);

  return finish(fields, warnings);
}

/** Un libellé seul suivi de libellés « à remplir » introduits par une puce : c'était un titre de section. */
function looksLikeSectionFollow(lines: string[], i: number): boolean {
  const next = lines.slice(i + 1).find((l) => l && !BLANK.test(l));
  return !!next && /^[-•·▪●◦]\s+.+:/.test(next);
}

function finish(fields: Omit<DraftField, 'key'>[], warnings: string[]): ParsedForm {
  const keys = uniqueKeys(fields);
  return { fields: fields.map((f, i) => ({ ...f, key: keys[i]! })), warnings };
}

// ---------------------------------------------------------------- classeurs (Excel, CSV)

const cellString = (c: TableCell | null | undefined): string => (c == null || c.v == null ? '' : clean(String(c.v)));

const HEADER_ROLES: [keyof DictColumns, RegExp][] = [
  ['label', /^(?:libelle|intitule|question|description de la variable|label|nom complet|item)s?$/],
  ['name', /^(?:variables?|nom|nom de (?:la )?variable|code|champ|identifiant|cle|name|var)$/],
  ['type', /^(?:type|type de (?:donnee|variable)|format|nature)$/],
  ['options', /^(?:modalites?|valeurs?(?: possibles)?|options?|choix|reponses? possibles|codage|liste)$/],
  ['unit', /^(?:unites?|unit)$/],
  ['section', /^(?:section|rubrique|partie|categorie|chapitre|bloc|onglet|groupe)$/],
  ['required', /^(?:obligatoire|requis|required|necessaire)$/],
  ['description', /^(?:commentaires?|remarques?|aide|consigne|notes?|definition|precisions?)$/],
];

interface DictColumns {
  label?: number;
  name?: number;
  type?: number;
  options?: number;
  unit?: number;
  section?: number;
  required?: number;
  description?: number;
}

/** Type écrit dans un dictionnaire de données (« Numérique », « Liste », « Oui/Non »…). */
function typeFromWord(raw: string): FieldType | null {
  const t = fold(raw);
  if (!t) return null;
  if (/multi|plusieurs|cases a cocher|checkbox/.test(t)) return 'multi';
  if (/^(?:o\/n|oui\/non|oui-non|bool|binaire|dichotom|vrai\/faux|logique)/.test(t)) return 'boolean';
  if (/date|jj\/mm/.test(t)) return 'date';
  if (/entier|integer|^int$|discret|comptage/.test(t)) return 'integer';
  if (/num|nombre|decimal|reel|float|quanti|continu|mesure/.test(t)) return 'number';
  if (/liste|enum|choix|quali|categ|modal|nominal|ordinal|menu/.test(t)) return 'enum';
  if (/texte|text|chaine|libre|string|alpha|caract|commentaire/.test(t)) return 'text';
  return null;
}

function splitOptions(raw: string): string[] {
  if (!raw.trim()) return [];
  const sep = /[;\n|]/.test(raw) ? /\s*[;\n|]\s*/ : /\s*[,/]\s*/;
  return raw
    .split(sep)
    .map((o) => clean(o.replace(/^\s*\d{1,3}\s*[=:-]\s*/, '')))
    .filter(Boolean)
    .slice(0, 100);
}

const yesish = (s: string) => /^(?:oui|o|x|1|vrai|yes|y|obligatoire|requis|true)$/i.test(fold(s));

/** Première ligne non vide d'une feuille (ligne d'en-tête). */
function headerRowIndex(sheet: TableSheet): number {
  return sheet.rows.findIndex((r) => r.filter((c) => cellString(c)).length >= 1);
}

export function parseFormWorkbook(workbook: TableWorkbook): ParsedForm {
  const warnings = [...workbook.warnings.slice(0, 5)];
  const sheets = workbook.sheets.filter((s) => !s.hidden && !s.error && s.rows.length > 0);
  if (sheets.length === 0) return { fields: [], warnings: [...warnings, 'Aucune feuille lisible dans ce classeur.'] };

  // Un dictionnaire de données, s'il y en a un, l'emporte sur une feuille de saisie.
  for (const sheet of sheets) {
    const h = headerRowIndex(sheet);
    if (h < 0) continue;
    const cols: DictColumns = {};
    sheet.rows[h]!.forEach((c, i) => {
      const name = fold(cellString(c)).replace(/[*:]/g, '').trim();
      for (const [role, re] of HEADER_ROLES) if (cols[role] === undefined && re.test(name)) {
        cols[role] = i;
        break;
      }
    });
    const labelCol = cols.label ?? cols.name;
    // Il faut au moins une colonne qui décrive les variables, en plus de leur nom.
    if (labelCol !== undefined && (cols.type !== undefined || cols.options !== undefined || cols.unit !== undefined)) {
      return parseDictionary(sheet, h, cols, labelCol, warnings);
    }
  }

  const sheet = sheets[0]!;
  const h = headerRowIndex(sheet);
  if (h < 0) return { fields: [], warnings: [...warnings, 'Feuille vide : aucune ligne d’en-tête.'] };
  return parseDataSheet(sheet, h, warnings);
}

function parseDictionary(sheet: TableSheet, h: number, cols: DictColumns, labelCol: number, warnings: string[]): ParsedForm {
  const fields: (Omit<DraftField, 'key'> & { key?: string })[] = [];
  let section = DEFAULT_SECTION;
  for (let r = h + 1; r < sheet.rows.length && fields.length < MAX_FIELDS; r++) {
    const row = sheet.rows[r]!;
    const at = (i: number | undefined) => (i === undefined ? '' : cellString(row[i]));
    const rawLabel = at(labelCol);
    const name = at(cols.name);
    const typeWord = at(cols.type);
    if (!rawLabel && !name) continue;
    // Ligne de titre dans le dictionnaire : un libellé seul, sans type ni modalités.
    if (cols.section === undefined && !typeWord && !at(cols.options) && !at(cols.unit) && sectionTitle(rawLabel || name)) {
      section = sectionTitle(rawLabel || name)!;
      continue;
    }
    const info = labelInfo(rawLabel || name);
    let options = splitOptions(at(cols.options));
    let type = typeFromWord(typeWord);
    if (!type) {
      if (typeWord) warnings.length < MAX_WARNINGS && warnings.push(`Type « ${typeWord.slice(0, 40)} » non reconnu pour « ${info.label} » : à vérifier.`);
      type = options.length > 0 ? (info.multi ? 'multi' : 'enum') : guessType(info.label, at(cols.unit) || info.unit);
    }
    if ((type === 'enum' || type === 'text') && isBooleanOptions(options)) type = 'boolean';
    if (type === 'boolean') options = [];
    if ((type === 'number' || type === 'integer' || type === 'date' || type === 'text') && options.length > 0) {
      type = info.multi ? 'multi' : 'enum';
    }
    const required = cols.required !== undefined ? yesish(at(cols.required)) : info.required;
    fields.push({
      label: info.label || name,
      key: cols.label !== undefined && cols.name !== undefined && name ? name : undefined,
      type,
      section: at(cols.section) || section,
      unit: at(cols.unit) || info.unit,
      options,
      required,
      description: at(cols.description) || null,
    });
  }
  const keys = uniqueKeys(fields);
  return { fields: fields.map((f, i) => ({ ...f, key: keys[i]! })), warnings };
}

/** Feuille de saisie vierge : chaque en-tête de colonne est une variable ; les exemples éventuels en donnent le type. */
function parseDataSheet(sheet: TableSheet, h: number, warnings: string[]): ParsedForm {
  const header = sheet.rows[h]!;
  const fields: Omit<DraftField, 'key'>[] = [];
  header.forEach((c, col) => {
    const raw = cellString(c);
    if (!raw || fields.length >= MAX_FIELDS) return;
    const info = labelInfo(raw);
    const samples = sheet.rows.slice(h + 1, h + 201).map((r) => r[col]).filter((x): x is TableCell => !!x && x.v !== null && cellString(x) !== '');
    let type: FieldType = guessType(info.label, info.unit);
    let options: string[] = [];
    if (samples.length > 0) {
      const kinds = new Set(samples.map((s) => (s.k === 'text' && /^-?\d+(?:[.,]\d+)?$/.test(cellString(s)) ? 'number' : s.k)));
      if (kinds.size === 1 && kinds.has('number')) {
        type = samples.every((s) => Number.isInteger(Number(String(s.v).replace(',', '.')))) && type !== 'number' ? 'integer' : 'number';
      } else if (kinds.size === 1 && kinds.has('date')) type = 'date';
      else if (kinds.size === 1 && kinds.has('boolean')) type = 'boolean';
      else {
        const distinct = [...new Set(samples.map(cellString))];
        if (isBooleanOptions(distinct) || (distinct.length === 1 && BOOL_WORDS.has(fold(distinct[0]!)))) type = 'boolean';
        else if (distinct.length <= 8 && samples.length > distinct.length && distinct.every((d) => d.length <= 30)) {
          type = 'enum';
          options = distinct;
        } else if (type !== 'date') type = 'text';
      }
    }
    fields.push({ label: info.label, type, section: DEFAULT_SECTION, unit: info.unit, options, required: info.required, description: null });
  });
  return finish(fields, warnings);
}

/** Texte d'un classeur, pour Claude : une ligne par rangée, cellules séparées par « | ». */
export function workbookToText(workbook: TableWorkbook, maxRows = 400): string {
  return workbook.sheets
    .filter((s) => !s.hidden && !s.error)
    .map((s) => `## Feuille « ${s.name} »\n${s.rows.slice(0, maxRows).map((r) => r.map(cellString).join(' | ')).filter((l) => l.replace(/[|\s]/g, '')).join('\n')}`)
    .join('\n\n');
}

// ---------------------------------------------------------------- réponse de Claude

const typeSchema = z.enum(FIELD_TYPES as [FieldType, ...FieldType[]]);

/** Réponse attendue de Claude : validée strictement, puis normalisée comme celle des règles. */
export const claudeDraftSchema = z.object({
  fields: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200),
        key: z.string().max(80).nullish(),
        type: typeSchema,
        section: z.string().max(80).nullish(),
        unit: z.string().max(40).nullish(),
        options: z.array(z.string().max(120)).max(100).nullish(),
        required: z.boolean().nullish(),
        description: z.string().max(1000).nullish(),
      }),
    )
    .max(MAX_FIELDS),
  warnings: z.array(z.string().max(300)).max(MAX_WARNINGS).nullish(),
});

/** Schéma JSON imposé à la sortie du modèle (même contenu que `claudeDraftSchema`). */
export const claudeOutputSchema: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['fields', 'warnings'],
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'key', 'type', 'section', 'unit', 'options', 'required', 'description'],
        properties: {
          label: { type: 'string' },
          key: { type: 'string' },
          type: { type: 'string', enum: FIELD_TYPES },
          section: { type: 'string' },
          unit: { type: ['string', 'null'] },
          options: { type: 'array', items: { type: 'string' } },
          required: { type: 'boolean' },
          description: { type: ['string', 'null'] },
        },
      },
    },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

export const CLAUDE_FORM_PROMPT = `Tu aides un chercheur en médecine à reprendre sa fiche d'exploitation (formulaire de recueil de données) dans un logiciel. On te donne le texte de ce document (Word converti en texte, ou classeur Excel/CSV dont les cellules sont séparées par « | » ; dans un tableau Word, les cellules d'une même ligne sont séparées par « : »).

Ta tâche : dresser la liste exhaustive des variables à recueillir, dans l'ordre du document, sans en inventer.

Pour chaque variable :
- label : le libellé tel qu'écrit, sans les deux-points, les zones à remplir (____, ......), l'astérisque ni l'unité ;
- key : identifiant court en snake_case ASCII (ex. « date_naissance », « crp ») ;
- type : un seul parmi
  · text (texte libre),
  · number (mesure décimale : poids, CRP, Hb…),
  · integer (nombre entier : âge en années, nombre de séances, score),
  · date (« le __/__/____ », « Date de… »),
  · boolean (« ☐ Oui ☐ Non », « Oui / Non », « O/N » — dans ce cas options = []),
  · enum (une seule réponse parmi une liste : « ☐ Homme ☐ Femme », « M / F », « ☐ A ☐ B ☐ C »),
  · multi (plusieurs réponses possibles : la consigne le dit, « plusieurs réponses possibles », « cocher tout ce qui s'applique ») ;
- section : le titre de la partie du document où elle se trouve (titres en capitales, numérotés « 1. », « I. », « A) », lignes de section d'un tableau) ; « Général » si aucune ;
- unit : l'unité si elle est indiquée (« (mg/L) », « ____ kg »), sinon null ;
- options : les modalités pour enum et multi, dans l'ordre et l'orthographe du document ; [] pour les autres types ;
- required : true si la variable est marquée « * » ou « (obligatoire) », sinon false ;
- description : une consigne de remplissage présente dans le document, sinon null.

Règles :
- Une ligne « Autre, préciser : ____ » sous une liste devient une option « Autre » et, si une zone de saisie suit, une variable texte distincte « Autre (préciser) ».
- Les titres, consignes générales, mentions légales et en-têtes de tableau (« Variable | Valeur ») ne sont pas des variables.
- Ne recopie aucune valeur déjà remplie : seule la structure de la fiche compte.
- Dans « warnings », signale en français, brièvement, ce que tu n'as pas pu interpréter avec certitude.

Exemples :
« Âge : ____ ans » → {"label":"Âge","key":"age","type":"integer","section":"Général","unit":"ans","options":[],"required":false,"description":null}
« Tabagisme* : ☐ Oui ☐ Non » → {"label":"Tabagisme","key":"tabagisme","type":"boolean","section":"Général","unit":null,"options":[],"required":true,"description":null}
« Comorbidités (plusieurs réponses possibles) : ☐ HTA ☐ Diabète ☐ BPCO » → {"label":"Comorbidités","key":"comorbidites","type":"multi","section":"Général","unit":null,"options":["HTA","Diabète","BPCO"],"required":false,"description":null}

Réponds uniquement par le JSON demandé.`;

/** Normalise la réponse validée de Claude : clés uniques, options cohérentes avec le type. */
export function normalizeClaudeDraft(parsed: z.infer<typeof claudeDraftSchema>): ParsedForm {
  const fields = parsed.fields.map((f) => {
    let type = f.type;
    let options = (f.options ?? []).map(clean).filter(Boolean);
    if (type === 'enum' && isBooleanOptions(options)) type = 'boolean';
    if (type !== 'enum' && type !== 'multi') options = [];
    return {
      label: clean(f.label),
      key: f.key ?? '',
      type,
      section: clean(f.section ?? '') || DEFAULT_SECTION,
      unit: f.unit?.trim() || null,
      options: [...new Set(options)],
      required: f.required ?? false,
      description: f.description?.trim() || null,
    };
  });
  const keys = uniqueKeys(fields);
  return { fields: fields.map((f, i) => ({ ...f, key: keys[i]! })), warnings: (parsed.warnings ?? []).map(clean).filter(Boolean) };
}
