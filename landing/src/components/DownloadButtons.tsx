import { config } from '../lib/config';

/** Archives prêtes à l'emploi publiées avec chaque version (voir .github/workflows/package.yml). */
const TARGETS = [
  { id: 'win-x64', label: 'Windows', ext: 'zip', hint: 'Windows 10 ou 11' },
  { id: 'mac-arm64', label: 'Mac (Apple M1 à M4)', ext: 'zip', hint: 'Mac récent, puce Apple' },
  { id: 'mac-x64', label: 'Mac (Intel)', ext: 'zip', hint: 'Mac d’avant 2021' },
  { id: 'linux-x64', label: 'Linux', ext: 'tar.gz', hint: 'x64, glibc' },
] as const;

type TargetId = (typeof TARGETS)[number]['id'];

function detect(): TargetId {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'win-x64';
  if (/Mac/i.test(ua)) return 'mac-arm64';
  if (/Linux/i.test(ua) && !/Android/i.test(ua)) return 'linux-x64';
  return 'win-x64';
}

const fileUrl = (id: string, ext: string) =>
  `${config.repoUrl}/releases/download/v${config.version}/PubResearcher-${config.version}-${id}.${ext}`;

export function DownloadButtons() {
  const mine = TARGETS.find((t) => t.id === detect())!;
  const others = TARGETS.filter((t) => t.id !== mine.id);
  return (
    <div className="download">
      <a className="btn btn-primary btn-lg" href={fileUrl(mine.id, mine.ext)}>
        Télécharger pour {mine.label}
      </a>
      <p className="small muted">
        Version {config.version} · {mine.hint} · non signée : au premier lancement, Windows peut afficher « Informations
        complémentaires › Exécuter quand même » ; sur Mac, clic droit › Ouvrir.
      </p>
      <p className="small">
        Autre système :{' '}
        {others.map((t, i) => (
          <span key={t.id}>
            {i > 0 && ' · '}
            <a href={fileUrl(t.id, t.ext)}>{t.label}</a>
          </span>
        ))}
      </p>
      <ol className="small download-steps">
        <li>Ouvrez le fichier téléchargé et choisissez « Extraire tout ».</li>
        <li>Dans le dossier extrait, double-cliquez sur <strong>PubResearcher</strong> (PubResearcher.cmd sous Windows).</li>
        <li>L’application s’ouvre dans votre navigateur. Vos données restent sur votre ordinateur.</li>
      </ol>
    </div>
  );
}
