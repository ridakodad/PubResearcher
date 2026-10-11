/**
 * Charte d'anonymisation : ce que l'on s'engage à avoir fait *avant* de déposer des données de patients.
 *
 * Copie du texte de l'application (web/src/lib/anonymisation.ts) : ce site est un projet autonome, qui ne peut pas
 * importer le code de l'application pour se déployer seul. Un test (server/test/landing-logic.test.ts) compare les
 * deux fichiers : le texte confirmé ici est exactement celui que l'application redemande avant l'import.
 *
 * Quand le texte change sur le fond, changer `ANONYMISATION_VERSION` dans les deux fichiers : l'engagement est alors
 * redemandé, ici (nouvelle ligne dans `consents`) comme dans l'application.
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

/** Vrai quand chaque engagement de la charte est coché. */
export function allConfirmed(checked: ReadonlySet<string>): boolean {
  return CHARTER_ITEMS.every((item) => checked.has(item.id));
}
