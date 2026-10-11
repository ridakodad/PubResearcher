/**
 * La vidéo de présentation : l'application réelle, filmée sur les dossiers fictifs de la démonstration.
 *
 * Elle est montrée une fois, à la première inscription, avant le parcours d'accueil (et reste disponible sur la page
 * d'accueil et la page d'accès). Vidéo sans son, aux sous-titres incrustés : le déroulé ci-dessous en est l'équivalent
 * texte, pour qui ne la regarde pas (WCAG 1.2.1).
 */
export const INTRO_VIDEO = {
  src: '/video/presentation-pubresearcher.mp4',
  /** H.264 High, niveau 4.0 : annoncé avec son codec, pour qu'un navigateur qui ne le lit pas passe à la version WebM. */
  type: 'video/mp4; codecs="avc1.640028"',
  /** VP9 : pour les navigateurs sans H.264 (Chromium libre, certains Firefox sous Linux). */
  webm: '/video/presentation-pubresearcher.webm',
  webmType: 'video/webm; codecs="vp9"',
  poster: '/video/presentation-pubresearcher-affiche.jpg',
  duration: '1 min 35',
  size: '3,9 Mo',
  width: 1280,
  height: 720,
} as const;

/** Ce que montre la vidéo, plan par plan, avec ses sous-titres entre guillemets. */
export const INTRO_TRANSCRIPT: readonly string[] = [
  'Titre : « PubResearcher — de la pile de dossiers patients au tableau prêt à analyser. »',
  'Le plan de travail : 20 dossiers fictifs déjà importés, 96 documents, 22 variables, 0 % de remplissage. « Votre étude rétrospective, de bout en bout, sur votre ordinateur. »',
  'La fiche d’exploitation : la liste des variables, chacune avec ses règles d’extraction. « Décrivez vos variables — âge, CRP, traitement… — et la règle qui trouve chacune. »',
  'L’import : « Importez les dossiers : Word, PDF — même scannés —, images, DICOM. » La charte d’anonymisation s’affiche d’abord ; ses cinq engagements sont cochés, puis confirmés. Un dossier qui contient quatre dossiers patients est choisi : l’outil les reconnaît et importe leurs 17 documents. « Un dossier par patient : son nom devient le code du dossier. »',
  'L’extraction : « Lancez l’extraction : chaque valeur est retrouvée dans le texte des documents. » Bilan : 500 valeurs extraites, 28 non trouvées.',
  'La relecture du dossier PAT-001 : la justification d’une valeur (délai de consultation : 10 jours) est dépliée, et le passage est surligné dans le texte de l’observation médicale. « Vérifiez : chaque valeur garde l’extrait du document qui la justifie. »',
  'Les résultats : le tableau de données (24 dossiers, 95 % de complétude), puis les distributions. « Analysez : tableau, distributions, complétude — calculés sur les mêmes données. »',
  'L’export : classeur Excel, figures en diaporama, rapport « Méthodes et traçabilité ». « Exportez vers Excel, R ou SPSS, avec un rapport « Méthodes » prêt à citer. »',
  'Claude, en option : la page « Activer Claude » et ses étapes. « En option, Claude lit le texte rédigé — avec votre propre clé, payée à l’usage. »',
  'Retour au plan de travail : 24 dossiers, 113 documents, 95 % de remplissage. « 24 dossiers, 95 % de variables remplies, chacune avec sa source : prêt pour l’analyse. »',
  'Fin : « Gratuit, sur votre ordinateur. Par défaut, rien ne quitte votre ordinateur. Essayez-le d’abord avec les 24 dossiers fictifs fournis. »',
];

/**
 * « Déjà vue » vaut pour la session de navigation, dans `sessionStorage` (clés `pr:`) : `localStorage` ne garde que le
 * choix du thème, et aucun identifiant de compte ne s'écrit dans le navigateur. Recharger la page au milieu du parcours
 * ne remontre pas la vidéo ; revenir un autre jour sans avoir commencé son profil, si.
 */
const SEEN_KEY = 'pr:presentation-vue';

export function introSeen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

export function markIntroSeen(): void {
  try {
    sessionStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Sans stockage, la vidéo pourra simplement réapparaître au prochain chargement.
  }
}
