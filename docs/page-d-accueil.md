# Page d'accueil (`landing/`)

Le site public de PubResearcher : il présente l'outil, propose de créer un accès (Google ou adresse e-mail), mène l'utilisateur dans un court parcours d'accueil — profil, étude, **engagement d'anonymisation** — puis le dirige vers l'application. Il se déploie seul, sur Vercel, et ne contient aucune donnée de patient.

> **À retenir avant de commencer.** Ce site est une **porte d'entrée, pas une serrure**. L'application tourne sur l'ordinateur de l'utilisateur (voir [Sécurité et données personnelles](securite-et-donnees.md)) et ne vérifie pas qu'un compte existe : le site enregistre l'engagement pris et mène à l'application, il ne la protège pas. Pour protéger l'application elle-même, le § 9 donne les pistes (et ce qu'elles coûtent).

## 1. Ce que contient le site

| Adresse | Page | Accès |
|---|---|---|
| `/` | Accueil : l'outil en une phrase, un exemple fictif de valeur et de source, les outils, un aperçu de l'application, le parcours en quatre étapes, la section « PubResearcher n'anonymise rien », l'installation, les questions | public |
| `/inscription` | « Créer mon accès » : Google en premier, puis nom, e-mail, mot de passe | public |
| `/connexion` | « Se connecter » : mêmes moyens ; « Mot de passe oublié ? » | public |
| `/bienvenue` | Parcours d'accueil en trois étapes : **profil**, **étude**, **engagement** (la charte d'anonymisation) | connecté |
| `/acces` | « Ouvrir l'application », mode d'emploi du premier lancement, récapitulatif des réponses, rappel adapté à l'autorisation de l'étude | connecté, parcours terminé |
| `/mot-de-passe` | Demander un lien de réinitialisation ; choisir un nouveau mot de passe ; explique un lien reçu qui n'a pas pu servir | public / connecté |
| `/deconnexion` | Déconnecte **ce navigateur** puis revient à l'accueil. Atteinte autrement que par un bouton du site (lien venu d'ailleurs, adresse tapée), elle demande d'abord confirmation | — |
| `/confidentialite` | Ce qui est conservé, pourquoi, où ; comment le faire effacer | public |

**Reprise.** Chaque étape enregistre ce qu'elle a recueilli avant de passer à la suivante : on peut quitter la page et reprendre là où l'on s'est arrêté. `/acces` renvoie vers `/bienvenue` tant que le profil est incomplet ou que l'engagement n'a pas été pris pour la **version courante** du texte. `/bienvenue?modifier` rouvre le parcours pour corriger ses réponses (la charte n'est alors redemandée que si le texte a changé).

**Retour après connexion.** `?suite=/acces` ramène à la page demandée. Seules deux pages sont admises (`/bienvenue`, `/acces`) : une adresse complète, `//autre-site` ou un chemin inconnu sont ignorés (pas de redirection ouverte).

## 2. Deux modes : configuré, ou aperçu

| | **Configuré** | **Aperçu** |
|---|---|---|
| Condition | `VITE_SUPABASE_URL` et `VITE_SUPABASE_PUBLISHABLE_KEY` définies à la compilation | l'une des deux manque |
| Comptes | Supabase Auth (e-mail + mot de passe, Google) | aucun : une identité fictive, gardée dans l'onglet |
| Réponses | tables `profiles` et `consents` de Supabase | mémoire de l'onglet (`sessionStorage`), perdue à sa fermeture |
| Réseau | Supabase seulement, et seulement après la première connexion | **rien** ne part |
| Signalement | — | un bandeau **sur chaque page** : « Mode aperçu » |

Le mode aperçu permet de visiter tout le parcours (et de montrer le site) avant d'avoir créé le moindre compte. Un site publié sans variables reste donc utilisable, et ne laisse jamais croire qu'un compte a été créé.

**Dans ce dépôt**, `landing/.env.production` fournit les deux variables du projet Supabase **PubResearcher** (§ 5) : `npm run build` et les déploiements Vercel compilent donc en mode **configuré**. `npm run dev` ne lit pas ce fichier et reste en **aperçu**, sauf `.env.local` (§ 5.5).

## 3. Les données

### 3.1 Ce qui est conservé

Dans **Supabase** (projet du responsable du site), jamais ailleurs :

| Donnée | Où | Pour quoi faire |
|---|---|---|
| Nom, adresse e-mail (avec Google : nom, adresse, photo du compte) | `auth.users` | créer l'accès, reconnaître l'utilisateur |
| Fonction, établissement, pays, spécialité | `public.profiles` | adapter les rappels |
| Type d'étude, ordre de grandeur du nombre de dossiers, lieu d'hébergement prévu, état de l'autorisation | `public.profiles` | idem — jamais une évaluation |
| Version de la charte confirmée, engagements cochés, date | `public.consents` | garder la trace de l'engagement pris |

Dans le **navigateur** : la session ouverte par Supabase (`localStorage`, clé `sb-…-auth-token`) et le choix du thème (`theme`). Aucun cookie, aucun traceur, aucun outil de mesure d'audience.

### 3.2 Ce qui n'est jamais reçu

Aucun document de patient, aucun nom de patient, aucune valeur extraite, aucune équation de recherche bibliographique. Un test (`server/test/landing-logic.test.ts`) vérifie qu'aucune colonne des deux tables ne peut en recevoir (pas de colonne « patient », « dossier », « naissance », « ipp », « cin », « document »…).

### 3.3 Qui peut lire quoi

La clé « publique » (`sb_publishable_…`) est **lisible par tout visiteur, par conception** : elle est publiée dans le code du site. Ce qui protège les données, ce sont les **règles d'accès par ligne** de la migration (`landing/supabase/migrations/…`) :

- chaque compte lit et écrit **ses lignes seulement** (`(select auth.uid()) = user_id`) ;
- les **droits sont accordés colonne par colonne** : la migration retire tout (`revoke all … from anon, authenticated` — Supabase accorde d'office tous les droits sur les tables du schéma `public`), puis rend à l'utilisateur connecté la lecture des deux tables et l'écriture des **seules colonnes que le site remplit** (`grant insert (…)` et `grant update (…)` sur `profiles`, `grant insert (user_id, kind, version, items)` sur `consents`) ;
- les dates (`created_at`, `updated_at`, `accepted_at`) et l'identifiant d'un engagement sont posés **par la base**, jamais par le navigateur : **un engagement ne peut pas être antidaté** ;
- `consents` est un journal **en ajout seul** : ni modification, ni suppression, même par son titulaire (aucun droit `update` ou `delete`, aucune règle correspondante) ;
- un visiteur non connecté n'a **aucun droit** sur ces tables ; personne ne peut vider une table (`truncate`) ;
- un utilisateur ne peut pas supprimer son profil ; les lignes disparaissent avec le compte (`on delete cascade`) ;
- la fonction du déclencheur `touch_updated_at` fixe son chemin de recherche (`set search_path = ''`).

**Vérifié sur le projet réel** (11 octobre 2026), en simulant deux comptes dans une transaction annulée ensuite : créer puis mettre à jour son profil (la forme exacte de l'« upsert » du site), inscrire son engagement — acceptés ; écrire le profil ou l'engagement d'un autre, lire les lignes d'un autre, antidater un engagement ou la création d'un profil, modifier ou effacer un engagement, effacer son profil, transférer son profil à un autre, vider une table, et tout accès sans connexion — **refusés** (17 contrôles). Par HTTP, avec la clé publique et sans connexion, la lecture et l'écriture sont refusées (`401`, « permission denied »). Le conseiller de sécurité de Supabase ne signale rien.

Le responsable du site, qui administre le projet Supabase, peut en revanche lire les tables : la page « Confidentialité » le dit.

**Effacement.** Un utilisateur ne peut pas supprimer son compte seul (cela exigerait une clé d'administration, qui ne doit jamais se trouver dans un site public). La page « Confidentialité » l'invite à écrire au responsable, dont l'adresse vient de `VITE_CONTACT_EMAIL` ; le responsable supprime l'utilisateur dans le tableau de bord (*Authentication › Users*), ce qui supprime ses lignes par cascade.

## 4. La charte d'anonymisation

C'est le cœur du site : **avant qu'un chercheur ne dépose des données de patients, il s'engage**, point par point, à les avoir préparées. Le texte dit d'abord ce que l'outil ne fait pas : *PubResearcher n'anonymise rien*.

Les cinq engagements : identifiants directs retirés ; angles morts vérifiés (en-têtes, tampons, noms de fichiers, texte dans les images, balises DICOM) ; code d'étude sans lien avec l'identité et table de correspondance conservée ailleurs ; base légale et autorisations (une donnée seulement pseudonymisée reste en général une donnée personnelle de santé) ; aucun envoi à une API sans autorisation (mode « Claude », équations de recherche).

**Où elle est demandée** — à deux endroits, avec le **même texte** :

1. **Sur le site**, en fin de parcours (`/bienvenue`, étape 3) : cinq cases à cocher ; le bouton de confirmation reste inactif tant que les cinq ne le sont pas. Une ligne de `consents` est ajoutée : version du texte, identifiants des engagements, date.
2. **Dans l'application**, devant tout import (« Importer des dossiers », « Ajouter des documents ») : tant que l'engagement n'a pas été pris pour la version courante, **l'écran de dépôt des fichiers n'existe pas**. L'engagement est mémorisé dans le navigateur (`localStorage`, clé `anonymisation:ack`, `{ version, at }`) ; ensuite, un rappel d'une ligne reste affiché et se déplie pour relire les engagements. Le champ « Libellé » d'un patient rappelle de n'y mettre ni nom, ni initiales, ni date de naissance.

**C'est un rappel, pas un contrôle.** L'outil ne peut pas savoir si un document est anonymisé : cocher une case ne change rien à ce que contient le fichier. La charte rend l'engagement explicite et daté, elle ne le vérifie pas. Elle ne remplace ni le délégué à la protection des données, ni le comité d'éthique, ni un conseil juridique — et le dit.

**Changer le texte.** Le texte vit dans deux fichiers qui ne peuvent pas s'importer (le site se déploie seul) : `web/src/lib/anonymisation.ts` (application) et `landing/src/lib/charter.ts` (site). Un test les compare mot pour mot, version comprise (`landing-logic.test.ts`, « la charte… »). Quand le texte change **sur le fond**, changez `ANONYMISATION_VERSION` dans les deux : l'engagement est alors redemandé, dans l'application à l'import suivant, sur le site à la prochaine visite de `/acces` ou de `/bienvenue` (une nouvelle ligne s'ajoute à `consents`, l'ancienne reste).

## 5. Mettre le site en ligne — pas à pas

Trois comptes, à créer une fois : **Supabase** (comptes et réponses), **Google Cloud** (le bouton « Continuer avec Google »), **Vercel** (l'hébergement). Comptez une heure, sans compter la création du client OAuth de Google. Dans l'ordre :

> **Où en est-on (11 octobre 2026).** Le projet Supabase **PubResearcher** existe : référence `oyzhlclaniaykyixhsjy`, région `eu-west-3` (Paris), formule gratuite. La migration y est appliquée (version `20261011011740`) et vérifiée (§ 3.3) ; son adresse et sa clé publique sont dans `landing/.env.production`. Les étapes 1 à 3 du § 5.1 sont donc faites. **Reste à régler dans les tableaux de bord** — rien de cela ne passe par le code : § 5.1 (4) à (6), § 5.2, § 5.3. L'outil Supabase dont dispose l'assistant qui a préparé le site crée projets et tables, mais ne règle pas l'authentification (adresses de retour, Google, envoi des courriels) : c'est le tableau de bord, ou l'API d'administration de Supabase avec un jeton personnel.

### 5.1 Supabase

1. **Créer un projet** *(fait : voir l'encadré)*. Choisissez la région la plus proche de vos utilisateurs (en Europe, pour un public marocain ou européen). Notez l'**URL du projet** (`https://<réf>.supabase.co`) et la **clé publique** (`sb_publishable_…`, page *Connect* ou *API Keys*), et mettez-les dans `landing/.env.production`. N'utilisez et ne copiez jamais la clé secrète (`service_role` / `sb_secret_…`) : le site n'en a pas besoin.
2. **Créer les tables** *(fait)*. Éditeur SQL › collez le contenu de `landing/supabase/migrations/20261011011740_profils_et_engagements.sql` › *Run* (ou `supabase db push` avec la CLI : le numéro du fichier est celui que le projet a enregistré, la CLI ne le rejouera pas). Le script est rejouable (`if not exists`, `drop … if exists`).
3. **Contrôler** *(fait)*. *Advisors › Security Advisor* : aucun avertissement. *Table Editor* : un cadenas « RLS enabled » sur les deux tables. (Côté *Performance*, « Unused Index » sur `consents_user_kind_idx` est normal tant que la table est vide : c'est l'index de la lecture du dernier engagement.)
4. **Réglages d'authentification** (*Authentication*) :
   - *URL Configuration* — **Site URL** : l'adresse publique du site (`https://…`). **Redirect URLs** : l'adresse du site (de préférence le chemin exact, `https://…/bienvenue` et `https://…/mot-de-passe`) ; pour le développement local `http://localhost:5174/**` ; pour les déploiements d'essai de Vercel `https://*-<votre-compte-ou-équipe>.vercel.app/**`. Sans cela, les retours (Google, lien de confirmation, réinitialisation) tombent sur la mauvaise adresse ou sont refusés. Le jeton `**` accepte tout chemin : réservez-le au local et aux essais.
   - *Sign In / Providers › Email* — laissez **Confirm email** activée (c'est le réglage actuel du projet) ; **longueur minimale du mot de passe : 10** au moins (le site en exige 10 ; le service doit faire de même) ; « Prevent use of leaked passwords » si votre formule le permet (formule Pro).
   - *Sign In / Providers › Google* — voir § 5.2.
5. **Envoi des courriels (obligatoire pour de vrais utilisateurs).** Le serveur d'envoi fourni par défaut **n'écrit qu'aux membres de votre équipe** Supabase, avec des limites strictes et sans garantie : il ne sert qu'à essayer. Pour toute autre adresse, l'inscription par e-mail est refusée et le site affiche « Ce site ne peut pas encore envoyer de courriel à cette adresse. Utilisez « Continuer avec Google », ou réessayez plus tard. » *Authentication › Emails › SMTP Settings* : branchez un service d'envoi (Resend, Brevo, Postmark, AWS SES, SendGrid…) et un expéditeur d'un domaine **vérifié** chez ce service. Sans cela, personne d'autre que l'équipe ne reçoit son lien de confirmation.
6. **Textes des courriels** (*Authentication › Emails › Templates*) : les modèles par défaut sont en anglais, et leur lien (`{{ .ConfirmationURL }}`) ne marche que dans le navigateur où la demande a été faite — courant pour qui s'inscrit sur son ordinateur et lit ses courriels sur son téléphone — et un logiciel de sécurité de messagerie qui l'ouvre avant l'utilisateur le consomme. Les deux gabarits ci-dessous mènent **directement au site** avec un jeton à usage unique, que le site échange lui-même : ils marchent sur n'importe quel appareil. À coller tels quels (`{{ .SiteURL }}` et `{{ .TokenHash }}` sont fournis par le service ; la **Site URL** doit donc être celle du site, § 5.1 (4)) :

   *Confirm signup* — objet : `Confirmez votre adresse e-mail — PubResearcher`

   ```html
   <h2>Confirmez votre adresse e-mail</h2>
   <p>Bonjour,</p>
   <p>Pour terminer la création de votre accès à PubResearcher, confirmez votre adresse :</p>
   <p><a href="{{ .SiteURL }}/bienvenue?token_hash={{ .TokenHash }}&type=email">Confirmer mon adresse</a></p>
   <p>Ce lien ne sert qu’une fois. Si vous n’avez rien demandé, ignorez ce message.</p>
   ```

   *Reset password* — objet : `Nouveau mot de passe — PubResearcher`

   ```html
   <h2>Choisissez un nouveau mot de passe</h2>
   <p>Vous avez demandé la réinitialisation de votre mot de passe PubResearcher.</p>
   <p><a href="{{ .SiteURL }}/mot-de-passe?token_hash={{ .TokenHash }}&type=recovery">Choisir un nouveau mot de passe</a></p>
   <p>Ce lien ne sert qu’une fois. Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe ne change pas.</p>
   ```

   Le site accepte aussi les liens par défaut (flux PKCE) : si vous gardez les modèles d'origine, un lien ouvert dans un autre navigateur donne un message qui dit quoi faire, sans plus.

### 5.2 Google (bouton « Continuer avec Google »)

1. [Console Google Cloud](https://console.cloud.google.com/) › créez (ou choisissez) un projet › **Google Auth Platform** :
   - *Branding* : nom (PubResearcher), adresse d'assistance, liens vers l'accueil et la page « Confidentialité » du site ; **domaines autorisés** : celui du site et `oyzhlclaniaykyixhsjy.supabase.co`.
   - *Data Access* : les champs du profil de base seulement — `.../auth/userinfo.email` et `.../auth/userinfo.profile` (présents d'office), `openid` (à ajouter). Aucune validation par Google n'est nécessaire pour ces champs.
   - *Audience* : tant que l'application est en mode « Test », seuls les utilisateurs de test peuvent se connecter : **publiez-la** (« In production ») avant de communiquer l'adresse.
2. *Clients › Créer un client OAuth* › type **Application Web**.
   - **Origines JavaScript autorisées** : l'adresse du site (`https://…`), et `http://localhost:5174` pour le développement.
   - **URI de redirection autorisés** : l'**URL de rappel de Supabase**, affichée sur la page *Providers › Google* du tableau de bord : `https://<réf>.supabase.co/auth/v1/callback`. (C'est l'adresse **de Supabase**, pas celle du site.)
3. Copiez l'**ID client** et le **code secret** dans *Authentication › Sign In / Providers › Google* de Supabase, activez le fournisseur.

Pour ce projet, l'URL de rappel est `https://oyzhlclaniaykyixhsjy.supabase.co/auth/v1/callback`. Sur la page de choix du compte, Google affichera « continuer vers oyzhlclaniaykyixhsjy.supabase.co » : c'est l'adresse du service d'authentification. Seul un domaine personnalisé pour le projet Supabase (option payante) la remplace par une adresse à vous ; la vérification de la marque (*Branding*, quelques jours) fait afficher le nom et le logo.

Le site demande à Google de proposer le choix du compte (`prompt=select_account`) : utile sur un poste partagé. **Tant que Google n'est pas activé dans Supabase**, le site le vérifie avant de partir (réglages publics du service, `/auth/v1/settings`) et affiche « La connexion avec Google n’est pas encore activée sur ce site : utilisez votre adresse e-mail. » — au lieu de laisser le service afficher sa page d'erreur brute. Si cette vérification échoue (réseau), le site tente quand même la connexion.

### 5.3 Vercel

1. *Add New… › Project* › importez le dépôt GitHub. **Root Directory : `landing`** — c'est le seul réglage essentiel (le dépôt contient aussi l'application, qui ne se déploie pas sur Vercel : voir § 9). Le reste (framework Vite, `npm ci`, `npm run build`, dossier `dist`, en-têtes de sécurité, réécriture vers `index.html`) est lu dans `landing/vercel.json`.
2. *Environment Variables* (Production **et** Preview) — voir le tableau du § 6. `VITE_SUPABASE_URL` et `VITE_SUPABASE_PUBLISHABLE_KEY` viennent déjà de `landing/.env.production` (une variable **du même nom** définie dans Vercel l'emporte sur ce fichier ; l'ancienne `VITE_SUPABASE_ANON_KEY`, elle, ne remplace pas la clé du fichier : changez l'adresse et la clé ensemble, sous ces deux noms) ; restent `VITE_SITE_URL`, `VITE_CONTROLLER_NAME`, `VITE_CONTACT_EMAIL`. Les variables `VITE_*` sont **incorporées à la compilation** : toute modification demande un nouveau déploiement.
3. *Deploy*. Notez l'adresse de production, puis revenez au § 5.1 (4) : **Site URL** et **Redirect URLs**, et au § 5.2 : **origine JavaScript** de Google.
4. Renseignez `VITE_CONTROLLER_NAME` et `VITE_CONTACT_EMAIL` (page « Confidentialité »), puis redéployez. Tant qu'elles manquent, la page le dit en toutes lettres : *ne confiez pas de données à ce site avant de les avoir renseignées*.
5. Vérifiez que le plan Vercel choisi convient à votre usage (conditions d'utilisation de Vercel) et, si vous utilisez un domaine à vous, ajoutez-le dans *Settings › Domains*.
6. **Branche déployée.** Vercel publie en production la branche par défaut du dépôt (`main`). Tant que le site vit sur une autre branche (`landing`), fusionnez-la, ou choisissez-la dans *Settings › Environments › Production › Branch Tracking* (anciennement *Settings › Git › Production Branch*).

### 5.4 Contrôle de mise en service

À faire une fois, sur l'adresse de production, avec une adresse e-mail qui n'est pas celle de l'équipe Supabase :

- [ ] La page d'accueil s'ouvre, **sans bandeau « Mode aperçu »**.
- [ ] *Créer mon accès* par e-mail : le courriel de confirmation **arrive** (courrier indésirable compris), en français, et son lien ramène sur `/bienvenue`, connecté.
- [ ] *Continuer avec Google* : le sélecteur de compte s'ouvre, puis `/bienvenue` (avant l'activation de Google : le message « pas encore activée », sans quitter le site).
- [ ] Le parcours va jusqu'à `/acces` ; *Table Editor* montre une ligne dans `profiles` et une dans `consents` (version `2026-10-v1`, cinq identifiants).
- [ ] En étant connecté avec un **second** compte : la ligne du premier n'apparaît nulle part (essai à faire depuis l'éditeur SQL en simulant le rôle, ou simplement : le second parcours démarre vide).
- [ ] *Mot de passe oublié* : le lien arrive, mène à « Choisir un nouveau mot de passe ».
- [ ] La page « Confidentialité » affiche le responsable et son adresse.
- [ ] « Ouvrir l'application » mène à `VITE_APP_URL` (voir § 7).
- [ ] *Advisors › Security Advisor* : aucun avertissement de sécurité sur les deux tables.
- [ ] Lien reçu par e-mail ouvert **sur un autre appareil** que celui de la demande (téléphone) : avec les modèles du § 5.1 (6), la confirmation et la réinitialisation y aboutissent.
- [ ] *Renvoyer le lien* (écran « Vérifiez votre boîte e-mail ») : le second courriel arrive et son lien aboutit.

### 5.5 Essayer en local

```bash
cd landing
npm ci
npm run dev        # http://localhost:5174 — mode aperçu (.env.production n'est lu qu'en compilation de production)
```

Pour essayer avec le vrai projet Supabase, copiez `.env.example` en `.env.local`, renseignez les deux variables `VITE_SUPABASE_*` (les valeurs de `.env.production`), et ajoutez `http://localhost:5174/**` aux *Redirect URLs*. `npm run build` compile dans `dist/` **avec le vrai projet** ; `npm run preview` le sert sur `http://localhost:4173` (à ajouter aussi aux *Redirect URLs* pour y essayer les retours de Google ou des liens reçus).

## 6. Variables d'environnement

Toutes sont lues **à la compilation** ; aucune ne doit contenir de secret (tout ce qui est préfixé `VITE_` est publié dans le code du site). Ordre de priorité, du plus fort au plus faible : variable d'environnement (Vercel, ligne de commande) > `.env.production.local` (jamais versé au dépôt) > `.env.production` (dans le dépôt : l'adresse et la clé du projet) > `.env.local` > `.env`.

| Variable | Rôle | Valeur par défaut |
|---|---|---|
| `VITE_SUPABASE_URL` | Adresse du projet Supabase | `.env.production` : `https://oyzhlclaniaykyixhsjy.supabase.co` ; sans elle, mode aperçu |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Clé publique (`sb_publishable_…` ; l'ancienne `VITE_SUPABASE_ANON_KEY` est acceptée) | `.env.production` ; sans elle, mode aperçu |
| `VITE_APP_URL` | Où mène « Ouvrir l'application » | `http://localhost:4000` |
| `VITE_SITE_URL` | Adresse publique du site : balises de partage (aperçu d'un lien sur les messageries), image `og.png` | — (pas de balises d'image) |
| `VITE_CONTROLLER_NAME` | Responsable du site, page « Confidentialité » | — (avertissement visible) |
| `VITE_CONTACT_EMAIL` | Adresse pour exercer ses droits | — (avertissement visible) |

Une valeur mal saisie ne produit jamais un lien dangereux : `VITE_APP_URL`, `VITE_SUPABASE_URL` et `VITE_SITE_URL` ne sont acceptées qu'en `http(s)`, sans identifiants (`javascript:…` vaut « non configuré »).

## 7. Ouvrir l'application depuis le site

Le bouton « Ouvrir l'application » de `/acces` mène à `VITE_APP_URL`. Par défaut, c'est `http://localhost:4000` : **l'application installée sur l'ordinateur de l'utilisateur**, qui n'est pas joignable depuis l'extérieur. Si elle n'est pas démarrée, la page ne s'ouvre pas — c'est pourquoi `/acces` donne juste dessous le mode d'emploi du premier lancement (`git clone`, `npm ci`, `npm start`, ou `lancer.bat` / `lancer.command`).

Si votre établissement exploite l'application sur un serveur (voir le [guide de l'administrateur](guide-administrateur.md#5-exposer-loutil-sur-un-réseau) : HTTPS, mot de passe, `ALLOWED_HOSTS`), mettez son adresse dans `VITE_APP_URL`. Le site n'envoie **rien** à l'application en ouvrant ce lien : pas de jeton, pas de paramètre.

## 8. Contrôles réalisés

| Quoi | Comment | Où |
|---|---|---|
| Logique pure : formulaires, parcours, adresses, retours d'erreur | `npm test` (racine) — `server/test/landing-logic.test.ts` | dépôt |
| La charte du site = celle de l'application (version, titres, cinq engagements mot pour mot) | idem | dépôt |
| Les jetons de couleur, les polices et l'arc d'or du site = ceux de l'application, octet pour octet | idem | dépôt |
| Les listes d'options du parcours = les contraintes `check (… in …)` de la migration | idem | dépôt |
| Règles d'accès par ligne et droits de la migration (cinq règles ; retrait de tout, puis droits colonne par colonne ; aucun droit pour un visiteur ; dates posées par la base ; journal en ajout seul) ; le site n'écrit que des colonnes autorisées ; `.env.production` ne contient que l'adresse et la clé publique | idem | dépôt |
| Politique de sécurité du contenu, en-têtes, absence de script ou de style en ligne, de secret, de lien mort | idem | dépôt |
| Contrastes WCAG 2.2 AA des jetons, deux thèmes | `npm test` — `server/test/web-contrast.test.ts` (lit les **deux** feuilles de style) | dépôt |
| 25 parcours dans un vrai navigateur, contre un faux Supabase (inscription avec confirmation, lien ouvert ailleurs, liens « token_hash » sur un autre appareil, réinitialisation ratée puis réussie sur téléphone, envoi refusé par le serveur par défaut, Google/PKCE, Google pas encore activé, connexion, reprise, modification, pannes, déconnexion et déconnexion à confirmer, adresses abîmées, redirections, clavier, 320 → 1 440 px) | `cd landing && node --test e2e/flows.test.mjs` (Playwright requis) | dépôt, `landing/e2e/` |
| **Projet réel** : 17 contrôles des règles et des droits (deux comptes simulés, transaction annulée), refus sans connexion par HTTP, codes d'erreur réels (`invalid_credentials`), en-têtes CORS, conseillers de sécurité et de performance | requêtes SQL et HTTP, 11 octobre 2026 | § 3.3 ; [rapport de validation, § 13](validation.md#13-page-daccueil-et-charte-danonymisation-130) |
| Accessibilité (axe-core), contraste du **rendu**, anneaux de focus | scripts de validation, non publiés | [rapport de validation, § 13](validation.md#13-page-daccueil-et-charte-danonymisation-130) |

Le faux Supabase (`landing/e2e/fake-supabase.mjs`) imite le **protocole** — formats de réponse, codes d'erreur, PKCE vérifié pour de bon (défi recalculé à partir du vérificateur), jeton obligatoire sur les tables, règles d'accès par ligne, contraintes **et droits par colonne lus dans la migration** (une colonne non accordée est refusée comme sur le vrai projet : `42501`). **Il ne remplace pas un essai sur un vrai projet** (§ 5.4) : ni les courriels, ni Google, ni les réglages de votre tableau de bord ne sont éprouvés par lui. Le navigateur de l'environnement où le site a été préparé ne pouvait pas joindre Internet : la première inscription réelle (§ 5.4) reste le test de réception.

## 9. Limites et pistes

- **Le site ne protège pas l'application.** Quelqu'un qui connaît l'adresse de l'application (ou qui l'installe) l'utilise sans compte. Pour que l'application exige la connexion, il faudrait que son serveur vérifie un jeton émis par Supabase (vérification de la signature avec les clés publiques du projet) *et* qu'une session puisse passer du site à l'application, deux origines distinctes : un chantier à part, qui change le modèle de l'outil (aujourd'hui, un poste = un utilisateur, sans compte). Il n'est pas fait.
- **L'engagement est déclaratif.** Voir § 4.
- **Pas de suppression de compte en libre-service** (§ 3.3).
- **Pas de protection anti-robots.** Le service d'authentification limite lui-même le débit des demandes. Si vous activez la protection CAPTCHA de Supabase, **le site ne la gère pas** : les inscriptions échoueront tant qu'un jeton CAPTCHA n'est pas ajouté au code.
- **Pas d'authentification à deux facteurs** proposée par le site.
- **Formule gratuite de Supabase** : un projet sans activité suffisante pendant une semaine est **mis en pause** (un courriel prévient environ une semaine avant) ; inscriptions et connexions échouent alors jusqu'à sa reprise (*Resume project*, possible pendant 90 jours). La formule Pro n'est jamais mise en pause.
- **Textes en français seulement.**
- **Le plan de l'application sur Vercel.** L'application elle-même (SQLite, fichiers téléversés jusqu'à 200 Mo, extractions de plusieurs minutes) ne peut pas tourner sur Vercel tel quel : ni disque persistant, ni requêtes de cette taille, ni durées de cette longueur. D'où ce site séparé, statique.
- **Responsabilité du site.** Le site collecte des données personnelles de professionnels (nom, adresse, établissement) : selon votre juridiction, cela appelle une base légale, une information des personnes et parfois une déclaration (par exemple, au Maroc, auprès de la CNDP ; dans l'Union européenne, un registre des traitements). Ce document décrit le fonctionnement technique ; il ne constitue pas un conseil juridique.

## 10. Dépannage

| Ce que vous voyez | Cause probable | Remède |
|---|---|---|
| Bandeau « Mode aperçu » sur le site publié | `landing/.env.production` a été retiré ou vidé, ou une variable `VITE_SUPABASE_*` **vide** est définie dans Vercel (elle l'emporte sur le fichier) | Rétablissez le fichier, ou renseignez les deux variables dans Vercel (Production **et** Preview), puis **redéployez** |
| Google : « redirect_uri_mismatch » | L'URI de redirection de Google n'est pas l'URL de rappel **de Supabase** | § 5.2 (2) : `https://<réf>.supabase.co/auth/v1/callback` |
| Après Google ou après un lien reçu : on arrive sur `localhost` ou sur une page inconnue | **Site URL** laissée à sa valeur par défaut, ou adresse absente des **Redirect URLs** | § 5.1 (4) |
| Google : « accès bloqué » ou seuls quelques comptes passent | L'écran de consentement est en mode « Test » | Publiez l'application (§ 5.2) |
| « La connexion avec Google n’est pas encore activée sur ce site » | Fournisseur Google désactivé dans Supabase | § 5.2 (3) |
| « Ce site ne peut pas encore envoyer de courriel à cette adresse » à l'inscription (`email_address_not_authorized`) | Serveur d'envoi par défaut de Supabase : il n'écrit qu'à l'équipe | § 5.1 (5) : service d'envoi personnalisé |
| « Ce lien de réinitialisation ne peut pas servir ici » | Lien par défaut ouvert ailleurs que dans le navigateur de la demande, expiré, ou déjà utilisé (y compris par un logiciel de sécurité de la messagerie) | Redemander un lien depuis l'appareil où on le lira ; durablement : modèles du § 5.1 (6) |
| « Vérifiez votre boîte e-mail », mais rien n'arrive, pour une adresse qui avait déjà un compte | Par discrétion, le service répond pareil que l'adresse ait un compte ou non, et n'envoie rien pour un compte existant | Se connecter (l'écran le rappelle), ou « Mot de passe oublié » |
| « Trop de tentatives en peu de temps » | Limite de débit du service d'authentification | Patientez une minute ; avec le serveur d'envoi par défaut, la limite est basse |
| « La connexion n'a pas pu se terminer dans ce navigateur » | Le lien de confirmation a été ouvert sur un autre appareil que celui de l'inscription, ou il a déjà servi | Si l'adresse est confirmée, connectez-vous avec le mot de passe |
| « Impossible d'enregistrer ou de lire vos réponses » | Les tables n'existent pas (migration non jouée), ou une règle refuse | § 5.1 (2) ; consultez la console du navigateur (le détail technique y est écrit, préfixé `[pubresearcher]`) et *Logs › Postgres* |
| Même message, et « permission denied for table » dans la console | Le site écrit une colonne qui n'a pas de droit accordé (par exemple après l'ajout d'un champ au parcours) | Ajoutez la colonne aux `grant insert (…)` et `grant update (…)` d'une nouvelle migration ; un test (`landing-logic.test.ts`) le signale avant la mise en ligne |
| Plus rien ne fonctionne après des jours sans visite ; erreurs `540` | Projet Supabase mis en pause (formule gratuite) | *Resume project* dans le tableau de bord (§ 9) |
| Page blanche, console : « Refused to … Content Security Policy » | Une ressource d'un autre site a été ajoutée au code | La politique de `vercel.json` n'admet que le site, `*.supabase.co` et les photos de compte Google ; ajoutez la ressource au site lui-même, ou élargissez la politique en connaissance de cause |
| « Ouvrir l'application » : « connexion refusée » | L'application n'est pas démarrée sur cet ordinateur | `/acces` donne les commandes ; voir [le guide de l'administrateur](guide-administrateur.md) |

## 11. Carte des fichiers

| Chemin | Rôle |
|---|---|
| `landing/index.html` | Page unique ; écran d'attente lisible par les robots, remplacé au démarrage |
| `landing/vercel.json` | Compilation, réécriture, en-têtes (CSP, `nosniff`, `Referrer-Policy`, …), cache des fichiers à empreinte |
| `landing/src/lib/` | Logique : `charter`, `forms`, `onboarding`, `urls`, `authReturn` (pures, testées), `auth`, `authSettings` (Google activé ?), `profile`, `supabase` (client dans un fichier à part, chargé après l'affichage), `config` |
| `landing/.env.production` | Adresse et clé publique du projet Supabase, lues par les compilations de production |
| `landing/src/pages/`, `components/` | Pages et composants React |
| `landing/src/styles.css` | Feuille de style : jetons copiés de l'application, puis composants |
| `landing/supabase/migrations/` | Tables, contraintes, règles d'accès par ligne, droits par colonne (numéro = version enregistrée sur le projet) |
| `landing/e2e/` | Parcours dans un navigateur : serveur statique à la manière de Vercel, faux Supabase, scénarios |
| `landing/public/` | Icône, image de partage, `robots.txt`, script du thème, captures de l'application (WebP, claires et sombres) |
