import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ThemeToggle } from './components/ui';
import { Brand } from './components/Brand';
import {
  IconBook,
  IconChart,
  IconExport,
  IconExtract,
  IconFolders,
  IconForm,
  IconGauge,
  IconSidebar,
  IconWrite,
  IconTable,
  IconWorkspace,
} from './components/icons';
import { WorkspaceProvider, useWorkspace } from './lib/workspace';
import { readSetting, writeSetting } from './lib/storage';
import { BibliographiePage } from './pages/BibliographiePage';
import { DossiersPage } from './pages/DossiersPage';
import { DossierDetailPage } from './pages/DossierDetailPage';
import { FichePage } from './pages/FichePage';
import { ExtractionPage } from './pages/ExtractionPage';
import { RedactionPage } from './pages/RedactionPage';
import { ResultatsPage } from './pages/ResultatsPage';
import { WorkspacePage } from './pages/WorkspacePage';

/**
 * Coquille de l'espace de travail.
 *
 * L'application n'est pas un formulaire à parcourir du début à la fin : c'est
 * un atelier où le chercheur prend l'outil dont il a besoin. Le rail de gauche
 * les présente tous en permanence, groupés par nature du travail — constituer
 * le corpus, régler les instruments, lire les résultats, sortir les données.
 * L'extraction n'est qu'un de ces outils.
 */

interface Tool {
  to: string;
  label: string;
  /**
   * Libellé court de la barre du bas (écrans étroits). Chaque libellé court est contenu dans le libellé complet,
   * lu par les lecteurs d'écran : le nom accessible contient toujours ce que l'œil lit (WCAG 2.5.3).
   */
  short: string;
  icon: typeof IconWorkspace;
  /** Chiffre-clé, quand il en existe un qui aide à décider où aller. */
  count?: number | null;
  /** Le lien reste actif sur les routes filles (détail d'un dossier). */
  matchPrefix?: string;
}

function ToolRail({ collapsed }: { collapsed: boolean }) {
  const { patients, fields, completeness, loading } = useWorkspace();
  const { pathname, search, hash } = useLocation();
  const nav = useRef<HTMLElement>(null);

  // Sur écran étroit le rail est une barre flottante qui défile : l'outil courant doit y rester en vue.
  useEffect(() => {
    if (!window.matchMedia('(max-width: 1000px)').matches) return;
    nav.current?.querySelector<HTMLElement>('.rail-item.active')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [pathname, search, hash]);

  const groups: { label: string; tools: Tool[] }[] = [
    {
      label: 'Corpus',
      tools: [
        {
          to: '/dossiers',
          label: 'Dossiers patients',
          short: 'Dossiers',
          icon: IconFolders,
          count: loading ? null : patients,
          matchPrefix: '/dossiers',
        },
      ],
    },
    {
      label: 'Littérature',
      tools: [
        {
          to: '/bibliographie',
          label: 'Revue bibliographique',
          short: 'Revue',
          icon: IconBook,
          matchPrefix: '/bibliographie',
        },
      ],
    },
    {
      label: 'Instruments',
      tools: [
        {
          to: '/fiche',
          label: "Fiche d’exploitation",
          short: 'Fiche',
          icon: IconForm,
          count: loading ? null : fields,
          matchPrefix: '/fiche',
        },
        { to: '/extraction', label: 'Extraction', short: 'Extraction', icon: IconExtract, matchPrefix: '/extraction' },
        { to: '/redaction', label: 'Rédaction', short: 'Rédaction', icon: IconWrite, matchPrefix: '/redaction' },
      ],
    },
    {
      label: 'Analyse',
      tools: [
        { to: '/resultats?vue=table', label: 'Tableau de données', short: 'Tableau', icon: IconTable },
        { to: '/resultats?vue=charts', label: 'Distributions', short: 'Distributions', icon: IconChart },
        {
          to: '/resultats?vue=completeness',
          label: 'Complétude',
          short: 'Complétude',
          icon: IconGauge,
          count: loading ? null : completeness,
        },
      ],
    },
    {
      label: 'Sortie',
      tools: [{ to: '/resultats?vue=export', label: 'Export', short: 'Export', icon: IconExport }],
    },
  ];

  /**
   * Un seul outil est mis en avant à la fois. Plusieurs entrées visent la même
   * route en variant l'ancre ou la vue : la comparaison porte donc sur le
   * chemin, la vue et l'ancre pris ensemble, sinon deux entrées voisines
   * s'allumeraient en même temps.
   */
  const isActive = (tool: Tool): boolean => {
    const [target, targetHash] = tool.to.split('#');
    const [targetPath, targetQuery] = (target ?? '').split('?');

    if (targetHash) return pathname === targetPath && hash === `#${targetHash}`;
    if (tool.matchPrefix) return pathname.startsWith(tool.matchPrefix) && hash === '';
    if (targetQuery) {
      // `/resultats` sans paramètre affiche le tableau : la première entrée de
      // la famille reste donc allumée sur l'URL nue.
      const effective = search === '' ? '?vue=table' : search;
      return pathname === targetPath && effective === `?${targetQuery}`;
    }
    return pathname === targetPath;
  };

  return (
    <nav
      ref={nav}
      className={collapsed ? 'rail rail-collapsed' : 'rail'}
      aria-label="Outils de l’espace de recherche"
    >
      <div className="rail-group">
        <NavLink
          to="/"
          end
          className={({ isActive: active }) => (active ? 'rail-item active' : 'rail-item')}
          title={collapsed ? 'Plan de travail' : undefined}
        >
          <IconWorkspace />
          <span className="rail-text">
            <span className="rail-long">Plan de travail</span>
            <span className="rail-short" aria-hidden="true">
              Plan
            </span>
          </span>
        </NavLink>
      </div>

      {groups.map((group) => (
        <div className="rail-group" key={group.label}>
          <div className="rail-label">{group.label}</div>
          {group.tools.map((tool) => {
            const Icon = tool.icon;
            const active = isActive(tool);
            return (
              <NavLink
                key={tool.to}
                to={tool.to}
                /* Forme fonction imposée : avec une chaîne, NavLink ajoute sa
                   propre classe « active », calculée sur le seul chemin. Les
                   quatre vues de résultats partagent le même chemin et
                   s'allumeraient donc toutes en même temps. */
                className={() => (active ? 'rail-item active' : 'rail-item')}
                aria-current={active ? 'page' : undefined}
                title={collapsed ? tool.label : undefined}
              >
                <Icon />
                <span className="rail-text">
                  <span className="rail-long">{tool.label}</span>
                  <span className="rail-short" aria-hidden="true">
                    {tool.short}
                  </span>
                </span>
                {tool.count != null && (
                  <span className="rail-count">
                    {tool.label === 'Complétude' ? `${tool.count} %` : tool.count}
                  </span>
                )}
              </NavLink>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** Titre de l'onglet pour chaque outil. La page d'un dossier précise le sien (code du dossier). */
const TITLES: [prefix: string, title: string][] = [
  ['/dossiers', 'Dossiers patients'],
  ['/bibliographie', 'Revue bibliographique'],
  ['/fiche', "Fiche d’exploitation"],
  ['/extraction', 'Extraction'],
  ['/redaction', 'Rédaction assistée'],
  ['/resultats', 'Résultats'],
];

const RESULT_VIEWS: Record<string, string> = {
  table: 'Tableau de données',
  charts: 'Distributions',
  completeness: 'Complétude',
  quality: 'Fiabilité',
  export: 'Export',
};

/**
 * Un onglet par outil, nommé : avec dix onglets ouverts sur dix dossiers, un titre identique partout
 * rend l'historique, les favoris et les lecteurs d'écran inutilisables.
 */
function useRouteTitle(pathname: string, search: string): string {
  let page = 'Plan de travail';
  for (const [prefix, title] of TITLES) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) page = title;
  }
  if (pathname === '/resultats') {
    const view = new URLSearchParams(search).get('vue') ?? 'table';
    page = `${RESULT_VIEWS[view] ?? 'Résultats'} — Résultats`;
  }
  useEffect(() => {
    document.title = `${page} · PubResearcher`;
  }, [page]);
  return page;
}

export function App() {
  const location = useLocation();
  // Le repli du rail est un réglage de poste de travail : il suit
  // l'utilisateur d'une session à l'autre.
  const [collapsed, setCollapsed] = useState(() => readSetting('rail:collapsed') === '1');

  const toggleRail = () => {
    setCollapsed((current) => {
      writeSetting('rail:collapsed', current ? '0' : '1');
      return !current;
    });
  };

  const page = useRouteTitle(location.pathname, location.search);

  // Dans une application à page unique, changer d'outil ne recharge rien : un lecteur d'écran n'entend
  // rien. Le nom du nouvel écran est annoncé (pas au chargement initial, que le navigateur annonce déjà).
  const [announcement, setAnnouncement] = useState('');
  const firstPage = useRef(true);
  useEffect(() => {
    if (firstPage.current) {
      firstPage.current = false;
      return;
    }
    setAnnouncement(page);
  }, [page, location.pathname]);

  return (
    <WorkspaceProvider>
      <div className={collapsed ? 'app rail-is-collapsed' : 'app'}>
        <a className="skip-link" href="#plan-de-travail">
          Aller au contenu
        </a>
        <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>

        <header className="topbar">
          <button
            className="btn-icon btn-quiet"
            onClick={toggleRail}
            aria-label={collapsed ? "Déployer le rail d’outils" : "Replier le rail d’outils"}
            title={collapsed ? 'Déployer les outils' : 'Replier les outils'}
            aria-expanded={!collapsed}
          >
            <IconSidebar size={18} />
          </button>
          <Brand />
          <div className="topbar-end">
            <ThemeToggle />
          </div>
        </header>

        <div className="shell">
          <ToolRail collapsed={collapsed} />

          <main className="canvas" id="plan-de-travail" tabIndex={-1}>
            {/* La clé de route rejoue l'animation d'entrée : le changement
                d'outil se voit, sans que rien ne bouge pendant la lecture. */}
            <div className="view" key={location.pathname}>
              <Routes>
                <Route path="/" element={<WorkspacePage />} />
                <Route path="/dossiers" element={<DossiersPage />} />
                <Route path="/bibliographie" element={<BibliographiePage />} />
                <Route path="/dossiers/:id" element={<DossierDetailPage />} />
                <Route path="/fiche" element={<FichePage />} />
                <Route path="/extraction" element={<ExtractionPage />} />
                <Route path="/redaction" element={<RedactionPage />} />
                <Route path="/resultats" element={<ResultatsPage />} />
                <Route path="/index.html" element={<Navigate to="/" replace />} />
                <Route
                  path="*"
                  element={
                    <div className="empty-state">
                      <h1>Page introuvable</h1>
                      <p>Le lien demandé ne correspond à aucun outil de l’espace de travail.</p>
                      <Link className="btn btn-primary btn-sm" to="/">
                        Retour au plan de travail
                      </Link>
                    </div>
                  }
                />
              </Routes>
            </div>
          </main>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
