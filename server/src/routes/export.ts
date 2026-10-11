import { Router } from 'express';
import { asyncHandler, intQuery, notFound } from '../lib/http.js';
import { getActiveTemplate, getTemplate } from '../repo/templates.js';
import { toCsv } from '../lib/csv.js';
import { makeXlsx, type CellValue, type Sheet } from '../lib/xlsx.js';
import { makePptx, type ChartSlide } from '../lib/pptx.js';
import { fieldTypeLabel } from '../domain/labels.js';
import { buildDataset, buildFieldStats } from './analytics.js';
import { renderHtml, renderMarkdown } from '../lib/report.js';
import { gatherMethods, methodsBlocks, type Lang } from '../repo/methods.js';
import { listEventsForTemplate } from '../repo/events.js';
import type { FieldValue, TemplateWithFields } from '../domain/types.js';

export const exportRouter = Router();

function resolveTemplate(id: number | null): TemplateWithFields {
  const template = id ? getTemplate(id) : getActiveTemplate();
  if (!template) throw notFound("Aucune fiche d'exploitation disponible.");
  return template;
}

function slugify(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 60) || 'export';
}

/**
 * Export CSV du jeu de données.
 *
 * Options adaptées à l'aval : `delimiter=;` et `booleans=text` pour une
 * relecture dans Excel, `delimiter=,` et `booleans=numeric` pour un import
 * direct dans R, SPSS ou pandas.
 */
exportRouter.get(
  '/csv',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const rows = buildDataset(template);

    const delimiter = req.query.delimiter === ',' ? ',' : ';';
    // Par défaut le séparateur décimal suit l'usage du séparateur de colonnes : « ; » va avec « , »
    // (Excel français, read.csv2), « , » avec « . ». `decimal=.` ou `decimal=,` force le choix.
    const decimal = req.query.decimal === '.' || req.query.decimal === ',' ? req.query.decimal : delimiter === ';' ? ',' : '.';
    const booleanAsText = req.query.booleans === 'text';
    // `labels=1` : en-têtes en clair plutôt que les clés techniques. Les clés techniques restent des noms
    // de colonne valides pour R, Stata ou SPSS : l'unité n'y figure pas (elle est dans le dictionnaire).
    const useLabels = req.query.labels === '1';
    // `deidentify=1` : sans la colonne du libellé libre des dossiers, qui peut contenir un nom ou une
    // initiale — le fichier se partage alors avec un statisticien ou une revue.
    const withLabel = req.query.deidentify !== '1';

    const headers = [
      useLabels ? 'Code dossier' : 'patient_code',
      ...(withLabel ? [useLabels ? 'Libellé du dossier' : 'patient_label'] : []),
      useLabels ? 'Nombre de documents' : 'nb_documents',
      ...template.fields.map((f) => (useLabels && f.unit ? `${f.label} (${f.unit})` : useLabels ? f.label : f.key)),
    ];

    const data: FieldValue[][] = rows.map((row) => [
      row.patientCode,
      ...(withLabel ? [row.patientLabel] : []),
      row.documentCount,
      ...template.fields.map((f) => row.values[f.key] ?? null),
    ]);

    const csv = toCsv(headers, data, { delimiter, booleanAsText, decimal });
    const filename = `${slugify(template.name)}-${new Date().toISOString().slice(0, 10)}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.send(csv);
  }),
);

/**
 * Export du dictionnaire des variables : indispensable pour documenter
 * la méthodologie et pour que le CSV reste interprétable par un tiers.
 */
exportRouter.get(
  '/dictionary.csv',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const delimiter = req.query.delimiter === ',' ? ',' : ';';

    // `type` reste la clé technique (pour un import automatique), `type_libelle` sa lecture pour un humain.
    const headers = ['cle', 'libelle', 'section', 'type', 'unite', 'obligatoire', 'options', 'description', 'type_libelle'];
    const rows: FieldValue[][] = template.fields.map((f) => [
      f.key,
      f.label,
      f.section,
      f.type,
      f.unit ?? '',
      f.required ? 'oui' : 'non',
      f.options.join(' | '),
      f.description ?? '',
      fieldTypeLabel(f.type),
    ]);

    const filename = `dictionnaire-${slugify(template.name)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(toCsv(headers, rows, { delimiter }));
  }),
);

/** Export JSON de la fiche : sauvegarde et partage du paramétrage entre postes. */
exportRouter.get(
  '/template.json',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const payload = {
      name: template.name,
      description: template.description,
      fields: template.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        section: f.section,
        unit: f.unit,
        description: f.description,
        required: f.required,
        options: f.options,
        extraction: f.extraction,
      })),
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${slugify(template.name).startsWith('fiche') ? '' : 'fiche-'}${slugify(template.name)}.json"`,
    );
    res.send(JSON.stringify(payload, null, 2));
  }),
);

/**
 * Export du jeu de données au format classeur.
 *
 * Le CSV reste utile pour R ou SPSS, mais il perd le typage : les dates y
 * deviennent du texte, les décimaux dépendent de la locale, et Excel
 * réinterprète volontiers « 5-10 » en date. Le classeur porte le type de
 * chaque colonne et s'ouvre sans assistant d'importation.
 *
 * Trois feuilles, parce qu'un jeu de données livré seul n'est pas
 * interprétable : les données, le dictionnaire des variables sans lequel les
 * clés ne veulent rien dire, et une synthèse de cohorte qui donne les effectifs
 * et la complétude atteinte.
 */
exportRouter.get(
  '/xlsx',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const rows = buildDataset(template);
    const useLabels = req.query.labels === '1';

    const donnees: Sheet = {
      name: 'Données',
      columns: [
        { header: 'Dossier', width: 16 },
        ...template.fields.map((field) => ({
          header: useLabels
            ? field.label + (field.unit ? ` (${field.unit})` : '')
            : field.key,
          width: 18,
          type:
            field.type === 'date'
              ? ('date' as const)
              : field.type === 'number' || field.type === 'integer'
                ? ('number' as const)
                : ('text' as const),
        })),
      ],
      rows: rows.map((row) => [
        row.patientCode,
        ...template.fields.map((field): CellValue => {
          const value = row.values[field.key] ?? null;
          if (value === null) return null;
          // Un choix multiple tient dans une colonne, options séparées : la
          // dépliure en colonnes indicatrices relève de l'analyse, pas de
          // l'export.
          if (Array.isArray(value)) return value.join(' | ');
          // Vrai booléen : le tableur affichera VRAI/FAUX et saura le filtrer.
          if (typeof value === 'boolean') return value;
          return value;
        }),
      ]),
    };

    const dictionnaire: Sheet = {
      name: 'Dictionnaire',
      columns: [
        { header: 'Clé', width: 22 },
        { header: 'Libellé', width: 34 },
        { header: 'Section', width: 20 },
        { header: 'Type', width: 14 },
        { header: 'Unité', width: 12 },
        { header: 'Obligatoire', width: 12 },
        { header: 'Options', width: 40 },
        { header: 'Définition', width: 60 },
      ],
      rows: template.fields.map((field) => [
        field.key,
        field.label,
        field.section,
        fieldTypeLabel(field.type),
        field.unit,
        field.required,
        field.options.join(' | '),
        field.description,
      ]),
    };

    // Mêmes calculs que l'écran et le diaporama : une valeur manquante n'est jamais comptée comme un zéro,
    // et le classeur ne peut pas contredire la figure tirée des mêmes données.
    const fieldStats = new Map(buildFieldStats(template, rows).map((stat) => [stat.key, stat]));
    const synthese: Sheet = {
      name: 'Synthèse',
      columns: [
        { header: 'Variable', width: 34 },
        { header: 'Type', width: 14 },
        { header: 'Renseignées', width: 13, type: 'number' },
        { header: 'Manquantes', width: 13, type: 'number' },
        { header: 'Complétude %', width: 14, type: 'number' },
        { header: 'Moyenne', width: 12, type: 'number' },
        { header: 'Écart-type', width: 12, type: 'number' },
        { header: 'Médiane', width: 12, type: 'number' },
        { header: '1er quartile', width: 12, type: 'number' },
        { header: '3e quartile', width: 12, type: 'number' },
        { header: 'Minimum', width: 12, type: 'number' },
        { header: 'Maximum', width: 12, type: 'number' },
        { header: 'Effectifs n (%)', width: 60 },
      ],
      rows: template.fields.map((field): CellValue[] => {
        const stat = fieldStats.get(field.key);
        const total = rows.length;
        const n = stat?.n ?? 0;
        const base: CellValue[] = [
          field.label + (field.unit ? ` (${field.unit})` : ''),
          fieldTypeLabel(field.type),
          n,
          total - n,
          total > 0 ? Math.round((n / total) * 100) : 0,
        ];
        const summary = stat?.chart === 'histogram' ? stat.summary : null;
        const counts =
          stat?.chart === 'categories'
            ? stat.categories
                .map((c) => `${c.label} ${c.count} (${String(c.percent).replace('.', ',')} %)`)
                .join(' ; ') + (stat.multiple ? ' — plusieurs réponses possibles' : '')
            : null;
        return [
          ...base,
          summary?.mean ?? null,
          summary?.sd ?? null,
          summary?.median ?? null,
          summary?.q1 ?? null,
          summary?.q3 ?? null,
          summary?.min ?? null,
          summary?.max ?? null,
          counts,
        ];
      }),
    };

    const file = makeXlsx([donnees, dictionnaire, synthese]);
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${slugify(template.name)}.xlsx"`,
    );
    res.send(file);
  }),
);

/**
 * Export des distributions en diaporama.
 *
 * Une distribution finit presque toujours dans un diaporama : réunion de
 * service, comité de thèse, congrès. La refaire à la main à partir d'une
 * capture fait perdre la netteté et introduit des erreurs de recopie. Chaque
 * graphique est ici dessiné en formes natives, donc net à toute échelle et
 * modifiable, et chaque planche porte son numéro de figure et sa page — ce qui
 * la rend citable dans le texte d'un article.
 *
 * Seules les variables ayant produit des effectifs sont retenues : une planche
 * vide n'apprend rien et alourdit la présentation.
 */
exportRouter.get(
  '/pptx',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const rows = buildDataset(template);
    const stats = buildFieldStats(template, rows);

    const slides: ChartSlide[] = [];
    for (const stat of stats) {
      const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
      const manquants = stat.missing > 0 ? `, ${plural(stat.missing, 'manquante')}` : '';
      const subtitle = `${plural(stat.n, 'observation')}${manquants} · ${stat.section}`;

      if (stat.chart === 'categories' && stat.categories.length > 0) {
        slides.push({
          title: stat.label + (stat.unit ? ` (${stat.unit})` : ''),
          subtitle,
          bars: stat.categories.map((c) => ({ label: c.label, value: c.count })),
          // Les barres d'une variable à choix multiples additionnent plus de réponses que de dossiers : le dire.
          note: stat.multiple
            ? `Plusieurs réponses possibles : ${plural(stat.n, 'dossier renseigné')}, le total des barres peut dépasser ce nombre.`
            : undefined,
        });
      } else if (stat.chart === 'histogram' && stat.bins.length > 0 && stat.n > 0) {
        const s = stat.summary;
        slides.push({
          title: stat.label + (stat.unit ? ` (${stat.unit})` : ''),
          subtitle,
          bars: stat.bins.map((b) => ({
            label: `${formatBound(b.from)} – ${formatBound(b.to)}`,
            value: b.count,
          })),
          note: s
            ? `Moyenne ${formatBound(s.mean)} ± ${formatBound(s.sd)} · médiane ${formatBound(s.median)} · extrêmes ${formatBound(s.min)} – ${formatBound(s.max)}`
            : undefined,
        });
      }
    }

    const file = makePptx({
      title: template.name,
      subtitle:
        `${rows.length} dossiers · ${slides.length} figures · ` +
        `exporté depuis PubResearcher`,
      slides,
    });

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${slugify(template.name)}-figures.pptx"`,
    );
    res.send(file);
  }),
);

/** Deux décimales au plus (au-delà, la précision est illusoire), virgule décimale : le diaporama est en français. */
export function formatBound(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return (Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')).replace('.', ',');
}

/**
 * Rapport « Méthodes et traçabilité » : corpus, fiche (avec empreinte), passes d'extraction, origine des
 * valeurs, fiabilité mesurée sur les relectures, journal, environnement logiciel — et un paragraphe
 * « Méthodes » rédigé avec ces chiffres. `format=md|html|json`, `lang=fr|en`.
 */
exportRouter.get(
  '/methods',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const lang: Lang = req.query.lang === 'en' ? 'en' : 'fr';
    const format = req.query.format === 'html' || req.query.format === 'json' ? req.query.format : 'md';
    const data = gatherMethods(template);
    const stem = `methodes-${slugify(template.name)}-${new Date().toISOString().slice(0, 10)}`;

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${stem}.json"`);
      res.send(JSON.stringify(data, null, 2));
      return;
    }
    const blocks = methodsBlocks(data, lang);
    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      // Page autonome (styles intégrés) : aucune ressource extérieure, donc une CSP sans réserve.
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.setHeader('Content-Disposition', `attachment; filename="${stem}.html"`);
      res.send(
        renderHtml(blocks, {
          lang,
          title: lang === 'fr' ? `Méthodes et traçabilité — ${template.name}` : `Methods and traceability — ${template.name}`,
        }),
      );
      return;
    }
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${stem}.md"`);
    res.send(renderMarkdown(blocks));
  }),
);

/**
 * Journal des modifications de valeur, du plus ancien au plus récent : l'ordre d'un audit.
 * Une ligne par changement, avec la valeur d'avant, la valeur d'après et leur origine.
 */
exportRouter.get(
  '/audit.csv',
  asyncHandler(async (req, res) => {
    const template = resolveTemplate(intQuery(req, 'templateId'));
    const delimiter = req.query.delimiter === ',' ? ',' : ';';
    const decimal = delimiter === ';' ? ',' : '.';
    const headers = [
      'evenement',
      'horodatage',
      'dossier',
      'variable',
      'libelle',
      'action',
      'valeur_avant',
      'origine_avant',
      'valeur_apres',
      'origine_apres',
      'passe',
      'import',
    ];
    const rows: FieldValue[][] = listEventsForTemplate(template.id).map((e) => [
      e.id,
      e.at,
      e.patientCode,
      e.fieldKey,
      e.fieldLabel,
      e.action,
      e.oldValue,
      e.oldSource,
      e.newValue,
      e.newSource,
      e.runId,
      e.importId,
    ]);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="journal-${slugify(template.name)}-${new Date().toISOString().slice(0, 10)}.csv"`,
    );
    res.send(toCsv(headers, rows, { delimiter, decimal, booleanAsText: true }));
  }),
);
