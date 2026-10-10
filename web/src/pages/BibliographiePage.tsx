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
import {
  SOURCES,
  SearchForm,
  restoreForm,
  saveDraft,
  toParams,
  validateForm,
  type SearchFormState,
} from '../components/biblio/SearchForm';
import { DECISION_LABELS, SOURCE_LABELS } from '../components/biblio/shared';
import type {
  BiblioDecision,
  BiblioOverview,
  BiblioRef,
  BiblioSearch,
  BiblioSource,
  BiblioStatus,
} from '../lib/types';

/**
 * Revue bibliographique : chercher dans PubMed et Google Scholar, trier, exporter.
 *
 * Les interrogations passent par des acteurs Apify, facturés au résultat. Le
 * jeton reste côté serveur ; cette page ne le voit jamais. Ce qu'elle garde, en
 * revanche, c'est de quoi rendre la revue reproductible : chaque passe consigne
 * sa chaîne exacte, sa date, l'acteur interrogé et ses effectifs.
 */

type DecisionFilter = BiblioDecision | 'all';
type SourceFilter = BiblioSource | 'both' | 'all';
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
          `${plural(added, 'nouvelle référence', 'nouvelles références')} ${added > 1 ? 'ajoutées' : 'ajoutée'}.`,
        );
      }
    } catch (err) {
      toast.error(messageOf(err));
    } finally {
      setRunning(false);
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
          search.status === 'error' && status.sources[search.source].supported
            ? [search.source]
            : current.sources,
        sort: search.sort,
        maxResults: Math.min(search.maxResults, status.maxResults),
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
            Interrogez PubMed et Google Scholar par des acteurs Apify, regroupez les doublons, puis
            triez chaque référence : retenue, à voir, ou exclue avec son motif. Chaque recherche garde
            sa chaîne exacte et sa date — c’est ce qui rend la revue reproductible.
          </p>
        </div>
      </div>

      {!status.configured && (
        <div className="notice notice-warn">
          <IconAlert size={18} />
          <div>
            <strong>Apify n’est pas configuré.</strong> Les recherches passent par des acteurs Apify,
            facturés à l’usage. Créez un jeton dans la console Apify (Settings → API &amp;
            integrations), renseignez-le dans <span className="mono">APIFY_TOKEN</span> dans
            l’environnement du serveur, puis redémarrez. Le jeton reste côté serveur : il n’apparaît
            jamais dans cette interface. En attendant, la bibliothèque, le tri et les exports restent
            utilisables.
          </div>
        </div>
      )}

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
              : `PubMed ${counts.bySource.pubmed} · Scholar ${counts.bySource.scholar}${
                  counts.bySource.both > 0 ? ` · ${counts.bySource.both} dans les deux` : ''
                }`
          }
        />
        <StatTile label="À trier" value={counts.pending} accent={counts.pending > 0} hint="pas encore lues" />
        <StatTile label="Retenues" value={counts.include} hint="à lire en texte intégral" />
        <StatTile label="À voir" value={counts.maybe} hint="mises de côté" />
        <StatTile label="Exclues" value={counts.exclude} hint="avec leur motif" />
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
            Lancez une première recherche ci-dessus : les références de PubMed et de Google Scholar
            s’ajoutent à la bibliothèque, sans doublon.
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
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABELS[s]}
                  </option>
                ))}
                <option value="both">Trouvées par les deux</option>
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
        summary={`${prisma.identified} identifiées → ${prisma.included} retenues`}
        defaultOpen={counts.total > 0}
      >
        {counts.total === 0 && searches.length === 0 ? (
          <div className="small muted">
            Le diagramme se calcule des recherches et des décisions de tri : il apparaît dès la
            première passe.
          </div>
        ) : (
          <PrismaFlow prisma={prisma} reasons={status.exclusionReasons} />
        )}
      </Panel>

      <Panel
        key={searches.length > 0 ? 'strategies-remplies' : 'strategies-vides'}
        id="biblio.history"
        title="Stratégies de recherche"
        summary={searches.length === 0 ? 'aucune passe' : plural(searches.length, 'passe')}
        defaultOpen={searches.length > 0}
        padded={false}
      >
        {searches.length === 0 ? (
          <div className="panel-body small muted">
            Chaque passe, réussie ou non, sera consignée ici avec sa date, l’acteur Apify interrogé et
            ses effectifs.
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

/** Bilan de la passe qui vient de se terminer, source par source. */
function RunReport({ searches }: { searches: BiblioSearch[] }) {
  return (
    <div className="stack" style={{ gap: 8 }} aria-live="polite">
      {searches.map((search) => {
        const failed = search.status === 'error';
        // Le plan gratuit d'Apify limite l'acteur PubMed à 10 résultats par passe :
        // un compte rond de 10 pour une demande plus large a presque toujours cette cause.
        const freePlanCap =
          !failed && search.source === 'pubmed' && search.returned === 10 && search.maxResults > 10;
        return (
          <div key={search.id} className={failed ? 'notice notice-error' : 'notice notice-info'}>
            {failed && <IconAlert size={18} />}
            <div style={{ flex: 1 }}>
              <strong>{SOURCE_LABELS[search.source]}</strong>
              {failed ? (
                <> — {search.error}</>
              ) : (
                <>
                  {' '}
                  — {plural(search.returned, 'référence')} {search.returned > 1 ? 'rendues' : 'rendue'} ·{' '}
                  {plural(search.added, 'nouvelle')} ·{' '}
                  {plural(search.duplicates, 'déjà connue')}
                  {search.skipped > 0 && ` · ${plural(search.skipped, 'ligne inexploitable', 'lignes inexploitables')} écartée${search.skipped > 1 ? 's' : ''}`}
                </>
              )}
              {freePlanCap && (
                <div className="small secondary" style={{ marginTop: 4 }}>
                  Dix résultats sur {search.maxResults} demandés : avec un plan Apify gratuit, l’acteur
                  PubMed plafonne à 10 résultats par passe.
                </div>
              )}
              {!failed && !freePlanCap && search.returned < search.maxResults && (
                <div className="small secondary" style={{ marginTop: 4 }}>
                  Moins que les {search.maxResults} demandés : la requête n’a peut-être pas davantage de
                  résultats.
                </div>
              )}
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
            <span>Stratégies de recherche</span>
            <span className="small muted">CSV : équations, dates, acteurs, effectifs</span>
          </a>
        ) : (
          <button type="button" className="export-link" disabled>
            <span>Stratégies de recherche</span>
            <span className="small muted">aucune passe consignée</span>
          </button>
        )}
      </div>

      <div className="field-hint">
        Le fichier d’une référence fusionnée reprend le résumé de PubMed et le nombre de citations de
        Scholar. La décision de tri, le motif d’exclusion et la note sont consignés dans le champ de
        note du RIS et dans les colonnes du CSV.
      </div>
    </div>
  );
}
