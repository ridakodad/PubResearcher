import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { plural } from '../lib/format';
import { EmptyState, ErrorPanel, LoadingPanel, useToast } from '../components/ui';
import { Panel } from '../components/Panel';
import { StatTile } from '../components/charts/StatTile';
import { FunnelChart } from '../components/charts/FunnelChart';
import { IconAlert } from '../components/icons';
import { PrismaFlow } from '../components/biblio/PrismaFlow';
import { RefCard, type DecidePatch } from '../components/biblio/RefCard';
import { SearchHistory } from '../components/biblio/SearchHistory';
import { ImportForm } from '../components/biblio/ImportForm';
import { VeillePubdaily } from '../components/biblio/VeillePubdaily';
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
  BiblioAssistantSearchParams,
  BiblioStrategy,
  BiblioStrategyConcept,
  BiblioStudyType,
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

/** Mode de saisie retenu (question ou équation experte), mémorisé sur ce poste. */
const MODE_KEY = 'pubresearcher.biblio.searchMode';

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
  const [searchMode, setSearchMode] = useState<'nl' | 'expert' | 'pubdaily'>(() => {
    try {
      const v = window.localStorage.getItem(MODE_KEY);
      return v === 'expert' || v === 'pubdaily' ? v : 'nl';
    } catch {
      return 'nl';
    }
  });
  const chooseMode = (mode: 'nl' | 'expert' | 'pubdaily') => {
    setSearchMode(mode);
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* stockage indisponible : le choix vaut pour la visite */
    }
  };

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

  /**
   * Lance la passe. Depuis l'assistant, `fromQuestion` porte l'équation validée, la question et la stratégie :
   * le journal de recherche les consigne (PRISMA-S : comment la stratégie a été élaborée).
   */
  async function submit(fromQuestion?: { equation: string; question: string; strategy: BiblioStrategy }) {
    if (!form || !status) return;
    const effective = fromQuestion ? { ...form, query: fromQuestion.equation } : form;
    if (validateForm(effective, status)) {
      if (fromQuestion) toast.error(validateForm(effective, status) ?? 'Recherche impossible.');
      return;
    }
    setRunning(true);
    setReport(null);
    try {
      const params = toParams(effective);
      const body: BiblioAssistantSearchParams = fromQuestion
        ? { ...params, question: fromQuestion.question, strategy: fromQuestion.strategy }
        : params;
      const result = await api.biblioSearch(body);
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
    // Reprendre une passe, c'est reprendre son équation : elle se relit dans le formulaire expert.
    chooseMode('expert');
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

      {counts.total > 0 && (
        <section className="card">
          <div className="card-head">
            <h2 style={{ fontSize: '1.05rem' }}>Flux de sélection</h2>
            <span className="sub">De l’identification à l’inclusion, au fil du tri : chaque étape garde une part de la précédente.</span>
          </div>
          <div className="card-body">
            <FunnelChart
              label="Flux de sélection des références"
              stages={[
                { id: 'identifiees', label: 'Identifiées', value: counts.total, hint: 'Références uniques, doublons fusionnés.' },
                { id: 'triees', label: 'Triées', value: counts.total - counts.pending, hint: 'Titre et résumé lus.' },
                { id: 'gardees', label: 'Retenues ou à voir', value: counts.include + counts.maybe, hint: 'Non exclues à ce stade.' },
                { id: 'retenues', label: 'Retenues', value: counts.include, hint: 'À lire en texte intégral.' },
              ]}
            />
          </div>
        </section>
      )}

      <section className="card" id="biblio-form">
        <div className="card-head">
          <h2 style={{ fontSize: '1.05rem' }}>Nouvelle recherche</h2>
          <span className="sub">
            {form.sources.length === 0
              ? 'aucune source choisie'
              : form.sources.map((s) => SOURCE_LABELS[s]).join(' + ')}
          </span>
        </div>
        <div className="card-body stack">
          <div className="seg" role="group" aria-label="Mode de saisie de la recherche">
            <button type="button" className={searchMode === 'nl' ? 'is-on' : ''} aria-pressed={searchMode === 'nl'} onClick={() => chooseMode('nl')}>
              Question en langage naturel
            </button>
            <button type="button" className={searchMode === 'expert' ? 'is-on' : ''} aria-pressed={searchMode === 'expert'} onClick={() => chooseMode('expert')}>
              Équation experte
            </button>
            <button type="button" className={searchMode === 'pubdaily' ? 'is-on' : ''} aria-pressed={searchMode === 'pubdaily'} onClick={() => chooseMode('pubdaily')}>
              Veille PubDaily
            </button>
          </div>
          {searchMode === 'pubdaily' ? (
            <VeillePubdaily />
          ) : searchMode === 'nl' ? (
            <NaturalSearch
              form={form}
              onYears={(yearFrom, yearTo) => setForm((current) => current && { ...current, yearFrom, yearTo })}
              running={inProgress}
              elapsed={elapsed}
              onLaunch={(launch) => void submit(launch)}
              onEditAsExpert={(equation) => {
                setForm((current) => current && { ...current, query: equation });
                chooseMode('expert');
              }}
            />
          ) : (
            <SearchForm
              status={status}
              form={form}
              onChange={setForm}
              onSubmit={() => void submit()}
              running={inProgress}
              elapsed={elapsed}
            />
          )}
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

/* ─────────────────────── Recherche en langage naturel ─────────────────────── */

const STUDY_TYPE_CHOICES: [BiblioStudyType, string][] = [
  ['rct', 'Essais randomisés'],
  ['systematic_review', 'Revues systématiques'],
  ['observational', 'Études observationnelles'],
  ['diagnostic', 'Études diagnostiques'],
];

/* Mise en forme PubMed, la même que côté serveur (`biblio/query-builder.ts`) : un terme retouché ici donne le bloc
 * que le serveur aurait produit. */
const cleanTerm = (raw: string): string =>
  raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/["“”«»()]/g, ' ')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
const meshTag = (t: string) => `"${cleanTerm(t)}"[Mesh]`;
const tiabTag = (t: string) => {
  const c = cleanTerm(t);
  return /[\s-]/.test(c) ? `"${c}"[tiab]` : `${c}[tiab]`;
};
function conceptBlock(mesh: string[], freeText: string[]): string {
  const parts = [
    ...new Set([...mesh.map(cleanTerm).filter(Boolean).map(meshTag), ...freeText.map(cleanTerm).filter(Boolean).map(tiabTag)]),
  ];
  if (parts.length === 0) return '';
  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
}

const parseYearInput = (raw: string): number | undefined => {
  const n = Number(raw.trim());
  return raw.trim() && Number.isInteger(n) ? n : undefined;
};

const ROLE_LABELS: Record<BiblioStrategyConcept['role'], string> = {
  population: 'Population',
  intervention: 'Intervention',
  comparison: 'Comparateur',
  outcome: 'Critère de jugement',
  other: 'Autre notion',
};

const countLabel = (n: number | null | undefined) => (n === null || n === undefined ? '—' : fmtCount(n));

/** Une liste de termes en puces : chacune se retire, un champ en ajoute. */
function TermChips({
  label,
  terms,
  kind,
  onChange,
}: {
  label: string;
  terms: string[];
  kind: 'mesh' | 'tiab';
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const t = cleanTerm(draft);
    if (t && !terms.includes(t)) onChange([...terms, t]);
    setDraft('');
  };
  return (
    <div className="nl-chips" role="group" aria-label={label}>
      <span className="nl-chips-label small secondary">{label}</span>
      {terms.map((t) => (
        <span key={t} className={`nl-chip nl-chip-${kind}`}>
          <span className="mono">{t}</span>
          <button type="button" className="nl-chip-remove" aria-label={`Retirer « ${t} »`} onClick={() => onChange(terms.filter((x) => x !== t))}>
            ×
          </button>
        </span>
      ))}
      <input
        className="nl-chip-input"
        value={draft}
        placeholder={kind === 'mesh' ? '+ descripteur MeSH' : '+ synonyme'}
        aria-label={`Ajouter : ${label}`}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={() => draft.trim() && add()}
      />
    </div>
  );
}

/**
 * La question en langage naturel : l'assistant la découpe (PICO), propose les blocs de termes et l'équation,
 * vérifiées sur les nombres PubMed ; l'utilisateur retouche, recompte, puis lance — c'est sa validation.
 */
function NaturalSearch({
  form,
  onYears,
  running,
  elapsed,
  onLaunch,
  onEditAsExpert,
}: {
  form: SearchFormState;
  onYears: (yearFrom: string, yearTo: string) => void;
  running: boolean;
  elapsed: number;
  onLaunch: (launch: { equation: string; question: string; strategy: BiblioStrategy }) => void;
  onEditAsExpert: (equation: string) => void;
}) {
  const toast = useToast();
  const questionId = useId();
  const equationId = useId();
  const fromId = useId();
  const toId = useId();
  const [question, setQuestion] = useState('');
  const [studyTypes, setStudyTypes] = useState<BiblioStudyType[]>([]);
  const [building, setBuilding] = useState(false);
  const [counting, setCounting] = useState(false);
  const [strategy, setStrategy] = useState<BiblioStrategy | null>(null);
  const [concepts, setConcepts] = useState<BiblioStrategyConcept[]>([]);
  /** Les filtres de type d'étude, tels que le serveur les a ajoutés en fin d'équation. */
  const [filterTail, setFilterTail] = useState<string[]>([]);
  const [equation, setEquation] = useState('');
  const [counts, setCounts] = useState<BiblioStrategy['counts'] | null>(null);
  const [countWarnings, setCountWarnings] = useState<string[]>([]);
  const [stale, setStale] = useState(false);

  const years = { yearFrom: parseYearInput(form.yearFrom), yearTo: parseYearInput(form.yearTo) };

  async function build() {
    if (question.trim().length < 5 || building) return;
    setBuilding(true);
    try {
      const result = await api.biblioAssistantBuild({
        question: question.trim(),
        ...(studyTypes.length ? { studyTypes } : {}),
        ...(years.yearFrom !== undefined ? { yearFrom: years.yearFrom } : {}),
        ...(years.yearTo !== undefined ? { yearTo: years.yearTo } : {}),
      });
      setStrategy(result);
      setConcepts(result.concepts);
      // Ni les blocs ni les filtres ne contiennent « AND » : ce qui suit les blocs, ce sont les filtres.
      setFilterTail(result.equation ? result.equation.split(' AND ').slice(result.concepts.length) : []);
      setEquation(result.equation);
      setCounts(result.counts);
      setCountWarnings([]);
      setStale(false);
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setBuilding(false);
    }
  }

  function editConcept(index: number, patch: Partial<Pick<BiblioStrategyConcept, 'mesh' | 'freeText'>>) {
    const next = concepts.map((c, i) => {
      if (i !== index) return c;
      const merged = { ...c, ...patch };
      return { ...merged, block: conceptBlock(merged.mesh, merged.freeText) };
    });
    setConcepts(next);
    setEquation([...next.map((c) => c.block).filter(Boolean), ...filterTail].join(' AND '));
    setStale(true);
  }

  function removeConcept(index: number) {
    const next = concepts.filter((_, i) => i !== index);
    setConcepts(next);
    setEquation([...next.map((c) => c.block).filter(Boolean), ...filterTail].join(' AND '));
    setStale(true);
  }

  async function recount() {
    if (!equation.trim() || counting) return;
    setCounting(true);
    try {
      const result = await api.biblioAssistantCount({
        equation: equation.trim(),
        blocks: concepts.filter((c) => c.block).map((c) => ({ name: c.name, block: c.block })),
        ...(years.yearFrom !== undefined ? { yearFrom: years.yearFrom } : {}),
        ...(years.yearTo !== undefined ? { yearTo: years.yearTo } : {}),
      });
      setCounts({ total: result.total, perConcept: result.perConcept });
      setCountWarnings(result.warnings);
      setStale(false);
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setCounting(false);
    }
  }

  function launch() {
    if (!strategy || !equation.trim()) return;
    onLaunch({
      equation: equation.trim(),
      question: strategy.question,
      // La stratégie consignée est celle que l'utilisateur a validée : ses retouches comprises.
      strategy: { ...strategy, concepts, equation: equation.trim(), counts: counts ?? strategy.counts },
    });
  }

  const perConcept = new Map((counts?.perConcept ?? []).map((c) => [c.name, c.count]));
  const pico = strategy?.pico;

  return (
    <div className="stack nl-search">
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={questionId}>Décrivez votre question de recherche</label>
        <textarea
          id={questionId}
          className="nl-question"
          rows={4}
          maxLength={2000}
          value={question}
          placeholder="par exemple : Chez l’adulte avec une pneumopathie communautaire, une antibiothérapie courte (≤ 5 jours) est-elle aussi efficace qu’une antibiothérapie longue ? Essais randomisés."
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void build();
            }
          }}
        />
        <div className="field-hint">
          En français ou en anglais. L’assistant découpe la question en concepts (PICO), traduit les termes en anglais,
          associe descripteurs MeSH et synonymes, puis vérifie l’équation sur les nombres de résultats PubMed. Vous la
          relisez avant de lancer la recherche.
        </div>
      </div>

      <div className="nl-options">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={fromId}>De l’année</label>
          <input id={fromId} inputMode="numeric" value={form.yearFrom} placeholder="ex. 2010" onChange={(e) => onYears(e.target.value, form.yearTo)} />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={toId}>À l’année</label>
          <input id={toId} inputMode="numeric" value={form.yearTo} placeholder="ex. 2026" onChange={(e) => onYears(form.yearFrom, e.target.value)} />
        </div>
        <fieldset className="nl-types">
          <legend>Types d’études (filtre validé)</legend>
          {STUDY_TYPE_CHOICES.map(([key, label]) => (
            <label key={key} className="checkbox">
              <input
                type="checkbox"
                checked={studyTypes.includes(key)}
                onChange={() => setStudyTypes((cur) => (cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key]))}
              />
              <span>{label}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <div className="row">
        <button type="button" className="btn-primary" disabled={question.trim().length < 5 || building} onClick={() => void build()}>
          {building ? 'Construction et vérification…' : 'Construire la stratégie'}
        </button>
        {building && <span className="small secondary">Les nombres sont demandés à PubMed, à son rythme (3 requêtes par seconde sans clé).</span>}
      </div>

      {strategy && (
        <div className="nl-result stack" aria-live="polite">
          <div className="row" style={{ gap: 8 }}>
            {strategy.method === 'llm' ? (
              <span className="badge badge-llm">Modèle : {strategy.model ?? 'inconnu'}</span>
            ) : (
              <span className="badge badge-warn">Règles, sans modèle de langage</span>
            )}
            {strategy.filters.map((f) => (
              <span key={f} className="badge badge-type">
                Filtre : {f}
              </span>
            ))}
            <span className="badge">
              PubMed : <strong className="tabular">{countLabel(counts?.total)}</strong>&nbsp;article{counts?.total === 1 ? '' : 's'}
              {stale ? ' (à recalculer)' : ''}
            </span>
          </div>

          {[...strategy.warnings, ...countWarnings].length > 0 && (
            <div className="notice notice-warn">
              <ul className="nl-warnings">
                {[...strategy.warnings, ...countWarnings].map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {pico && (
            <dl className="nl-pico">
              {(
                [
                  ['P', 'Population', pico.population],
                  ['I', 'Intervention', pico.intervention],
                  ['C', 'Comparateur', pico.comparison],
                  ['O', 'Critère de jugement', pico.outcome],
                  ['S', 'Type d’étude', pico.studyDesign],
                ] as const
              ).map(([k, label, value]) => (
                <div key={k}>
                  <dt>
                    <span className="nl-pico-key">{k}</span> {label}
                  </dt>
                  <dd>{value || <span className="muted">—</span>}</dd>
                </div>
              ))}
            </dl>
          )}

          <div className="stack nl-concepts">
            {concepts.map((c, i) => (
              <div key={`${c.name}-${i}`} className="nl-concept">
                <div className="nl-concept-head">
                  <strong>{c.name}</strong>
                  <span className="small secondary">{ROLE_LABELS[c.role]}</span>
                  <span className="spacer" />
                  <span className="small tabular">{countLabel(perConcept.get(c.name))} articles</span>
                  <button type="button" className="btn-sm btn-quiet" onClick={() => removeConcept(i)}>
                    Retirer le concept
                  </button>
                </div>
                <TermChips label="MeSH" kind="mesh" terms={c.mesh} onChange={(mesh) => editConcept(i, { mesh })} />
                <TermChips label="Texte libre [tiab]" kind="tiab" terms={c.freeText} onChange={(freeText) => editConcept(i, { freeText })} />
              </div>
            ))}
          </div>

          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={equationId}>Équation PubMed (modifiable)</label>
            <textarea
              id={equationId}
              className="mono"
              rows={5}
              maxLength={4000}
              value={equation}
              onChange={(e) => {
                setEquation(e.target.value);
                setStale(true);
              }}
            />
            <div className="field-hint">
              Les années ne figurent pas dans l’équation : elles sont transmises à PubMed à part et consignées au journal.
              Retoucher une puce reconstruit l’équation à partir des blocs.
            </div>
          </div>

          {strategy.rationale && (
            <p className="small secondary nl-rationale">
              <strong>Pourquoi cette équation :</strong> {strategy.rationale}
            </p>
          )}

          <div className="row">
            <button type="button" disabled={counting || !equation.trim()} onClick={() => void recount()}>
              {counting ? 'Comptage…' : 'Recalculer le nombre'}
            </button>
            <button type="button" className="btn-primary" disabled={running || !equation.trim()} onClick={launch}>
              {running ? `Recherche en cours… ${elapsed} s` : 'Lancer la recherche'}
            </button>
            <button type="button" className="btn-quiet" onClick={() => onEditAsExpert(equation)}>
              Ouvrir dans l’équation experte
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
