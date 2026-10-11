import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { displayValue, formatDateTime, plural } from '../lib/format';
import { FolderUploader } from '../components/FolderUploader';
import { DocumentViewer, type ViewerFocus } from '../components/DocumentViewer';
import { SourceBadge, ValueEditor } from '../components/ValueEditor';
import { ErrorPanel, LoadingPanel, Modal, Spinner, useToast } from '../components/ui';
import { IconAlert, IconInfo } from '../components/icons';
import { Meter } from '../components/charts/StatTile';
import type {
  DocumentMeta,
  FieldValue,
  OutOfBounds,
  Patient,
  PatientRecord,
  TemplateField,
  TemplateWithFields,
  ValueEvent,
} from '../lib/types';

export function DossierDetailPage() {
  const params = useParams();
  const patientId = Number(params.id);
  const toast = useToast();

  const [patient, setPatient] = useState<Patient | null>(null);
  const [documents, setDocuments] = useState<DocumentMeta[]>([]);
  const [template, setTemplate] = useState<TemplateWithFields | null>(null);
  const [record, setRecord] = useState<PatientRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Corrections en attente d'enregistrement, par identifiant de variable. */
  const [edits, setEdits] = useState<Map<number, FieldValue>>(new Map());
  /** Saisies en cours qui ne sont pas des valeurs recevables (ex. « 12,5x » dans un nombre), par variable. */
  const [invalid, setInvalid] = useState<Map<number, string>>(new Map());
  /** Valeurs hors bornes que le serveur a signalées et qui attendent une confirmation. */
  const [outOfBounds, setOutOfBounds] = useState<OutOfBounds[] | null>(null);
  /** Nombre de corrections retrouvées dans le brouillon de la session au chargement de la page. */
  const [restored, setRestored] = useState(0);
  const draftChecked = useRef(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [showImport, setShowImport] = useState(false);
  /* Justification cliquée dans la fiche : amène le lecteur sur le bon
     document, à la bonne ligne. */
  const [focus, setFocus] = useState<ViewerFocus | null>(null);
  const focusNonce = useRef(0);

  const load = useCallback(async () => {
    if (!Number.isInteger(patientId)) {
      setError('Identifiant de dossier invalide.');
      return;
    }
    try {
      setError(null);
      const [detail, recordData] = await Promise.all([
        api.getPatient(patientId),
        api.getRecord(patientId),
      ]);
      setPatient(detail.patient);
      setDocuments(detail.documents);
      setTemplate(recordData.template);
      setRecord(recordData.record);
      setEdits(new Map());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Le code du dossier dans l'onglet : plusieurs dossiers ouverts côte à côte doivent se distinguer.
  useEffect(() => {
    if (patient) document.title = `Dossier ${patient.code} · Exploitation de dossiers patients`;
  }, [patient]);

  /*
   * Brouillon de session.
   *
   * Les corrections non enregistrées survivent à un rechargement, un retour arrière
   * ou une navigation vers un autre dossier : on les range dans la session du
   * navigateur (jamais sur le serveur) et on les remet à l'ouverture de la page.
   */
  const draftKey = template ? `rt:brouillon:${template.id}:${patientId}` : null;

  useEffect(() => {
    if (!template || !draftKey || draftChecked.current) return;
    draftChecked.current = true;
    try {
      const raw = sessionStorage.getItem(draftKey);
      if (!raw) return;
      const entries = (JSON.parse(raw) as [number, FieldValue][]).filter(([id]) =>
        template.fields.some((f) => f.id === id),
      );
      if (entries.length > 0) {
        setEdits(new Map(entries));
        setRestored(entries.length);
      }
    } catch {
      // Brouillon illisible ou stockage indisponible : on repart d'une page propre.
    }
  }, [template, draftKey]);

  useEffect(() => {
    if (!draftKey || !draftChecked.current) return;
    try {
      if (edits.size === 0) sessionStorage.removeItem(draftKey);
      else sessionStorage.setItem(draftKey, JSON.stringify([...edits]));
    } catch {
      // Sans stockage, le brouillon ne vaut que pour la page ouverte.
    }
  }, [edits, draftKey]);

  // Ctrl+S (⌘S) enregistre les corrections en attente, comme dans tout éditeur.
  const saveRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (edits.size === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [edits.size]);

  // Fermer l'onglet ou recharger avec des corrections en attente : le navigateur demande confirmation.
  useEffect(() => {
    if (edits.size === 0) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [edits.size]);

  const valuesByField = useMemo(() => {
    const map = new Map<number, PatientRecord['values'][number]>();
    for (const value of record?.values ?? []) map.set(value.fieldId, value);
    return map;
  }, [record]);

  const sections = useMemo(() => {
    const grouped = new Map<string, TemplateWithFields['fields']>();
    for (const field of template?.fields ?? []) {
      const list = grouped.get(field.section) ?? [];
      list.push(field);
      grouped.set(field.section, list);
    }
    return [...grouped.entries()];
  }, [template]);

  function currentValue(fieldId: number): FieldValue {
    if (edits.has(fieldId)) return edits.get(fieldId)!;
    return valuesByField.get(fieldId)?.value ?? null;
  }

  function setEdit(fieldId: number, value: FieldValue) {
    setEdits((current) => {
      const next = new Map(current);
      next.set(fieldId, value);
      return next;
    });
  }

  function setInvalidFor(fieldId: number, message: string | null) {
    setInvalid((current) => {
      if ((current.get(fieldId) ?? null) === message) return current;
      const next = new Map(current);
      if (message === null) next.delete(fieldId);
      else next.set(fieldId, message);
      return next;
    });
  }

  async function save(acceptOutOfBounds = false) {
    if (!template || edits.size === 0) return;
    setSaving(true);
    try {
      const payload = [...edits.entries()].map(([fieldId, value]) => ({ fieldId, value }));
      const { record: updated } = await api.saveValues(template.id, patientId, payload, { acceptOutOfBounds });
      setRecord(updated);
      setEdits(new Map());
      setRestored(0);
      setOutOfBounds(null);
      toast.success(`${plural(payload.length, 'correction enregistrée', 'corrections enregistrées')}.`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'out_of_bounds' && Array.isArray(err.details)) {
        // Pas une erreur : une valeur inhabituelle que le relecteur doit confirmer ou corriger.
        setOutOfBounds(err.details as OutOfBounds[]);
      } else {
        toast.error(err instanceof ApiError ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  }

  saveRef.current = () => {
    if (!saving && invalid.size === 0) void save();
  };

  function discardEdits() {
    setEdits(new Map());
    setInvalid(new Map());
    setRestored(0);
  }

  /** Décision immédiate sur une variable : confirmer la proposition, ou rendre la main à l'extraction. */
  async function decide(field: TemplateField, mode: 'confirm' | 'release') {
    if (!template) return;
    try {
      const { record: updated } = await api.saveValues(template.id, patientId, [{ fieldId: field.id, mode }]);
      setRecord(updated);
      if (mode === 'release') {
        // Rendre la main n'a de sens que si l'extraction rejoue : on la relance pour ce dossier.
        await api.runExtraction({ templateId: template.id, patientIds: [patientId] });
        const fresh = await api.getRecord(patientId, template.id);
        setRecord(fresh.record);
        toast.success(`« ${field.label} » : extraction rétablie.`);
      } else {
        toast.success(`« ${field.label} » confirmé.`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function runExtraction() {
    if (!template) return;
    setRunning(true);
    try {
      const result = await api.runExtraction({ templateId: template.id, patientIds: [patientId] });
      const report = result.reports[0];
      toast.success(
        report
          ? `${report.extracted} valeurs extraites, ${report.notFound} non trouvées.`
          : 'Extraction terminée.',
      );
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  async function removeDocument(doc: DocumentMeta) {
    try {
      await api.deleteDocument(doc.id);
      toast.success(`« ${doc.filename} » supprimé.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function reparse(doc: DocumentMeta) {
    try {
      await api.reparseDocument(doc.id);
      toast.success(`« ${doc.filename} » ré-analysé.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  if (error) {
    // « Réessayer » n'a de sens que pour une panne : un dossier supprimé ou une adresse erronée ne reviendra pas.
    const absent = /introuvable/i.test(error);
    return (
      <div className="stack" style={{ gap: 12 }}>
        <ErrorPanel message={error} {...(absent ? {} : { onRetry: () => void load() })} />
        <div>
          <Link className="btn btn-sm" to="/dossiers">
            ← Retour aux dossiers patients
          </Link>
        </div>
      </div>
    );
  }
  if (!patient || !template || !record) return <LoadingPanel />;

  const filled = template.fields.filter((f) => {
    const value = currentValue(f.id);
    return value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);
  }).length;
  const completeness = template.fields.length > 0 ? (filled / template.fields.length) * 100 : 0;
  const missingRequired = template.fields.filter(
    (f) => f.required && (currentValue(f.id) === null || currentValue(f.id) === ''),
  );

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="small muted" style={{ marginBottom: 4 }}>
            <Link to="/dossiers" className="back-link">← Dossiers patients</Link>
          </div>
          <h1>{patient.code}</h1>
          <p className="sub">
            {patient.label ? `${patient.label} · ` : ''}
            {plural(documents.length, 'document')}
            {record.lastExtractionAt
              ? ` · dernière extraction le ${formatDateTime(record.lastExtractionAt)}`
              : ' · aucune extraction effectuée'}
          </p>
        </div>
        <div className="page-head-actions">
          <button onClick={() => setShowImport(true)}>Ajouter des documents</button>
          <button onClick={runExtraction} disabled={running || documents.length === 0}>
            {running ? <Spinner label="Extraction…" /> : 'Relancer l’extraction'}
          </button>
          <button
            className="btn-primary"
            onClick={() => void save()}
            disabled={saving || edits.size === 0 || invalid.size > 0}
            title={invalid.size > 0 ? 'Corrigez d’abord les champs en erreur.' : undefined}
          >
            {saving
              ? 'Enregistrement…'
              : edits.size > 0
                ? `Enregistrer (${edits.size})`
                : 'Enregistrer'}
          </button>
        </div>
      </div>

      {/* La relecture est un aller-retour entre la variable et le document
          qui la justifie : les deux restent donc côte à côte, et le lecteur
          de droite suit la fiche sans jamais la recouvrir. */}
      <div className="relecture">
        {/* ------------------------------------------------------- fiche */}
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h2>Fiche d’exploitation</h2>
              <span className="sub">{template.name}</span>
            </div>
            <div className="card-body stack">
              <Meter
                value={completeness}
                label="Complétude du dossier"
                caption={`${filled} variable${filled > 1 ? 's' : ''} renseignée${filled > 1 ? 's' : ''} sur ${template.fields.length}`}
              />
              {missingRequired.length > 0 && (
                <div className="notice notice-warn">
                  <IconAlert size={18} />
                  <div>
                    <strong>Variables obligatoires non renseignées :</strong>{' '}
                    {missingRequired.map((f) => f.label).join(', ')}.
                  </div>
                </div>
              )}
              {restored > 0 && edits.size > 0 && (
                <div className="notice notice-info">
                  <IconInfo size={18} />
                  <div>
                    {plural(restored, 'correction non enregistrée retrouvée', 'corrections non enregistrées retrouvées')}{' '}
                    dans cette session. Enregistrez-les, ou rechargez la page après les avoir annulées.
                    <button
                      className="link-button"
                      style={{ marginLeft: 8 }}
                      onClick={() => {
                        setEdits(new Map());
                        setRestored(0);
                      }}
                    >
                      Abandonner ces corrections
                    </button>
                  </div>
                </div>
              )}
              {documents.length === 0 && (
                <div className="notice notice-info">
                  <IconInfo size={18} />
                  <div>
                    Aucun document dans ce dossier. Importez des documents pour alimenter
                    l’extraction automatique, ou saisissez les variables à la main.
                  </div>
                </div>
              )}
            </div>
          </div>

          {sections.map(([section, fields]) => (
            <div className="card" key={section}>
              <div className="card-head">
                <h3>{section}</h3>
                <span className="sub">{plural(fields.length, 'variable')}</span>
              </div>
              <div className="card-body stack" style={{ gap: 18 }}>
                {fields.map((field) => {
                  const stored = valuesByField.get(field.id);
                  const edited = edits.has(field.id);
                  const inputId = `field-${field.id}`;
                  return (
                    <div key={field.id}>
                      <div className="row" style={{ marginBottom: 6, gap: 8 }}>
                        <label htmlFor={inputId} style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-primary)' }}>
                          {field.label}
                          {field.unit && <span className="muted"> ({field.unit})</span>}
                          {field.required && (
                            <span style={{ color: 'var(--critical)' }} title="Variable obligatoire">
                              {' '}
                              *
                            </span>
                          )}
                        </label>
                        <div className="spacer" />
                        {edited ? (
                          <span className="badge badge-warn">Modifié</span>
                        ) : (
                          <SourceBadge stored={stored} />
                        )}
                      </div>

                      <ValueEditor
                        id={inputId}
                        field={field}
                        value={currentValue(field.id)}
                        onChange={(value) => setEdit(field.id, value)}
                        onInvalid={(message) => setInvalidFor(field.id, message)}
                      />

                      {field.description && <div className="field-hint">{field.description}</div>}

                      {!edited && stored && (
                        <div className="row field-actions">
                          {(stored.source === 'auto' || stored.source === 'llm') && stored.value !== null && (
                            <button
                              className="btn-sm btn-quiet"
                              onClick={() => void decide(field, 'confirm')}
                              title="Valider la valeur proposée par l’extraction, telle quelle"
                            >
                              Confirmer
                            </button>
                          )}
                          {stored.source === 'manual' && (
                            <button
                              className="btn-sm btn-quiet"
                              onClick={() => void decide(field, 'release')}
                              title="Retirer la décision du relecteur et relancer l’extraction pour cette variable"
                            >
                              Rétablir l’extraction
                            </button>
                          )}
                          {stored.origin && stored.source === 'manual' && (
                            <span className="small muted">
                              Proposé : {displayValue(stored.origin.value, field)} ({stored.origin.source === 'llm' ? 'Claude' : 'règle'})
                            </span>
                          )}
                        </div>
                      )}
                      {stored && stored.source !== 'empty' && (
                        <FieldHistory templateId={template.id} patientId={patientId} field={field} version={stored.updatedAt} />
                      )}

                      {!edited && stored?.evidence && (
                        <details style={{ marginTop: 6 }}>
                          <summary
                            className="small"
                            style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}
                          >
                            Justification — {stored.evidence.documentName}
                          </summary>
                          <div
                            className="small"
                            style={{
                              marginTop: 6,
                              padding: '8px 10px',
                              background: 'var(--surface-2)',
                              borderRadius: 'var(--radius-sm)',
                              borderLeft: '3px solid var(--series-1)',
                            }}
                          >
                            <div style={{ fontStyle: 'italic' }}>« {stored.evidence.snippet} »</div>
                            <div className="muted" style={{ marginTop: 5 }}>
                              Trouvé par {stored.evidence.rule} dans{' '}
                              <button
                                className="link-button"
                                onClick={() => {
                                  focusNonce.current += 1;
                                  setFocus({
                                    documentId: stored.evidence!.documentId,
                                    evidence: stored.evidence!,
                                    nonce: focusNonce.current,
                                  });
                                }}
                                title="Afficher le passage dans le document"
                              >
                                {stored.evidence.documentName}
                              </button>
                            </div>
                            {stored.evidence.alternatives && stored.evidence.alternatives.length > 0 && (
                              <div style={{ marginTop: 5 }}>
                                <span className="muted">
                                  {stored.evidence.selection ?? 'Mentions discordantes'}. Autres valeurs trouvées :
                                </span>{' '}
                                {stored.evidence.alternatives.map((alt, i) => (
                                  <span key={i}>
                                    {i > 0 && ' ; '}
                                    <strong>{displayValue(alt.value, field)}</strong> ({alt.documentName})
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        </details>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {/* --------------------------------------------------- documents */}
        <DocumentViewer
          documents={documents}
          focus={focus}
          onAdd={() => setShowImport(true)}
          onReparse={(doc) => void reparse(doc)}
          onDelete={(doc) => void removeDocument(doc)}
          onRenamed={() => void load()}
        />
      </div>

      {edits.size > 0 && (
        <div className="savebar" role="region" aria-label="Corrections non enregistrées">
          <span>
            <strong>{plural(edits.size, 'correction non enregistrée', 'corrections non enregistrées')}</strong>
            {invalid.size > 0 && <span className="field-error"> — corrigez d’abord les champs en erreur.</span>}
          </span>
          <div className="spacer" />
          <button onClick={discardEdits} disabled={saving}>
            Annuler les corrections
          </button>
          <button className="btn-primary" onClick={() => void save()} disabled={saving || invalid.size > 0}>
            {saving ? 'Enregistrement…' : 'Enregistrer (Ctrl+S)'}
          </button>
        </div>
      )}

      {outOfBounds && (
        <Modal
          title="Valeur inhabituelle"
          onClose={() => setOutOfBounds(null)}
          width={560}
          footer={
            <>
              <button onClick={() => setOutOfBounds(null)}>Corriger</button>
              <button className="btn-primary" onClick={() => void save(true)} disabled={saving}>
                Enregistrer quand même
              </button>
            </>
          }
        >
          <p style={{ marginTop: 0 }}>
            {outOfBounds.length > 1 ? 'Ces valeurs sortent' : 'Cette valeur sort'} des bornes de
            plausibilité de la fiche. Rien n’a été enregistré.
          </p>
          <ul className="stack" style={{ gap: 6, paddingLeft: 18, margin: 0 }}>
            {outOfBounds.map((o) => {
              const field = template.fields.find((f) => f.id === o.fieldId);
              const show = (v: number | string) => displayValue(v, field);
              return (
                <li key={o.fieldId}>
                  <strong>{o.label}</strong> : {show(o.value)} — attendu{' '}
                  {o.min !== null && o.max !== null
                    ? `de ${show(o.min)} à ${show(o.max)}`
                    : o.min !== null
                      ? `au moins ${show(o.min)}`
                      : `au plus ${show(o.max!)}`}
                  .
                </li>
              );
            })}
          </ul>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Une faute de frappe se corrige ; une valeur exceptionnelle mais exacte se confirme.
          </p>
        </Modal>
      )}

      {showImport && (
        <Modal
          title={`Ajouter des documents — ${patient.code}`}
          onClose={() => setShowImport(false)}
          width={800}
        >
          <FolderUploader
            fixedPatient={{ id: patient.id, code: patient.code }}
            onDone={() => void load()}
          />
        </Modal>
      )}

    </div>
  );
}

const ACTION_LABELS: Record<ValueEvent['action'], string> = {
  extract: 'Extraction',
  unset: 'Valeur retirée (plus trouvée)',
  edit: 'Corrigé',
  confirm: 'Confirmé',
  clear: 'Vidé',
  release: 'Main rendue à l’extraction',
};

/**
 * Historique d'une variable : qui a mis quoi, quand — l'extraction, puis chaque décision d'un relecteur.
 * Chargé à l'ouverture seulement : une fiche de quarante variables ne fait pas quarante requêtes.
 */
function FieldHistory({
  templateId,
  patientId,
  field,
  version,
}: {
  templateId: number;
  patientId: number;
  field: TemplateField;
  /** Change à chaque modification de la valeur : l'historique ouvert se recharge. */
  version: string;
}) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ValueEvent[] | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api
      .getValueHistory(templateId, patientId, field.id)
      .then((r) => !cancelled && setEvents(r.events))
      .catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [open, templateId, patientId, field.id, version]);

  return (
    <details style={{ marginTop: 4 }} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className="small" style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>
        Historique
      </summary>
      {events === null ? (
        <div className="small muted" style={{ padding: '6px 0' }}>Chargement…</div>
      ) : events.length === 0 ? (
        <div className="small muted" style={{ padding: '6px 0' }}>Aucun changement enregistré.</div>
      ) : (
        <ol className="history-list">
          {events.map((e) => (
            <li key={e.id}>
              <span className="history-when">{formatDateTime(e.at)}</span>
              <span className="history-what">
                <strong>{ACTION_LABELS[e.action]}</strong>
                {e.action !== 'release' && e.action !== 'unset' && <> → {displayValue(e.newValue, field)}</>}
                {(e.action === 'edit' || e.action === 'clear' || e.action === 'confirm' || e.action === 'extract') &&
                  e.oldSource &&
                  e.oldValue !== null && <span className="muted"> (avant : {displayValue(e.oldValue, field)})</span>}
                {e.action === 'unset' && <span className="muted"> (était : {displayValue(e.oldValue, field)})</span>}
                {e.runId && <span className="muted"> · passe n° {e.runId}</span>}
              </span>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
