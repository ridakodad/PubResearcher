import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ErrorPanel, LoadingPanel, Modal, useToast } from '../components/ui';
import { api, currentProjectId, switchProject, type ProjectSummary } from '../lib/api';

/**
 * Projets de recherche.
 *
 * Une étude = un projet. Chaque projet a sa propre base : dossiers patients, fiche d'exploitation, extraction,
 * résultats, bibliographie et rédaction ne passent jamais de l'un à l'autre. On peut reprendre la fiche d'un projet
 * existant pour en démarrer un nouveau (une étude de suivi, une seconde cohorte).
 */
export function ProjetsPage() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(params.get('nouveau') === '1');
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const current = currentProjectId();

  const load = useCallback(() => {
    setError(null);
    api.listProjects().then(setProjects, (e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  useEffect(() => {
    if (params.get('nouveau') === '1') setCreating(true);
  }, [params]);

  const closeCreate = () => {
    setCreating(false);
    if (params.has('nouveau')) setParams({}, { replace: true });
  };

  if (error) return <ErrorPanel message={error} onRetry={load} />;
  if (!projects) return <LoadingPanel />;

  return (
    <div className="projects-page">
      <div className="page-head">
        <div>
          <h1>Projets de recherche</h1>
          <p className="sub">
            Une étude par projet. Chaque projet garde ses propres dossiers patients, sa fiche d’exploitation, ses
            résultats, sa bibliographie et sa rédaction : rien ne passe de l’un à l’autre.
          </p>
        </div>
        <div className="page-head-actions">
          <button className="btn-primary" onClick={() => setCreating(true)}>
            Nouveau projet
          </button>
        </div>
      </div>

      <ul className="project-cards" aria-label="Projets">
        {projects.map((p) => {
          const isCurrent = p.id === current;
          return (
            <li key={p.id} className={isCurrent ? 'card project-card is-current' : 'card project-card'}>
              <div className="card-body">
                <div className="project-card-head">
                  <h2 className="project-card-title">{p.name}</h2>
                  {isCurrent && <span className="badge badge-auto">Ouvert</span>}
                </div>
                {p.description && <p className="project-card-desc">{p.description}</p>}
                {p.stats && (
                  <dl className="project-card-stats">
                    <div>
                      <dt>Dossiers</dt>
                      <dd>{p.stats.patients}</dd>
                    </div>
                    <div>
                      <dt>Documents</dt>
                      <dd>{p.stats.documents}</dd>
                    </div>
                    <div>
                      <dt>Références</dt>
                      <dd>{p.stats.references}</dd>
                    </div>
                  </dl>
                )}
                <p className="small muted">
                  {p.stats?.template ? `Fiche : ${p.stats.template} · ` : ''}créé le{' '}
                  {new Date(p.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
                <div className="project-card-actions">
                  {isCurrent ? (
                    <button disabled>Projet ouvert</button>
                  ) : (
                    <button className="btn-primary" onClick={() => switchProject(p.id)}>
                      Ouvrir
                    </button>
                  )}
                  <button className="btn-quiet" onClick={() => setRenaming(p)}>
                    Renommer
                  </button>
                  {!p.isMain && (
                    <button className="btn-quiet project-delete" onClick={() => setDeleting(p)}>
                      Supprimer
                    </button>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {creating && <CreateProjectModal projects={projects} onClose={closeCreate} />}
      {renaming && (
        <RenameProjectModal
          project={renaming}
          onClose={() => setRenaming(null)}
          onDone={() => {
            setRenaming(null);
            load();
          }}
        />
      )}
      {deleting && (
        <DeleteProjectModal
          project={deleting}
          onClose={() => setDeleting(null)}
          onDone={() => {
            setDeleting(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function CreateProjectModal({ projects, onClose }: { projects: ProjectSummary[]; onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = await api.createProject({ name, description: description || null, copyTemplateFrom: copyFrom || null });
      switchProject(created.id);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Nouveau projet de recherche"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Annuler</button>
          <button className="btn-primary" onClick={submit} disabled={busy || name.trim().length === 0}>
            {busy ? 'Création…' : 'Créer et ouvrir'}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void submit();
        }}
      >
        <div className="field">
          <label htmlFor="project-name">Nom de l’étude</label>
          <input
            id="project-name"
            type="text"
            value={name}
            autoFocus
            maxLength={120}
            placeholder="Pneumopathies communautaires 2020–2024"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="project-desc">Description (facultatif)</label>
          <textarea
            id="project-desc"
            value={description}
            maxLength={2000}
            placeholder="Service, période, question de recherche, investigateur…"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="project-copy">Fiche d’exploitation de départ</label>
          <select id="project-copy" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
            <option value="">Fiche générale par défaut</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                Reprendre la fiche de « {p.name} »{p.stats?.template ? ` (${p.stats.template})` : ''}
              </option>
            ))}
          </select>
          <p className="small muted">
            Seule la fiche est reprise (variables et règles) : le nouveau projet démarre sans dossier ni référence.
          </p>
        </div>
        {error && (
          <p className="notice notice-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Modal>
  );
}

function RenameProjectModal({ project, onClose, onDone }: { project: ProjectSummary; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const submit = async () => {
    setBusy(true);
    try {
      await api.updateProject(project.id, { name, description: description || null });
      toast.success('Projet mis à jour.');
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Renommer le projet"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Annuler</button>
          <button className="btn-primary" onClick={submit} disabled={busy || name.trim().length === 0}>
            Enregistrer
          </button>
        </>
      }
    >
      <div className="field">
        <label htmlFor="project-rename">Nom</label>
        <input id="project-rename" type="text" value={name} autoFocus maxLength={120} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="project-redesc">Description</label>
        <textarea id="project-redesc" value={description} maxLength={2000} onChange={(e) => setDescription(e.target.value)} />
      </div>
    </Modal>
  );
}

function DeleteProjectModal({ project, onClose, onDone }: { project: ProjectSummary; onClose: () => void; onDone: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const isCurrent = project.id === currentProjectId();

  const submit = async () => {
    setBusy(true);
    try {
      await api.deleteProject(project.id, typed);
      if (isCurrent) {
        switchProject('principal');
        return;
      }
      toast.success(`Projet « ${project.name} » supprimé.`);
      onDone();
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Supprimer le projet"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Annuler</button>
          <button className="btn-danger" onClick={submit} disabled={busy || typed.trim() !== project.name}>
            Supprimer définitivement
          </button>
        </>
      }
    >
      <p>
        Tout le contenu de « <strong>{project.name}</strong> » sera effacé de cet ordinateur :{' '}
        {project.stats?.patients ?? 0} dossier(s), {project.stats?.documents ?? 0} document(s),{' '}
        {project.stats?.references ?? 0} référence(s), la fiche et les résultats. Il n’y a pas de corbeille.
      </p>
      <p className="small muted">Faites d’abord une sauvegarde si vous pourriez en avoir besoin.</p>
      <div className="field">
        <label htmlFor="project-confirm">Recopiez le nom du projet pour confirmer</label>
        <input id="project-confirm" type="text" value={typed} autoFocus autoComplete="off" onChange={(e) => setTyped(e.target.value)} />
      </div>
    </Modal>
  );
}
