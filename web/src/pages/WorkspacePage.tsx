import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  IconArrow,
  IconBook,
  IconChart,
  IconExport,
  IconExtract,
  IconFolders,
  IconForm,
  IconGauge,
  IconTable,
} from '../components/icons';
import { ErrorPanel } from '../components/ui';
import { EXPORTS } from '../lib/exports';
import { api } from '../lib/api';
import { useWorkspace } from '../lib/workspace';

/**
 * Plan de travail.
 *
 * Point d'entrée de l'espace de recherche : tous les outils y sont visibles à
 * la fois, avec le chiffre qui dit où en est le travail. Un chercheur qui
 * revient sur son étude doit pouvoir décider en un coup d'œil s'il lui manque
 * des documents, des variables, ou une relecture — sans avoir à ouvrir trois
 * écrans pour le savoir.
 */

interface ToolCardProps {
  to: string;
  icon: typeof IconFolders;
  tone?: 'brand' | 'accent' | 'violet';
  title: string;
  description: string;
  figure?: string | number;
  unit?: string;
  span?: 'b-4' | 'b-6' | 'b-8' | 'b-12';
}

function ToolCard({
  to,
  icon: Icon,
  tone = 'brand',
  title,
  description,
  figure,
  unit,
  span = 'b-4',
}: ToolCardProps) {
  return (
    <Link to={to} className={`tool-card ${span}`}>
      <div className="tool-card-head">
        <span className={tone === 'brand' ? 'tool-icon' : `tool-icon ${tone}`}>
          <Icon />
        </span>
        <span className="tool-title">{title}</span>
        <span className="tool-arrow" aria-hidden="true">
          <IconArrow size={18} />
        </span>
      </div>

      <p className="tool-desc">{description}</p>

      {figure != null && (
        <div className="tool-meta">
          <span className="figure">{figure}</span>
          {unit && <span>{unit}</span>}
        </div>
      )}
    </Link>
  );
}

export function WorkspacePage() {
  const {
    patients,
    documents,
    unreadable,
    templateName,
    fields,
    completeness,
    capabilities,
    loading,
    error,
    refresh,
  } = useWorkspace();

  const llm = capabilities?.llm;

  // Le chiffre de la carte « Revue bibliographique » : s'il ne vient pas (serveur
  // d'une version antérieure, panne), la carte s'affiche sans lui.
  const [references, setReferences] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .biblioOverview()
      .then((overview) => {
        if (!cancelled) setReferences(overview.counts.total);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const number = (value: number): string => (loading ? '—' : value.toLocaleString('fr-FR'));

  return (
    <div className="stack" style={{ gap: 24 }}>
      <section className="hero">
        {/* L'état de l'extraction en un mot : « règles seules » tant que Claude n'est pas activé — et alors, le chemin. */}
        {!loading && capabilities &&
          (llm?.available ? (
            <span className="hero-chip" title="Les règles et Claude sont disponibles pour l’extraction.">
              Règles + Claude
            </span>
          ) : (
            <Link className="hero-chip hero-chip-link" to="/claude">
              Règles seules · Activer Claude
            </Link>
          ))}
        <div className="eyebrow">Espace de recherche</div>
        <h1>Plan de travail</h1>
        <p className="sub">
          Constituer un corpus de dossiers, le lire à travers une fiche
          d’exploitation paramétrable, puis en tirer un jeu de données
          exploitable. Chaque outil travaille sur les mêmes dossiers ; prenez
          celui dont vous avez besoin.
        </p>

        <div className="figures">
          <div className="figure-block">
            <span className="figure">{number(patients)}</span>
            <span className="label">Dossiers</span>
          </div>
          <div className="figure-block">
            <span className="figure">{number(documents)}</span>
            <span className="label">Documents</span>
          </div>
          <div className="figure-block">
            <span className="figure">{number(fields)}</span>
            <span className="label">Variables</span>
          </div>
          <div className="figure-block">
            <span className="figure">{loading ? '—' : `${completeness} %`}</span>
            <span className="label">Remplissage</span>
          </div>
        </div>
      </section>

      {error && <ErrorPanel message={error} onRetry={refresh} />}

      {!loading && !error && templateName === null && (
        <div className="notice notice-warn">
          <div>
            Aucune fiche d’exploitation active. Les outils d’analyse restent
            vides tant que les variables de l’étude ne sont pas définies.{' '}
            <Link to="/fiche">Ouvrir la fiche d’exploitation</Link>.
          </div>
        </div>
      )}

      {!loading && !error && unreadable > 0 && (
        <div className="notice notice-warn">
          <div>
            {unreadable} document{unreadable > 1 ? 's' : ''} sans texte
            exploitable. L’extraction ne peut rien y trouver ; le détail du
            dossier indique la cause.
          </div>
        </div>
      )}

      <section>
        <h2 style={{ marginBottom: 12 }}>Corpus</h2>
        <div className="bento">
          <ToolCard
            to="/dossiers"
            icon={IconFolders}
            title="Dossiers patients"
            description="Importer une arborescence, suivre les documents de chaque dossier et repérer ceux qui n’ont pas pu être lus."
            figure={number(patients)}
            unit={patients > 1 ? 'dossiers importés' : 'dossier importé'}
          />
          <ToolCard
            to="/fiche"
            icon={IconForm}
            title="Fiche d’exploitation"
            description="Définir les variables de l’étude, leur type et la façon dont elles se retrouvent dans les documents. Un banc d’essai teste chaque règle avant de l’enregistrer."
            figure={number(fields)}
            unit={templateName ? `variables · ${templateName}` : 'variables'}
          />
          <ToolCard
            to="/extraction"
            icon={IconExtract}
            tone="violet"
            title="Extraction"
            description="Appliquer la fiche à tous les dossiers, par règles, par Claude, ou les deux. Chaque valeur garde le document et l’extrait qui la justifient."
            figure={loading ? '—' : llm?.available ? '3' : '1'}
            unit={loading ? '' : llm?.available ? "modes d’extraction" : "mode d’extraction (règles)"}
          />
        </div>
      </section>

      <section>
        <h2 style={{ marginBottom: 12 }}>Littérature</h2>
        <div className="bento">
          <ToolCard
            to="/bibliographie"
            icon={IconBook}
            title="Revue bibliographique"
            description="Interroger PubMed et Google Scholar par des acteurs Apify, regrouper les doublons, trier chaque référence avec son motif d’exclusion, puis exporter en RIS, BibTeX ou CSV. Chaque recherche garde sa chaîne exacte et sa date."
            span="b-12"
            figure={references === null ? undefined : references.toLocaleString('fr-FR')}
            unit={references === null ? undefined : references > 1 ? 'références dans la bibliothèque' : 'référence dans la bibliothèque'}
          />
        </div>
      </section>

      <section>
        <h2 style={{ marginBottom: 12 }}>Analyse et sortie</h2>
        <div className="bento">
          <ToolCard
            to="/resultats?vue=table"
            icon={IconTable}
            title="Tableau de données"
            description="Le jeu de données complet, un dossier par ligne, avec l’origine de chaque valeur."
            figure={number(patients * fields)}
            unit="cellules"
          />
          <ToolCard
            to="/resultats?vue=charts"
            icon={IconChart}
            title="Distributions"
            description="Une distribution par variable : histogramme pour le quantitatif, effectifs pour le qualitatif, chronologie pour les dates."
            figure={number(fields)}
            unit="variables décrites"
          />
          <ToolCard
            to="/resultats?vue=completeness"
            icon={IconGauge}
            title="Complétude"
            description="Le taux de remplissage variable par variable, et la part relue à la main : où porter l’effort."
            figure={loading ? '—' : `${completeness} %`}
            unit="du tableau renseigné"
          />
          <ToolCard
            to="/resultats?vue=export"
            icon={IconExport}
            tone="accent"
            title="Export"
            description="Jeu de données en CSV ou en classeur Excel, dictionnaire des variables, figures en diaporama, rapport « Méthodes et traçabilité » avec son journal d’audit, et fiche au format JSON pour la transporter d’un poste à l’autre."
            span="b-8"
            figure={EXPORTS.length}
            unit="formats de sortie"
          />
        </div>
      </section>
    </div>
  );
}
