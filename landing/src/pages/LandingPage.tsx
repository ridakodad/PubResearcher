import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { CodeBlock } from '../components/CodeBlock';
import { IntroVideo } from '../components/IntroVideo';
import { ThemedShot } from '../components/ThemedShot';
import {
  IconArrow,
  IconBook,
  IconChart,
  IconCheck,
  IconDocument,
  IconEmpty,
  IconExport,
  IconExtract,
  IconFolders,
  IconForm,
  IconLaptop,
  IconShield,
} from '../components/icons';
import { useAuth } from '../lib/auth';
import { CHARTER_ITEMS } from '../lib/charter';
import { config } from '../lib/config';
import { usePageTitle } from '../lib/usePageTitle';

/**
 * Page d'accueil.
 *
 * Le fil : ce que fait l'outil → le parcours pour y entrer → ce qu'il faut savoir sur les données avant d'y mettre
 * quoi que ce soit → comment l'installer → les questions qu'on se pose. Les chiffres et les formats cités sont ceux
 * de la documentation de l'application (README.md, docs/securite-et-donnees.md) : rien n'est promis ici que
 * l'application ne fait pas.
 */

const TOOLS = [
  {
    icon: IconFolders,
    tone: '',
    title: 'Dossiers patients',
    text: 'Glissez une arborescence : chaque sous-dossier devient un dossier patient. Word, PDF (scannés compris), images, DICOM, texte.',
  },
  {
    icon: IconForm,
    tone: '',
    title: 'Fiche d’exploitation',
    text: 'Les variables de votre étude, avec leur type, leur unité, leurs bornes de plausibilité et la façon de les retrouver dans les documents. Un banc d’essai teste chaque règle avant de l’enregistrer.',
  },
  {
    icon: IconExtract,
    tone: 'violet',
    title: 'Extraction',
    text: 'Par des règles que vous paramétrez, par Claude (facultatif) ou par les deux. Ce que les règles écartent est consigné avec sa raison : l’outil préfère un vide à une valeur fausse.',
  },
  {
    icon: IconDocument,
    tone: '',
    title: 'Relecture traçable',
    text: 'Dossier par dossier, chaque variable montre son origine, l’extrait du document qui la justifie et son historique. Une valeur relue à la main n’est jamais écrasée.',
  },
  {
    icon: IconChart,
    tone: '',
    title: 'Fiabilité et résultats',
    text: 'Concordance et rappel de l’extraction avec leur intervalle de confiance à 95 %, distributions par variable, complétude, tableau de données complet.',
  },
  {
    icon: IconExport,
    tone: 'accent',
    title: 'Exports et rapport « Méthodes »',
    text: 'CSV, classeur Excel typé, dictionnaire des variables, figures en diaporama, et un rapport « Méthodes et traçabilité » prêt à citer, avec son journal d’audit.',
  },
] as const;

const STEPS = [
  {
    title: 'Créez votre accès',
    text: 'Avec votre compte Google ou une adresse e-mail. Une minute.',
  },
  {
    title: 'Décrivez votre étude',
    text: 'Votre fonction, le type d’étude, où l’outil tournera, où en est l’autorisation éthique. Ces réponses servent à vous donner les bons rappels, pas à vous évaluer.',
  },
  {
    title: 'Prenez l’engagement d’anonymisation',
    text: 'Cinq engagements à confirmer, enregistrés avec la date et la version du texte. L’application vous les redemandera avant votre premier import.',
  },
  {
    title: 'Ouvrez l’application',
    text: 'Elle tourne sur votre ordinateur. Premier lancement : deux minutes, le temps d’installer ses dépendances.',
  },
] as const;

/** Titre court et précision de chaque engagement de la charte (le texte complet est dans `CHARTER_ITEMS`). */
const COMMITMENTS: Record<string, { title: string; gloss: string }> = {
  identifiants: {
    title: 'Retirer les identifiants directs',
    gloss: 'Nom, prénom, date de naissance complète, CIN, numéro de dossier, adresse, téléphone, e-mail, visage.',
  },
  'angles-morts': {
    title: 'Vérifier les angles morts',
    gloss: 'En-têtes et pieds de page, tampons, noms de fichiers, texte dans les scans, balises DICOM.',
  },
  codes: {
    title: 'Coder chaque dossier',
    gloss: 'Un code d’étude sans lien avec l’identité ; la table de correspondance reste ailleurs, sous votre contrôle.',
  },
  autorisation: {
    title: 'Avoir les autorisations',
    gloss: 'Comité d’éthique ; RGPD, ou loi n° 09-08 et CNDP au Maroc. Pseudonymisé ne veut pas dire anonyme.',
  },
  transferts: {
    title: 'Ne rien transmettre sans autorisation',
    gloss: 'Pas de mode « Claude » sans accord pour l’envoi des textes ; aucune donnée de patient dans une équation de recherche.',
  },
};

const KEPT = [
  'Votre nom et votre adresse e-mail (ou, avec Google, le nom, l’adresse et la photo de votre compte)',
  'Votre fonction, votre établissement, votre pays',
  'Le type d’étude, l’ordre de grandeur du nombre de dossiers, l’état de l’autorisation',
  'La version de la charte que vous avez confirmée, et la date',
];

const NEVER = [
  'Un document de patient, un nom de patient, une valeur extraite',
  'Le contenu de votre base de données, qui reste sur votre ordinateur',
  'Vos équations de recherche bibliographique',
  'Aucun cookie publicitaire, aucun outil de mesure d’audience',
];

const FAQ: readonly { q: string; a: ReactNode }[] = [
  {
    q: 'Dois-je créer un compte pour utiliser l’application ?',
    a: 'Non. L’application tourne sur votre ordinateur et ne demande aucun compte. Ce site est sa porte d’entrée : il présente l’outil, enregistre l’engagement d’anonymisation que vous prenez et vous mène à l’application, qui le redemande avant le premier import.',
  },
  {
    q: 'Combien cela coûte-t-il ?',
    a: (
      <>
        L’application ne coûte rien. Seules les fonctions de Claude, facultatives — l’extraction et la rédaction assistée —,
        ont un coût : vous enregistrez dans l’application votre propre clé d’API Anthropic et payez Anthropic directement,
        à l’usage, de l’ordre de 0,05 à 0,20{'\u00a0'}$US par dossier ordinaire avec le modèle par défaut. Chaque passe est
        chiffrée avant d’être lancée, et PubResearcher ne prélève rien au passage. Le guide{' '}
        <Link to="/activer-claude">Activer Claude</Link> vous mène pas à pas jusqu’à votre clé. La revue bibliographique
        passe, de même, par votre propre compte Apify.
      </>
    ),
  },
  {
    q: 'Mes dossiers patients sont-ils envoyés quelque part ?',
    a: 'Pas par défaut : l’application n’écoute que sur votre ordinateur et n’envoie rien hors de la machine. Trois fonctions facultatives font sortir des données si vous les configurez : l’extraction par Claude (texte des documents), la rédaction assistée (agrégats de la cohorte) et la revue bibliographique (équation de recherche). Le mode « Règles seules » reste entièrement local.',
  },
  {
    q: 'PubResearcher anonymise-t-il mes documents ?',
    a: 'Non. Il ne détecte ni ne retire aucun identifiant : ce qu’il lit est ce qu’il stocke. Importez des documents déjà anonymisés ou pseudonymisés, avec un code d’étude sans lien avec l’identité. Des données seulement pseudonymisées restent en général des données personnelles de santé : il faut les autorisations qui vont avec.',
  },
  {
    q: 'Puis-je l’essayer sans données réelles ?',
    a: 'Oui. La commande « npm run demo » écrit 24 dossiers fictifs, et « npm run demo -- --upload » les importe directement dans l’application. C’est le bon point de départ tant que l’autorisation de l’étude n’est pas obtenue.',
  },
  {
    q: 'Où sont conservées mes réponses d’inscription ?',
    a: 'Dans la base d’authentification de ce site (Supabase), protégée par des règles d’accès par ligne : chacun ne lit et n’écrit que ses propres lignes. La page « Confidentialité » détaille ce qui est conservé, pourquoi, et comment le faire effacer.',
  },
  {
    q: 'Cela fonctionne-t-il sur téléphone ou tablette ?',
    a: 'Non : l’application demande un ordinateur (Windows, macOS ou Linux) avec Node.js 22.13 ou plus récent. Ce site, lui, se consulte partout.',
  },
];

function ProofCard() {
  return (
    <figure className="proof">
      <div className="proof-head">
        <span className="proof-tag">Exemple fictif</span>
        <span className="proof-ref">Dossier D-014 · CRP</span>
      </div>
      <div className="proof-value">
        <span className="proof-number">
          48 <small>mg/L</small>
        </span>
        <span className="proof-badges">
          <span className="proof-badge">Règle</span>
          <span className="proof-badge">Relu</span>
        </span>
      </div>
      <blockquote className="proof-quote">
        « … apyrétique, <mark>CRP à 48 mg/L</mark>, hyperleucocytose à 14 G/L, créatininémie normale … »
      </blockquote>
      <figcaption className="proof-source">
        <IconDocument size={16} />
        <span>compte-rendu-hospitalisation.docx</span>
      </figcaption>
    </figure>
  );
}

export function LandingPage() {
  usePageTitle(null);
  const { status } = useAuth();
  const signedIn = status === 'signed-in';
  const docs = `${config.repoUrl}/blob/main/docs`;

  return (
    <div className="view">
      <div className="container">
        <section className="hero hero-landing" aria-labelledby="hero-title">
          <div className="hero-copy">
            <p className="eyebrow">Études rétrospectives · thèses · mémoires</p>
            <h1 id="hero-title">Chaque valeur de votre étude, retrouvée dans son dossier.</h1>
            <p className="sub">
              PubResearcher lit les comptes rendus, remplit votre fiche d’exploitation et garde, sous chaque valeur, la
              phrase qui la justifie. Vous relisez, vous mesurez la fiabilité, vous exportez. Tout se passe sur votre
              ordinateur.
            </p>
            <div className="hero-actions">
              {signedIn ? (
                <Link className="btn btn-primary btn-lg" to="/acces">
                  Ouvrir mon accès <IconArrow size={18} />
                </Link>
              ) : (
                <Link className="btn btn-primary btn-lg" to="/inscription">
                  Créer mon accès <IconArrow size={18} />
                </Link>
              )}
              <Link className="btn btn-glass btn-lg" to={{ pathname: '/', hash: '#apercu' }}>
                Voir la démonstration ({'1\u00a0min\u00a035'})
              </Link>
            </div>
            <p className="hero-note">
              <IconShield size={18} />
              <span>Aucune donnée de patient ne passe par ce site.</span>
            </p>
          </div>
          <ProofCard />
        </section>
      </div>

      <section className="section" id="outils" aria-labelledby="tools-title">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">L’application</p>
            <h2 id="tools-title">De la pile de dossiers au tableau de données.</h2>
            <p className="lead">Des outils qui travaillent sur les mêmes dossiers : vous prenez celui dont vous avez besoin.</p>
          </div>

          <div className="tools">
            {TOOLS.map(({ icon: Icon, tone, title, text }) => (
              <article className="tool" key={title}>
                <span className={tone ? `tool-icon ${tone}` : 'tool-icon'}>
                  <Icon />
                </span>
                <h3>{title}</h3>
                <p>{text}</p>
              </article>
            ))}
            <article className="tool tool-wide">
              <span className="tool-icon accent">
                <IconBook />
              </span>
              <div>
                <h3>Revue bibliographique</h3>
                <p>
                  Une page à part, indépendante des dossiers : PubMed et Google Scholar interrogés par des acteurs
                  Apify, doublons regroupés, chaque référence triée avec son motif d’exclusion, diagramme de flux, puis
                  export RIS, BibTeX ou CSV. Chaque recherche garde sa chaîne exacte et sa date.
                </p>
              </div>
            </article>
          </div>
        </div>
      </section>

      <section className="section section-tour" id="apercu" aria-labelledby="tour-title">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Aperçu</p>
            <h2 id="tour-title">L’application, avec les dossiers fictifs de la démonstration.</h2>
            <p className="lead">
              Une minute et demie de démonstration, filmée sur l’application réelle ; puis deux écrans, tels qu’ils s’ouvrent sur
              votre ordinateur : celui où l’on relit, et celui qui précède tout import.
            </p>
          </div>

          <div className="tour-video">
            <IntroVideo preload="none" />
          </div>

          <div className="tour">
            <figure className="shot">
              <div className="shot-frame">
                <ThemedShot
                  name="relecture"
                  width={980}
                  height={800}
                  alt="Écran de relecture d’un dossier fictif : la variable Âge vaut 22 ans, sa justification est dépliée, et le texte du compte rendu à droite surligne le passage d’où vient la valeur."
                />
              </div>
              <figcaption>
                <strong>Relecture.</strong> Chaque valeur garde l’extrait du document qui la justifie ; un clic le situe dans le texte.
              </figcaption>
            </figure>
            <figure className="shot">
              <div className="shot-frame">
                <ThemedShot
                  name="import"
                  width={908}
                  height={893}
                  alt="Fenêtre d’import de l’application : la charte d’anonymisation affiche cinq engagements dont trois sont cochés, et le bouton de confirmation est encore inactif."
                />
              </div>
              <figcaption>
                <strong>Avant l’import.</strong> La charte s’affiche avant le premier fichier : l’import ne s’ouvre qu’une fois les cinq engagements confirmés.
              </figcaption>
            </figure>
          </div>
        </div>
      </section>

      <section className="section section-band" id="parcours" aria-labelledby="steps-title">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Le parcours</p>
            <h2 id="steps-title">De l’inscription au premier import, en quatre étapes.</h2>
            <p className="lead">Cinq minutes en tout, dont deux pour le premier lancement de l’application.</p>
          </div>

          <ol className="steps">
            {STEPS.map((step, index) => (
              <li key={step.title}>
                <span className="step-number" aria-hidden="true">
                  {index + 1}
                </span>
                <div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="steps-cta">
            {signedIn ? (
              <Link className="btn btn-primary btn-lg" to="/acces">
                Continuer mon parcours <IconArrow size={18} />
              </Link>
            ) : (
              <>
                <Link className="btn btn-primary btn-lg" to="/inscription">
                  Commencer par l’étape 1 <IconArrow size={18} />
                </Link>
                <Link className="btn btn-quiet" to="/connexion">
                  J’ai déjà un compte
                </Link>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="section" id="donnees" aria-labelledby="data-title">
        <div className="container">
          <div className="hero data-card">
            <div className="data-head">
              <span className="data-badge" aria-hidden="true">
                <IconShield size={26} />
              </span>
              <div>
                <p className="eyebrow">Avant tout import</p>
                <h2 id="data-title">PubResearcher n’anonymise rien.</h2>
              </div>
            </div>
            <p className="data-lead">
              Ce que vous importez est lu, conservé sur votre ordinateur et — si vous activez certaines fonctions —
              transmis tel quel. L’anonymisation se fait avant, par vous. C’est pourquoi l’inscription se termine par un
              engagement, et pourquoi l’application le redemande avant le premier import.
            </p>

            <ul className="commitments">
              {CHARTER_ITEMS.map((item) => {
                const entry = COMMITMENTS[item.id];
                return (
                  <li key={item.id}>
                    <span className="commitment-check" aria-hidden="true">
                      <IconCheck size={15} />
                    </span>
                    <div>
                      <strong>{entry?.title ?? item.id}</strong>
                      <span>{entry?.gloss}</span>
                    </div>
                  </li>
                );
              })}
            </ul>

            <details className="data-full">
              <summary>Lire les cinq engagements en entier</summary>
              <ol>
                {CHARTER_ITEMS.map((item) => (
                  <li key={item.id}>{item.text}</li>
                ))}
              </ol>
            </details>
          </div>

          <div className="keep-grid">
            <div className="keep-card">
              <h3>
                <IconCheck size={18} /> Ce que ce site conserve
              </h3>
              <ul>
                {KEPT.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
            <div className="keep-card">
              <h3>
                <IconEmpty size={18} /> Ce qu’il ne reçoit jamais
              </h3>
              <ul>
                {NEVER.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="small muted section-foot">
            Détail complet : <Link to="/confidentialite">page Confidentialité</Link> et{' '}
            <a href={`${docs}/securite-et-donnees.md`} target="_blank" rel="noopener noreferrer">
              Sécurité et données personnelles
            </a>
            .
          </p>
        </div>
      </section>

      <section className="section section-band" id="installer" aria-labelledby="install-title">
        <div className="container">
          <div className="section-head">
            <p className="eyebrow">Sur votre ordinateur</p>
            <h2 id="install-title">Deux minutes pour le premier lancement.</h2>
            <p className="lead">
              L’application n’est pas un site : elle tourne chez vous, avec vos données, et n’écoute que sur votre poste.
              Il faut <strong>Node.js 22.13</strong> ou plus récent.
            </p>
          </div>

          <div className="install-grid">
            <div>
              <h3 className="install-title">
                <IconLaptop size={20} /> En ligne de commande
              </h3>
              <CodeBlock
                label="Commandes d’installation"
                lines={[`git clone ${config.repoUrl}.git`, 'cd PubResearcher', 'npm ci', 'npm start']}
              />
              <p className="small muted">
                Le navigateur s’ouvre ensuite sur <code>http://localhost:4000</code>. Laissez la fenêtre du terminal
                ouverte tant que vous travaillez.
              </p>
            </div>
            <div>
              <h3 className="install-title">Sans terminal</h3>
              <p>
                Téléchargez le projet (<em>Code › Download ZIP</em> sur GitHub), décompressez-le, puis double-cliquez sur{' '}
                <code>lancer.bat</code> (Windows) ou <code>lancer.command</code> (macOS).
              </p>
              <h3 className="install-title">Pour essayer sans données réelles</h3>
              <CodeBlock label="Commande des dossiers fictifs" lines={['npm run demo -- --upload']} />
              <p className="small muted">
                24 dossiers fictifs, importés directement. Le{' '}
                <a href={`${docs}/guide-administrateur.md`} target="_blank" rel="noopener noreferrer">
                  guide de l’administrateur
                </a>{' '}
                couvre le reste : mot de passe, réseau, sauvegardes.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="section" id="questions" aria-labelledby="faq-title">
        <div className="container narrow-wide">
          <div className="section-head">
            <p className="eyebrow">Questions</p>
            <h2 id="faq-title">Ce que l’on demande avant de commencer.</h2>
          </div>
          <div className="faq">
            {FAQ.map((item) => (
              <details className="faq-item" key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="section section-last" aria-labelledby="cta-title">
        <div className="container">
          <div className="cta-band">
            <h2 id="cta-title">Prêt à constituer votre jeu de données ?</h2>
            <p>Créez votre accès, prenez l’engagement d’anonymisation, ouvrez l’application.</p>
            <div className="hero-actions">
              {signedIn ? (
                <Link className="btn btn-primary btn-lg" to="/acces">
                  Ouvrir mon accès <IconArrow size={18} />
                </Link>
              ) : (
                <Link className="btn btn-primary btn-lg" to="/inscription">
                  Créer mon accès <IconArrow size={18} />
                </Link>
              )}
              <a className="btn btn-glass btn-lg" href={`${docs}/guide-chercheur.md`} target="_blank" rel="noopener noreferrer">
                Lire le guide du chercheur
              </a>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
