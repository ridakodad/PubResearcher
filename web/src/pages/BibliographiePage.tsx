import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { plural } from '../lib/format';
import { EmptyState, ErrorPanel, LoadingPanel, useToast } from '../components/ui';
import { Panel } from '../components/Panel';
import { StatTile } from '../components/charts/StatTile';
import { IconAlert } from '../components/icons';
import { PrismaFlow } from '../components/biblio/PrismaFlow';
import { RefCard, type DecidePatch } from '../components/biblio/RefCard';
import { SearchHistory } from '../components/biblio/SearchHistory';
import { ImportForm } from '../components/biblio/ImportForm';
import {
  SearchForm,
  restoreForm,
  saveDraft,
  toParams,
  validateForm,
  type SearchFormState,
} from '../components/biblio/SearchForm';
import { DECISION_LABELS, SOURCE_LABELS, countOf, fmtCount, shortSource } from '../components/biblio/shared';
import type {
  BiblioDecision,
  BiblioOverview,
  BiblioRef,
  BiblioSearch,
  BiblioSource,
  BiblioStatus,
} from '../lib/types';

/**
 * Revue bibliographique : chercher dans PubMed (et, en option, Google Scholar),
 * importer les exports des autres bases, trier, exporter.
 *
 * PubMed passe par l'API officielle du NCBI, gratuite ; Google Scholar par un
 * acteur Apify facturé, dont le jeton reste côté serveur. Ce que la page garde,
 * c'est de quoi rendre la revue reproductible : chaque passe et chaque import
 * consignent leur équation ou leur fichier, leur date, le nombre total annoncé
 * par la source et ce qui a été récupéré.
 */

type DecisionFilter = BiblioDecision | 'all';
type SourceFilter = BiblioSource | 'both' | 'all';

/** Passes consignées par le serveur quand toutes les sources ont échoué (réponse 502). */
function failedSearches(err: unknown): BiblioSearch[] | null {
  if (!(err instanceof ApiError) || err.code !== 'all_sources_failed') return null;
  const details = err.details as { searches?: unknown } | undefined;
  return Array.isArray(details?.searches) ? (details.searches as BiblioSearch[]) : null;
}
type RefSort = 'added' | 'recent' | 'cited';

/** Suit le temps écoulé d'une passe, pour que l'attente ne ressemble pas à un blocage. */
function useElapsed(active: boolean): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      setSeconds(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return seconds;
}

const messageOf = (err: unknown): string => (err instanceof ApiError ? err.message : String(err));

export function BibliographiePage() {
  const toast = useToast();
  const [status, setStatus] = useState<BiblioStatus | null>(null);
  const [overview, setOverview] = useState<BiblioOverview | null>(null);
  const [refs, setRefs] = useState<{ refs: BiblioRef[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<SearchFormState | null>(null);
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<BiblioSearch[] | null>(null);
  const reportRef = useRef<HTMLDivElement | null>(null);
  const elapsed = useElapsed(running);

  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [sort, setSort] = useState<RefSort>('added');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState('');

  // La saisie du filtre texte attend une pause de frappe avant d'interroger le serveur.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const loadMeta = useCallback(async () => {
    try {
      const [nextStatus, nextOverview] = await Promise.all([api.biblioStatus(), api.biblioOverview()]);
      setStatus(nextStatus);
      setOverview(nextOverview);
      setError(null);
      setForm((current) => current ?? restoreForm(nextStatus));
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  // Une réponse en retard ne doit pas écraser celle d'un filtre plus récent.
  const latestRefsRequest = useRef(0);
  const loadRefs = useCallback(async () => {
    const mine = ++latestRefsRequest.current;
    try {
      const result = await api.biblioRefs({
        ...(decisionFilter !== 'all' ? { decision: decisionFilter } : {}),
        ...(sourceFilter !== 'all' ? { source: sourceFilter } : {}),
        ...(query ? { q: query } : {}),
        sort,
      });
      if (mine === latestRefsRequest.current) setRefs(result);
    } catch (err) {
      if (mine === latestRefsRequest.current) setError(messageOf(err));
    }
  }, [decisionFilter, sourceFilter, query, sort]);

  useEffect(() => {
    if (form) saveDraft(form);
  }, [form]);

  // Le bilan s'affiche sous un formulaire haut : on le ramène dans la vue s'il est plus bas.
  useEffect(() => {
    if (report) reportRef.current?.scrollIntoView({ block: 'nearest' });
  }, [report]);

  useEffect(() => {
    void loadMeta();
  }, [loadMeta]);

  useEffect(() => {
    void loadRefs();
  }, [loadRefs]);

  // Une passe peut tourner côté serveur sans que cette page l'ait lancée (autre
  // fenêtre, retour sur la page en cours de route) : on attend sa fin.
  const serverRunning = status?.running ?? false;
  useEffect(() => {
    if (!serverRunning || running) return;
    const timer = window.setInterval(() => {
      void api
        .biblioStatus()
        .then(async (next) => {
          if (next.running) return;
          await loadMeta();
          await loadRefs();
        })
        .catch(() => undefined);
    }, 3000);
    return () => window.clearInterval(timer);
  }, [serverRunning, running, loadMeta, loadRefs]);

  async function submit() {
    if (!form || !status || validateForm(form, status)) return;
    setRunning(true);
    setReport(null);
    try {
      const result = await api.biblioSearch(toParams(form));
      setReport(result.searches);
      const failed = result.searches.filter((s) => s.status === 'error');
      const added = result.searches.reduce((sum, s) => sum + s.added, 0);
      if (failed.length > 0) {
        // Un échec, même partiel, ne se noie pas dans un message de réussite : le bilan détaille le reste.
        const names = failed.map((s) => SOURCE_LABELS[s.source]).join(' et ');
        toast.error(
          failed.length === result.searches.length
            ? `${names} : ${failed[0]?.error ?? 'la recherche a échoué.'}`
            : `${names} a échoué — voir le bilan sous le formulaire.`,
        );
      } else {
        toast.success(
          `${countOf(added, 'nouvelle référence', 'nouvelles références')} ${added > 1 ? 'ajoutées' : 'ajoutée'}.`,
        );
      }
    } catch (err) {
      // Toutes les sources ont échoué : le bilan détaille chacune, les passes restent dans l'historique.
      const failed = failedSearches(err);
      if (failed) setReport(failed);
      toast.error(messageOf(err));
    } finally {
      setRunning(false);
      await Promise.all([loadMeta(), loadRefs()]);
    }
  }

  async function importFile(file: File, source: BiblioSource, label: string): Promise<boolean> {
    setImporting(true);
    try {
      const result = await api.biblioImport(file, source, label || undefined);
      setReport([result.search]);
      const s = result.search;
      toast.success(
        `${file.name} : ${countOf(s.returned, 'notice')} lue${s.returned > 1 ? 's' : ''}, ${countOf(s.added, 'nouvelle référence', 'nouvelles références')}, ${countOf(s.duplicates, 'doublon')}.`,
      );
      return true;
    } catch (err) {
      toast.error(messageOf(err));
      return false;
    } finally {
      setImporting(false);
      await Promise.all([loadMeta(), loadRefs()]);
    }
  }

  const decide = useCallback(
    async (id: number, patch: DecidePatch): Promise<boolean> => {
      try {
        const result = await api.biblioDecide(id, patch);
        setRefs((current) =>
          current
            ? { ...current, refs: current.refs.map((r) => (r.id === id ? result.ref : r)) }
            : current,
        );
        setOverview((current) =>
          current ? { ...current, counts: result.counts, prisma: result.prisma } : current,
        );
        return true;
      } catch (err) {
        toast.error(messageOf(err));
        return false;
      }
    },
    [toast],
  );

  function reuse(search: BiblioSearch) {
    if (!status) return;
    setForm((current) =>
      current && {
        ...current,
        query: search.query,
        yearFrom: search.yearFrom === null ? '' : String(search.yearFrom),
        yearTo: search.yearTo === null ? '' : String(search.yearTo),
        // Reprendre une passe réussie garde les sources cochées ; relancer une passe en
        // échec ne vise que sa source, sans repayer l'autre.
        sources:
          search.status === 'error' && (search.source === 'pubmed' || search.source === 'scholar') && status.sources[search.source].available
            ? [search.source]
            : current.sources,
        sort: search.sort,
        ...(search.source === 'scholar' ? { maxResults: Math.min(Math.max(search.maxResults, 1), status.maxResults) } : {}),
        ...(search.source === 'pubmed'
          ? { pubmedAll: search.maxResults === 0, ...(search.maxResults > 0 ? { pubmedMax: search.maxResults } : {}) }
          : {}),
      },
    );
    const target = document.getElementById('biblio-form');
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    target?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
    target?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true });
  }

  if (error && !status) return <ErrorPanel message={error} onRetry={() => void loadMeta()} />;
  if (!status || !overview || !form) return <LoadingPanel />;

  const { counts, prisma, searches } = overview;
  const filtered = decisionFilter !== 'all' || sourceFilter !== 'all' || query !== '';
  const inProgress = running || serverRunning;
  /** Sources présentes dans la bibliothèque, de la plus fournie à la moins fournie. */
  const presentSources = (Object.entries(counts.bySource) as [BiblioSource, number][])
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);

  const decisionChips: [DecisionFilter, string][] = [
    ['all', `Toutes (${counts.total})`],
    ['pending', `${DECISION_LABELS.pending} (${counts.pending})`],
    ['include', `${DECISION_LABELS.include.replace('Retenue', 'Retenues')} (${counts.include})`],
    ['maybe', `${DECISION_LABELS.maybe} (${counts.maybe})`],
    ['exclude', `${DECISION_LABELS.exclude.replace('Exclue', 'Exclues')} (${counts.exclude})`],
  ];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Littérature</div>
          <h1>Revue bibliographique</h1>
          <p className="sub">
            Interrogez PubMed — gratuitement, par l’API officielle du NCBI —, importez les exports
            d’Embase, de CENTRAL, de Scopus ou de toute autre base, regroupez les doublons, puis triez
            chaque référence : retenue, à voir, ou exclue. Chaque recherche et chaque import gardent leur
            équation ou leur fichier, leur date et leurs effectifs — c’est ce qui rend la revue
            reproductible.
          </p>
        </div>
      </div>

      {serverRunning && !running && (
        <div className="notice notice-info">
          <div>
            <strong>Une recherche est en cours côté serveur</strong> (lancée depuis une autre fenêtre ou
            avant votre retour sur la page). Cette page se met à jour dès qu’elle se termine.
          </div>
        </div>
      )}

      <div className="grid grid-5">
        <StatTile
          label="Références"
          value={counts.total}
          hint={
            counts.total === 0
              ? 'aucune recherche encore'
              : `${presentSources
                  .slice(0, 3)
                  .map(([source, n]) => `${shortSource(source)} ${fmtCount(n)}`)
                  .join(' · ')}${counts.multiSource > 0 ? ` · ${fmtCount(counts.multiSource)} dans plusieurs` : ''}`
          }
        />
        <StatTile label="À trier" value={counts.pending} accent={counts.pending > 0} hint="pas encore lues" />
        <StatTile label="Retenues" value={counts.include} hint="à lire en texte intégral" />
        <StatTile label="À voir" value={counts.maybe} hint="mises de côté" />
        <StatTile label="Exclues" value={counts.exclude} hint="motif facultatif à ce stade" />
      </div>

      <section className="card" id="biblio-form">
        <div className="card-head">
          <h2 style={{ fontSize: '1.05rem' }}>Nouvelle recherche</h2>
          <span className="sub">
            {form.sources.length === 0
              ? 'aucune source choisie'
              : form.sources.map((s) => SOURCE_LABELS[s]).join(' + ')}
          </span>
        </div>
        <div className="card-body">
          <SearchForm
            status={status}
            form={form}
            onChange={setForm}
            onSubmit={() => void submit()}
            running={inProgress}
            elapsed={elapsed}
          />
        </div>
      </section>

      <Panel
        id="biblio.import"
        title="Importer des références (RIS, nbib, BibTeX, CSV)"
        summary="Embase, CENTRAL, Scopus, Web of Science, LiSSa, Zotero…"
        defaultOpen={false}
      >
        <ImportForm status={status} busy={importing} onImport={importFile} />
      </Panel>

      {report && (
        <div ref={reportRef}>
          <RunReport searches={report} />
        </div>
      )}

      <Panel
        id="biblio.refs"
        title="Références"
        summary={
          counts.total === 0
            ? 'aucune pour l’instant'
            : `${plural(counts.total, 'référence')} · ${counts.pending} à trier`
        }
      >
        {counts.total === 0 ? (
          <EmptyState title="Aucune référence pour l’instant">
            Lancez une première recherche ci-dessus, ou importez l’export d’une autre base : les
            références s’ajoutent à la bibliothèque, sans doublon.
          </EmptyState>
        ) : (
          <div className="stack" style={{ gap: 14 }}>
            <div className="row" style={{ gap: 4 }} role="group" aria-label="Filtrer par décision">
              {decisionChips.map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  className={decisionFilter === key ? 'btn-primary btn-sm' : 'btn-sm btn-quiet'}
                  aria-pressed={decisionFilter === key}
                  onClick={() => setDecisionFilter(key)}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="row" style={{ gap: 8 }}>
              <input
                type="search"
                value={queryInput}
                placeholder="Chercher dans le titre, les auteurs, la revue, le DOI…"
                aria-label="Chercher dans la bibliothèque"
                style={{ flex: 1, minWidth: 220 }}
                onChange={(event) => setQueryInput(event.target.value)}
              />
              <select
                value={sourceFilter}
                aria-label="Filtrer par source"
                style={{ width: 'auto' }}
                onChange={(event) => setSourceFilter(event.target.value as SourceFilter)}
              >
                <option value="all">Toutes les sources</option>
                {presentSources.map(([s, n]) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]} ({fmtCount(n)})
                  </option>
                ))}
                <option value="both">Trouvées par plusieurs sources ({fmtCount(counts.multiSource)})</option>
              </select>
              <select
                value={sort}
                aria-label="Trier la liste"
                style={{ width: 'auto' }}
                onChange={(event) => setSort(event.target.value as RefSort)}
              >
                <option value="added">Ordre d’ajout</option>
                <option value="recent">Plus récentes</option>
                <option value="cited">Plus citées</option>
              </select>
            </div>

            {refs === null ? (
              <LoadingPanel />
            ) : refs.refs.length === 0 ? (
              <EmptyState title="Rien à afficher">
                Aucune référence ne correspond à ce filtre.
              </EmptyState>
            ) : (
              <>
                <div className="small muted" aria-live="polite">
                  {filtered
                    ? `${plural(refs.total, 'référence')} sur ${counts.total}`
                    : plural(refs.total, 'référence')}
                  {refs.total > refs.refs.length &&
                    ` — les ${refs.refs.length} premières sont affichées, affinez le filtre`}
                </div>
                <div className="stack" style={{ gap: 12 }}>
                  {refs.refs.map((item) => (
                    <RefCard
                      key={item.id}
                      item={item}
                      reasons={status.exclusionReasons}
                      onDecide={decide}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}
      </Panel>

      {/* La clé fait repartir le panneau quand son contenu apparaît : replié tant que la bibliothèque
          est vide, il s'ouvre à la première recherche. Un choix déjà fait par l'utilisateur, mémorisé,
          l'emporte sur ce réglage par défaut. */}
      <Panel
        key={counts.total > 0 ? 'flux-rempli' : 'flux-vide'}
        id="biblio.prisma"
        title="Diagramme de flux"
        summary={`${fmtCount(prisma.identified)} identifiées → ${fmtCount(prisma.included)} retenues`}
        defaultOpen={counts.total > 0}
      >
        {counts.total === 0 && searches.length === 0 ? (
          <div className="small muted">
            Le diagramme se calcule des recherches, des imports et des décisions de tri : il apparaît
            dès la première passe.
          </div>
        ) : (
          <PrismaFlow prisma={prisma} reasons={status.exclusionReasons} />
        )}
      </Panel>

      <Panel
        key={searches.length > 0 ? 'strategies-remplies' : 'strategies-vides'}
        id="biblio.history"
        title="Journal de recherche"
        summary={searches.length === 0 ? 'aucune passe' : `${plural(searches.length, 'passe')} et imports`}
        defaultOpen={searches.length > 0}
        padded={false}
      >
        {searches.length === 0 ? (
          <div className="panel-body small muted">
            Chaque passe, réussie ou non, et chaque import seront consignés ici : date, source, équation
            et sa traduction par PubMed, ou fichier importé, nombre total annoncé et notices récupérées.
          </div>
        ) : (
          <SearchHistory searches={searches} onReuse={reuse} />
        )}
      </Panel>

      <Panel
        id="biblio.export"
        title="Exports"
        summary="RIS · BibTeX · CSV"
      >
        <ExportPanel counts={counts} hasSearches={searches.length > 0} />
      </Panel>
    </div>
  );
}

/** Bilan de la passe (ou de l'import) qui vient de se terminer, source par source. */
function RunReport({ searches }: { searches: BiblioSearch[] }) {
  return (
    <div className="stack" style={{ gap: 8 }} aria-live="polite">
      {searches.map((search) => {
        const failed = search.status === 'error';
        const imported = search.kind === 'import';
        const name = `${SOURCE_LABELS[search.source]}${search.sourceLabel ? ` (${search.sourceLabel})` : ''}`;
        return (
          <div key={search.id} className={failed ? 'notice notice-error' : 'notice notice-info'}>
            {failed && <IconAlert size={18} />}
            <div style={{ flex: 1 }}>
              <strong>{imported ? `Import ${name}` : name}</strong>
              {failed ? (
                <> — {search.error}</>
              ) : (
                <>
                  {' '}
                  —{' '}
                  {search.totalCount !== null
                    ? `${fmtCount(search.totalCount)} résultat${search.totalCount > 1 ? 's' : ''} annoncé${search.totalCount > 1 ? 's' : ''}, ${fmtCount(search.returned)} récupéré${search.returned > 1 ? 's' : ''}`
                    : imported
                      ? `${countOf(search.returned, 'notice')} lue${search.returned > 1 ? 's' : ''} dans ${search.fileName ?? 'le fichier'}`
                      : `${countOf(search.returned, 'référence')} ${search.returned > 1 ? 'rendues' : 'rendue'}`}{' '}
                  · {countOf(search.added, 'nouvelle')} · {countOf(search.duplicates, 'déjà connue')}
                  {search.skipped > 0 &&
                    ` · ${countOf(search.skipped, 'notice inexploitable', 'notices inexploitables')} écartée${search.skipped > 1 ? 's' : ''}`}
                </>
              )}
              {failed && search.totalCount !== null && (
                <div className="small secondary" style={{ marginTop: 4 }}>
                  Nombre total annoncé par PubMed : {fmtCount(search.totalCount)} — consigné dans le journal de recherche.
                </div>
              )}
              {search.warnings.map((warning) => (
                <div key={warning} className="small secondary" style={{ marginTop: 4 }}>
                  {warning}
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ExportPanel({
  counts,
  hasSearches,
}: {
  counts: BiblioOverview['counts'];
  hasSearches: boolean;
}) {
  const [scope, setScope] = useState<DecisionFilter>('all');
  const available = scope === 'all' ? counts.total : counts[scope];
  const decision = scope === 'all' ? undefined : scope;

  const link = (format: 'ris' | 'bibtex' | 'csv', title: string, detail: string) =>
    available > 0 ? (
      <a className="btn export-link" href={api.biblioExportUrl(format, decision)} download>
        <span>{title}</span>
        <span className="small muted">{detail}</span>
      </a>
    ) : (
      <button type="button" className="export-link" disabled>
        <span>{title}</span>
        <span className="small muted">{detail}</span>
      </button>
    );

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="field" style={{ marginBottom: 0, maxWidth: 320 }}>
        <label htmlFor="biblio-export-scope">Références à exporter</label>
        <select
          id="biblio-export-scope"
          value={scope}
          onChange={(event) => setScope(event.target.value as DecisionFilter)}
        >
          <option value="all">Toutes ({counts.total})</option>
          <option value="include">Retenues ({counts.include})</option>
          <option value="maybe">À voir ({counts.maybe})</option>
          <option value="exclude">Exclues ({counts.exclude})</option>
          <option value="pending">À trier ({counts.pending})</option>
        </select>
      </div>

      <div className="row" style={{ gap: 8 }}>
        {link('ris', 'RIS', 'Zotero, EndNote, Mendeley')}
        {link('bibtex', 'BibTeX', 'LaTeX, Overleaf')}
        {link('csv', 'CSV', 'Excel (séparateur « ; »)')}
      </div>

      <div className="row" style={{ gap: 8 }}>
        {hasSearches ? (
          <a className="btn export-link" href={api.biblioExportUrl('searches')} download>
            <span>Journal de recherche (PRISMA-S)</span>
            <span className="small muted">CSV : équations, traductions, dates, totaux, imports</span>
          </a>
        ) : (
          <button type="button" className="export-link" disabled>
            <span>Journal de recherche (PRISMA-S)</span>
            <span className="small muted">aucune passe consignée</span>
          </button>
        )}
      </div>

      <div className="field-hint">
        Le fichier d’une référence fusionnée reprend le résumé et les auteurs de PubMed, et le nombre
        de citations de Scholar. Le RIS porte le type de chaque référence (article, communication,
        livre, chapitre…) et son PMCID ; la décision de tri, le motif d’exclusion et la note sont
        consignés dans le champ de note du RIS et dans les colonnes du CSV.
      </div>
    </div>
  );
}
