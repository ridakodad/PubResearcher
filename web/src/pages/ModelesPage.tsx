import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';
import { useWorkspace } from '../lib/workspace';
import { ErrorPanel, LoadingPanel, Spinner, useToast } from '../components/ui';
import { IconAlert, IconCheck, IconExternal, IconInfo } from '../components/icons';
import type { CatalogModel, ModelEvaluation, ModelProvider, ModelsStatus, ModelTask, ModelTaskStatus, ModelTestResult } from '../lib/types';

/**
 * Modèles d'IA : pour chaque tâche (extraction, import de fiche, rédaction, recherche bibliographique), Claude ou un
 * modèle ouvert qui tourne sur ce poste avec Ollama.
 *
 * La page dit ce qui compte pour choisir : où vont les données, ce que le modèle demande de mémoire, ce qu'il pèse au
 * téléchargement, et sa précision mesurée quand elle l'a été — jamais une promesse.
 */

interface PullState {
  status: string;
  completed: number;
  total: number;
  error: string | null;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1).replace('.', ',')} Go`;
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1).replace('.', ',')} %`);
const bare = (model: string) => model.replace(/^ollama:/, '');
const sameTag = (a: string, b: string) => (a.includes(':') ? a : `${a}:latest`) === (b.includes(':') ? b : `${b}:latest`);

function detectOs(): 'windows' | 'macos' | 'linux' {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac/i.test(ua)) return 'macos';
  return 'linux';
}

export function ModelesPage() {
  const toast = useToast();
  const { refresh } = useWorkspace();
  const [status, setStatus] = useState<ModelsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  const [tests, setTests] = useState<Partial<Record<ModelTask, ModelTestResult | 'running'>>>({});
  const aborts = useRef<Record<string, AbortController>>({});

  const load = useCallback(async () => {
    try {
      setStatus(await api.modelsStatus());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const controllers = aborts.current;
    return () => Object.values(controllers).forEach((c) => c.abort());
  }, [load]);

  async function save(task: ModelTask, change: { provider?: ModelProvider; model?: string | null }) {
    try {
      await api.saveModelSettings({ tasks: { [task]: change } });
      await load();
      refresh(); // l'écran Extraction relit la disponibilité des modes
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function pull(model: string) {
    if (aborts.current[model]) return;
    const controller = new AbortController();
    aborts.current[model] = controller;
    setPulls((p) => ({ ...p, [model]: { status: 'Démarrage…', completed: 0, total: 0, error: null } }));
    try {
      await api.pullModel(model, controller.signal, (event) =>
        setPulls((p) => ({
          ...p,
          [model]: {
            status: event.status ?? '',
            completed: event.completed ?? p[model]?.completed ?? 0,
            total: event.total ?? p[model]?.total ?? 0,
            error: null,
          },
        })),
      );
      toast.success(`Modèle ${model} téléchargé.`);
      setPulls((p) => {
        const { [model]: _done, ...rest } = p;
        return rest;
      });
      await load();
    } catch (e) {
      if (!controller.signal.aborted) {
        const message = e instanceof ApiError || e instanceof Error ? e.message : String(e);
        setPulls((p) => ({ ...p, [model]: { status: '', completed: 0, total: 0, error: message } }));
      } else {
        setPulls((p) => {
          const { [model]: _cancelled, ...rest } = p;
          return rest;
        });
      }
    } finally {
      delete aborts.current[model];
    }
  }

  async function remove(model: string) {
    if (!window.confirm(`Supprimer le modèle ${model} de cet ordinateur ? Il faudra le retélécharger pour s’en servir.`)) return;
    try {
      await api.deleteModel(model);
      toast.success(`Modèle ${model} supprimé.`);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function runTest(task: ModelTask) {
    setTests((t) => ({ ...t, [task]: 'running' }));
    try {
      const result = await api.testModel(task);
      setTests((t) => ({ ...t, [task]: result }));
    } catch (e) {
      setTests((t) => ({ ...t, [task]: undefined }));
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function setPseudonymize(value: boolean) {
    try {
      await api.saveModelSettings({ pseudonymizeLocal: value });
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  if (error) return <ErrorPanel message={error} onRetry={() => void load()} />;
  if (!status) return <LoadingPanel />;

  const os = detectOs();
  const installed = status.ollama.installed;

  return (
    <div className="stack models-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Modèles d’IA</div>
          <h1>Modèles d’IA</h1>
          <p className="sub">
            Chaque tâche peut être confiée à Claude (votre clé Anthropic) ou à un modèle ouvert qui tourne sur cet
            ordinateur avec Ollama. Les garde-fous sont les mêmes dans les deux cas : une valeur n’est retenue que si sa
            citation est retrouvée dans le document et ne la contredit pas.
          </p>
        </div>
      </div>

      <div className="notice notice-info">
        <IconInfo size={18} />
        <div>
          <strong>Modèle local : rien ne quitte l’ordinateur.</strong> Le texte des dossiers est lu par un programme qui
          tourne sur ce poste ; aucune clé, aucun coût, aucun envoi. En contrepartie, il demande de la mémoire, il est plus
          lent sans carte graphique, et sa précision est à vérifier (bouton « Tester », et l’évaluation décrite plus bas).
          Avec Claude, les textes sont pseudonymisés puis envoyés à Anthropic.
        </div>
      </div>

      {status.ollama.warning && (
        <div className="notice notice-warn" role="alert">
          <IconAlert size={18} />
          <div>{status.ollama.warning}</div>
        </div>
      )}

      <section className="card" aria-labelledby="ollama-etat">
        <div className="card-head">
          <span className={`models-dot ${status.ollama.reachable ? 'on' : 'off'}`} aria-hidden="true" />
          <div>
            <h2 id="ollama-etat" style={{ fontSize: '1rem', margin: 0 }}>
              {status.ollama.reachable ? `Ollama ${status.ollama.version ?? ''} est en marche` : 'Ollama ne répond pas'}
            </h2>
            <div className="sub">
              {status.ollama.reachable
                ? `${installed.length} modèle${installed.length > 1 ? 's' : ''} sur ce poste · ${status.ollama.url}`
                : `Adresse interrogée : ${status.ollama.url}`}
            </div>
          </div>
          <div className="card-actions">
            <button className="btn-sm" onClick={() => void load()}>
              Vérifier à nouveau
            </button>
          </div>
        </div>
        <div className="card-body stack" style={{ gap: 12 }}>
          {!status.ollama.reachable && (
            <>
              <p className="small" style={{ margin: 0 }}>
                Ollama est un logiciel libre qui fait tourner les modèles ouverts sur votre ordinateur. Installez-le une fois
                (PubResearcher ne l’installe pas à votre place), lancez-le, puis cliquez « Vérifier à nouveau ».
              </p>
              <ol className="small models-install">
                {(['windows', 'macos', 'linux'] as const).map((key) => (
                  <li key={key} className={key === os ? 'current' : undefined}>
                    <strong>{key === 'windows' ? 'Windows' : key === 'macos' ? 'macOS' : 'Linux'}</strong> — {status.ollama.install.steps[key]}
                  </li>
                ))}
              </ol>
              <div>
                <a className="btn btn-primary btn-sm" href={status.ollama.install.url} target="_blank" rel="noreferrer">
                  Télécharger Ollama <IconExternal size={12} />
                </a>
              </div>
            </>
          )}
          {status.ollama.reachable && installed.length > 0 && (
            <table className="models-installed">
              <thead>
                <tr>
                  <th scope="col">Modèle</th>
                  <th scope="col">Taille</th>
                  <th scope="col">Précision mesurée</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {installed.map((m) => {
                  const ev = status.evaluations[`ollama:${m.name}`];
                  return (
                    <tr key={m.name}>
                      <td className="mono">{m.name}</td>
                      <td>
                        {gb(m.size)}
                        {m.parameterSize ? ` · ${m.parameterSize}` : ''}
                      </td>
                      <td>{ev ? `${pct(ev.precision)} (rappel ${pct(ev.recall)})` : <span className="muted">non mesurée</span>}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn-sm btn-quiet" onClick={() => void remove(m.name)}>
                          Supprimer
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      <div className="grid grid-2 models-tasks">
        {status.tasks.map((task) => (
          <TaskCard
            key={task.task}
            task={task}
            status={status}
            pull={pulls}
            test={tests[task.task]}
            onProvider={(provider) => void save(task.task, { provider })}
            onModel={(model) => void save(task.task, { model })}
            onPull={(model) => void pull(model)}
            onCancelPull={(model) => aborts.current[model]?.abort()}
            onTest={() => void runTest(task.task)}
          />
        ))}
      </div>

      <section className="card">
        <div className="card-body stack" style={{ gap: 10 }}>
          <label className="row small" style={{ gap: 8 }}>
            <input type="checkbox" checked={status.pseudonymizeLocal} onChange={(e) => void setPseudonymize(e.target.checked)} />
            Pseudonymiser aussi avant un modèle local (noms, téléphones, numéros…). Inutile pour la confidentialité — rien ne
            sort du poste —, mais possible si votre protocole l’exige. Les citations restent ramenées au texte d’origine.
          </label>
          <p className="small secondary" style={{ margin: 0 }}>
            <strong>Et un modèle « médical » ?</strong> {status.medicalNote}
          </p>
          <p className="small secondary" style={{ margin: 0 }}>
            <strong>Mesurer la précision d’un modèle</strong> sur les 24 dossiers fictifs de démonstration (valeurs connues) :
            dans un terminal, à la racine de PubResearcher, <code>npm run eval:models --workspace server -- qwen3.5:9b</code>.
            Le résultat s’affiche ensuite ici. Ce n’est pas une validation clinique : sur vos dossiers, relisez un échantillon
            (voir <Link to="/resultats?vue=quality">Fiabilité</Link>).
          </p>
        </div>
      </section>
    </div>
  );
}

function ModelHint({ model }: { model: CatalogModel }) {
  return (
    <span className="small secondary">
      {model.family} · {String(model.downloadGb).replace('.', ',')} Go à télécharger · {model.ramGb} Go de mémoire conseillés ·
      français {model.french} · {model.licence}
    </span>
  );
}

function Evaluation({ ev }: { ev: ModelEvaluation }) {
  return (
    <div className="models-eval small">
      <strong>Mesuré sur le corpus de démonstration</strong> ({ev.patients} dossiers, {formatDateTime(ev.measuredAt)}) :
      précision <strong>{pct(ev.precision)}</strong> ({ev.correct}/{ev.extracted}), rappel {pct(ev.recall)}, JSON invalide{' '}
      {pct(ev.invalidJsonRate)}, citations écartées {pct(ev.unverifiedRate)}, {(ev.meanLatencyMs / 1000).toFixed(1).replace('.', ',')} s par
      dossier.
    </div>
  );
}

function TaskCard(props: {
  task: ModelTaskStatus;
  status: ModelsStatus;
  pull: Record<string, PullState>;
  test: ModelTestResult | 'running' | undefined;
  onProvider: (p: ModelProvider) => void;
  onModel: (m: string) => void;
  onPull: (m: string) => void;
  onCancelPull: (m: string) => void;
  onTest: () => void;
}) {
  const { task, status, pull, test } = props;
  const local = task.provider === 'local';
  const rec = task.recommendation;
  const chosen = task.localModel;
  const catalogEntry = status.catalog.find((c) => c.tag === chosen);
  const isInstalled = status.ollama.installed.some((m) => sameTag(m.name, chosen));
  const progress = pull[chosen];
  const options = [
    ...new Set([rec.recommended.tag, rec.light.tag, rec.strong.tag, ...status.ollama.installed.map((m) => m.name), ...status.catalog.map((c) => c.tag), chosen]),
  ];
  const labelFor = (tag: string) =>
    tag === rec.recommended.tag
      ? `${tag} — recommandé`
      : tag === rec.light.tag
        ? `${tag} — léger`
        : tag === rec.strong.tag
          ? `${tag} — plus fort`
          : tag;
  const id = `tache-${task.task}`;

  return (
    <section className="card models-task" aria-labelledby={id}>
      <div className="card-head">
        <div>
          <h2 id={id} style={{ fontSize: '1rem', margin: 0 }}>
            {task.label}
          </h2>
          <div className="sub">
            {local ? `Modèle local : ${bare(task.model)}` : `Claude (${task.model})`}
            {!task.available && ' — indisponible'}
          </div>
        </div>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        <div className="models-toggle" role="group" aria-label={`Fournisseur pour ${task.label}`}>
          <button type="button" aria-pressed={!local} className={!local ? 'on' : ''} onClick={() => props.onProvider('anthropic')}>
            Claude
          </button>
          <button type="button" aria-pressed={local} className={local ? 'on' : ''} onClick={() => props.onProvider('local')}>
            Modèle local
          </button>
        </div>

        {!local && !status.anthropic.available && (
          <p className="small" style={{ margin: 0 }}>
            Aucune clé Anthropic : <Link to="/claude">activer Claude</Link>, ou choisir un modèle local.
          </p>
        )}

        {local && (
          <>
            <label className="stack small" style={{ gap: 4 }}>
              Modèle
              <select value={chosen} onChange={(e) => props.onModel(e.target.value)}>
                {options.map((tag) => (
                  <option key={tag} value={tag}>
                    {labelFor(tag)}
                    {status.ollama.installed.some((m) => sameTag(m.name, tag)) ? ' ✓' : ''}
                  </option>
                ))}
              </select>
            </label>
            {catalogEntry && <ModelHint model={catalogEntry} />}
            {catalogEntry && <span className="small secondary">{catalogEntry.note}</span>}

            {!status.ollama.reachable ? (
              <span className="small muted">Installez et lancez Ollama (plus haut) pour télécharger ce modèle.</span>
            ) : isInstalled ? (
              <span className="small models-ok">
                <IconCheck size={12} /> Téléchargé sur ce poste
              </span>
            ) : progress && !progress.error ? (
              <div className="stack" style={{ gap: 4 }}>
                <div
                  className="meter"
                  role="progressbar"
                  aria-label={`Téléchargement de ${chosen}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progress.total ? Math.round((progress.completed / progress.total) * 100) : 0}
                >
                  <div className="meter-fill" style={{ width: `${progress.total ? (progress.completed / progress.total) * 100 : 2}%` }} />
                </div>
                <div className="row small secondary">
                  <span>
                    {progress.status}
                    {progress.total ? ` — ${gb(progress.completed)} / ${gb(progress.total)}` : ''}
                  </span>
                  <button type="button" className="btn-sm btn-quiet" onClick={() => props.onCancelPull(chosen)}>
                    Annuler
                  </button>
                </div>
              </div>
            ) : (
              <div className="stack" style={{ gap: 4 }}>
                <div>
                  <button type="button" className="btn-sm btn-primary" onClick={() => props.onPull(chosen)}>
                    Télécharger {chosen}
                    {catalogEntry ? ` (${String(catalogEntry.downloadGb).replace('.', ',')} Go)` : ''}
                  </button>
                </div>
                {progress?.error && (
                  <span className="small models-error" role="alert">
                    {progress.error}
                  </span>
                )}
              </div>
            )}
            <details className="small secondary">
              <summary>Pourquoi ce modèle ?</summary>
              <p>{rec.why}</p>
              <p>
                Léger : {rec.light.tag} ({rec.light.ramGb} Go de mémoire). Plus fort : {rec.strong.tag} ({rec.strong.ramGb} Go).
              </p>
            </details>
          </>
        )}

        {task.evaluation && <Evaluation ev={task.evaluation} />}

        {local && (
          <div className="stack" style={{ gap: 6 }}>
            <div>
              <button type="button" className="btn-sm" onClick={props.onTest} disabled={test === 'running' || !isInstalled}>
                {test === 'running' ? <Spinner label="Essai en cours…" /> : 'Tester'}
              </button>
            </div>
            {test && test !== 'running' && (
              <div className={`small ${test.pass ? 'models-ok' : 'models-error'}`} role="status">
                {test.pass ? <IconCheck size={12} /> : <IconAlert size={12} />}{' '}
                {test.pass ? 'Essai réussi' : 'Essai échoué'} en {(test.latencyMs / 1000).toFixed(1).replace('.', ',')} s
                {test.checks.length > 0 && ` — ${test.checks.filter((c) => c.ok).length}/${test.checks.length} valeurs exactes et citées`}
                {test.validJson === false && ' — réponse JSON invalide'}
                {test.details && <div className="secondary">{test.details}</div>}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
