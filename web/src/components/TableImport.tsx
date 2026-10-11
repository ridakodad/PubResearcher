import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { displayValue, formatBytes, formatDateTime, plural } from '../lib/format';
import { FIELD_TYPE_LABELS } from '../lib/types';
import type {
  TableColumnsResponse,
  TableImport,
  TableImportOptions,
  TableImportReport,
  TableImportRequest,
  TableUploadResponse,
  TemplateField,
  TemplateWithFields,
  ValueSource,
} from '../lib/types';
import { AnonymisationGate } from './AnonymisationGate';
import { StatTile } from './charts/StatTile';
import { IconAlert, IconInfo } from './icons';
import { Modal, Spinner, useToast } from './ui';

/**
 * Import d'un tableau de cohorte (Excel, CSV) : une ligne par patient, une colonne par variable.
 *
 * Cinq étapes, dont aucune n'écrit avant la dernière : le fichier ; la feuille et la ligne d'en-tête ; la colonne des
 * codes et la correspondance colonnes -> variables ; la simulation, cellule par cellule ; l'écriture. Fermer la
 * fenêtre avant d'importer abandonne le brouillon, fichier compris.
 */

type Step = 'file' | 'sheet' | 'columns' | 'review' | 'done';

const STEPS: { id: Step; label: string }[] = [
  { id: 'file', label: 'Fichier' },
  { id: 'sheet', label: 'Feuille et en-tête' },
  { id: 'columns', label: 'Colonnes' },
  { id: 'review', label: 'Simulation' },
  { id: 'done', label: 'Import' },
];

const SOURCE_LABELS: Record<ValueSource, string> = {
  auto: 'règle',
  llm: 'Claude',
  manual: 'relecteur',
  import: 'import précédent',
  empty: 'vide',
};

const DEFAULT_OPTIONS: TableImportOptions = { createPatients: true, overwriteExtracted: false, overwriteManual: false };

export function TableImportModal({
  template,
  onClose,
  onDone,
}: {
  template: TemplateWithFields;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const [step, setStep] = useState<Step>('file');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [upload, setUpload] = useState<TableUploadResponse | null>(null);
  const [sheetName, setSheetName] = useState<string | null>(null);
  const [headerRow, setHeaderRow] = useState(1);
  const [columns, setColumns] = useState<TableColumnsResponse | null>(null);
  const [codeColumn, setCodeColumn] = useState<number | null>(null);
  const [mapping, setMapping] = useState<Map<number, number>>(new Map());
  const [options, setOptions] = useState<TableImportOptions>(DEFAULT_OPTIONS);
  const [report, setReport] = useState<TableImportReport | null>(null);
  const [committed, setCommitted] = useState<{ import: TableImport; report: TableImportReport } | null>(null);

  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const draftId = upload?.import.id ?? null;
  const draftRef = useRef<number | null>(null);
  draftRef.current = committed ? null : draftId;

  // Fermer sans importer abandonne le brouillon : le fichier de patients ne reste pas sur le serveur.
  useEffect(
    () => () => {
      if (draftRef.current !== null) void api.abandonTableImport(draftRef.current).catch(() => undefined);
    },
    [],
  );

  // À chaque étape, le focus va à son titre : un lecteur d'écran annonce où l'on est.
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, [step]);

  const sheet = upload?.workbook.sheets.find((s) => s.name === sheetName) ?? null;
  const fieldsById = useMemo(() => new Map(template.fields.map((f) => [f.id, f])), [template]);

  function fail(err: unknown) {
    setError(err instanceof ApiError ? err.message : String(err));
  }

  async function receive(file: File) {
    setBusy(true);
    setError(null);
    try {
      if (draftId !== null) void api.abandonTableImport(draftId).catch(() => undefined);
      const r = await api.uploadTable(file);
      setUpload(r);
      // La feuille proposée est la plus remplie des feuilles visibles et lisibles : un « Lisez-moi » en tête de
      // classeur n'est pas la cohorte.
      const readable = r.workbook.sheets.filter((s) => !s.error && s.rows > 0);
      const pool = readable.some((s) => !s.hidden) ? readable.filter((s) => !s.hidden) : readable;
      const first = [...pool].sort((a, b) => b.rows * b.columns - a.rows * a.columns)[0] ?? r.workbook.sheets[0]!;
      setSheetName(first.name);
      setHeaderRow(first.suggestedHeaderRow);
      setStep('sheet');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function loadColumns() {
    if (draftId === null || !sheet) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.tableColumns(draftId, { sheet: upload!.workbook.format === 'xlsx' ? sheet.name : null, headerRow, templateId: template.id });
      setColumns(r);
      setCodeColumn(r.suggestion.codeColumn ?? r.columns[0]?.index ?? null);
      setMapping(new Map(r.suggestion.mapping.map((m) => [m.column, m.fieldId])));
      setReport(null);
      setStep('columns');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  function requestBody(withPlan: boolean): TableImportRequest {
    return {
      sheet: upload!.workbook.format === 'xlsx' ? sheetName : null,
      headerRow,
      codeColumn: codeColumn ?? 0,
      mapping: [...mapping.entries()].map(([column, fieldId]) => ({ column, fieldId })),
      options,
      templateId: template.id,
      ...(withPlan && report ? { expectedPlan: report.planHash } : {}),
    };
  }

  async function simulate(next: TableImportOptions = options) {
    if (draftId === null) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.tableDryRun(draftId, { ...requestBody(false), options: next });
      setReport(r.report);
      setStep('review');
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (draftId === null || !report) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.tableCommit(draftId, requestBody(true));
      setCommitted(r);
      setStep('done');
      toast.success(`${plural(r.import.written, 'valeur importée', 'valeurs importées')} depuis « ${r.import.filename} ».`);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'plan_changed') {
        // L'état a bougé depuis la simulation : on la refait, et l'utilisateur relit avant de confirmer.
        setError(err.message);
        await simulate();
        setError(err.message);
      } else fail(err);
    } finally {
      setBusy(false);
    }
  }

  function setField(column: number, fieldId: number | null) {
    setMapping((current) => {
      const next = new Map(current);
      // Une variable ne reçoit qu'une colonne : la choisir ailleurs la retire de la colonne précédente.
      if (fieldId !== null) for (const [c, f] of next) if (f === fieldId && c !== column) next.delete(c);
      if (fieldId === null) next.delete(column);
      else next.set(column, fieldId);
      return next;
    });
  }

  const index = STEPS.findIndex((s) => s.id === step);
  const footer = (
    <>
      {step !== 'file' && step !== 'done' && (
        <button
          onClick={() => {
            setError(null);
            setStep(STEPS[index - 1]!.id);
          }}
          disabled={busy}
        >
          Retour
        </button>
      )}
      <button onClick={onClose} disabled={busy && step !== 'done'}>
        {step === 'done' ? 'Fermer' : 'Annuler'}
      </button>
      {step === 'sheet' && (
        <button className="btn-primary" onClick={() => void loadColumns()} disabled={busy || !sheet || Boolean(sheet.error)}>
          {busy ? <Spinner label="Lecture…" /> : 'Choisir les colonnes'}
        </button>
      )}
      {step === 'columns' && (
        <button className="btn-primary" onClick={() => void simulate()} disabled={busy || codeColumn === null || mapping.size === 0}>
          {busy ? <Spinner label="Simulation…" /> : 'Simuler l’import'}
        </button>
      )}
      {step === 'review' && report && (
        <button
          className="btn-primary"
          onClick={() => void commit()}
          disabled={busy || (report.values.write === 0 && report.patients.created === 0)}
        >
          {busy ? <Spinner label="Import…" /> : `Importer ${plural(report.values.write, 'valeur')}`}
        </button>
      )}
    </>
  );

  return (
    <Modal title="Importer un tableau (Excel, CSV)" onClose={onClose} width={1000} footer={step === 'file' ? undefined : footer}>
      <AnonymisationGate>
        <div className="stack">
          <ol className="stepper" aria-label="Étapes de l’import">
            {STEPS.map((s, i) => (
              <li key={s.id} className={i < index ? 'done' : i === index ? 'current' : undefined} aria-current={i === index ? 'step' : undefined}>
                <span className="stepper-num" aria-hidden="true">
                  {i + 1}
                </span>
                <span>{s.label}</span>
                {i < index && <span className="sr-only"> (fait)</span>}
              </li>
            ))}
          </ol>

          <h3 className="sr-only" tabIndex={-1} ref={headingRef}>
            Étape {index + 1} sur {STEPS.length} : {STEPS[index]!.label}
          </h3>

          {error && (
            <div className="notice notice-error" role="alert">
              <IconAlert size={18} />
              <div>{error}</div>
            </div>
          )}

          {step === 'file' && <FileStep busy={busy} onFile={(f) => void receive(f)} template={template} />}
          {step === 'sheet' && upload && (
            <SheetStep upload={upload} sheetName={sheetName} onSheet={(name) => {
              setSheetName(name);
              setHeaderRow(upload.workbook.sheets.find((s) => s.name === name)?.suggestedHeaderRow ?? 1);
            }} headerRow={headerRow} onHeaderRow={setHeaderRow} />
          )}
          {step === 'columns' && columns && (
            <ColumnsStep
              columns={columns}
              template={template}
              codeColumn={codeColumn}
              onCodeColumn={setCodeColumn}
              mapping={mapping}
              onField={setField}
            />
          )}
          {step === 'review' && report && (
            <ReviewStep
              report={report}
              options={options}
              busy={busy}
              fieldsById={fieldsById}
              onOptions={(next) => {
                setOptions(next);
                void simulate(next);
              }}
            />
          )}
          {step === 'done' && committed && <DoneStep result={committed} />}
        </div>
      </AnonymisationGate>
    </Modal>
  );
}

/* ─────────────────────────────── Étape 1 : fichier ─────────────────────── */

function FileStep({ busy, onFile, template }: { busy: boolean; onFile: (file: File) => void; template: TemplateWithFields }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const hintId = useId();
  return (
    <div className="stack">
      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const file = e.dataTransfer.files[0];
          if (file) onFile(file);
        }}
      >
        <div style={{ fontSize: '1.6rem', marginBottom: 6 }} aria-hidden="true">
          ▦
        </div>
        <p>
          <strong>Glissez ici le tableau de la cohorte</strong>
          <br />
          <span className="small">Une ligne par patient, une colonne par variable, avec une ligne d’en-tête.</span>
        </p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button className="btn-sm btn-primary" onClick={() => input.current?.click()} disabled={busy} aria-describedby={hintId}>
            {busy ? <Spinner label="Lecture du fichier…" /> : 'Choisir un fichier…'}
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 10 }} id={hintId}>
          Formats acceptés : Excel (.xlsx), CSV et TSV (séparateur et encodage reconnus). Un ancien .xls s’enregistre
          d’abord en .xlsx.
        </div>
        <input
          ref={input}
          type="file"
          hidden
          accept=".xlsx,.xlsm,.csv,.tsv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = '';
          }}
        />
      </div>
      <div className="notice notice-info">
        <IconInfo size={18} />
        <div className="small">
          Les valeurs iront dans la fiche active, « {template.name} ». Rien n’est écrit avant la simulation, qui montre
          cellule par cellule ce qui sera importé, refusé ou laissé en place. Les valeurs saisies ou relues à la main ne
          sont jamais remplacées sans votre accord. Les formules ne sont pas recalculées : c’est la valeur enregistrée
          par le tableur qui est lue.
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────── Étape 2 : feuille et ligne d'en-tête ──────────── */

function SheetStep({
  upload,
  sheetName,
  onSheet,
  headerRow,
  onHeaderRow,
}: {
  upload: TableUploadResponse;
  sheetName: string | null;
  onSheet: (name: string) => void;
  headerRow: number;
  onHeaderRow: (row: number) => void;
}) {
  const { workbook } = upload;
  const sheet = workbook.sheets.find((s) => s.name === sheetName) ?? null;
  const width = Math.min(12, Math.max(1, ...(sheet?.preview.map((r) => r.length) ?? [1])));
  const groupName = useId();
  return (
    <div className="stack">
      <div className="row small secondary" style={{ gap: 12 }}>
        <strong style={{ color: 'var(--text-primary)' }}>{upload.import.filename}</strong>
        <span>{formatBytes(upload.import.size)}</span>
        {workbook.format !== 'xlsx' && (
          <span>
            {workbook.format.toUpperCase()} · séparateur « {workbook.delimiter === '\t' ? 'tabulation' : workbook.delimiter} » · encodage {workbook.charset}
          </span>
        )}
        {workbook.date1904 && <span>Calendrier 1904 (dates converties)</span>}
      </div>

      {upload.previousImports.length > 0 && (
        <div className="notice notice-warn">
          <IconAlert size={18} />
          <div className="small">
            Ce fichier, identique octet pour octet, a déjà été importé (
            {upload.previousImports.map((p) => `${p.filename}, ${p.committedAt ? formatDateTime(p.committedAt) : '—'}`).join(' ; ')}). La
            simulation montrera ce qui est déjà en place.
          </div>
        </div>
      )}
      {workbook.warnings.map((w) => (
        <div className="notice notice-warn" key={w}>
          <IconAlert size={18} />
          <div className="small">{w}</div>
        </div>
      ))}

      {workbook.format === 'xlsx' && (
        <div className="field" style={{ maxWidth: 420 }}>
          <label htmlFor="table-sheet">Feuille</label>
          <select id="table-sheet" value={sheetName ?? ''} onChange={(e) => onSheet(e.target.value)}>
            {workbook.sheets.map((s) => (
              <option key={s.name} value={s.name} disabled={Boolean(s.error)}>
                {s.name} — {s.error ? 'illisible' : `${plural(s.rows, 'ligne')}, ${plural(s.columns, 'colonne')}`}
                {s.hidden ? ' (masquée)' : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      {sheet?.error && (
        <div className="notice notice-error">
          <IconAlert size={18} />
          <div className="small">Feuille illisible : {sheet.error}</div>
        </div>
      )}
      {sheet && sheet.formulasWithoutValue > 0 && (
        <div className="notice notice-warn">
          <IconAlert size={18} />
          <div className="small">
            {plural(sheet.formulasWithoutValue, 'formule n’a', 'formules n’ont')} pas de valeur enregistrée (marquées
            « ⚠ formule ») : l’outil ne recalcule pas les formules. Ouvrez le classeur dans le tableur, enregistrez-le,
            puis réimportez-le ; sinon ces cellules seront refusées.
          </div>
        </div>
      )}

      {sheet && !sheet.error && (
        <fieldset className="table-preview-set">
          <legend>Quelle ligne porte les en-têtes de colonne ?</legend>
          <p className="small muted" style={{ margin: '0 0 8px' }}>
            Les lignes au-dessus (titre, notes) sont ignorées ; chaque ligne en dessous est un patient. Aperçu des{' '}
            {Math.min(sheet.preview.length, 30)} premières lignes.
          </p>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Aperçu de la feuille (défilement)">
            <table className="table-preview">
              <thead>
                <tr>
                  <th scope="col">En-tête</th>
                  <th scope="col" className="num">Ligne</th>
                  {Array.from({ length: width }, (_, c) => (
                    <th scope="col" key={c}>
                      {String.fromCharCode(65 + c)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sheet.preview.map((row, r) => {
                  const number = r + 1;
                  const isHeader = number === headerRow;
                  return (
                    <tr key={r} className={isHeader ? 'is-header' : number < headerRow ? 'is-above' : undefined} onClick={() => onHeaderRow(number)}>
                      <td>
                        <input
                          type="radio"
                          name={groupName}
                          checked={isHeader}
                          onChange={() => onHeaderRow(number)}
                          aria-label={`Ligne ${number} comme ligne d’en-tête`}
                        />
                      </td>
                      <td className="num muted">{number}</td>
                      {Array.from({ length: width }, (_, c) => (
                        <td key={c} style={isHeader ? { fontWeight: 600 } : undefined}>
                          {row[c] ?? ''}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {sheet.columns > width && <div className="small muted" style={{ marginTop: 6 }}>{plural(sheet.columns - width, 'autre colonne')} à l’étape suivante.</div>}
        </fieldset>
      )}
    </div>
  );
}

/* ───────────────────── Étape 3 : codes et correspondances ──────────────── */

function fieldOptionLabel(field: TemplateField): string {
  return `${field.label}${field.unit ? ` (${field.unit})` : ''} — ${FIELD_TYPE_LABELS[field.type]}`;
}

function ColumnsStep({
  columns,
  template,
  codeColumn,
  onCodeColumn,
  mapping,
  onField,
}: {
  columns: TableColumnsResponse;
  template: TemplateWithFields;
  codeColumn: number | null;
  onCodeColumn: (column: number) => void;
  mapping: Map<number, number>;
  onField: (column: number, fieldId: number | null) => void;
}) {
  const sections = useMemo(() => {
    const out = new Map<string, TemplateField[]>();
    for (const f of template.fields) out.set(f.section, [...(out.get(f.section) ?? []), f]);
    return [...out.entries()];
  }, [template]);
  const suggestions = new Map(columns.suggestion.mapping.map((m) => [m.column, m]));
  const code = columns.columns.find((c) => c.index === codeColumn);

  return (
    <div className="stack">
      <div className="field" style={{ maxWidth: 520 }}>
        <label htmlFor="table-code-column">Colonne des codes dossier</label>
        <select id="table-code-column" value={codeColumn ?? ''} onChange={(e) => onCodeColumn(Number(e.target.value))} aria-describedby="table-code-hint">
          {columns.columns.map((c) => (
            <option key={c.index} value={c.index}>
              {c.letter} — {c.text || '(sans en-tête)'}
            </option>
          ))}
        </select>
        <div className="field-hint" id="table-code-hint">
          Un code par ligne, lu comme un nom de dossier (espaces et caractères invisibles retirés, majuscules sans
          importance) : un code existant complète ce dossier, un code nouveau crée un dossier.
          {code && code.distinct < code.filled && (
            <strong style={{ color: 'var(--critical)' }}> Cette colonne contient des doublons : les lignes concernées seront écartées.</strong>
          )}
        </div>
      </div>

      <div className="small secondary">
        {plural(columns.dataRows, 'ligne')} sous l’en-tête (ligne {columns.headerRow}) · {plural(mapping.size, 'colonne associée', 'colonnes associées')} sur{' '}
        {columns.columns.length}. Les colonnes laissées sur « Ignorer » ne sont pas importées.
      </div>

      <div className="table-scroll" tabIndex={0} role="region" aria-label="Correspondance des colonnes (défilement)">
        <table>
          <thead>
            <tr>
              <th scope="col">Col.</th>
              <th scope="col">En-tête</th>
              <th scope="col">Exemples</th>
              <th scope="col" style={{ minWidth: 260 }}>Variable de la fiche</th>
            </tr>
          </thead>
          <tbody>
            {columns.columns.map((c) => {
              const selected = mapping.get(c.index) ?? null;
              const suggestion = suggestions.get(c.index);
              const field = selected !== null ? template.fields.find((f) => f.id === selected) : undefined;
              const unitClash = Boolean(
                field?.unit && c.knownUnit && suggestion?.fieldId === selected && suggestion.unitWarning,
              );
              const selectId = `table-col-${c.index}`;
              return (
                <tr key={c.index}>
                  <td className="muted">{c.letter}</td>
                  <td>
                    <label htmlFor={selectId} style={{ margin: 0, fontWeight: 600 }}>
                      {c.text || <span className="muted">(sans en-tête)</span>}
                    </label>
                    {c.index === codeColumn && <span className="badge badge-type" style={{ marginLeft: 6 }}>Codes</span>}
                    <div className="small muted">{plural(c.filled, 'cellule renseignée', 'cellules renseignées')}</div>
                  </td>
                  <td className="small secondary">{c.sample.join(' · ') || '—'}</td>
                  <td>
                    <select
                      id={selectId}
                      value={selected ?? ''}
                      onChange={(e) => onField(c.index, e.target.value === '' ? null : Number(e.target.value))}
                      aria-describedby={unitClash ? `${selectId}-unit` : undefined}
                    >
                      <option value="">— Ignorer —</option>
                      {sections.map(([section, fields]) => (
                        <optgroup key={section} label={section}>
                          {fields.map((f) => (
                            <option key={f.id} value={f.id}>
                              {fieldOptionLabel(f)}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                    {suggestion && suggestion.fieldId === selected && (
                      <div className="small muted" style={{ marginTop: 4 }}>
                        Proposé : {suggestion.reason}
                      </div>
                    )}
                    {unitClash && (
                      <div className="small" id={`${selectId}-unit`} style={{ marginTop: 4, color: 'var(--critical)' }}>
                        {suggestion!.unitWarning}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─────────────────────────────── Étape 4 : simulation ──────────────────── */

function ReviewStep({
  report,
  options,
  busy,
  fieldsById,
  onOptions,
}: {
  report: TableImportReport;
  options: TableImportOptions;
  busy: boolean;
  fieldsById: Map<number, TemplateField>;
  onOptions: (next: TableImportOptions) => void;
}) {
  const v = report.values;
  const show = (fieldId: number, value: unknown) => displayValue(value as never, fieldsById.get(fieldId));
  return (
    <div className="stack">
      <div role="status" className="sr-only">
        Simulation : {plural(v.write, 'valeur')} à écrire, {plural(v.rejected, 'refusée')}, {plural(v.conflicts, 'conflit')}.
      </div>
      <div className="grid grid-stats">
        <StatTile
          label="Lignes retenues"
          value={report.rows.used}
          hint={`sur ${report.dataRows}${report.rows.skipped ? ` · ${report.rows.skipped} écartées` : ''}${report.rows.empty ? ` · ${report.rows.empty} vides` : ''}`}
        />
        <StatTile label="Dossiers" value={report.patients.created + report.patients.existing} hint={`${report.patients.created} à créer · ${report.patients.existing} existants`} />
        <StatTile
          label="Valeurs à écrire"
          value={v.write}
          accent
          hint={`${v.unchanged} déjà en place${v.replaceExtracted + v.replaceManual ? ` · ${v.replaceExtracted + v.replaceManual} remplacées` : ''}`}
        />
        <StatTile label="Refusées" value={v.rejected} hint={v.rejected ? 'Détail ci-dessous' : 'Toutes les cellules sont lisibles'} />
        <StatTile label="Conflits gardés" value={v.conflicts} hint={v.conflicts ? 'Valeur en place différente, conservée' : 'Aucun'} />
      </div>

      <fieldset className="layout-choice" disabled={busy}>
        <legend>Options</legend>
        <label className="radio">
          <input type="checkbox" checked={options.createPatients} onChange={(e) => onOptions({ ...options, createPatients: e.target.checked })} />
          <span>
            <strong>Créer les dossiers absents</strong> — sinon, les lignes dont le code n’existe pas sont écartées
          </span>
        </label>
        <label className="radio">
          <input type="checkbox" checked={options.overwriteExtracted} onChange={(e) => onOptions({ ...options, overwriteExtracted: e.target.checked })} />
          <span>
            <strong>Remplacer les valeurs extraites ou importées auparavant</strong> qui diffèrent du tableau (règles, Claude,
            imports précédents)
          </span>
        </label>
        <label className="radio">
          <input type="checkbox" checked={options.overwriteManual} onChange={(e) => onOptions({ ...options, overwriteManual: e.target.checked })} />
          <span>
            <strong>Remplacer aussi les décisions des relecteurs</strong> (valeurs saisies, confirmées ou vidées à la main)
          </span>
        </label>
        {options.overwriteManual && (
          <div className="notice notice-warn">
            <IconAlert size={18} />
            <div className="small">
              Des valeurs vérifiées par un relecteur seront remplacées par celles du tableau. Le journal garde l’ancienne
              valeur, mais la relecture sera perdue.
            </div>
          </div>
        )}
      </fieldset>

      {busy && <Spinner label="Simulation en cours…" />}

      <details open className="report-block">
        <summary>
          <strong>Par variable</strong>
        </summary>
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Bilan par variable (défilement)">
          <table>
            <thead>
              <tr>
                <th scope="col">Colonne</th>
                <th scope="col">Variable</th>
                <th scope="col" className="num">À écrire</th>
                <th scope="col" className="num">Déjà en place</th>
                <th scope="col" className="num">Vides</th>
                <th scope="col" className="num">Refusées</th>
                <th scope="col" className="num">Conflits</th>
              </tr>
            </thead>
            <tbody>
              {report.fields.map((f) => (
                <tr key={f.fieldId}>
                  <td>
                    <span className="muted">{f.letter}</span> {f.header}
                  </td>
                  <td>{f.fieldLabel}</td>
                  <td className="num">{f.write}</td>
                  <td className="num">{f.unchanged || '—'}</td>
                  <td className="num">{f.empty || '—'}</td>
                  <td className="num">{f.rejected || '—'}</td>
                  <td className="num">{f.conflicts || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>

      {report.rejected.length > 0 && (
        <details open className="report-block">
          <summary>
            <strong>{plural(v.rejected, 'valeur refusée', 'valeurs refusées')}</strong> — elles ne seront pas importées ; corrigez le tableau ou saisissez-les à la main
          </summary>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Valeurs refusées (défilement)">
            <table>
              <thead>
                <tr>
                  <th scope="col">Cellule</th>
                  <th scope="col">Dossier</th>
                  <th scope="col">Variable</th>
                  <th scope="col">Contenu</th>
                  <th scope="col">Motif</th>
                </tr>
              </thead>
              <tbody>
                {report.rejected.map((x) => (
                  <tr key={`${x.cell}`}>
                    <td className="nowrap">{x.cell}</td>
                    <td className="nowrap">{x.code}</td>
                    <td>{x.fieldLabel}</td>
                    <td>« {x.raw} »</td>
                    <td className="small">{x.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {report.conflicts.length > 0 && (
        <details open className="report-block">
          <summary>
            <strong>{plural(report.conflicts.length, 'valeur en place différente', 'valeurs en place différentes')}</strong> — gardées sauf option de remplacement
          </summary>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="Conflits avec les valeurs en place (défilement)">
            <table>
              <thead>
                <tr>
                  <th scope="col">Cellule</th>
                  <th scope="col">Dossier</th>
                  <th scope="col">Variable</th>
                  <th scope="col">En place</th>
                  <th scope="col">Tableau</th>
                  <th scope="col">Issue</th>
                </tr>
              </thead>
              <tbody>
                {report.conflicts.map((x) => (
                  <tr key={x.cell}>
                    <td className="nowrap">{x.cell}</td>
                    <td className="nowrap">{x.code}</td>
                    <td>{x.fieldLabel}</td>
                    <td>
                      {show(x.fieldId, x.current)} <span className="small muted">({SOURCE_LABELS[x.currentSource]})</span>
                    </td>
                    <td>{show(x.fieldId, x.incoming)}</td>
                    <td>
                      {x.resolution === 'kept' ? (
                        <span className="badge badge-manual">Gardée</span>
                      ) : (
                        <span className="badge badge-warn">Remplacée</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {report.rowIssues.length > 0 && (
        <details open className="report-block">
          <summary>
            <strong>{plural(report.rows.skipped, 'ligne écartée', 'lignes écartées')}</strong>
          </summary>
          <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
            {report.rowIssues.map((i) => (
              <li key={i.row}>
                Ligne {i.row}
                {i.code ? ` (${i.code})` : ''} : {i.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {report.patients.created > 0 && (
        <div className="small secondary">
          Dossiers à créer : {report.patients.createdCodes.slice(0, 12).join(', ')}
          {report.patients.created > 12 ? `, … (${report.patients.created} en tout)` : ''}.
        </div>
      )}
      {report.truncated && <div className="small muted">Les listes sont limitées aux mille premières entrées ; les compteurs sont complets.</div>}
    </div>
  );
}

/* ─────────────────────────────── Étape 5 : import ──────────────────────── */

function DoneStep({ result }: { result: { import: TableImport; report: TableImportReport } }) {
  const { import: done } = result;
  return (
    <div className="stack">
      <div className="notice notice-info" role="status">
        <IconInfo size={18} />
        <div>
          <strong>
            {plural(done.written, 'valeur importée', 'valeurs importées')} depuis « {done.filename} »
            {done.sheet ? `, feuille « ${done.sheet} »` : ''}.
          </strong>{' '}
          {plural(done.patientsCreated, 'dossier créé', 'dossiers créés')}, {plural(done.patientsExisting, 'dossier complété', 'dossiers complétés')}
          {done.conflicts ? `, ${plural(done.conflicts, 'valeur en place gardée', 'valeurs en place gardées')}` : ''}
          {done.rejected ? `, ${plural(done.rejected, 'cellule refusée', 'cellules refusées')}` : ''}.
        </div>
      </div>
      <p className="small secondary" style={{ margin: 0 }}>
        Chaque valeur importée porte la mention « Importé » et cite sa cellule ; le fichier est conservé avec son
        empreinte (SHA-256 {done.sha256.slice(0, 12)}…) et figure dans le rapport « Méthodes ». Ces valeurs ne sont pas
        relues : confirmez-les dossier par dossier après vérification.
      </p>
      <div className="row" style={{ gap: 8 }}>
        <Link className="btn btn-sm" to="/resultats">
          Voir les résultats
        </Link>
        <a className="btn btn-sm btn-quiet" href={api.tableImportFileUrl(done.id)} download>
          Télécharger le tableau importé
        </a>
      </div>
    </div>
  );
}
