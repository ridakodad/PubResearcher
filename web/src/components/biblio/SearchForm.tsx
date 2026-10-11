import { useId } from 'react';
import type { BiblioSearchParams, BiblioSearchableSource, BiblioStatus } from '../../lib/types';
import { IconAlert } from '../icons';
import { SOURCE_LABELS, fmtCount, formatElapsed } from './shared';

/**
 * Formulaire d'une passe de recherche.
 *
 * Il ne fait que recueillir les paramètres : la validation vit ici, pour que le
 * bouton dise *pourquoi* il est grisé, et le serveur revalide de toute façon.
 *
 * PubMed fonctionne sans aucun réglage (API officielle du NCBI) ; Google
 * Scholar, en option, demande un jeton Apify et se paie au résultat.
 */

export interface SearchFormState {
  query: string;
  sources: BiblioSearchableSource[];
  /** Résultats demandés à Google Scholar. */
  maxResults: number;
  /** PubMed : tout récupérer (revue systématique) ou les N premiers (exploration). */
  pubmedAll: boolean;
  pubmedMax: number;
  yearFrom: string;
  yearTo: string;
  sort: 'relevance' | 'date';
}

export const SOURCES: BiblioSearchableSource[] = ['pubmed', 'scholar'];

export const QUERY_MAX = 4000;

export function initialForm(status: BiblioStatus): SearchFormState {
  return {
    query: '',
    // Scholar est facturé : il ne se coche pas tout seul.
    sources: ['pubmed'],
    maxResults: Math.min(20, status.maxResults),
    pubmedAll: true,
    pubmedMax: 200,
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

const usable = (status: BiblioStatus, source: BiblioSearchableSource) => status.sources[source].available;

export function restoreForm(status: BiblioStatus): SearchFormState {
  const base = initialForm(status);
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(DRAFT_KEY) ?? 'null');
    if (typeof raw !== 'object' || raw === null) return base;
    const draft = raw as Record<string, unknown>;
    const sources = Array.isArray(draft.sources)
      ? SOURCES.filter((s) => (draft.sources as unknown[]).includes(s) && usable(status, s))
      : base.sources;
    const int = (value: unknown, fallback: number) => (typeof value === 'number' && Number.isInteger(value) ? value : fallback);
    return {
      query: typeof draft.query === 'string' ? draft.query.slice(0, QUERY_MAX) : base.query,
      sources,
      maxResults: Math.min(Math.max(int(draft.maxResults, base.maxResults), 1), status.maxResults),
      pubmedAll: typeof draft.pubmedAll === 'boolean' ? draft.pubmedAll : base.pubmedAll,
      pubmedMax: Math.min(Math.max(int(draft.pubmedMax, base.pubmedMax), 1), status.pubmed.window),
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
  if (form.sources.includes('pubmed') && !form.pubmedAll) {
    if (!Number.isInteger(form.pubmedMax) || form.pubmedMax < 1 || form.pubmedMax > status.pubmed.window) {
      return `Entre 1 et ${fmtCount(status.pubmed.window)} premiers résultats PubMed — au-delà, récupérez-les tous.`;
    }
  }
  if (form.sources.includes('scholar')) {
    if (!Number.isInteger(form.maxResults) || form.maxResults < 1 || form.maxResults > status.maxResults) {
      return `Entre 1 et ${status.maxResults} résultats Google Scholar.`;
    }
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
    pubmedMax: form.pubmedAll ? null : form.pubmedMax,
    ...(typeof from === 'number' ? { yearFrom: from } : {}),
    ...(typeof to === 'number' ? { yearTo: to } : {}),
    sort: form.sort,
  };
}

function sourceNote(source: BiblioSearchableSource, status: BiblioStatus): string {
  const info = status.sources[source];
  if (source === 'pubmed') {
    return `API officielle du NCBI, gratuite et sans jeton. Résumé complet, termes MeSH, types de publication, DOI, PMID, PMCID${
      status.pubmed.apiKey ? '' : ' — 3 requêtes par seconde (une clé NCBI_API_KEY porte la limite à 10)'
    }.`;
  }
  if (!info.supported) {
    return `L’acteur Apify configuré n’a pas d’adaptateur dans l’application. Pris en charge : ${info.alternatives.join(', ')}.`;
  }
  if (!status.configured) {
    return 'En option : passe par un acteur Apify, facturé au résultat. Renseignez APIFY_TOKEN côté serveur pour l’activer.';
  }
  return 'Extrait de chaque résultat (pas le résumé) et nombre de citations, par un acteur Apify facturé au résultat. Les conditions de Google restreignent l’extraction automatisée.';
}

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
  const queryHintId = useId();
  const fromId = useId();
  const toId = useId();
  const maxId = useId();
  const pubmedMaxId = useId();
  const sortId = useId();
  const hintId = useId();

  const problem = validateForm(form, status);
  // Grisé : rien ne peut partir. Pendant une passe le bouton reste plein — il porte le temps écoulé.
  const blocked = problem !== null;
  const set = <K extends keyof SearchFormState>(key: K, value: SearchFormState[K]) =>
    onChange({ ...form, [key]: value });

  const toggleSource = (source: BiblioSearchableSource) =>
    set(
      'sources',
      form.sources.includes(source)
        ? form.sources.filter((s) => s !== source)
        : SOURCES.filter((s) => s === source || form.sources.includes(s)),
    );

  const withPubmed = form.sources.includes('pubmed');
  const withScholar = form.sources.includes('scholar');

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
          maxLength={QUERY_MAX}
          aria-describedby={queryHintId}
          placeholder="par exemple : (appendicitis[MeSH Terms] OR appendicitis[tiab]) AND antibiotic*[tiab] AND appendectomy[tiab]"
          onChange={(event) => set('query', event.target.value)}
          onKeyDown={(event) => {
            // Ctrl/Cmd + Entrée lance la passe, comme dans un moteur de recherche.
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !blocked && !running) {
              event.preventDefault();
              onSubmit();
            }
          }}
        />
        <div className="field-hint" id={queryHintId}>
          PubMed reçoit l’équation telle quelle, avec sa syntaxe ([tiab], [MeSH Terms], AND, OR, NOT, troncature *).
          Pour Google Scholar, les balises de champ sont retirées et la passe le consigne. Gardez l’équation identique
          d’une passe à l’autre : c’est elle, avec sa date et sa traduction par PubMed, que le journal de recherche garde.
        </div>
      </div>

      <fieldset className="source-set">
        <legend>Sources interrogées</legend>
        <div className="source-grid">
          {SOURCES.map((source) => {
            const info = status.sources[source];
            const checked = form.sources.includes(source);
            const disabled = !info.available && !checked;
            return (
              <label key={source} className="source-choice" aria-disabled={disabled || undefined}>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggleSource(source)}
                />
                <span className="source-text">
                  <span className="source-name">{SOURCE_LABELS[source]}</span>
                  <span className="mono source-actor">{info.actor}</span>
                  <span className="small secondary">{sourceNote(source, status)}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>

      {withPubmed && (
        <fieldset className="layout-choice" style={{ marginBottom: 0 }}>
          <legend>Notices PubMed à récupérer</legend>
          <label className="radio">
            <input type="radio" name="pubmed-scope" checked={form.pubmedAll} onChange={() => set('pubmedAll', true)} />
            <span>
              <strong>Toutes</strong>, jusqu’à {fmtCount(status.pubmed.maxRecords)} — ce qu’une revue systématique demande. Le
              nombre total annoncé par PubMed est consigné ; au-delà du plafond, rien n’est importé et la passe le dit.
            </span>
          </label>
          <label className="radio">
            <input type="radio" name="pubmed-scope" checked={!form.pubmedAll} onChange={() => set('pubmedAll', false)} />
            <span>Seulement les premières, dans l’ordre choisi — pour explorer une équation.</span>
          </label>
          {!form.pubmedAll && (
            <div className="field" style={{ margin: '0 0 0 32px', maxWidth: 220 }}>
              <label htmlFor={pubmedMaxId}>Nombre de notices</label>
              <input
                id={pubmedMaxId}
                type="number"
                inputMode="numeric"
                min={1}
                max={status.pubmed.window}
                value={Number.isNaN(form.pubmedMax) ? '' : form.pubmedMax}
                onChange={(event) => set('pubmedMax', event.target.valueAsNumber)}
              />
              <div className="field-hint">Au plus {fmtCount(status.pubmed.window)}</div>
            </div>
          )}
        </fieldset>
      )}

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
        {withScholar && (
          <div className="field" style={{ marginBottom: 0 }}>
            <label htmlFor={maxId}>Résultats Google Scholar</label>
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
        )}
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
          {running ? (
            'La recherche tourne côté serveur : quelques secondes pour quelques centaines de notices PubMed, une à deux minutes pour 10 000. Vous pouvez rester sur la page.'
          ) : problem ? (
            <span className="row" style={{ gap: 6 }}>
              <IconAlert size={15} /> {problem}
            </span>
          ) : withScholar ? (
            `Google Scholar rendra au plus ${form.maxResults} résultats, facturés à l’usage par Apify. PubMed est gratuit.`
          ) : (
            'PubMed est gratuit : aucune clé ni jeton n’est nécessaire.'
          )}
        </span>
      </div>
    </form>
  );
}
