import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { plural } from '../lib/format';
import { FIELD_TYPE_LABELS } from '../lib/types';
import type { PatientSummary, Template, TemplateField, TemplateWithFields } from '../lib/types';
import { FieldEditor } from '../components/FieldEditor';
import {
  ConfirmButton,
  EmptyState,
  ErrorPanel,
  LoadingPanel,
  Modal,
  useToast,
} from '../components/ui';

export function FichePage() {
  const toast = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [template, setTemplate] = useState<TemplateWithFields | null>(null);
  const [patients, setPatients] = useState<PatientSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ field: TemplateField | null } | null>(null);
  const [showNew, setShowNew] = useState(false);
  const importInput = useRef<HTMLInputElement>(null);

  const loadTemplate = useCallback(async (id: number) => {
    const { template: loaded } = await api.getTemplate(id);
    setTemplate(loaded);
  }, []);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [list, patientList] = await Promise.all([api.listTemplates(), api.listPatients()]);
      setTemplates(list.templates);
      setPatients(patientList.patients);

      const targetId =
        selectedId && list.templates.some((t) => t.id === selectedId)
          ? selectedId
          : (list.active?.id ?? list.templates[0]?.id ?? null);
      setSelectedId(targetId);
      if (targetId) await loadTemplate(targetId);
      else setTemplate(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, [selectedId, loadTemplate]);

  useEffect(() => {
    void load();
    // Chargement initial uniquement : `load` change à chaque sélection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function selectTemplate(id: number) {
    setSelectedId(id);
    try {
      await loadTemplate(id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  const sections = useMemo(() => {
    const grouped = new Map<string, TemplateField[]>();
    for (const field of template?.fields ?? []) {
      const list = grouped.get(field.section) ?? [];
      list.push(field);
      grouped.set(field.section, list);
    }
    return [...grouped.entries()];
  }, [template]);

  const sectionNames = useMemo(() => {
    const names = sections.map(([name]) => name);
    return names.length > 0 ? names : ['Général'];
  }, [sections]);

  async function activate() {
    if (!template) return;
    try {
      await api.activateTemplate(template.id);
      toast.success(`« ${template.name} » est désormais la fiche active.`);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function duplicate() {
    if (!template) return;
    try {
      const { template: copy } = await api.duplicateTemplate(template.id);
      toast.success(`Copie créée : « ${copy.name} ».`);
      setSelectedId(copy.id);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function removeTemplate() {
    if (!template) return;
    try {
      await api.deleteTemplate(template.id);
      toast.success('Fiche supprimée.');
      setSelectedId(null);
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function removeField(field: TemplateField) {
    try {
      await api.deleteField(field.id);
      toast.success(`Variable « ${field.label} » supprimée.`);
      if (selectedId) await loadTemplate(selectedId);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  /**
   * Déplace une variable parmi celles de sa section. L'écran groupe par section : échanger avec la voisine de l'ordre
   * global, qui peut appartenir à une autre section, ne changeait rien à l'écran — et décalait l'ordre des colonnes de l'export.
   * Les places occupées par la section restent les mêmes ; seul l'ordre des variables qu'elle contient change.
   */
  async function moveField(field: TemplateField, direction: -1 | 1) {
    if (!template) return;
    const ordered = [...template.fields].sort((a, b) => a.position - b.position);
    const slots = ordered.map((f, i) => (f.section === field.section ? i : -1)).filter((i) => i >= 0);
    const inSection = slots.map((i) => ordered[i]!);
    const at = inSection.findIndex((f) => f.id === field.id);
    const target = at + direction;
    if (at === -1 || target < 0 || target >= inSection.length) return;
    [inSection[at], inSection[target]] = [inSection[target]!, inSection[at]!];
    slots.forEach((slot, i) => {
      ordered[slot] = inSection[i]!;
    });
    try {
      await api.reorderFields(template.id, ordered.map((f) => f.id));
      await loadTemplate(template.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    }
  }

  async function importTemplate(file: File) {
    try {
      const payload = JSON.parse(await file.text());
      const { template: imported } = await api.importTemplate(payload);
      toast.success(`Fiche « ${imported.name} » importée.`);
      setSelectedId(imported.id);
      await load();
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : "Fichier illisible : attendu un export JSON de fiche d’exploitation.",
      );
    }
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />;
  if (!template && templates.length === 0 && !error) return <LoadingPanel />;

  const withRules = template?.fields.filter(
    (f) => f.extraction.enabled && f.extraction.rules.length > 0,
  ).length ?? 0;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Fiche d’exploitation</h1>
          <p className="sub">
            Définissez les variables de votre étude et la façon dont elles sont retrouvées dans les
            documents. La fiche active sert de référence à l’extraction et aux résultats.
          </p>
        </div>
        <div className="page-head-actions">
          <input
            ref={importInput}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void importTemplate(file);
              e.target.value = '';
            }}
          />
          <button onClick={() => importInput.current?.click()}>Importer une fiche</button>
          <button className="btn-primary" onClick={() => setShowNew(true)}>
            Nouvelle fiche
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div style={{ minWidth: 220 }}>
            <label htmlFor="template-select" style={{ marginBottom: 4 }}>
              Fiche affichée
            </label>
            <select
              id="template-select"
              value={selectedId ?? ''}
              onChange={(e) => void selectTemplate(Number(e.target.value))}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.isActive ? ' — active' : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="card-actions">
            {template && !template.isActive && (
              <button onClick={activate}>Définir comme active</button>
            )}
            {template?.isActive && <span className="badge badge-manual">Fiche active</span>}
            <button onClick={duplicate} disabled={!template}>
              Dupliquer
            </button>
            <a
              className="btn"
              href={template ? api.templateJsonUrl(template.id) : '#'}
              aria-disabled={!template}
            >
              Exporter (JSON)
            </a>
            {templates.length > 1 && (
              <ConfirmButton
                className="btn btn-danger"
                label="Supprimer"
                confirmLabel="Confirmer la suppression"
                subject="cette fiche"
                onConfirm={removeTemplate}
              />
            )}
          </div>
        </div>

        {template && (
          <div className="card-body">
            <div className="row" style={{ gap: 24 }}>
              <span>
                <strong>{template.fields.length}</strong>{' '}
                <span className="secondary">variables</span>
              </span>
              <span>
                <strong>{withRules}</strong>{' '}
                <span className="secondary">avec extraction automatique</span>
              </span>
              <span>
                <strong>{sections.length}</strong> <span className="secondary">sections</span>
              </span>
            </div>
            {template.description && (
              <p className="small secondary" style={{ marginTop: 8 }}>
                {template.description}
              </p>
            )}
          </div>
        )}
      </div>

      {template && (
        <div className="card">
          <div className="card-head">
            <h2>Variables</h2>
            <div className="card-actions">
              <button className="btn-primary" onClick={() => setEditing({ field: null })}>
                Ajouter une variable
              </button>
            </div>
          </div>

          {template.fields.length === 0 ? (
            <EmptyState
              title="Aucune variable"
              action={
                <button className="btn-primary" onClick={() => setEditing({ field: null })}>
                  Ajouter une variable
                </button>
              }
            >
              Une fiche d’exploitation est une liste de variables : ce que vous voulez recueillir
              pour chaque patient, et comment le retrouver dans les documents.
            </EmptyState>
          ) : (
            <div className="card-body stack">
              {sections.map(([section, fields]) => (
                <details className="section" key={section} open>
                  <summary>
                    {section}
                    <span className="muted" style={{ fontWeight: 400 }}>
                      · {plural(fields.length, 'variable')}
                    </span>
                  </summary>
                  <div className="table-scroll" style={{ marginTop: 8 }} tabIndex={0} role="region" aria-label={`Variables de la section ${section} (défilement horizontal)`}>
                    <table>
                      <thead>
                        <tr>
                          <th>Libellé</th>
                          <th>Clé</th>
                          <th>Type</th>
                          <th>Extraction</th>
                          <th><span className="sr-only">Actions</span></th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field, index) => (
                          <tr key={field.id}>
                            <td>
                              <strong>{field.label}</strong>
                              {field.unit && <span className="muted"> ({field.unit})</span>}
                              {field.required && (
                                <span style={{ color: 'var(--critical)' }} title="Obligatoire">
                                  {' '}
                                  *
                                </span>
                              )}
                              {field.options.length > 0 && (
                                <div className="small muted truncate" style={{ maxWidth: 320 }}>
                                  {field.options.join(' · ')}
                                </div>
                              )}
                            </td>
                            <td className="mono muted">{field.key}</td>
                            <td className="small">{FIELD_TYPE_LABELS[field.type]}</td>
                            <td>
                              {!field.extraction.enabled ? (
                                <span className="badge badge-empty">Manuelle</span>
                              ) : field.extraction.rules.length === 0 ? (
                                <span className="badge badge-warn">Aucune règle</span>
                              ) : (
                                <span className="badge badge-auto">
                                  {plural(field.extraction.rules.length, 'règle')}
                                </span>
                              )}
                            </td>
                            <td>
                              <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                                <button
                                  className="btn-icon btn-sm"
                                  onClick={() => void moveField(field, -1)}
                                  disabled={index === 0}
                                  aria-label={`Monter ${field.label}`}
                                  title="Monter"
                                >
                                  ↑
                                </button>
                                <button
                                  className="btn-icon btn-sm"
                                  onClick={() => void moveField(field, 1)}
                                  disabled={index === fields.length - 1}
                                  aria-label={`Descendre ${field.label}`}
                                  title="Descendre"
                                >
                                  ↓
                                </button>
                                <button className="btn-sm" onClick={() => setEditing({ field })} aria-label={`Modifier la variable ${field.label}`}>
                                  Modifier
                                </button>
                                <ConfirmButton
                                  label="Supprimer"
                                  confirmLabel="Confirmer"
                                  subject={`la variable ${field.label}`}
                                  onConfirm={() => void removeField(field)}
                                />
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </details>
              ))}
            </div>
          )}
        </div>
      )}

      {editing && template && (
        <FieldEditor
          templateId={template.id}
          field={editing.field}
          sections={sectionNames}
          patients={patients}
          takenFieldKeys={template.fields.map((f) => f.key)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void loadTemplate(template.id);
          }}
        />
      )}

      {showNew && (
        <NewTemplateModal
          onClose={() => setShowNew(false)}
          onCreated={async (id) => {
            setShowNew(false);
            setSelectedId(id);
            await load();
          }}
        />
      )}
    </div>
  );
}

function NewTemplateModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (id: number) => void;
}) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (name.trim().length === 0) return;
    setBusy(true);
    try {
      const { template } = await api.createTemplate({
        name: name.trim(),
        description: description.trim() || null,
      });
      toast.success('Fiche créée.');
      onCreated(template.id);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Nouvelle fiche d’exploitation"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button onClick={onClose}>Annuler</button>
          <button className="btn-primary" onClick={submit} disabled={busy || name.trim().length === 0}>
            Créer
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="tpl-name">Nom</label>
        <input
          id="tpl-name"
          type="text"
          value={name}
          autoFocus
          placeholder="Fiche — cancers du sein 2024"
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="tpl-desc">Description</label>
        <textarea
          id="tpl-desc"
          value={description}
          placeholder="Objet de l’étude, critères d’inclusion…"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <p className="small muted">
        La nouvelle fiche est vide. Pour partir de la trame existante, utilisez plutôt
        « Dupliquer ».
      </p>
    </Modal>
  );
}
