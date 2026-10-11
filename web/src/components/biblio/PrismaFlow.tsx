import type { ReactNode } from 'react';
import type { BiblioPrisma, ExclusionReason, PrismaCategory } from '../../lib/types';
import { IconArrow } from '../icons';

/**
 * Diagramme de flux, inspiré de PRISMA 2020.
 *
 * Aucun chiffre n'est saisi : les notices identifiées et les doublons viennent
 * des recherches et des imports réussis, le reste de l'état de tri. Chaque
 * source se range dans sa colonne PRISMA — bases de données, registres, autres
 * méthodes (Google Scholar, recherche de citations, sites) — et une notice
 * rendue plusieurs fois par la même source (équation relancée) n'y compte
 * qu'une fois. Le diagramme suit les *références* de titre et de résumé ;
 * l'évaluation sur texte intégral n'est pas suivie ici, et le dit.
 */

const CATEGORIES: { key: PrismaCategory; label: string }[] = [
  { key: 'database', label: 'Bases de données' },
  { key: 'register', label: 'Registres' },
  { key: 'other', label: 'Autres méthodes' },
];

function Stage({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="prisma-stage">
      <h3 className="prisma-label">{label}</h3>
      <div className="prisma-content">{children}</div>
    </section>
  );
}

function Figure({ value, label, strong }: { value: number; label: string; strong?: boolean }) {
  return (
    <div className={strong ? 'prisma-figure prisma-figure-strong' : 'prisma-figure'}>
      <span className="prisma-value">{value.toLocaleString('fr-FR')}</span>
      <span className="prisma-caption">{label}</span>
    </div>
  );
}

const Connector = () => (
  <div className="prisma-connector" aria-hidden="true">
    <IconArrow size={18} />
  </div>
);

export function PrismaFlow({
  prisma,
  reasons,
}: {
  prisma: BiblioPrisma;
  reasons: Record<ExclusionReason, string>;
}) {
  const total = Math.max(prisma.screened, 1);
  const segments = [
    { key: 'include', label: 'Retenues', value: prisma.included },
    { key: 'maybe', label: 'À voir', value: prisma.maybe },
    { key: 'exclude', label: 'Exclues', value: prisma.excluded },
    { key: 'pending', label: 'À trier', value: prisma.pending },
  ];

  return (
    <div className="prisma">
      <Stage label="Identification">
        {CATEGORIES.map(({ key, label }) => {
          const rows = prisma.bySource.filter((r) => r.category === key);
          if (rows.length === 0) return null;
          const total = rows.reduce((sum, r) => sum + r.count, 0);
          return (
            <div key={key} className="prisma-group">
              <div className="small secondary">
                {label} : <strong>{total.toLocaleString('fr-FR')}</strong>
              </div>
              <div className="prisma-figures">
                {rows.map((row) => (
                  <Figure key={row.source} value={row.count} label={row.label} />
                ))}
              </div>
            </div>
          );
        })}
        <div className="prisma-figures">
          <Figure value={prisma.identified} label="notices identifiées" strong />
        </div>
        <p className="prisma-line">
          Doublons retirés : <strong>{prisma.duplicatesRemoved.toLocaleString('fr-FR')}</strong>
          <span className="muted">
            {' '}
            — repérés par DOI, PMID, PMCID ou titre, entre sources et à l’intérieur d’un même fichier. Une
            recherche relancée ne compte pas deux fois ses notices.
          </span>
        </p>
      </Stage>

      <Connector />

      <Stage label="Tri sur titre et résumé">
        <div className="prisma-figures">
          <Figure value={prisma.screened} label="références uniques à trier" strong />
        </div>

        <div
          className="prisma-bar"
          role="img"
          aria-label={segments.map((s) => `${s.label} : ${s.value}`).join(', ')}
        >
          {segments.map(
            (segment) =>
              segment.value > 0 && (
                <span
                  key={segment.key}
                  className={`prisma-seg prisma-seg-${segment.key}`}
                  style={{ width: `${(segment.value / total) * 100}%` }}
                />
              ),
          )}
        </div>
        <ul className="prisma-legend">
          {segments.map((segment) => (
            <li key={segment.key}>
              <span className={`prisma-swatch prisma-seg-${segment.key}`} aria-hidden="true" />
              <span className="prisma-legend-label">{segment.label}</span>
              <span className="prisma-legend-value">{segment.value.toLocaleString('fr-FR')}</span>
            </li>
          ))}
        </ul>

        {prisma.excluded > 0 && (
          <div className="prisma-reasons">
            <div className="small secondary">Exclusions, par motif</div>
            <ul>
              {prisma.excludedByReason.map((entry) => (
                <li key={entry.reason}>
                  <span>{entry.reason === 'unspecified' ? 'Motif non précisé' : reasons[entry.reason]}</span>
                  <strong>{entry.count.toLocaleString('fr-FR')}</strong>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Stage>

      <Connector />

      <Stage label="Inclusion">
        <div className="prisma-figures">
          <Figure value={prisma.included} label="références retenues" strong />
        </div>
        <p className="prisma-line muted">
          Le diagramme compte des références, pas des textes intégraux : l’évaluation de l’éligibilité
          sur texte complet reste à consigner hors de cet outil.
        </p>
      </Stage>
    </div>
  );
}
