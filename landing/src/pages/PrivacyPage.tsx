import { Link } from 'react-router-dom';
import { IconInfo } from '../components/icons';
import { config } from '../lib/config';
import { usePageTitle } from '../lib/usePageTitle';

const STORED = [
  {
    what: 'Nom et adresse e-mail (avec Google : nom, adresse et photo du compte)',
    why: 'Créer votre accès et vous reconnaître à la connexion',
    where: 'Service d’authentification (Supabase)',
  },
  {
    what: 'Fonction, établissement, pays, spécialité',
    why: 'Adapter les rappels qui vous sont faits',
    where: 'Table « profiles »',
  },
  {
    what: 'Type d’étude, ordre de grandeur du nombre de dossiers, lieu d’hébergement prévu, état de l’autorisation',
    why: 'Idem : un rappel adapté à votre situation, jamais une évaluation',
    where: 'Table « profiles »',
  },
  {
    what: 'Version de la charte d’anonymisation confirmée, engagements cochés, date',
    why: 'Garder la trace de l’engagement pris, comme une pièce',
    where: 'Table « consents » (journal en ajout seul : jamais modifié)',
  },
];

/**
 * Confidentialité : ce que le site conserve, pourquoi, chez qui, et comment le faire effacer.
 *
 * Le texte décrit le fonctionnement *technique* du site tel qu'il est écrit. Les mentions de l'éditeur (qui est
 * responsable, comment le joindre) viennent de la configuration : tant qu'elles ne sont pas renseignées, la page le
 * dit en toutes lettres plutôt que de laisser croire qu'elles existent.
 */
export function PrivacyPage() {
  usePageTitle('Confidentialité');
  const { controllerName, contactEmail } = config;
  const documented = Boolean(controllerName && contactEmail);

  return (
    <div className="view container prose-page">
      <p className="eyebrow">Confidentialité</p>
      <h1>Ce que ce site sait de vous.</h1>
      <p className="lead">
        Ce site est la porte d’entrée de PubResearcher. Il ne reçoit aucune donnée de patient : seulement votre profil
        professionnel et la trace de l’engagement d’anonymisation que vous prenez.
      </p>

      <section aria-labelledby="p-stored">
        <h2 id="p-stored">Ce qui est conservé, pourquoi, et où</h2>
        {/* Défilant sur écran étroit : focalisable, pour que le clavier puisse le parcourir. */}
        <div className="table-scroll" tabIndex={0} role="region" aria-label="Données conservées (tableau)">
          <table>
            <thead>
              <tr>
                <th scope="col">Donnée</th>
                <th scope="col">Pour quoi faire</th>
                <th scope="col">Où</th>
              </tr>
            </thead>
            <tbody>
              {STORED.map((row) => (
                <tr key={row.what}>
                  <td>{row.what}</td>
                  <td>{row.why}</td>
                  <td>{row.where}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="p-never">
        <h2 id="p-never">Ce que ce site ne reçoit pas</h2>
        <ul>
          <li>Aucun document de patient, aucun nom de patient, aucune valeur extraite : l’application tourne sur votre ordinateur, avec ses propres données.</li>
          <li>Aucune équation de recherche bibliographique.</li>
          <li>Aucun cookie publicitaire, aucun outil de mesure d’audience, aucun traceur tiers.</li>
        </ul>
        <p>
          Votre navigateur garde localement deux choses : la session ouverte par le service d’authentification (pour ne pas
          vous redemander le mot de passe à chaque page) et votre choix de thème, clair ou sombre.
        </p>
      </section>

      <section aria-labelledby="p-who">
        <h2 id="p-who">Qui peut lire vos réponses</h2>
        <p>
          Des règles d’accès par ligne limitent chaque compte à ses propres lignes : un autre utilisateur ne peut ni lire ni
          modifier vos réponses, et personne — pas même vous — ne peut modifier ou effacer une ligne d’engagement. Le
          responsable du site, qui administre la base, peut en revanche y accéder techniquement.
        </p>
        <p>
          Intervenants techniques : le service d’authentification et de base de données (Supabase), Google si vous choisissez
          « Continuer avec Google » (il ne communique que votre nom, votre adresse et votre photo), et l’hébergeur qui sert
          les pages du site (Vercel, dans la configuration documentée).
        </p>
      </section>

      <section aria-labelledby="p-rights">
        <h2 id="p-rights">Vos droits</h2>
        <p>
          Vous pouvez demander l’accès à vos données, leur rectification ou l’effacement de votre compte et de vos
          réponses. Vous pouvez corriger votre profil vous-même à tout moment depuis{' '}
          <Link to="/bienvenue?modifier">le parcours d’accueil</Link>.
        </p>
        {documented ? (
          <p>
            Responsable du site : <strong>{controllerName}</strong>. Pour exercer vos droits :{' '}
            <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
          </p>
        ) : (
          <div className="notice notice-warn">
            <IconInfo size={18} />
            <div>
              Les mentions du responsable du site ne sont pas encore renseignées (variables <code>VITE_CONTROLLER_NAME</code> et{' '}
              <code>VITE_CONTACT_EMAIL</code>, voir la documentation de déploiement). Tant qu’elles ne le sont pas, personne ne peut
              recevoir une demande d’effacement : ne confiez pas de données à ce site avant de les avoir renseignées.
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby="p-limits">
        <h2 id="p-limits">Ce que cette page n’est pas</h2>
        <p>
          Elle décrit comment le site fonctionne ; elle ne remplace ni les mentions légales de son éditeur, ni l’avis de votre
          délégué à la protection des données ou de votre comité d’éthique. Pour les données de patients, lisez{' '}
          <a href={`${config.repoUrl}/blob/main/docs/securite-et-donnees.md`} target="_blank" rel="noopener noreferrer">
            Sécurité et données personnelles
          </a>
          .
        </p>
      </section>
    </div>
  );
}
