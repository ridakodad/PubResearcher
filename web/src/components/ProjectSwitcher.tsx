import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, currentProjectId, switchProject, type ProjectSummary } from '../lib/api';
import { IconCheck, IconChevron, IconFolders } from './icons';

/**
 * Sélecteur de projet, dans la barre du haut : le nom de l'étude ouverte, toujours visible, et un menu pour passer
 * à une autre. Chaque projet a ses propres dossiers, fiche, extraction, bibliographie et rédaction.
 */
export function ProjectSwitcher() {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const current = currentProjectId();

  useEffect(() => {
    api.listProjects().then(setProjects, () => setProjects([]));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = projects?.find((p) => p.id === current);
  const name = active?.name ?? (projects ? 'Étude principale' : '…');

  useEffect(() => {
    if (active) document.documentElement.dataset.project = active.name;
  }, [active]);

  return (
    <div className="project-switcher" ref={root}>
      <button
        className="project-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Changer de projet de recherche"
      >
        <IconFolders size={16} />
        <span className="project-button-text">
          <span className="project-eyebrow">Projet</span>
          <span className="project-name">{name}</span>
        </span>
        <IconChevron size={14} />
      </button>
      {open && (
        <div className="project-menu" role="menu" aria-label="Projets de recherche">
          {(projects ?? []).map((p) => (
            <button
              key={p.id}
              role="menuitemradio"
              aria-checked={p.id === current}
              className="project-menu-item"
              onClick={() => (p.id === current ? setOpen(false) : switchProject(p.id))}
            >
              <span className="project-menu-check" aria-hidden="true">
                {p.id === current && <IconCheck size={14} />}
              </span>
              <span className="project-menu-text">
                <span className="project-menu-name">{p.name}</span>
                {p.stats && (
                  <span className="project-menu-meta">
                    {p.stats.patients} dossier{p.stats.patients > 1 ? 's' : ''} · {p.stats.references} référence
                    {p.stats.references > 1 ? 's' : ''}
                  </span>
                )}
              </span>
            </button>
          ))}
          <div className="project-menu-sep" role="separator" />
          <Link role="menuitem" className="project-menu-item project-menu-link" to="/projets?nouveau=1" onClick={() => setOpen(false)}>
            + Nouveau projet
          </Link>
          <Link role="menuitem" className="project-menu-item project-menu-link" to="/projets" onClick={() => setOpen(false)}>
            Gérer les projets
          </Link>
        </div>
      )}
    </div>
  );
}
