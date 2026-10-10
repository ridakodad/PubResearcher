import { useId } from 'react';
import type { BiblioSearchParams, BiblioSource, BiblioStatus } from '../../lib/types';
import { IconAlert } from '../icons';
import { SOURCE_LABELS, formatElapsed } from './shared';

/**
 * Formulaire d'une passe de recherche.
 *
 * Il ne fait que recueillir les paramètres : la validation vit ici, pour que le
 * bouton dise *pourquoi* il est grisé, et le serveur revalide de toute façon —
 * la dépense, elle, se décide côté serveur.
 */

export interface SearchFormState {
  query: string;
  sources: BiblioSource[];
  maxResults: number;
  yearFrom: string;
  yearTo: string;
  sort: 'relevance' | 'date';
}

export const SOURCES: BiblioSource[] = ['pubmed', 'scholar'];

export function initialForm(status: BiblioStatus): SearchFormState {
  return {
    query: '',
    sources: SOURCES.filter((s) => status.sources[s].supported),
    maxResults: Math.min(20, status.maxResults),
    yearFrom: '',
    yearTo: '',
    sort: 'relevance',
  };
}

const DRAFT_KEY = 'biblio:form';

/**
 * Le brouillon suit la session, pas le poste : une équation de plusieurs lignes
 * ne doit pas disparaître parce qu'on a ouvert un autre outil du rail, mais elle
 * n'a pas à resurgir le lendemain. Le stockage peut être absent ou corrompu —
 * dans ce cas on repart du formulaire vierge.
 */
export function saveDraft(form: SearchFormState): void {
  try {
    sessionStorage.setItem(DRAFT_KEY, JSON.stringify(form));
  } catch {
    // Stockage indisponible : le brouillon vaut pour la page ouverte, pas davantage.
  }
}

export function restoreForm(status: BiblioStatus): SearchFormState {
  const base = initialForm(status);
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return base;
    const draft = raw as Record<string, unknown>;
    const sources = Array.isArray(draft.sources)
      ? SOURCES.filter((s) => draft.sources instanceof Array && draft.sources.includes(s) && status.sources[s].supported)
      : base.sources;
    const max = typeof draft.maxResults === 'number' && Number.isInteger(draft.maxResults) ? draft.maxResults : base.maxResults;
    return {
      query: typeof draft.query === 'string' ? draft.query.slice(0, 500) : base.query,
      sources,
      maxResults: Math.min(Math.max(max, 1), status.maxResults),
      yearFrom: typeof draft.yearFrom === 'string' ? draft.yearFrom.slice(0, 4) : base.yearFrom,
      yearTo: typeof draft.yearTo === 'string' ? draft.yearTo.slice(0, 4) : base.yearTo,
      sort: draft.sort === 'date' ? 'date' : 'relevance',
    };
  } catch {
    return base;
  }
}

const parseYear = (raw: string): number | null | 'invalid' => {
  const text = raw.trim();
  if (text === '') return null;
  const year = Number(text);
  return Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : 'invalid';
};

/** Premier problème bloquant, ou `null` si la passe peut partir. */
export function validateForm(form: SearchFormState, status: BiblioStatus): string | null {
  if (form.query.trim().length < 2) return 'Saisissez une équation de recherche.';
  if (form.sources.length === 0) return 'Choisissez au moins une source.';
  const from = parseYear(form.yearFrom);
  const to = parseYear(form.yearTo);
  if (from === 'invalid' || to === 'invalid') return 'Une année s’écrit sur quatre chiffres (par exemple 2019).';
  if (from !== null && to !== null && from > to) return 'L’année de début dépasse l’année de fin.';
  if (!Number.isInteger(form.maxResults) || form.maxResults < 1 || form.maxResults > status.maxResults) {
    return `Entre 1 et ${status.maxResults} résultats par source.`;
  }
  return null;
}

export function toParams(form: SearchFormState): BiblioSearchParams {
  const from = parseYear(form.yearFrom);
  const to = parseYear(form.yearTo);
  return {
    query: form.query.trim(),
    sources: form.sources,
    maxResults: form.maxResults,
    ...(typeof from === 'number' ? { yearFrom: from } : {}),
    ...(typeof to === 'number' ? { yearTo: to } : {}),
    sort: form.sort,
  };
}

const SOURCE_NOTES: Record<BiblioSource, string> = {
  pubmed: 'Résumé complet, termes MeSH, types de publication, DOI et PMID.',
  scholar:
    'Extrait de chaque résultat (pas le résumé) et nombre de citations. Les conditions de Google restreignent l’extraction automatisée.',
};

export function SearchForm({
  status,
  form,
  onChange,
  onSubmit,
  running,
  elapsed,
}: {
  status: BiblioStatus;
  form: SearchFormState;
  onChange: (next: SearchFormState) => void;
  onSubmit: () => void;
  /** Une passe est en cours : lancée d'ici, ou côté serveur par ailleurs. */
  running: boolean;
  elapsed: number;
}) {
  const queryId = useId();
  const fromId = useId();
  const toId = useId();
  const maxId = useId();
  const sortId = useId();
  const hintId = useId();

  const problem = validateForm(form, status);
  // Grisé : rien ne peut partir. Pendant une passe le bouton reste plein — il porte le temps écoulé.
  const blocked = problem !== null || !status.configured;
  const set = <K extends keyof SearchFormState>(key: K, value: SearchFormState[K]) =>
    onChange({ ...form, [key]: value });

  const toggleSource = (source: BiblioSource) =>
    set(
      'sources',
      form.sources.includes(source)
        ? form.sources.filter((s) => s !== source)
        : SOURCES.filter((s) => s === source || form.sources.includes(s)),
    );

  const budget = form.maxResults * form.sources.length;

  return (
    <form
      className="stack"
      onSubmit={(event) => {
        event.preventDefault();
        if (!blocked && !running) onSubmit();
      }}
    >
      <div className="field" style={{ marginBottom: 0 }}>
        <label htmlFor={queryId}>Équation de recherche</label>
        <textarea
          id={queryId}
          rows={3}
          value={form.query}
          maxLength={500}
          placeholder="par exemple : holmium laser enucleation AND transurethral resection of the prostate"
          onChange={(event) => set('query', event.target.value)}
          onKeyDown={(event) => {
            // Ctrl/Cmd + Entrée lance la passe, comme dans un moteur de recherche.
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !blocked && !running) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <div className="field-hint">
          L’équation est transmise telle quelle aux sources cochées. Gardez-la identique d’une passe à
          l’autre : c’est elle, avec sa date, que la section « Stratégies de recherche » consigne.
        </div>
      </div>

      <fieldset className="source-set">
        <legend>Sources interrogées</legend>
        <div className="source-grid">
          {SOURCES.map((source) => {
            const info = status.sources[source];
            const checked = form.sources.includes(source);
            return (
              <label
                key={source}
                className="source-choice"
                aria-disabled={!info.supported || undefined}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!info.supported}
                  onChange={() => toggleSource(source)}
                />
                <span className="source-text">
                  <span className="source-name">{SOURCE_LABELS[source]}</span>
                  <span className="mono source-actor">{info.actor}</span>
                  <span className="small secondary">
                    {info.supported
                      ? SOURCE_NOTES[source]
                      : `Cet acteur n’a pas d’adaptateur dans l’application. Pris en charge : ${info.alternatives.join(', ')}.`}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      <div className="grid grid-4 form-grid">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={fromId}>Publiées depuis</label>
          <input
            id={fromId}
            type="number"
            inputMode="numeric"
            min={1800}
            max={2200}
            placeholder="année"
            value={form.yearFrom}
            onChange={(event) => set('yearFrom', event.target.value)}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={toId}>jusqu’en</label>
          <input
            id={toId}
            type="number"
            inputMode="numeric"
            min={1800}
            max={2200}
            placeholder="année"
            value={form.yearTo}
            onChange={(event) => set('yearTo', event.target.value)}
          />
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={maxId}>Résultats par source</label>
          <input
            id={maxId}
            type="number"
            inputMode="numeric"
            min={1}
            max={status.maxResults}
            value={Number.isNaN(form.maxResults) ? '' : form.maxResults}
            onChange={(event) => set('maxResults', event.target.valueAsNumber)}
          />
          <div className="field-hint">Plafond serveur : {status.maxResults}</div>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor={sortId}>Ordre</label>
          <select
            id={sortId}
            value={form.sort}
            onChange={(event) => set('sort', event.target.value as 'relevance' | 'date')}
          >
            <option value="relevance">Pertinence</option>
            <option value="date">Plus récentes d’abord</option>
          </select>
        </div>
      </div>

      <div className="row" style={{ gap: 14 }}>
        <button
          type="submit"
          className="btn-primary"
          disabled={blocked}
          aria-busy={running}
          aria-describedby={hintId}
        >
          {running ? (
            <>
              <span className="spinner spinner-inline" aria-hidden="true" />
              <span>Recherche en cours… {formatElapsed(elapsed)}</span>
            </>
          ) : (
            'Lancer la recherche'
          )}
        </button>
        <span id={hintId} className="small muted" style={{ flex: 1, minWidth: 240 }}>
          {!status.configured ? (
            <span className="row" style={{ gap: 6 }}>
              <IconAlert size={15} /> Renseignez d’abord APIFY_TOKEN côté serveur.
            </span>
          ) : running ? (
            'Les acteurs Apify tournent côté serveur : comptez de quelques secondes à deux minutes. Vous pouvez rester sur la page.'
          ) : problem ? (
            problem
          ) : (
            <>
              Cette passe rendra au plus {budget} résultats, facturés à l’usage par Apify
              {form.sources.includes('scholar') && ' — Google Scholar coûte nettement plus par résultat que PubMed'}.
            </>
          )}
        </span>
      </div>
    </form>
  );
}
