/**
 * Le guide « Activer Claude » : obtenir sa clé d'API Anthropic sans se perdre.
 *
 * Le même texte sert à l'application (page « Activer Claude ») et au site public (page du même nom) : un test vérifie
 * que les deux copies de ce fichier sont identiques. Chaque lien mène directement à la bonne page de la console
 * d'Anthropic (adresses vérifiées en octobre 2026 contre la documentation d'Anthropic) ; les mots entre guillemets
 * sont ceux, en anglais, de la console.
 */

export const CONSOLE_URL = 'https://platform.claude.com/';
export const BILLING_URL = 'https://platform.claude.com/settings/billing';
export const KEYS_URL = 'https://platform.claude.com/settings/keys';

export const GUIDE_TITLE = 'Activer Claude';

/** Ce que fait Claude, en une phrase (début de l'introduction, seul quand la clé est déjà en service). */
export const GUIDE_WHAT = 'Claude lit le texte rédigé des comptes rendus, là où les règles ne trouvent aucun libellé.';

export const GUIDE_INTRO = `${GUIDE_WHAT} Pour l’utiliser, il vous faut une clé d’API Anthropic : une sorte de mot de passe qui permet à PubResearcher de faire travailler Claude pour vous. Comptez cinq minutes, une seule fois.`;

export const GUIDE_COST =
  'PubResearcher est gratuit. Claude se paie à l’usage, directement à Anthropic, l’entreprise qui le développe : avec le modèle par défaut, de 0,05 à 0,20 $US par dossier ordinaire. 5 $US de crédit suffisent pour l’essayer sur quelques dizaines de dossiers, et le coût de chaque passe s’affiche avant que vous la lanciez.';

export interface GuideStep {
  id: 'compte' | 'credit' | 'cle';
  title: string;
  /** Durée indicative, en minutes. */
  minutes: number;
  /** Ce qu'il faut faire, une phrase par geste. */
  actions: readonly string[];
  link: { href: string; label: string };
  /** La précision qui évite de se tromper. */
  tip?: string;
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: 'compte',
    title: 'Créez votre compte Anthropic',
    minutes: 2,
    actions: [
      'Ouvrez la console d’Anthropic et créez un compte, avec votre adresse e-mail ou votre compte Google. Si vous en avez déjà un, connectez-vous.',
      'Si l’on vous demande le nom d’une organisation, indiquez votre nom ou celui de votre équipe.',
    ],
    link: { href: CONSOLE_URL, label: 'Ouvrir la console d’Anthropic' },
    tip: 'Un abonnement à Claude (claude.ai) ne remplace pas ce compte : l’API se règle à part, dans la console.',
  },
  {
    id: 'credit',
    title: 'Ajoutez du crédit',
    minutes: 1,
    actions: [
      'Dans la page de facturation (« Billing »), achetez du crédit : 5 $US suffisent pour commencer.',
      'Sans recharge automatique (« auto-reload »), vous ne pourrez jamais dépenser plus que ce crédit.',
      'Facultatif : dans la même page, « Spend limits » fixe un plafond de dépenses mensuel.',
    ],
    link: { href: BILLING_URL, label: 'Ouvrir la page de facturation' },
  },
  {
    id: 'cle',
    title: 'Créez votre clé',
    minutes: 1,
    actions: [
      'Dans la page des clés (« API keys »), cliquez sur « Create key ».',
      'Nom : PubResearcher. Expiration : « Never » (jamais) si la console le propose, sinon la durée la plus longue. Si l’on vous demande un espace de travail (« workspace »), choisissez « Default Workspace ». Laissez le reste tel quel.',
      'Copiez la clé tout de suite : elle commence par « sk-ant- » et ne s’affiche qu’une seule fois.',
    ],
    link: { href: KEYS_URL, label: 'Ouvrir la page des clés' },
    tip: 'Le bouton « Create key » est grisé ? Votre compte appartient à une organisation qui réserve ce droit : demandez la clé à son administrateur.',
  },
];

/** La dernière étape : dans l'application, un champ ; sur le site, l'endroit où aller. */
export const PASTE_STEP = {
  title: 'Collez-la dans PubResearcher',
  inApp: 'Collez la clé ci-dessous : PubResearcher la fait vérifier par Anthropic avant de l’enregistrer. Une clé refusée l’est avec sa raison, et rien n’est gardé.',
  onSite:
    'Dans l’application, ouvrez la page « Activer Claude » (dans la colonne de gauche) et collez la clé à l’étape 4. Elle reste sur votre ordinateur : ne la collez jamais ailleurs, ni sur ce site, ni dans un e-mail.',
} as const;

export const GUIDE_HELP: readonly { question: string; answer: string }[] = [
  {
    question: 'Anthropic refuse ma clé',
    answer: 'Recopiez-la en entier, d’un seul tenant. Une clé ne se réaffiche jamais : si vous l’avez perdue, créez-en une autre et supprimez l’ancienne.',
  },
  {
    question: 'On me dit « Crédit épuisé »',
    answer: 'Ajoutez du crédit dans la page de facturation, puis relancez : une passe interrompue n’efface rien.',
  },
  {
    question: 'Ma clé a expiré',
    answer: 'Créez-en une nouvelle et collez-la à l’étape 4 : elle remplace l’ancienne.',
  },
  {
    question: 'Je préfère me passer de Claude',
    answer: 'C’est possible : le mode « Règles seules » est gratuit, fonctionne sans connexion, et rien ne quitte votre ordinateur.',
  },
  {
    question: 'Et les données des patients ?',
    answer: 'Avec Claude, le texte des documents part chez Anthropic. N’envoyez que des documents anonymisés, et seulement si l’autorisation de votre étude couvre ce transfert.',
  },
];
