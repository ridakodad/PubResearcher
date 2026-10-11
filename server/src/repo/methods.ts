import { createRequire } from 'node:module';
import { db, schemaVersion } from '../db/index.js';
import type { ExtractionRule, TemplateWithFields } from '../domain/types.js';
import { llmStatus } from '../engine/llm.js';
import type { Block } from '../lib/report.js';
import { appVersion } from '../version.js';
import { computeQuality, type Proportion, type QualityReport } from './quality.js';
import { listImports } from './imports.js';
import { listRuns, templateFingerprint, type ExtractionRun } from './runs.js';

/**
 * Rapport « Méthodes et traçabilité ».
 *
 * Ce qu'un article, un comité d'éthique ou un relecteur demande à propos d'une extraction de données
 * rétrospective : d'où viennent les documents, quelle grille a été appliquée, avec quelles règles, quel moteur,
 * quelle part a été relue, avec quelle concordance — et comment refaire la même chose. Tout est lu dans la
 * base, rien n'est saisi : le rapport est le témoin de ce qui a été fait, pas un déclaratif.
 */

export type Lang = 'fr' | 'en';

export interface MethodsData {
  generatedAt: string;
  tool: { version: string; schemaVersion: number; node: string; platform: string; dependencies: Record<string, string> };
  template: {
    id: number;
    name: string;
    fingerprint: string;
    fields: {
      key: string;
      label: string;
      type: string;
      unit: string | null;
      required: boolean;
      rules: Record<ExtractionRule['kind'], number>;
      extractionEnabled: boolean;
      min: number | null;
      max: number | null;
    }[];
  };
  corpus: {
    patients: number;
    documents: number;
    byKind: { kind: string; documents: number }[];
    unreadable: number;
    ocrDocuments: number;
    ocrMeanConfidence: number | null;
    truncated: number;
  };
  /** Les 25 passes les plus récentes de la fiche (détail). */
  runs: ExtractionRun[];
  /** Toutes les passes de la fiche, y compris les plus anciennes que `runs`. */
  runSummary: { total: number; first: string | null; last: string | null; modes: string[]; models: string[] };
  provenance: { auto: number; llm: number; manual: number; imported: number; empty: number; cells: number; filled: number };
  /** Tableaux de cohorte importés dans cette fiche, du plus ancien au plus récent. */
  imports: {
    id: number;
    filename: string;
    sha256: string;
    format: string;
    sheet: string | null;
    committedAt: string | null;
    dataRows: number;
    written: number;
    patientsCreated: number;
    conflicts: number;
    rejected: number;
  }[];
  quality: QualityReport;
  audit: { events: number; byAction: Record<string, number> };
  llm: { used: boolean; models: string[] };
}

function dependencyVersions(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const out: Record<string, string> = {};
  for (const name of ['pdfjs-dist', 'mammoth', 'tesseract.js', 'exifr', 'dicom-parser', '@anthropic-ai/sdk']) {
    try {
      out[name] = (require(`${name}/package.json`) as { version: string }).version;
    } catch {
      /* paquet dont package.json n'est pas exposé : on n'invente pas de version */
    }
  }
  return out;
}

export function gatherMethods(template: TemplateWithFields): MethodsData {
  const one = <T>(sql: string, ...params: unknown[]): T => db.prepare(sql).get(...params) as T;
  const all = <T>(sql: string, ...params: unknown[]): T[] => db.prepare(sql).all(...params) as T[];

  const kinds = all<{ kind: string; n: number }>('SELECT kind, COUNT(*) AS n FROM documents GROUP BY kind ORDER BY n DESC');
  const docStats = one<{ docs: number; unreadable: number; ocr: number; conf: number | null; truncated: number }>(
    `SELECT COUNT(*) AS docs,
            COALESCE(SUM(CASE WHEN parse_status IN ('error','empty') THEN 1 ELSE 0 END), 0) AS unreadable,
            COALESCE(SUM(CASE WHEN json_extract(metadata,'$.ocrApplied') = 1 THEN 1 ELSE 0 END), 0) AS ocr,
            AVG(CASE WHEN json_extract(metadata,'$.ocrApplied') = 1 THEN json_extract(metadata,'$.ocrConfidence') END) AS conf,
            COALESCE(SUM(CASE WHEN json_extract(metadata,'$.textTruncated') = 1
                               OR COALESCE(json_extract(metadata,'$.pagesTruncated'), 0) > 0 THEN 1 ELSE 0 END), 0) AS truncated
       FROM documents`,
  );
  const patients = one<{ n: number }>('SELECT COUNT(*) AS n FROM patients').n;

  const bySource = all<{ source: string; n: number }>(
    `SELECT rv.source, COUNT(*) AS n
       FROM record_values rv JOIN records r ON r.id = rv.record_id
      WHERE r.template_id = ? GROUP BY rv.source`,
    template.id,
  );
  const count = (source: string): number => bySource.find((s) => s.source === source)?.n ?? 0;
  const provenance = {
    auto: count('auto'),
    llm: count('llm'),
    manual: count('manual'),
    imported: count('import'),
    empty: count('empty'),
    cells: patients * template.fields.length,
    // Une cellule manuelle sans valeur (« relue, rien à relever ») n'est pas renseignée.
    filled:
      one<{ n: number }>(
        `SELECT COUNT(*) AS n FROM record_values rv JOIN records r ON r.id = rv.record_id
          WHERE r.template_id = ? AND rv.value IS NOT NULL`,
        template.id,
      ).n,
  };

  const events = all<{ action: string; n: number }>(
    `SELECT e.action, COUNT(*) AS n FROM value_events e JOIN records r ON r.id = e.record_id
      WHERE r.template_id = ? GROUP BY e.action`,
    template.id,
  );

  const runs = listRuns(500).filter((r) => r.templateId === template.id).slice(0, 25);
  // Le mode et le modèle de TOUTES les passes, pas seulement des 25 dernières : une passe par modèle de langage vieille
  // de trente passes ne doit pas disparaître d'un rapport qui déclare « sans modèle de langage ».
  const perMode = all<{ mode: string; model: string | null; n: number; first: string; last: string }>(
    `SELECT mode, model, COUNT(*) AS n, MIN(started_at) AS first, MAX(started_at) AS last
       FROM extraction_runs WHERE template_id = ? GROUP BY mode, model`,
    template.id,
  );
  const runSummary = {
    total: perMode.reduce((sum, r) => sum + r.n, 0),
    first: perMode.reduce<string | null>((min, r) => (min === null || r.first < min ? r.first : min), null),
    last: perMode.reduce<string | null>((max, r) => (max === null || r.last > max ? r.last : max), null),
    modes: [...new Set(perMode.map((r) => r.mode))].sort(),
    models: [...new Set(perMode.map((r) => r.model).filter((m): m is string => Boolean(m)))].sort(),
  };
  const models = runSummary.models;

  return {
    generatedAt: new Date().toISOString(),
    tool: {
      version: appVersion,
      schemaVersion: schemaVersion(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      dependencies: dependencyVersions(),
    },
    template: {
      id: template.id,
      name: template.name,
      fingerprint: templateFingerprint(template),
      fields: template.fields.map((f) => {
        const rules: Record<ExtractionRule['kind'], number> = { label: 0, regex: 0, keyword: 0, dicom: 0 };
        for (const r of f.extraction.rules) rules[r.kind]++;
        return {
          key: f.key,
          label: f.label,
          type: f.type,
          unit: f.unit,
          required: f.required,
          rules,
          extractionEnabled: f.extraction.enabled,
          min: f.extraction.postProcess?.min ?? null,
          max: f.extraction.postProcess?.max ?? null,
        };
      }),
    },
    corpus: {
      patients,
      documents: docStats.docs,
      byKind: kinds.map((k) => ({ kind: k.kind, documents: k.n })),
      unreadable: docStats.unreadable,
      ocrDocuments: docStats.ocr,
      ocrMeanConfidence: docStats.conf === null ? null : Math.round(docStats.conf),
      truncated: docStats.truncated,
    },
    runs,
    runSummary,
    provenance,
    imports: listImports(template.id)
      .reverse()
      .map((i) => ({
        id: i.id,
        filename: i.filename,
        sha256: i.sha256,
        format: i.format,
        sheet: i.sheet,
        committedAt: i.committedAt,
        dataRows: i.dataRows,
        written: i.written,
        patientsCreated: i.patientsCreated,
        conflicts: i.conflicts,
        rejected: i.rejected,
      })),
    quality: computeQuality(template),
    audit: {
      events: events.reduce((sum, e) => sum + e.n, 0),
      byAction: Object.fromEntries(events.map((e) => [e.action, e.n])),
    },
    llm: { used: models.length > 0 || llmStatus().available, models },
  };
}

// --------------------------------------------------------------------- texte

const KIND_LABELS: Record<Lang, Record<string, string>> = {
  fr: { pdf: 'PDF', docx: 'Word', image: 'Image', dicom: 'DICOM', text: 'Texte', unknown: 'Non reconnu' },
  en: { pdf: 'PDF', docx: 'Word', image: 'Image', dicom: 'DICOM', text: 'Text', unknown: 'Unrecognised' },
};

const TYPE_LABELS: Record<Lang, Record<string, string>> = {
  fr: { text: 'texte', number: 'nombre', integer: 'entier', date: 'date', boolean: 'oui/non', enum: 'choix unique', multi: 'choix multiple' },
  en: { text: 'text', number: 'number', integer: 'integer', date: 'date', boolean: 'yes/no', enum: 'single choice', multi: 'multiple choice' },
};

export function methodsBlocks(data: MethodsData, lang: Lang): Block[] {
  const t = (fr: string, en: string): string => (lang === 'fr' ? fr : en);
  const nf = new Intl.NumberFormat(lang === 'fr' ? 'fr-FR' : 'en-GB');
  const n = (value: number): string => nf.format(value);
  const pct = (p: number, digits = 1): string => `${(p * 100).toFixed(digits).replace('.', lang === 'fr' ? ',' : '.')} %`;
  const prop = (p: Proportion | null): string =>
    p ? `${pct(p.value)} (${t('IC 95 %', '95% CI')} ${pct(p.low)}–${pct(p.high)}, n = ${n(p.of)})` : '—';
  const when = (iso: string | null): string =>
    iso ? new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—';

  const q = data.quality;
  const reviewed = q.overall.reviewed;
  const fpShort = data.template.fingerprint.slice(0, 12);
  const modes = data.runSummary.modes;
  const usedLlm = modes.some((mode) => mode !== 'rules');
  const varsWithRules = data.template.fields.filter((f) => f.extractionEnabled && Object.values(f.rules).some((c) => c > 0)).length;

  const blocks: Block[] = [];
  blocks.push({
    type: 'title',
    text: t('Méthodes et traçabilité de l’extraction', 'Data extraction methods and traceability'),
    subtitle: `${data.template.name} — ${t('généré le', 'generated on')} ${when(data.generatedAt)} — PubResearcher ${data.tool.version}`,
  });
  blocks.push({
    type: 'note',
    text: t(
      'Ce rapport est établi à partir de la base de l’outil : aucun chiffre n’est saisi à la main. Il décrit ce qui a été fait ; il ne remplace pas la déclaration réglementaire de l’étude.',
      'This report is built from the tool’s database: no figure is typed in by hand. It describes what was done; it does not replace the study’s regulatory documentation.',
    ),
  });

  // ------------------------------------------------------------- paragraphe
  blocks.push({ type: 'h2', text: t('Paragraphe « Méthodes » prêt à adapter', 'Ready-to-adapt “Methods” paragraph') });

  const engine = usedLlm
    ? t(
        `par des règles déterministes (libellés, expressions régulières, mots-clés, tags DICOM) puis, pour les variables que les règles n’avaient pas renseignées, par un modèle de langage (${data.llm.models.join(', ') || 'modèle non précisé'})`,
        `with deterministic rules (labels, regular expressions, keywords, DICOM tags) and, for variables the rules left empty, a language model (${data.llm.models.join(', ') || 'model not recorded'})`,
      )
    : t(
        'par des règles déterministes (libellés, expressions régulières, mots-clés, tags DICOM), sans modèle de langage',
        'with deterministic rules (labels, regular expressions, keywords, DICOM tags), without any language model',
      );
  const ocr =
    data.corpus.ocrDocuments > 0
      ? t(
          ` ${n(data.corpus.ocrDocuments)} document(s) scanné(s) ont été lus par reconnaissance optique de caractères (tesseract.js ${data.tool.dependencies['tesseract.js'] ?? ''}, langue française${data.corpus.ocrMeanConfidence !== null ? `, confiance moyenne ${data.corpus.ocrMeanConfidence} %` : ''}).`,
          ` ${n(data.corpus.ocrDocuments)} scanned document(s) were read by optical character recognition (tesseract.js ${data.tool.dependencies['tesseract.js'] ?? ''}, French language${data.corpus.ocrMeanConfidence !== null ? `, mean confidence ${data.corpus.ocrMeanConfidence}%` : ''}).`,
        )
      : '';
  const review =
    reviewed > 0
      ? t(
          ` Parmi les valeurs proposées par l’extraction, ${n(reviewed)} ont été relues par un investigateur : ${n(q.overall.confirmed)} confirmée(s), ${n(q.overall.corrected)} corrigée(s), ${n(q.overall.emptied)} écartée(s) ; la concordance était de ${prop(q.overall.agreement)}.`,
          ` Of the values proposed by the extraction, ${n(reviewed)} were reviewed by an investigator: ${n(q.overall.confirmed)} confirmed, ${n(q.overall.corrected)} corrected, ${n(q.overall.emptied)} discarded; agreement was ${prop(q.overall.agreement)}.`,
        )
      : t(
          ' Aucune valeur n’avait encore été relue à la date de ce rapport : la fiabilité de l’extraction n’est pas estimée.',
          ' No value had been reviewed at the date of this report: the reliability of the extraction is not estimated.',
        );
  const importedTotal = data.imports.reduce((sum, i) => sum + i.written, 0);
  const imports =
    data.imports.length > 0
      ? t(
          ` Par ailleurs, ${n(importedTotal)} valeur(s) ont été importées de ${n(data.imports.length)} tableau(x) tenu(s) par l’équipe (${data.imports
            .map((i) => `« ${i.filename} »${i.sheet ? `, feuille « ${i.sheet} »` : ''}, empreinte SHA-256 ${i.sha256.slice(0, 12)}…`)
            .join(' ; ')}) : chacune garde la cellule dont elle provient ; elles ne sont issues ni de l’extraction ni d’une relecture dans l’outil.`,
          ` In addition, ${n(importedTotal)} value(s) were imported from ${n(data.imports.length)} spreadsheet(s) kept by the team (${data.imports
            .map((i) => `“${i.filename}”${i.sheet ? `, sheet “${i.sheet}”` : ''}, SHA-256 fingerprint ${i.sha256.slice(0, 12)}…`)
            .join('; ')}): each keeps the cell it comes from; they result neither from the extraction nor from a review in the tool.`,
        )
      : '';
  blocks.push({
    type: 'p',
    text: t(
      `Les données ont été extraites rétrospectivement de ${n(data.corpus.documents)} documents (${n(data.corpus.patients)} dossiers) à l’aide de l’application PubResearcher, version ${data.tool.version}, selon une fiche d’exploitation de ${n(data.template.fields.length)} variables (empreinte ${fpShort}). L’extraction a été réalisée ${engine}.${ocr} Chaque valeur extraite conserve le document et l’extrait qui la justifient, et toute modification ultérieure est consignée dans un journal horodaté.${imports}${review}`,
      `Data were retrospectively extracted from ${n(data.corpus.documents)} documents (${n(data.corpus.patients)} records) using the PubResearcher application, version ${data.tool.version}, according to a data collection form of ${n(data.template.fields.length)} variables (fingerprint ${fpShort}). Extraction was carried out ${engine}.${ocr} Each extracted value keeps the document and the excerpt that support it, and any later change is recorded in a time-stamped log.${imports}${review}`,
    ),
  });

  // ----------------------------------------------------------------- corpus
  blocks.push({ type: 'h2', text: t('Corpus', 'Corpus') });
  blocks.push({
    type: 'table',
    head: [t('Élément', 'Item'), t('Effectif', 'Count')],
    align: ['left', 'right'],
    rows: [
      [t('Dossiers patients', 'Patient records'), n(data.corpus.patients)],
      [t('Documents', 'Documents'), n(data.corpus.documents)],
      ...data.corpus.byKind.map((k) => [`  ${KIND_LABELS[lang][k.kind] ?? k.kind}`, n(k.documents)]),
      [t('Documents sans texte exploitable', 'Documents without usable text'), n(data.corpus.unreadable)],
      [t('Documents lus par OCR', 'Documents read by OCR'), n(data.corpus.ocrDocuments)],
      [t('Documents lus partiellement (plafond de pages ou de texte)', 'Partially read documents (page or text limit)'), n(data.corpus.truncated)],
    ],
  });
  if (data.corpus.unreadable > 0 || data.corpus.truncated > 0) {
    blocks.push({
      type: 'note',
      text: t(
        'Les documents sans texte exploitable et ceux lus partiellement n’ont pu alimenter l’extraction qu’en partie : leurs variables manquantes ne sont pas des absences constatées.',
        'Documents without usable text and partially read documents could feed the extraction only in part: their missing variables are not observed absences.',
      ),
    });
  }

  // ----------------------------------------------------------------- fiche
  blocks.push({ type: 'h2', text: t('Fiche d’exploitation', 'Data collection form') });
  blocks.push({
    type: 'p',
    text: t(
      `Fiche « ${data.template.name} » : ${n(data.template.fields.length)} variables, dont ${n(varsWithRules)} avec extraction automatique. Empreinte SHA-256 des règles : ${data.template.fingerprint}. Deux passes d’empreinte identique ont appliqué exactement les mêmes règles.`,
      `Form “${data.template.name}”: ${n(data.template.fields.length)} variables, ${n(varsWithRules)} with automatic extraction. SHA-256 fingerprint of the rules: ${data.template.fingerprint}. Two runs with the same fingerprint applied exactly the same rules.`,
    ),
  });
  blocks.push({
    type: 'table',
    head: [t('Clé', 'Key'), t('Libellé', 'Label'), t('Type', 'Type'), t('Unité', 'Unit'), t('Bornes', 'Bounds'), t('Règles (libellé / regex / mot-clé / DICOM)', 'Rules (label / regex / keyword / DICOM)')],
    rows: data.template.fields.map((f) => [
      f.key,
      f.label,
      TYPE_LABELS[lang][f.type] ?? f.type,
      f.unit ?? '',
      f.min !== null || f.max !== null ? `${f.min ?? '…'} – ${f.max ?? '…'}` : '',
      f.extractionEnabled ? `${f.rules.label} / ${f.rules.regex} / ${f.rules.keyword} / ${f.rules.dicom}` : t('saisie manuelle', 'manual entry'),
    ]),
  });

  // ------------------------------------------------------------------ passes
  blocks.push({ type: 'h2', text: t('Passes d’extraction', 'Extraction runs') });
  if (data.runSummary.total === 0) {
    blocks.push({ type: 'p', text: t('Aucune passe d’extraction n’a été lancée avec cette fiche.', 'No extraction run has been launched with this form.') });
  } else {
    const detailed = data.runs.length < data.runSummary.total;
    blocks.push({
      type: 'p',
      text: t(
        `${n(data.runSummary.total)} passe(s) enregistrée(s), de ${when(data.runSummary.first)} à ${when(data.runSummary.last)}. Mode(s) : ${modes.join(', ')}.` +
          (detailed ? ` Les ${n(data.runs.length)} plus récentes sont détaillées ci-dessous.` : ''),
        `${n(data.runSummary.total)} run(s) recorded, from ${when(data.runSummary.first)} to ${when(data.runSummary.last)}. Mode(s): ${modes.join(', ')}.` +
          (detailed ? ` The ${n(data.runs.length)} most recent are detailed below.` : ''),
      ),
    });
    blocks.push({
      type: 'table',
      head: ['#', t('Début', 'Start'), t('Mode', 'Mode'), t('Modèle', 'Model'), t('Empreinte', 'Fingerprint'), t('Dossiers', 'Records'), t('Extraites', 'Extracted'), t('Non trouvées', 'Not found'), t('Gardées (relues)', 'Kept (reviewed)'), t('État', 'Status')],
      align: ['right', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'left'],
      rows: data.runs.map((r) => [
        String(r.id),
        when(r.startedAt),
        r.mode + (r.overwriteManual ? t(' + écrasement', ' + overwrite') : ''),
        r.model ?? '—',
        r.templateFingerprint.slice(0, 12),
        n(r.patients),
        n(r.extracted),
        n(r.notFound),
        n(r.keptManual),
        r.status === 'done' ? t('terminée', 'done') : r.status === 'running' ? t('en cours', 'running') : t('interrompue', 'failed'),
      ]),
    });
  }

  // ------------------------------------------------------------- provenance
  const p = data.provenance;
  blocks.push({ type: 'h2', text: t('Origine des valeurs', 'Value provenance') });
  blocks.push({
    type: 'table',
    head: [t('Origine', 'Source'), t('Valeurs', 'Values'), t('Part des cellules du tableau', 'Share of table cells')],
    align: ['left', 'right', 'right'],
    rows: [
      [t('Règles (non relues)', 'Rules (not reviewed)'), n(p.auto), p.cells ? pct(p.auto / p.cells) : '—'],
      [t('Modèle de langage (non relues)', 'Language model (not reviewed)'), n(p.llm), p.cells ? pct(p.llm / p.cells) : '—'],
      [t('Décision d’un relecteur', 'Reviewer decision'), n(p.manual), p.cells ? pct(p.manual / p.cells) : '—'],
      [t('Import de tableau (non relues)', 'Spreadsheet import (not reviewed)'), n(p.imported), p.cells ? pct(p.imported / p.cells) : '—'],
      [t('Cellules renseignées (toutes origines)', 'Filled cells (all sources)'), n(p.filled), p.cells ? pct(p.filled / p.cells) : '—'],
      [t('Cellules du tableau (dossiers × variables)', 'Table cells (records × variables)'), n(p.cells), ''],
    ],
  });

  // ------------------------------------------------------------------ imports
  if (data.imports.length > 0) {
    blocks.push({ type: 'h2', text: t('Tableaux importés', 'Imported spreadsheets') });
    blocks.push({
      type: 'p',
      text: t(
        'Fichiers conservés par l’outil avec leur empreinte : chaque valeur importée cite sa feuille, sa cellule, l’en-tête de sa colonne et son contenu brut. Les cellules converties l’ont été par les mêmes règles que l’extraction (types, options, unités, bornes) ; une valeur relue ou saisie par un relecteur n’est remplacée que sur demande expresse.',
        'Files kept by the tool with their fingerprint: each imported value cites its sheet, cell, column header and raw content. Cells were converted by the same rules as the extraction (types, options, units, bounds); a value reviewed or typed by a reviewer is only replaced on explicit request.',
      ),
    });
    blocks.push({
      type: 'table',
      head: ['#', t('Date', 'Date'), t('Fichier', 'File'), t('Feuille', 'Sheet'), 'SHA-256', t('Lignes', 'Rows'), t('Valeurs écrites', 'Values written'), t('Dossiers créés', 'Records created'), t('Refusées', 'Rejected'), t('Gardées (conflit)', 'Kept (conflict)')],
      align: ['right', 'left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
      rows: data.imports.map((i) => [
        String(i.id),
        when(i.committedAt),
        i.filename,
        i.sheet ?? '—',
        i.sha256.slice(0, 12),
        n(i.dataRows),
        n(i.written),
        n(i.patientsCreated),
        n(i.rejected),
        n(i.conflicts),
      ]),
    });
  }

  // --------------------------------------------------------------- fiabilité
  blocks.push({ type: 'h2', text: t('Fiabilité de l’extraction automatique', 'Reliability of automatic extraction') });
  if (reviewed === 0 && q.overall.added === 0) {
    blocks.push({
      type: 'p',
      text: t(
        'Aucune valeur proposée par l’extraction n’a été relue : la fiabilité ne peut pas être estimée. Relire un échantillon tiré au hasard (10 à 20 % des dossiers) suffit à la mesurer.',
        'No value proposed by the extraction has been reviewed: reliability cannot be estimated. Reviewing a random sample (10–20% of records) is enough to measure it.',
      ),
    });
  } else {
    blocks.push({
      type: 'table',
      head: [t('Mesure', 'Measure'), t('Valeur', 'Value')],
      rows: [
        [t('Dossiers dont au moins une valeur a été relue', 'Records with at least one reviewed value'), `${n(q.patientsReviewed)} / ${n(q.patients)}`],
        [t('Propositions relues', 'Proposals reviewed'), n(reviewed)],
        [t('  confirmées telles quelles', '  confirmed as is'), n(q.overall.confirmed)],
        [t('  corrigées', '  corrected'), n(q.overall.corrected)],
        [t('  écartées (vidées)', '  discarded (emptied)'), n(q.overall.emptied)],
        [t('Valeurs saisies là où l’extraction n’avait rien trouvé', 'Values typed where extraction found nothing'), n(q.overall.added)],
        [t('Concordance (précision) : confirmées / relues', 'Agreement (precision): confirmed / reviewed'), prop(q.overall.agreement)],
        [t('Rappel : confirmées / (confirmées + corrigées + ajoutées)', 'Recall: confirmed / (confirmed + corrected + added)'), prop(q.overall.recall)],
      ],
    });
    blocks.push({
      type: 'table',
      head: [t('Variable', 'Variable'), t('Relues', 'Reviewed'), t('Confirmées', 'Confirmed'), t('Corrigées', 'Corrected'), t('Vidées', 'Emptied'), t('Ajoutées', 'Added'), t('Concordance', 'Agreement')],
      align: ['left', 'right', 'right', 'right', 'right', 'right', 'right'],
      rows: q.fields
        .filter((f) => f.reviewed > 0 || f.added > 0)
        .map((f) => [f.label, n(f.reviewed), n(f.confirmed), n(f.corrected), n(f.emptied), n(f.added), f.agreement ? pct(f.agreement.value) : '—']),
    });
    blocks.push({
      type: 'note',
      text: t(
        'Ces mesures ne valent que si les dossiers relus ont été tirés au hasard : relire d’abord les valeurs douteuses fait baisser la concordance affichée, relire d’abord les dossiers faciles la fait monter.\nL’intervalle de confiance est celui de Wilson (95 %).',
        'These measures only hold if the reviewed records were drawn at random: reviewing doubtful values first lowers the displayed agreement, reviewing easy records first raises it.\nThe confidence interval is the Wilson interval (95%).',
      ),
    });
  }

  // ------------------------------------------------------------------ audit
  blocks.push({ type: 'h2', text: t('Journal des modifications', 'Change log') });
  const actionLabels: Record<string, [string, string]> = {
    extract: ['valeurs posées par une passe d’extraction', 'values set by an extraction run'],
    unset: ['valeurs retirées parce que plus trouvées', 'values removed because no longer found'],
    edit: ['valeurs corrigées ou saisies par un relecteur', 'values corrected or typed by a reviewer'],
    confirm: ['valeurs confirmées par un relecteur', 'values confirmed by a reviewer'],
    clear: ['valeurs vidées par un relecteur', 'values emptied by a reviewer'],
    release: ['décisions de relecteur retirées', 'reviewer decisions withdrawn'],
    import: ['valeurs posées par un import de tableau', 'values set by a spreadsheet import'],
  };
  blocks.push({
    type: 'p',
    text: t(
      `${n(data.audit.events)} changement(s) de valeur consigné(s), horodatés, qu’aucune fonction de l’outil ne modifie. Un événement ne disparaît qu’avec le dossier, la variable ou la fiche auxquels il se rapporte. Le journal complet s’exporte en CSV (« Journal des modifications »).`,
      `${n(data.audit.events)} value change(s) logged, time-stamped, which no function of the tool edits. An event is removed only together with the record, variable or form it belongs to. The full log can be exported as CSV (“Change log”).`,
    ),
  });
  blocks.push({
    type: 'list',
    items: Object.entries(data.audit.byAction).map(([action, count]) => `${n(count)} ${t(...(actionLabels[action] ?? [action, action]))}`),
  });

  // ------------------------------------------------------------ environnement
  blocks.push({ type: 'h2', text: t('Environnement logiciel', 'Software environment') });
  blocks.push({
    type: 'table',
    head: [t('Composant', 'Component'), t('Version', 'Version')],
    rows: [
      ['PubResearcher', data.tool.version],
      [t('Schéma de la base', 'Database schema'), String(data.tool.schemaVersion)],
      ['Node.js', data.tool.node],
      [t('Système', 'System'), data.tool.platform],
      ...Object.entries(data.tool.dependencies).map(([name, version]) => [name, version]),
    ],
  });

  // ------------------------------------------------------------------ limites
  blocks.push({ type: 'h2', text: t('Limites à signaler', 'Limitations to report') });
  blocks.push({
    type: 'list',
    items: [
      t(
        'Les règles lisent un texte : une valeur absente du texte (document illisible, page non scannée, mention orale) ne peut pas être extraite, et son absence n’établit pas que la donnée n’existe pas.',
        'Rules read text: a value that is not in the text (unreadable document, unscanned page, oral mention) cannot be extracted, and its absence does not establish that the data does not exist.',
      ),
      t(
        'La reconnaissance optique peut confondre des caractères et perdre une négation ; les valeurs issues d’un scan se relisent contre l’image.',
        'Optical character recognition may confuse characters and lose a negation; values from a scan should be checked against the image.',
      ),
      t(
        'Les règles et le vocabulaire (négations, sigles) sont écrits pour des comptes rendus en français ; l’emploi sur d’autres langues demande de réécrire les règles.',
        'Rules and vocabulary (negations, abbreviations) are written for French clinical reports; other languages require rewriting the rules.',
      ),
      t(
        'Une valeur proposée par un modèle de langage est une proposition : elle n’est retenue que si la citation recopiée par le modèle, ou à défaut la valeur elle-même, est retrouvée dans le texte du document — ce qui ne prouve pas qu’elle y a été lue à cet endroit —, et elle demande une relecture plus attentive qu’une valeur de règle.',
        'A value proposed by a language model is a proposal: it is kept only if the quotation copied by the model, or failing that the value itself, is found in the text of the document — which does not prove that it was read there — and it needs more careful review than a rule-derived value.',
      ),
      ...(data.imports.length > 0
        ? [
            t(
              'Une valeur importée d’un tableau reprend ce que l’équipe y avait saisi : l’outil en contrôle le format (type, options, unité, bornes), pas l’exactitude par rapport au dossier source.',
              'A value imported from a spreadsheet repeats what the team had entered there: the tool checks its format (type, options, unit, bounds), not its accuracy against the source record.',
            ),
          ]
        : []),
    ],
  });

  return blocks;
}
