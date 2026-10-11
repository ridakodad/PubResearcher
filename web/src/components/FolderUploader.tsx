import { useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { formatBytes, plural } from '../lib/format';
import { detectStructure, groupItems, type Layout } from '../lib/grouping';
import { useToast } from './ui';
import { AnonymisationGate } from './AnonymisationGate';
import { IconAlert } from './icons';
import type { UploadOutcome } from '../lib/types';

interface PickedFile {
  file: File;
  /** Chemin relatif au dossier déposé, ex. « PAT-001/scanner/coupe1.dcm ». */
  path: string;
}

interface Group {
  /** Code du dossier patient, déduit du premier segment du chemin. */
  code: string;
  files: PickedFile[];
}

interface GroupResult {
  code: string;
  imported: number;
  duplicates: number;
  errors: number;
  failures: UploadOutcome[];
  /** Importés, mais lus en partie (texte tronqué, pages non lues) : le texte dont les règles disposent est incomplet. */
  warnings: UploadOutcome[];
}

/**
 * Import de dossiers patients.
 *
 * Un dossier déposé = un patient : le premier niveau de l'arborescence donne
 * le code du dossier, ce qui permet de déverser d'un coup l'ensemble d'une
 * série. Les fichiers déposés seuls sont regroupés sous un code à saisir.
 */
export function FolderUploader(props: UploaderProps) {
  // La charte d'anonymisation se confirme avant que l'on puisse choisir un fichier ; l'état de l'import
  // (fichiers choisis, résultats) n'existe qu'une fois l'engagement pris.
  return (
    <AnonymisationGate>
      <FolderUploaderBody {...props} />
    </AnonymisationGate>
  );
}

interface UploaderProps {
  onDone: () => void;
  /** Impose un dossier de destination (import depuis la fiche d'un patient). */
  fixedPatient?: { id: number; code: string };
}

function FolderUploaderBody({ onDone, fixedPatient }: UploaderProps) {
  const toast = useToast();
  const [picked, setPicked] = useState<PickedFile[]>([]);
  const [looseCode, setLooseCode] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [results, setResults] = useState<GroupResult[] | null>(null);

  const fileInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);

  /** Lecture choisie quand un seul dossier contenant des sous-dossiers a été déposé (voir `lib/grouping.ts`). */
  const [layout, setLayout] = useState<Layout>('cohort');
  const structure = useMemo(() => (fixedPatient ? null : detectStructure(picked)), [picked, fixedPatient]);

  const groups = useMemo<Group[]>(() => {
    if (fixedPatient) {
      return picked.length > 0 ? [{ code: fixedPatient.code, files: picked }] : [];
    }
    return groupItems(picked, structure, layout);
  }, [picked, fixedPatient, structure, layout]);

  const looseGroup = groups.find((g) => g.code === '');
  const totalBytes = picked.reduce((sum, p) => sum + p.file.size, 0);

  function addFiles(files: PickedFile[]) {
    setResults(null);
    setPicked((current) => {
      const seen = new Set(current.map((c) => `${c.path}:${c.file.size}`));
      const fresh = files.filter((f) => !seen.has(`${f.path}:${f.file.size}`));
      return [...current, ...fresh];
    });
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const items = [...e.dataTransfer.items];
    const entries = items
      .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry() : null))
      .filter((entry): entry is FileSystemEntry => entry !== null);

    if (entries.length > 0) {
      const collected: PickedFile[] = [];
      for (const entry of entries) await walkEntry(entry, '', collected);
      addFiles(collected);
      return;
    }
    // Repli si l'API d'arborescence n'est pas disponible.
    addFiles([...e.dataTransfer.files].map((file) => ({ file, path: file.name })));
  }

  async function upload() {
    if (groups.length === 0) return;
    if (!fixedPatient && looseGroup && looseCode.trim().length === 0) {
      toast.error('Indiquez un code de dossier pour les fichiers déposés hors dossier.');
      return;
    }

    setBusy(true);
    setResults(null);
    setProgress({ done: 0, total: groups.length });
    const collected: GroupResult[] = [];

    try {
      for (const group of groups) {
        const code = group.code === '' ? looseCode.trim() : group.code;
        let imported = 0;
        let duplicates = 0;
        let errors = 0;
        const failures: UploadOutcome[] = [];
        const warnings: UploadOutcome[] = [];
        try {
          const patientId = fixedPatient
            ? fixedPatient.id
            : (await api.ensurePatient(code)).patient.id;

          // Les fichiers partent par lots : un dossier d'imagerie peut compter
          // plusieurs centaines de coupes.
          const batches = chunk(group.files, 25);

          const send = async (files: PickedFile[]): Promise<void> => {
            const response = await api.uploadDocuments(
              patientId,
              files.map((b) => b.file),
            );
            imported += response.summary.imported;
            duplicates += response.summary.duplicates;
            errors += response.summary.errors;
            failures.push(...response.results.filter((r) => r.status === 'error'));
            warnings.push(...response.results.filter((r) => r.status === 'imported' && r.message));
          };

          for (const batch of batches) {
            try {
              await send(batch);
            } catch (err) {
              // Un lot refusé en bloc par le serveur (un fichier au-delà de la limite fait refuser tout l'envoi) :
              // ses fichiers repartent un par un, pour que seul le fautif échoue et que les autres soient importés.
              // Une panne de réseau ou du serveur, elle, arrête ce dossier (inutile d'insister fichier par fichier).
              const refused = err instanceof ApiError && (err.status === 413 || err.status === 400);
              if (!refused) throw err;
              for (const one of batch) {
                try {
                  await send([one]);
                } catch (alone) {
                  if (!(alone instanceof ApiError && alone.status < 500)) throw alone;
                  errors += 1;
                  failures.push({ filename: one.path, status: 'error', message: alone.message });
                }
              }
            }
          }

          collected.push({ code, imported, duplicates, errors, failures, warnings });
        } catch (err) {
          // Panne de réseau ou du serveur en cours de route : ce qui est déjà parti reste compté, le reste est signalé.
          const unsent = Math.max(0, group.files.length - imported - duplicates - errors);
          collected.push({
            code,
            imported,
            duplicates,
            errors: errors + unsent,
            warnings,
            failures: [
              ...failures,
              {
                filename: `${unsent} fichier(s) non envoyé(s)`,
                status: 'error',
                message: err instanceof ApiError ? err.message : String(err),
              },
            ],
          });
        }
        setProgress((p) => (p ? { ...p, done: p.done + 1 } : null));
      }

      const imported = collected.reduce((s, r) => s + r.imported, 0);
      const errors = collected.reduce((s, r) => s + r.errors, 0);
      setResults(collected);
      setPicked([]);
      setLooseCode('');

      if (imported > 0) {
        toast.success(
          `${plural(imported, 'document importé', 'documents importés')} dans ${plural(collected.length, 'dossier')}.`,
        );
      }
      if (errors > 0) toast.error(`${plural(errors, 'fichier non analysé', 'fichiers non analysés')}.`);
      onDone();
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="stack">
      <div
        className={`dropzone${dragOver ? ' over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <div style={{ fontSize: '1.6rem', marginBottom: 6 }} aria-hidden="true">
          ⬒
        </div>
        <p>
          <strong>{fixedPatient ? 'Glissez ici les fichiers du dossier' : 'Glissez ici les dossiers patients'}</strong>
          <br />
          {fixedPatient ? (
            <span className="small">
              Les fichiers seront ajoutés au dossier {fixedPatient.code}.
            </span>
          ) : (
            <span className="small">
              Un dossier par patient — son nom devient le code du dossier. Pour toute une cohorte,
              déposez le dossier qui contient les dossiers patients.
            </span>
          )}
        </p>
        <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
          <button className="btn-sm" onClick={() => folderInput.current?.click()}>
            Choisir un dossier…
          </button>
          <button className="btn-sm" onClick={() => fileInput.current?.click()}>
            Choisir des fichiers…
          </button>
        </div>
        <div className="small muted" style={{ marginTop: 10 }}>
          Formats acceptés : PDF, Word (.docx), images (JPEG, PNG, TIFF) et DICOM.
        </div>

        <input
          ref={folderInput}
          type="file"
          multiple
          hidden
          // Attributs non standard : sélection d'une arborescence complète.
          {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
          onChange={(e) => {
            const files = [...(e.target.files ?? [])].map((file) => ({
              file,
              path: file.webkitRelativePath || file.name,
            }));
            addFiles(files);
            e.target.value = '';
          }}
        />
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])].map((file) => ({ file, path: file.name })));
            e.target.value = '';
          }}
        />
      </div>

      {picked.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>À importer</h3>
            <span className="sub">
              {plural(picked.length, 'fichier')} · {formatBytes(totalBytes)} ·{' '}
              {plural(groups.length, 'dossier')}
            </span>
            <div className="card-actions">
              <button className="btn-sm" onClick={() => setPicked([])} disabled={busy}>
                Vider
              </button>
              <button className="btn-sm btn-primary" onClick={upload} disabled={busy}>
                {busy ? 'Import en cours…' : 'Importer'}
              </button>
            </div>
          </div>
          <div className="card-body">
            {progress && (
              <div className="small secondary" style={{ marginBottom: 12 }}>
                Dossier {progress.done} sur {progress.total} — l’analyse des documents a lieu à
                l’import, elle peut prendre un instant.
              </div>
            )}
            {structure && (
              <fieldset className="layout-choice">
                <legend>
                  « {structure.root} » contient {structure.subfolders.length} sous-dossiers : que représentent-ils ?
                </legend>
                <label className="radio">
                  <input
                    type="radio"
                    name="layout"
                    checked={layout === 'cohort'}
                    onChange={() => setLayout('cohort')}
                    disabled={busy}
                  />
                  <span>
                    <strong>Chaque sous-dossier est un patient</strong> — {structure.subfolders.length} dossiers patients
                    ({structure.subfolders.slice(0, 4).join(', ')}
                    {structure.subfolders.length > 4 ? ', …' : ''})
                  </span>
                </label>
                <label className="radio">
                  <input
                    type="radio"
                    name="layout"
                    checked={layout === 'single'}
                    onChange={() => setLayout('single')}
                    disabled={busy}
                  />
                  <span>
                    <strong>« {structure.root} » est un seul patient</strong> — tous les fichiers, sous-dossiers compris,
                    vont dans le même dossier
                  </span>
                </label>
                {layout === 'single' && (
                  <div className="notice notice-warn">
                    <IconAlert size={18} />
                    <div>
                      Les documents de {structure.subfolders.length} sous-dossiers seront rassemblés dans{' '}
                      <strong>un seul</strong> dossier patient. Si ce sont des patients différents, leurs données seront mêlées.
                    </div>
                  </div>
                )}
              </fieldset>
            )}
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Dossiers et fichiers à importer (défilement horizontal)">
              <table>
                <thead>
                  <tr>
                    <th>Dossier</th>
                    <th className="num">Fichiers</th>
                    <th>Aperçu</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((group) => (
                    <tr key={group.code || '__racine__'}>
                      <td>
                        {group.code === '' ? (
                          <div>
                            <input
                              type="text"
                              value={looseCode}
                              placeholder="Code du dossier…"
                              onChange={(e) => setLooseCode(e.target.value)}
                              style={{ maxWidth: 220 }}
                              aria-label="Code du dossier pour les fichiers hors dossier"
                            />
                            <div className="field-hint">Fichiers déposés hors dossier</div>
                          </div>
                        ) : (
                          <strong>{group.code}</strong>
                        )}
                      </td>
                      <td className="num">{group.files.length}</td>
                      <td className="small muted truncate" style={{ maxWidth: 380 }}>
                        {group.files
                          .slice(0, 3)
                          .map((f) => f.file.name)
                          .join(', ')}
                        {group.files.length > 3 ? ` … +${group.files.length - 3}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {results && results.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h3>Résultat de l’import</h3>
          </div>
          <div className="card-body stack">
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Résultat de l’import (défilement horizontal)">
              <table>
                <thead>
                  <tr>
                    <th>Dossier</th>
                    <th className="num">Importés</th>
                    <th className="num">Doublons</th>
                    <th className="num">Échecs</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.code}>
                      <td>
                        <strong>{r.code}</strong>
                      </td>
                      <td className="num">{r.imported}</td>
                      <td className="num">{r.duplicates || '—'}</td>
                      <td className="num">{r.errors || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {results.some((r) => r.warnings.length > 0) && (
              <div className="notice notice-warn">
                <IconAlert size={18} />
                <div>
                  <strong>Importés, mais lus en partie</strong>
                  <p className="small" style={{ margin: '4px 0 0' }}>
                    Le texte dont les règles disposent est incomplet : les valeurs situées dans la partie non lue ne seront pas trouvées.
                  </p>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }} className="small">
                    {results
                      .flatMap((r) => r.warnings.map((w) => ({ ...w, code: r.code })))
                      .slice(0, 8)
                      .map((w, i) => (
                        <li key={i}>
                          {w.code} / {w.filename} — {w.message}
                        </li>
                      ))}
                  </ul>
                </div>
              </div>
            )}
            {results.some((r) => r.failures.length > 0) && (
              <div className="notice notice-warn">
                <IconAlert size={18} />
                <div>
                  <strong>Fichiers non analysés</strong>
                  <ul style={{ margin: '6px 0 0', paddingLeft: 18 }} className="small">
                    {results
                      .flatMap((r) => r.failures.map((f) => ({ ...f, code: r.code })))
                      .slice(0, 8)
                      .map((f, i) => (
                        <li key={i}>
                          {f.code} / {f.filename} — {f.message ?? 'erreur inconnue'}
                        </li>
                      ))}
                  </ul>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Parcourt récursivement une entrée déposée pour en extraire les fichiers. */
async function walkEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: PickedFile[],
): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      (entry as FileSystemFileEntry).file(resolve, () => resolve(null));
    });
    // Les fichiers système (.DS_Store, Thumbs.db) ne sont pas des documents.
    if (file && !file.name.startsWith('.')) {
      out.push({ file, path: `${prefix}${entry.name}` });
    }
    return;
  }

  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader();
    // `readEntries` ne renvoie qu'un lot à la fois : il faut boucler.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve) => {
        reader.readEntries(resolve, () => resolve([]));
      });
      if (batch.length === 0) break;
      for (const child of batch) {
        await walkEntry(child, `${prefix}${entry.name}/`, out);
      }
    }
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
