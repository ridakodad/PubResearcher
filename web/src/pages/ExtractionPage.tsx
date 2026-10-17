import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDateTime, formatUsd, modelLabel, plural } from '../lib/format';
import { EmptyState, ErrorPanel, LoadingPanel, Pager, Spinner, clampPage, useToast } from '../components/ui';
import { Panel, PanelGroupControls } from '../components/Panel';
import { StatTile } from '../components/charts/StatTile';
import { IconAlert, IconDocument, IconInfo } from '../components/icons';
import { ApiKeyPanel } from '../components/ApiKeyPanel';
import type {
  Capabilities,
  CostEstimate,
  ExtractionMode,
  ExtractionOverview,
  ExtractionRow,
  ExtractionRunResult,
} from '../lib/types';

/**
 * Extraction : lancer la passe, et voir ce qu'elle a produit.
 *
 * Un taux de complétude dit *combien* manque, jamais *pourquoi*. Cette page
 * répond à la seconde question en attribuant chaque valeur au fichier qui l'a
 * justifiée : un compte rendu dont aucune règle n'accroche le vocabulaire, un
 * scan sans couche texte, un dossier resté vide se voient immédiatement. Le
 * paramétrage se corrige à partir de là.
 */

/** Bilans par dossier affichés à la fois : un panneau par dossier, 2 000 dossiers font 54 000 nœuds. */
const PAGE_SIZE = 50;

export function ExtractionPage() {
  const toast = useToast();
  const [overview, setOverview] = useState<ExtractionOverview | null>(null);
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<ExtractionRunResult | null>(null);
  const [mode, setMode] = useState<ExtractionMode>('rules');
  /** Fourchette de coût d'une passe par Claude sur tous les dossiers (`null` : pas encore calculée, ou sans objet). */
  const [estimate, setEstimate] = useState<CostEstimate | null>(null);
  /** Filtre de lecture : on cherche d'abord ce qui n'a rien donné. */
  const [filter, setFilter] = useState<'tous' | 'incomplets' | 'vides'>('tous');
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [data, caps] = await Promise.all([
        api.extractionOverview(),
        api.capabilities().catch(() => null),
      ]);
      setOverview(data);
      setCapabilities(caps);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const llmAvailable = capabilities?.llm.available ?? false;
  const templateId = overview?.template.id;
  const patientCount = overview?.rows.length ?? 0;
  useEffect(() => {
    if (mode === 'rules' || !llmAvailable || templateId === undefined || patientCount === 0) {
      setEstimate(null);
      return undefined;
    }
    let cancelled = false;
    api
      .estimateExtraction(templateId)
      .then((r) => {
        if (!cancelled) setEstimate(r.estimate);
      })
      .catch(() => {
        if (!cancelled) setEstimate(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, llmAvailable, templateId, patientCount]);

  async function run() {
    if (!overview) return;
    // Payée par l'utilisateur sur son propre compte : au-delà de quelques dollars, on demande d'abord.
    if (mode !== 'rules' && estimate && estimate.high >= 5) {
      const ok = window.confirm(
        `Cette passe peut coûter jusqu’à ${formatUsd(estimate.high)} sur votre compte Anthropic (${plural(estimate.patients, 'dossier')}). La lancer ?`,
      );
      if (!ok) return;
    }
    setRunning(true);
    try {
      const result = await api.runExtraction({ templateId: overview.template.id, mode });
      setLastRun(result);
      toast.success(
        `${result.totals.extracted} valeurs trouvées sur ${plural(result.patientsProcessed, 'dossier')}.`,
      );
      await load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />;
  if (!overview) return <LoadingPanel />;

  const llmReady = capabilities?.llm.available ?? false;
  // Le modèle qui sert l'extraction : Claude, ou un modèle local choisi sur la page « Modèles d'IA ».
  const localEngine = capabilities?.llm.provider === 'local';
  const engine = localEngine ? `le modèle local ${capabilities?.llm.model.replace(/^ollama:/, '') ?? ''}` : 'Claude';
  const engineShort = localEngine ? `modèle local (${capabilities?.llm.model.replace(/^ollama:/, '') ?? ''})` : 'Claude';
  const { rows, summary, template } = overview;

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Aucun dossier à traiter"
        action={
          <Link className="btn btn-primary" to="/dossiers">
            Importer des dossiers
          </Link>
        }
      >
        L’extraction applique la fiche d’exploitation aux documents importés.
      </EmptyState>
    );
  }

  const visible = rows.filter((row) =>
    filter === 'vides'
      ? row.filled === 0
      : filter === 'incomplets'
        ? row.filled < row.total
        : true,
  );

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <div className="eyebrow">Instruments</div>
          <h1>Extraction</h1>
          <p className="sub">
            Applique la fiche « {template.name} » aux documents de chaque dossier. Chaque valeur
            retenue garde le fichier et l’extrait qui la justifient — ce qui rend visible, ici, ce
            que chaque document a réellement produit.
          </p>
        </div>
        <div className="page-head-actions">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as ExtractionMode)}
            aria-label="Moteur d’extraction"
            style={{ minWidth: 240 }}
          >
            <option value="rules">Règles seules — gratuit, reproductible</option>
            <option value="hybrid" disabled={!llmReady}>
              Règles puis {engineShort} — recommandé
            </option>
            <option value="llm" disabled={!llmReady}>
              {localEngine ? `${engineShort} seul` : 'Claude seul'}
            </option>
          </select>
          <button className="btn-primary" onClick={run} disabled={running}>
            {running ? <Spinner label="Extraction…" /> : "Lancer l’extraction"}
          </button>
        </div>
      </div>

      <div className="grid grid-stats">
        <StatTile label="Dossiers" value={summary.patients} />
        <StatTile
          label="Documents"
          value={summary.documents}
          hint={
            summary.barrenDocuments > 0
              ? `${summary.barrenDocuments} n’ont rien justifié`
              : 'tous ont produit au moins une valeur'
          }
        />
        <StatTile
          label="Dossiers vides"
          value={summary.emptyPatients}
          hint={summary.emptyPatients > 0 ? 'aucune variable renseignée' : undefined}
          accent={summary.emptyPatients > 0}
        />
        <StatTile
          label="Variables de la fiche"
          value={template.fields.length}
          hint={template.name}
        />
      </div>

      {localEngine && mode !== 'rules' && (
        <div className="notice notice-info">
          <IconInfo size={18} />
          <div>
            <strong>Extraction par {engine}, sur ce poste.</strong> Aucun coût, et aucun texte ne quitte l’ordinateur. Les
            mêmes contrôles qu’avec Claude s’appliquent : chaque valeur doit être justifiée par une citation retrouvée
            dans le document. Sans carte graphique, comptez de quelques secondes à quelques minutes par dossier.{' '}
            <Link to="/modeles">Modèles d’IA</Link>
          </div>
        </div>
      )}

      {!localEngine && (!llmReady || mode !== 'rules') && (
        <ApiKeyPanel
          onChange={(key) => {
            // Une clé vient d'être enregistrée : on passe au mode recommandé, et l'estimation du coût s'affiche.
            if (key.available) setMode((current) => (current === 'rules' ? 'hybrid' : current));
            void load();
          }}
        />
      )}

      {!localEngine && mode !== 'rules' && llmReady && estimate && estimate.patients > 0 && (
        <div className="notice notice-info">
          <IconInfo size={18} />
          <div>
            <strong>
              Coût estimé de la passe : entre {formatUsd(estimate.low)} et {formatUsd(estimate.high)}
            </strong>{' '}
            sur votre compte Anthropic ({plural(estimate.patients, 'dossier')}, {modelLabel(estimate.model)}).
            {mode === 'hybrid' && ' Avec « Règles puis Claude », c’est souvent moins : Claude ne reçoit que ce que les règles n’ont pas trouvé.'}
          </div>
        </div>
      )}

      {lastRun && <RunSummary run={lastRun} />}

      <div className="row" style={{ gap: 8 }}>
        <div className="row" style={{ gap: 4 }} role="group" aria-label="Filtrer les dossiers">
          {(
            [
              ['tous', `Tous (${rows.length})`],
              ['incomplets', `Incomplets (${rows.filter((r) => r.filled < r.total).length})`],
              ['vides', `Vides (${summary.emptyPatients})`],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={filter === key ? 'btn-primary btn-sm' : 'btn-sm btn-quiet'}
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
                setPage(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="spacer" />
        <PanelGroupControls keys={visible.map((r) => `extraction.${r.patientId}`)} />
      </div>

      {visible.length === 0 ? (
        <EmptyState title="Rien à signaler">
          Aucun dossier ne correspond à ce filtre — l’extraction a rempli ce qu’elle pouvait.
        </EmptyState>
      ) : (
        <>
          <div className="stack" style={{ gap: 12 }}>
            {visible.slice(clampPage(page, visible.length, PAGE_SIZE) * PAGE_SIZE, (clampPage(page, visible.length, PAGE_SIZE) + 1) * PAGE_SIZE).map((row) => (
              <PatientResult key={row.patientId} row={row} />
            ))}
          </div>
          <Pager total={visible.length} pageSize={PAGE_SIZE} page={page} onPage={setPage} label="Pages des bilans par dossier" noun="Dossiers" />
        </>
      )}
    </div>
  );
}

/** Détail d'un dossier : ses fichiers, et ce que chacun a produit. */
function PatientResult({ row }: { row: ExtractionRow }) {
  const rate = row.total > 0 ? Math.round((row.filled / row.total) * 100) : 0;
  const steriles = row.documents.filter((d) => d.fields.length === 0).length;

  return (
    <Panel
      id={`extraction.${row.patientId}`}
      // Les dossiers pleinement renseignés n'appellent pas d'inspection : ils
      // s'ouvrent repliés, et laissent la place à ceux qui posent question.
      defaultOpen={row.filled < row.total}
      title={
        <span className="row" style={{ gap: 10 }}>
          <span>{row.patientCode}</span>
          <span className={rate === 100 ? 'badge badge-auto' : 'badge'}>{rate} %</span>
        </span>
      }
      summary={
        <>
          {row.filled} / {row.total} variables · {plural(row.documents.length, 'fichier')}
          {steriles > 0 && ` · ${steriles} sans apport`}
        </>
      }
      actions={
        <Link className="btn btn-sm" to={`/dossiers/${row.patientId}`}>
          Ouvrir le dossier
        </Link>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="row small secondary" style={{ gap: 16 }}>
          <span>
            <span className="dot" style={{ background: 'var(--source-rule)' }} /> {row.bySource.auto} par règle
          </span>
          {row.bySource.llm > 0 && (
            <span>
              <span className="dot" style={{ background: 'var(--source-llm)' }} /> {row.bySource.llm} par Claude
            </span>
          )}
          {row.bySource.import > 0 && (
            <span>
              <span className="dot" style={{ background: 'var(--good)' }} /> {row.bySource.import} importées d’un tableau
            </span>
          )}
          {row.bySource.manual > 0 && (
            <span>
              <span className="dot" style={{ background: 'var(--source-manual)' }} /> {row.bySource.manual} à la main
            </span>
          )}
          {row.lastExtractionAt && (
            <span className="muted">extraction du {formatDateTime(row.lastExtractionAt)}</span>
          )}
        </div>

        {row.documents.length === 0 ? (
          <div className="notice notice-warn">
            <IconAlert size={18} />
            <div>Aucun document dans ce dossier : il n’y a rien à extraire.</div>
          </div>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {row.documents.map((doc) => (
              <div
                key={doc.documentId}
                className={doc.fields.length > 0 ? 'doc-yield' : 'doc-yield doc-yield-barren'}
              >
                <div className="row" style={{ gap: 8 }}>
                  <IconDocument size={16} />
                  <span className="truncate" style={{ fontWeight: 550 }} title={doc.filename}>
                    {doc.filename}
                  </span>
                  {doc.parseStatus === 'empty' && (
                    <span className="badge badge-warn">Aucun texte</span>
                  )}
                  {doc.parseStatus === 'error' && (
                    <span className="badge badge-error">Analyse impossible</span>
                  )}
                  <div className="spacer" />
                  <span className="small muted nowrap">
                    {doc.fields.length > 0
                      ? plural(doc.fields.length, 'variable')
                      : 'aucun apport'}
                  </span>
                </div>

                {doc.fields.length > 0 ? (
                  <div className="row" style={{ gap: 4, marginTop: 6 }}>
                    {doc.fields.map((label) => (
                      <span key={label} className="badge">
                        {label}
                      </span>
                    ))}
                  </div>
                ) : (
                  <div className="small muted" style={{ marginTop: 4 }}>
                    {doc.parseStatus !== 'ok'
                      ? "Le texte n’a pas pu être lu : aucune règle ne peut s’y appliquer."
                      : doc.textLength === 0
                        ? 'Document sans contenu textuel.'
                        : "Texte lisible, mais aucune règle n’y a trouvé de valeur. Le vocabulaire de ce document diffère peut-être de celui prévu dans la fiche."}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {row.sansJustification > 0 && (
          <div className="small muted">
            {plural(row.sansJustification, 'valeur')} sans document justificatif — saisies à la
            main lors de la relecture.
          </div>
        )}
      </div>
    </Panel>
  );
}

/**
 * Valeurs que les règles ont trouvées sans pouvoir les retenir.
 *
 * Une variable vide parce que « CRP < 5 » a été refusé n'est pas une variable
 * absente du dossier : elle demande une décision humaine. Sans cette liste, le
 * taux de complétude la confondrait avec une donnée manquante.
 */
function RejectedList({ run }: { run: ExtractionRunResult }) {
  const items = run.reports.flatMap((report) =>
    report.fields
      .filter((f) => f.rejected !== null)
      .map((f) => ({ patientCode: report.patientCode, label: f.label, rejected: f.rejected! })),
  );
  if (items.length === 0) return null;
  const shown = items.slice(0, 60);

  return (
    <details style={{ marginTop: 10 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 550 }}>
        {plural(items.length, 'valeur trouvée mais écartée', 'valeurs trouvées mais écartées')}
        <span className="muted"> — à saisir ou à trancher à la main</span>
      </summary>
      <ul className="small" style={{ margin: '8px 0 0', paddingLeft: '1.1em' }}>
        {shown.map((item, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            <strong>{item.patientCode}</strong> · {item.label} :{' '}
            <span style={{ fontStyle: 'italic' }}>« {item.rejected.snippet} »</span>
            <span className="muted"> — {item.rejected.reason}</span>
          </li>
        ))}
      </ul>
      {items.length > shown.length && (
        <div className="small muted" style={{ marginTop: 4 }}>
          … et {items.length - shown.length} autres.
        </div>
      )}
    </details>
  );
}

/** Bilan de la dernière passe, affiché juste après l'avoir lancée. */
function RunSummary({ run }: { run: ExtractionRunResult }) {
  return (
    <div className="notice notice-info">
      <div style={{ flex: 1 }}>
        <div className="row" style={{ gap: 20 }}>
          <span>
            <strong>{run.totals.extracted}</strong>{' '}
            <span className="secondary">valeurs extraites</span>
          </span>
          <span>
            <strong>{run.totals.notFound}</strong> <span className="secondary">non trouvées</span>
          </span>
          <span>
            <strong>{run.totals.keptManual}</strong>{' '}
            <span className="secondary">saisies préservées</span>
          </span>
          {run.totals.rejected > 0 && (
            <span title="Valeur trouvée dans le document mais inutilisable : valeur seuil, hors bornes, unité différente">
              <strong>{run.totals.rejected}</strong>{' '}
              <span className="secondary">trouvées mais écartées</span>
            </span>
          )}
          {run.totals.unverified > 0 && (
            <span title="Valeurs proposées par Claude sans citation retrouvable dans les documents">
              <strong>{run.totals.unverified}</strong>{' '}
              <span className="secondary">écartées, non justifiées</span>
            </span>
          )}
          {run.totals.invalid > 0 && (
            <span title="Valeurs incompatibles avec le type ou les options de la fiche">
              <strong>{run.totals.invalid}</strong>{' '}
              <span className="secondary">écartées, hors format</span>
            </span>
          )}
        </div>
        <RejectedList run={run} />
        {run.usage && (
          <div className="small muted" style={{ marginTop: 6 }}>
            Jetons : {run.usage.inputTokens.toLocaleString('fr-FR')} en entrée (
            {run.usage.cacheReadTokens.toLocaleString('fr-FR')} depuis le cache),{' '}
            {run.usage.outputTokens.toLocaleString('fr-FR')} en sortie
            {typeof run.costUsd === 'number' ? (
              <>
                {' '}
                — <strong>{formatUsd(run.costUsd)}</strong> sur votre compte Anthropic.
              </>
            ) : (
              '.'
            )}
          </div>
        )}
      </div>
    </div>
  );
}
