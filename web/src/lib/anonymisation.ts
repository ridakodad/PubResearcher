/**
 * Charte d'anonymisation : ce que l'on s'engage à avoir fait *avant* de déposer des données de patients.
 *
 * L'outil n'anonymise rien et ne peut pas le vérifier (voir docs/securite-et-donnees.md). Cette charte est donc un
 * rappel, qui se confirme avant l'import — pas un contrôle. Le même texte est repris par le parcours d'accueil du site
 * (landing/src/lib/charter.ts) : un test compare les deux fichiers, pour qu'ils ne divergent jamais.
 *
 * Quand le texte change sur le fond, changer `ANONYMISATION_VERSION` : l'engagement est alors redemandé.
 */

export const ANONYMISATION_VERSION = '2026-10-v1';

export interface CharterItem {
  id: string;
  /** Une phrase à la première personne : c'est un engagement, pas une consigne. */
  text: string;
}

export const CHARTER_TITLE = 'Avant d’importer des données de patients';

export const CHARTER_LEAD =
  'PubResearcher n’anonymise rien : ce que vous importez est lu, conservé et — si vous activez certaines fonctions — transmis tel quel.';

export const CHARTER_ITEMS: readonly CharterItem[] = [
  {
    id: 'identifiants',
    text:
      'J’ai retiré des documents les identifiants directs : nom et prénom, date de naissance complète, numéro d’identité (CIN, passeport…), numéro de dossier ou d’IPP de l’établissement, adresse, téléphone, e-mail, photo du visage.',
  },
  {
    id: 'angles-morts',
    text:
      'J’ai vérifié les endroits que l’on oublie : en-têtes et pieds de page, tampons et signatures, noms de fichiers, texte incrusté dans les images et les scans, balises des fichiers DICOM (nom, identifiant, date de naissance, établissement, médecin).',
  },
  {
    id: 'codes',
    text:
      'Chaque dossier porte un code d’étude sans lien avec l’identité (ni initiales, ni date de naissance, ni numéro de dossier hospitalier) ; la table de correspondance code ↔ identité est conservée ailleurs, sous mon contrôle.',
  },
  {
    id: 'autorisation',
    text:
      'Je sais que des données seulement pseudonymisées restent en général des données personnelles de santé : j’ai la base légale et les autorisations nécessaires (comité d’éthique ; RGPD, ou loi n° 09-08 et CNDP au Maroc).',
  },
  {
    id: 'transferts',
    text:
      'Je n’activerai le mode « Claude » que si l’autorisation couvre l’envoi du texte des documents à l’API d’Anthropic, et je n’écrirai aucune donnée de patient dans une équation de recherche bibliographique.',
  },
];

export const CHARTER_DISCLAIMER =
  'Cet outil n’est pas un dispositif d’anonymisation. Il ne remplace ni votre délégué à la protection des données, ni votre comité d’éthique, et ne constitue pas un conseil juridique.';

/** Clé du réglage du navigateur où l'engagement est mémorisé. */
export const ACK_KEY = 'anonymisation:ack';

export interface Acknowledgement {
  version: string;
  /** Instant de la confirmation, en ISO 8601. */
  at: string;
}

/** Lit la valeur stockée ; tout ce qui n'a pas la forme attendue vaut « pas d'engagement ». */
export function parseAcknowledgement(raw: string | null): Acknowledgement | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { version, at } = value as Record<string, unknown>;
    if (typeof version !== 'string' || typeof at !== 'string' || Number.isNaN(Date.parse(at))) return null;
    return { version, at };
  } catch {
    return null;
  }
}

/** L'engagement vaut pour la version courante du texte seulement : une version plus ancienne est redemandée. */
export function isAcknowledged(raw: string | null, version: string = ANONYMISATION_VERSION): boolean {
  return parseAcknowledgement(raw)?.version === version;
}

export function serialiseAcknowledgement(now: Date, version: string = ANONYMISATION_VERSION): string {
  return JSON.stringify({ version, at: now.toISOString() } satisfies Acknowledgement);
}

/** Vrai quand chaque engagement de la charte est coché. */
export function allConfirmed(checked: ReadonlySet<string>): boolean {
  return CHARTER_ITEMS.every((item) => checked.has(item.id));
}
