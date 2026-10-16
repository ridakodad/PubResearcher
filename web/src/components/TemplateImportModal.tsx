import { useId, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { plural } from '../lib/format';
import { FIELD_TYPE_LABELS } from '../lib/types';
import type { DraftField, FieldType, TemplateImportDraft } from '../lib/types';
import { IconAlert, IconInfo } from './icons';
import { Modal, Spinner, useToast } from './ui';

/**
 * Import d'une fiche d'exploitation existante (Word, Excel, CSV).
 *
 * Trois temps : le chercheur dépose le document qu'il utilisait jusque-là ; l'outil en propose les variables (par
 * règles, ou par Claude si une clé est disponible) ; il les relit, corrige, décoche ce qui n'en est pas, puis la fiche
 * est créée d'un coup. Rien n'est écrit avant le dernier clic : fermer la fenêtre abandonne la proposition.
 */

interface Row extends DraftField {
  /** Identifiant local de la ligne (les clés peuvent changer à l'édition). */
  uid: number;
  keep: boolean;
  /** Options en saisie libre, séparées par des virgules : converties à l'envoi. */
  optionsText: string;
}

const TYPES = Object.keys(FIELD_TYPE_LABELS) as FieldType[];
const hasOptions = (type: FieldType) => type === 'enum' || type === 'multi';
const ACCEPT =
  '.docx,.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv';

const splitOptions = (text: string) => [...new Set(text.split(/[,;]/).map((o) => o.trim()).filter(Boolean))];

export function TemplateImportModal({
  onClose,
  onImported,
  llmAvailable,
}: {
  onClose: () => void;
  onImported: (templateId: number) => void;
  llmAvailable: boolean;
}) {
  const toast = useToast();
  const [useClaude, setUseClaude] = useState(llmAvailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<TemplateImportDraft | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [name, setName] = useState('');
  const [activate, setActivate] = useState(true);

  const kept = useMemo(() => rows.filter((r) => r.keep), [rows]);
  const invalid = kept.some((r) => !r.label.trim());

  async function analyse(file: File) {
    setBusy(true);
    setError(null);
    try {
      const result = await api.importTemplateDocument(file, useClaude && llmAvailable);
      setDraft(result);
      setName(result.name);
      setRows(result.fields.map((f, i) => ({ ...f, uid: i, keep: true, optionsText: f.options.join(', ') })));
      if (result.fields.length === 0) setError('Aucune variable reconnue dans ce document. Vérifiez sa mise en page, ou créez la fiche à la main.');
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    setBusy(true);
    setError(null);
    try {
      const fields: DraftField[] = kept.map(({ uid: _uid, keep: _keep, optionsText, ...f }) => ({
        ...f,
        label: f.label.trim(),
        section: f.section.trim() || 'Général',
        unit: f.unit?.trim() || null,
        options: hasOptions(f.type) ? splitOptions(optionsText) : [],
      }));
      const { template } = await api.commitTemplateDocument({ name: name.trim() || 'Fiche importée', fields, activate });
      toast.success(`Fiche « ${template.name} » créée : ${plural(template.fields.length, 'variable')}.`);
      onImported(template.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const update = (uid: number, patch: Partial<Row>) => setRows((current) => current.map((r) => (r.uid === uid ? { ...r, ...patch } : r)));
  const allKept = rows.length > 0 && rows.every((r) => r.keep);

  const footer = draft ? (
    <>
      <button
        className="btn"
        onClick={() => {
          setDraft(null);
          setRows([]);
          setError(null);
        }}
        disabled={busy}
      >
        Autre document
      </button>
      <button className="btn-primary" onClick={() => void commit()} disabled={busy || kept.length === 0 || invalid || !name.trim()}>
        {busy ? <Spinner label="Création…" /> : `Créer la fiche (${plural(kept.length, 'variable')})`}
      </button>
    </>
  ) : undefined;

  return (
    <Modal title="Importer une fiche existante (Word, Excel)" onClose={onClose} width={1100} footer={footer}>
      <div className="stack">
        {error && (
          <div className="notice notice-error" role="alert">
            <IconAlert size={18} />
            <div>{error}</div>
          </div>
        )}
        {!draft ? (
          <FileStep busy={busy} onFile={(f) => void analyse(f)} useClaude={useClaude} onUseClaude={setUseClaude} llmAvailable={llmAvailable} />
        ) : (
          <>
            <div className="tpl-import-head">
              <div className="field">
                <label htmlFor="tpl-import-name">Nom de la fiche</label>
                <input id="tpl-import-name" type="text" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} aria-invalid={!name.trim()} />
              </div>
              <label className="checkbox">
                <input type="checkbox" checked={activate} onChange={(e) => setActivate(e.target.checked)} />
                En faire la fiche active
              </label>
            </div>
            <p className="small muted">
              {draft.method === 'claude' ? 'Variables proposées par Claude.' : 'Variables reconnues par l’analyse du document (règles).'}{' '}
              {plural(rows.length, 'variable')} détectée{rows.length > 1 ? 's' : ''}, {kept.length} retenue{kept.length > 1 ? 's' : ''}. Relisez,
              corrigez, et décochez ce qui n’est pas une variable. Les options se séparent par des virgules.
            </p>
            {draft.warnings.length > 0 && (
              <div className="notice notice-warn">
                <IconAlert size={18} />
                <details className="small">
                  <summary>{plural(draft.warnings.length, 'avertissement')}</summary>
                  <ul className="tpl-import-warnings">
                    {draft.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
            {rows.length > 0 && (
              <div className="table-scroll tpl-import-table">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">
                        <input
                          type="checkbox"
                          aria-label={allKept ? 'Tout décocher' : 'Tout cocher'}
                          checked={allKept}
                          onChange={(e) => setRows((current) => current.map((r) => ({ ...r, keep: e.target.checked })))}
                        />
                      </th>
                      <th scope="col">Libellé</th>
                      <th scope="col">Type</th>
                      <th scope="col">Options</th>
                      <th scope="col">Unité</th>
                      <th scope="col">Section</th>
                      <th scope="col">Obligatoire</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.uid} className={r.keep ? undefined : 'tpl-import-off'}>
                        <td>
                          <input type="checkbox" aria-label={`Garder « ${r.label} »`} checked={r.keep} onChange={(e) => update(r.uid, { keep: e.target.checked })} />
                        </td>
                        <td>
                          <input type="text" aria-label="Libellé" value={r.label} maxLength={200} disabled={!r.keep} aria-invalid={r.keep && !r.label.trim()} onChange={(e) => update(r.uid, { label: e.target.value })} />
                        </td>
                        <td>
                          <select aria-label={`Type de « ${r.label} »`} value={r.type} disabled={!r.keep} onChange={(e) => update(r.uid, { type: e.target.value as FieldType })}>
                            {TYPES.map((t) => (
                              <option key={t} value={t}>
                                {FIELD_TYPE_LABELS[t]}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td>
                          <input
                            type="text"
                            aria-label={`Options de « ${r.label} »`}
                            value={hasOptions(r.type) ? r.optionsText : ''}
                            placeholder={hasOptions(r.type) ? 'A, B, C' : '—'}
                            disabled={!r.keep || !hasOptions(r.type)}
                            onChange={(e) => update(r.uid, { optionsText: e.target.value })}
                          />
                        </td>
                        <td>
                          <input type="text" className="tpl-import-unit" aria-label={`Unité de « ${r.label} »`} value={r.unit ?? ''} maxLength={40} disabled={!r.keep} onChange={(e) => update(r.uid, { unit: e.target.value })} />
                        </td>
                        <td>
                          <input type="text" aria-label={`Section de « ${r.label} »`} value={r.section} maxLength={80} disabled={!r.keep} onChange={(e) => update(r.uid, { section: e.target.value })} />
                        </td>
                        <td className="tpl-import-center">
                          <input type="checkbox" aria-label={`« ${r.label} » obligatoire`} checked={r.required} disabled={!r.keep} onChange={(e) => update(r.uid, { required: e.target.checked })} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="notice notice-info">
              <IconInfo size={18} />
              <div className="small">
                Rien n’est écrit avant « Créer la fiche ». Des règles d’extraction de départ sont proposées pour chaque
                variable ; vous pourrez les affiner, comme le reste de la fiche, dans l’éditeur.
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function FileStep({
  busy,
  onFile,
  useClaude,
  onUseClaude,
  llmAvailable,
}: {
  busy: boolean;
  onFile: (file: File) => void;
  useClaude: boolean;
  onUseClaude: (value: boolean) => void;
  llmAvailable: boolean;
}) {
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
          if (file && !busy) onFile(file);
        }}
      >
        <div style={{ fontSize: '1.6rem', marginBottom: 6 }} aria-hidden="true">
          ▤
        </div>
        <p>
          <strong>Glissez ici votre fiche d’exploitation</strong>
          <br />
          <span className="small">Le formulaire de recueil que vous utilisez déjà : document Word ou classeur Excel.</span>
        </p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button className="btn-sm btn-primary" onClick={() => input.current?.click()} disabled={busy} aria-describedby={hintId}>
            {busy ? <Spinner label="Lecture du document…" /> : 'Choisir un fichier…'}
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 10 }} id={hintId}>
          Formats acceptés : Word (.docx), Excel (.xlsx) et CSV. Un ancien .doc ou .xls s’enregistre d’abord en .docx ou
          .xlsx.
        </div>
        <input
          ref={input}
          type="file"
          hidden
          accept={ACCEPT}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFile(file);
            e.target.value = '';
          }}
        />
      </div>
      <label className="checkbox">
        <input type="checkbox" checked={useClaude && llmAvailable} disabled={!llmAvailable || busy} onChange={(e) => onUseClaude(e.target.checked)} />
        Utiliser Claude pour mieux comprendre le document
      </label>
      {!llmAvailable && <div className="small muted">Claude n’est pas activé : l’analyse se fera par règles (libellés, cases à cocher, tableaux).</div>}
      <div className="notice notice-info">
        <IconInfo size={18} />
        <div className="small">
          Mises en page reconnues : « Libellé : ____ », cases « ☐ Oui ☐ Non » ou « ☐ A ☐ B ☐ C », titres de section,
          tableaux Word « Variable | Valeur » ou « Variable | Oui | Non », dictionnaire de données Excel (Variable, Type,
          Modalités, Unité…) ou feuille de saisie vierge dont la ligne d’en-tête liste les variables. Vous relirez chaque
          variable avant la création de la fiche.
        </div>
      </div>
    </div>
  );
}
