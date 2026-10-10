/**
 * Jeu d'icônes, dessiné en SVG plutôt qu'emprunté aux émojis.
 *
 * Un émoji change de dessin selon le système, ne suit pas la couleur du texte
 * et se lit à voix haute par les lecteurs d'écran. Ces tracés héritent de
 * `currentColor`, se redimensionnent proprement, et restent muets : le libellé
 * voisin porte le sens.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function Svg({
  size = 20,
  className,
  children,
}: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Plan de travail : la vue d'ensemble des outils. */
export function IconWorkspace(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
      <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
    </Svg>
  );
}

/** Dossiers patients. */
export function IconFolders(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 7.5a2 2 0 0 1 2-2h3.4a2 2 0 0 1 1.6.8l.9 1.2H19a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
      <path d="M3 11h18" />
    </Svg>
  );
}

/** Fiche d'exploitation : la liste des variables de l'étude. */
export function IconForm(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="3" width="15" height="18" rx="2" />
      <path d="M9 3.8V5a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V3.8" />
      <path d="M8.5 11h7M8.5 15h4.5" />
    </Svg>
  );
}

/** Extraction : la passe qui remplit la fiche à partir des documents. */
export function IconExtract(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 3.5 6 6.2 8.7 7.2 6 8.2 5 11 4 8.2 1.3 7.2 4 6.2Z" />
      <path d="M16 3.5 16.7 5.4 18.6 6.1 16.7 6.8 16 8.7 15.3 6.8 13.4 6.1 15.3 5.4Z" />
      <path d="M12.5 10.5 14 14.5 18 16 14 17.5 12.5 21.5 11 17.5 7 16 11 14.5Z" />
    </Svg>
  );
}

/** Tableau de données brut. */
export function IconTable(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9.5h18M9.5 9.5V20M3 14.8h18" />
    </Svg>
  );
}

/** Distributions : un bâton par classe. */
export function IconChart(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <rect x="7.5" y="12" width="3.2" height="5" rx="1" />
      <rect x="13" y="8" width="3.2" height="9" rx="1" />
      <rect x="18.5" y="14" width="0.1" height="3" rx="0.05" />
    </Svg>
  );
}

/** Complétude : où porter l'effort de relecture. */
export function IconGauge(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 17a8 8 0 1 1 16 0" />
      <path d="M12 17l4-4.5" />
      <circle cx="12" cy="17" r="1.4" />
    </Svg>
  );
}

/** Export du jeu de données. */
export function IconExport(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5v10.5" />
      <path d="m8 10.5 4 4 4-4" />
      <path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2" />
    </Svg>
  );
}

/** Document importé. */
export function IconDocument(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z" />
      <path d="M13.5 3v4.5a1 1 0 0 0 1 1H19" />
    </Svg>
  );
}

/** Revue bibliographique : un livre ouvert sur une loupe — chercher, puis lire. */
export function IconBook(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 5.2A1.2 1.2 0 0 1 5.2 4H10a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5.2A1.2 1.2 0 0 1 4 15.8Z" />
      <path d="M20 5.2A1.2 1.2 0 0 0 18.8 4H14a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h4.8a1.2 1.2 0 0 0 1.2-1.2Z" />
      <path d="M7 8.5h2M7 11.5h2M15 8.5h2M15 11.5h2" />
    </Svg>
  );
}

/** Lien sortant : ouvre la source dans un nouvel onglet. */
export function IconExternal(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11 13" />
      <path d="M17.5 14v3.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2H10" />
    </Svg>
  );
}

/** Passage à l'outil : le chevron des cartes du plan de travail. */
export function IconArrow(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h13" />
      <path d="m12.5 6.5 5.5 5.5-5.5 5.5" />
    </Svg>
  );
}

/** Avertissement : accompagne un message, ne le remplace jamais. */
export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.3 3.9 2.6 17.2a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9.5v4" />
      <path d="M12 17h.01" />
    </Svg>
  );
}

/** Chevron d'ouverture : pointe à droite fermé, vers le bas ouvert. */
export function IconChevron(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9 5.5 6.5 6.5L9 18.5" />
    </Svg>
  );
}

/** Repli et déploiement du rail d'outils. */
export function IconSidebar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9.5 4v16" />
    </Svg>
  );
}

/** Renommage d'un document. */
export function IconRename(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.5 4.5 19.5 9.5" />
      <path d="M4 20h4l11-11a2.1 2.1 0 0 0-3-3L5 17Z" />
    </Svg>
  );
}

/** Rédaction assistée : l'échange avec le modèle. */
export function IconWrite(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20.5 12a8 8 0 0 1-8 8H4.5l2-3a8 8 0 1 1 14-5Z" />
      <path d="M8.5 10h8M8.5 14h5" />
    </Svg>
  );
}

/** Information de contexte, sans caractère d'alerte. */
export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <path d="M12 7.8h.01" />
    </Svg>
  );
}

/** Résultat trouvé au banc d'essai. */
export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Svg>
  );
}

/** Aucun résultat : la règle n'a rien accroché. */
export function IconEmpty(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m6 6 12 12" />
    </Svg>
  );
}

/** Fermeture d'une fenêtre modale. */
export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </Svg>
  );
}

export function IconSun(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </Svg>
  );
}

export function IconMoon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
    </Svg>
  );
}

/** Thème suivant le système : un disque à moitié plein. */
export function IconAuto(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5a8.5 8.5 0 0 1 0 17Z" fill="currentColor" stroke="none" />
    </Svg>
  );
}
