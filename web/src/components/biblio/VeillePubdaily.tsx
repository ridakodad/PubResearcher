/**
 * Onglet « Veille PubDaily » : parcourt les sujets qui montent dans la
 * spécialité choisie et importe les papiers sélectionnés dans la bibliothèque
 * du projet. Toutes les données viennent du MCP public pubdaily.app ; aucune
 * donnée du projet ne sort d'ici (seules les clés `specialty`/`topic`/`page`
 * sont renvoyées, pour la traçabilité des références importées).
 */
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type {
  PubdailyPaperBrief,
  PubdailySearchPaperBrief,
  PubdailySpecialtyBrief,
  PubdailyTopicBrief,
} from '../../lib/types';

function slugFromPage(page: string | null | undefined, topic: string): string {
  if (!page) return topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
  try {
    const url = new URL(page);
    const parts = url.pathname.split('/').filter(Boolean);
    return parts[parts.length - 1] ?? 'topic';
  } catch {
    return 'topic';
  }
}

export function VeillePubdaily(): JSX.Element {
  const [specialties, setSpecialties] = useState<PubdailySpecialtyBrief[] | null>(null);
  const [specialty, setSpecialty] = useState<string>('');
  const [topics, setTopics] = useState<PubdailyTopicBrief[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingTrends, setLoadingTrends] = useState(false);

  const [openTopic, setOpenTopic] = useState<PubdailyTopicBrief | null>(null);
  const [topicPapers, setTopicPapers] = useState<PubdailyPaperBrief[]>([]);
  const [loadingPapers, setLoadingPapers] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [searchResults, setSearchResults] = useState<PubdailySearchPaperBrief[] | null>(null);

  useEffect(() => {
    api
      .pubdailySpecialties()
      .then((r) => {
        setSpecialties(r.specialties);
        if (r.specialties[0]) setSpecialty(r.specialties[0].name);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  const loadTrends = (name: string) => {
    if (!name) return;
    setLoadingTrends(true);
    setError(null);
    api
      .pubdailyTrends(name, 20)
      .then((r) => setTopics(r.topics))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoadingTrends(false));
  };

  useEffect(() => {
    if (specialty) loadTrends(specialty);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specialty]);

  const openTopicPapers = (topic: PubdailyTopicBrief) => {
    if (!topic.pubmed_search) {
      setError(`Ce sujet n'a pas de requête PubMed exploitable (${topic.topic}).`);
      return;
    }
    setOpenTopic(topic);
    setTopicPapers([]);
    setSelected(new Set());
    setLoadingPapers(true);
    api
      .pubdailyTopicPapers(slugFromPage(topic.page, topic.topic), topic.pubmed_search)
      .then((r) => setTopicPapers(r.papers))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoadingPapers(false));
  };

  const togglePmid = (pmid: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(pmid)) next.delete(pmid);
      else next.add(pmid);
      return next;
    });
  };

  const doImport = async () => {
    if (!openTopic || selected.size === 0) return;
    setImporting(true);
    setImportStatus(null);
    try {
      const r = await api.pubdailyImport({
        specialty,
        topic: openTopic.topic,
        page: openTopic.page ?? undefined,
        pmids: Array.from(selected),
      });
      setImportStatus(`${r.imported} nouvelle(s), ${r.duplicates} déjà connue(s).`);
      // Marque les papiers importés.
      setTopicPapers((prev) => prev.map((p) => (p.pmid && selected.has(p.pmid) ? { ...p, alreadyImported: true } : p)));
      setSelected(new Set());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setImporting(false);
    }
  };

  const runSearch = () => {
    const q = query.trim();
    if (q.length < 2) return;
    api
      .pubdailySearchPapers(q, { specialty: specialty || undefined, limit: 10 })
      .then((r) => setSearchResults(r.papers))
      .catch((e: Error) => setError(e.message));
  };

  const topicRows = useMemo(() => topics ?? [], [topics]);

  return (
    <div className="pubdaily-tab stack">
      <div className="pubdaily-row">
        <label>
          Spécialité :
          <select value={specialty} onChange={(e) => setSpecialty(e.target.value)}>
            {specialties?.map((s) => (
              <option key={s.name} value={s.name}>
                {s.name}
                {s.topicCount ? ` (${s.topicCount})` : ''}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={() => loadTrends(specialty)} disabled={loadingTrends}>
          {loadingTrends ? 'Chargement…' : 'Rafraîchir'}
        </button>
        <span className="pubdaily-source">
          Données publiques — <a href="https://pubdaily.app/editorial-policy" target="_blank" rel="noreferrer">politique éditoriale</a>
        </span>
      </div>
      {error && <div className="pubdaily-error">{error}</div>}

      <table className="pubdaily-trends">
        <thead>
          <tr>
            <th>Sujet</th>
            <th>Papiers (12 m.)</th>
            <th>Croissance</th>
            <th>Essais</th>
            <th>Score</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {topicRows.map((t) => (
            <tr key={t.topic}>
              <td>
                {t.page ? (
                  <a href={t.page} target="_blank" rel="noreferrer">{t.topic}</a>
                ) : (
                  t.topic
                )}
              </td>
              <td>{t.papers_last_12_months ?? '—'}</td>
              <td>{t.growth_vs_previous_12_months_pct != null ? `+${t.growth_vs_previous_12_months_pct}%` : '—'}</td>
              <td>{t.new_trials_last_12_months ?? '—'}</td>
              <td>
                <div className="pubdaily-score-bar" aria-label={`score ${t.trend_score ?? 0}`}>
                  <div style={{ width: `${Math.max(0, Math.min(100, t.trend_score ?? 0))}%` }} />
                </div>
                <span>{t.trend_score ?? '—'}</span>
              </td>
              <td>
                <button type="button" onClick={() => openTopicPapers(t)}>Voir les papiers</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {openTopic && (
        <section className="pubdaily-papers">
          <h3>Papiers récents — {openTopic.topic}</h3>
          {loadingPapers ? (
            <p>Chargement des papiers récents…</p>
          ) : (
            <ul>
              {topicPapers.map((p) => (
                <li key={p.pmid ?? p.title} className={p.alreadyImported ? 'is-already' : ''}>
                  <label>
                    <input
                      type="checkbox"
                      disabled={p.alreadyImported || !p.pmid}
                      checked={p.pmid ? selected.has(p.pmid) : false}
                      onChange={() => p.pmid && togglePmid(p.pmid)}
                    />
                    <strong>{p.title}</strong>
                  </label>
                  <div className="pubdaily-paper-meta">
                    {p.journal ?? '—'} · {p.year ?? '—'} · PMID {p.pmid ?? '—'}
                    {p.pmid && (
                      <>
                        {' '}
                        · <a href={`https://pubmed.ncbi.nlm.nih.gov/${p.pmid}/`} target="_blank" rel="noreferrer">PubMed</a>
                      </>
                    )}
                    {p.alreadyImported && <em> — déjà importé</em>}
                  </div>
                </li>
              ))}
            </ul>
          )}
          <div className="pubdaily-import-row">
            <button type="button" onClick={doImport} disabled={importing || selected.size === 0}>
              Importer la sélection ({selected.size})
            </button>
            {importStatus && <span>{importStatus}</span>}
          </div>
        </section>
      )}

      <section className="pubdaily-search">
        <h3>Chercher dans la sélection PubDaily</h3>
        <div className="pubdaily-row">
          <input
            type="search"
            value={query}
            placeholder="mots-clés, titre…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') runSearch();
            }}
          />
          <button type="button" onClick={runSearch}>Chercher</button>
        </div>
        {searchResults && (
          <ul>
            {searchResults.map((p) => (
              <li key={p.pmid ?? p.title}>
                <strong>{p.title}</strong>
                <div className="pubdaily-paper-meta">
                  {p.journal ?? '—'} · {p.published ?? '—'} · PMID {p.pmid ?? '—'}
                  {p.pubdaily_score != null && <> · score {p.pubdaily_score}</>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
