# Journal des versions

Le format suit l'ordre des versions, de la plus récente à la plus ancienne ; l'historique git de ce dépôt commence à la 1.2.0, les versions antérieures n'y sont décrites qu'ici. Les numéros de version sont ceux de `package.json` ; le rapport « Méthodes et traçabilité » consigne la version qui a produit un jeu de données.

## 1.7.0 — 12 octobre 2026

**Plusieurs études, sans les mélanger.** Chaque projet de recherche a désormais sa propre base : dossiers patients, fiche d'exploitation, extraction, résultats, bibliographie et rédaction.

- **Sélecteur de projet** dans la barre du haut : le nom de l'étude ouverte est toujours visible, et un menu permet d'en changer ou d'en créer une. Tous les onglets ouverts suivent le même projet.
- **Page « Projets de recherche »** (`/projets`) : créer (nom, description, fiche de départ), ouvrir, renommer et supprimer un projet. Pour supprimer, il faut recopier son nom : le projet est effacé avec tout son contenu, sans corbeille.
- **Projet neuf, vraiment vide** : aucun dossier, et une fiche d'exploitation sans aucune variable, à construire selon le protocole. Deux autres choix à la création : la trame générale fournie (22 variables), ou la fiche d'un projet existant (variables et règles, sans les valeurs).
- **Sélection multiple** : des cases à cocher dans la liste des dossiers et dans la fiche (par ligne, par page ou par section, ou « Tout sélectionner »), puis « Supprimer la sélection » avec confirmation. Routes `POST /api/patients/bulk-delete` et `POST /api/templates/fields/bulk-delete` (`{ ids }`, 5 000 au plus).
- **Données existantes** : elles deviennent le projet « Étude principale », au même emplacement. Rien n'est déplacé ni converti, et ce projet ne peut pas être supprimé.
- **Rangement** : chaque nouveau projet vit dans `projects/<identifiant>/` du dossier de données (sa base `research-tool.db` et son dossier `uploads/`). Le registre des projets est `projects.json`.
- **Sauvegarde** : `npm run backup` sauvegarde tous les projets, chacun vérifié. `npm run restore -- <dossier> --project <identifiant>` restaure un projet donné.
- **Graphiques** (adaptés de la bibliothèque beui, licence MIT, et animés avec `motion`) :
  - **Mosaïque** pour les variables à modalités : l'aire de chaque tuile est proportionnelle à l'effectif. Elle remplace les barres horizontales.
  - **Calendrier de chaleur** pour les dates (par jour sur quatre mois au plus, par mois au-delà).
  - **Barre d'états** en tête de la complétude : une pastille par variable, colorée selon son taux de remplissage.
  - **Entonnoir** du flux de sélection dans la revue bibliographique : identifiées → triées → retenues ou à voir → retenues.
  - **Chiffres animés** dans les tuiles de synthèse.

  Tous se lisent au clavier (flèches ou Tabulation, avec une infobulle), dans les deux thèmes, sans mouvement si le système le demande. Leurs données restent accessibles aux lecteurs d'écran.
- **API** : routes `/api/projects`. Toutes les autres routes visent le projet indiqué par l'en-tête `X-Project`, à défaut par `?project=` ou par le témoin `pubresearcher_project`, sinon le projet principal. Un projet inconnu est refusé (404, `PROJECT_NOT_FOUND`) : la requête n'est jamais redirigée en silence vers le principal.

## 1.6.0 — 11 octobre 2026

**Des valeurs plus sûres, sans rien installer.** Le moteur ne lit plus « oui » dans une hypothèse ni dans un antécédent, ne départage plus au hasard deux valeurs discordantes ; le tableau que l'équipe tenait déjà s'importe ; PubMed fonctionne sans réglage ; une archive par système s'ouvre d'un double-clic, sans Node.js ni connexion.

**Changements à connaître**

- **Mentions discordantes** : deux mentions différentes d'une même variable (« Hb 12,6 » dans un compte rendu, « Hb 8,1 » dans un autre) ne donnent plus la première trouvée : la variable reste vide et signalée « valeurs discordantes », à trancher à la main, sauf si la fiche indique quelle valeur retenir (« Si plusieurs mentions divergent »). Les fiches existantes ne sont pas modifiées : ce sont elles qui signaleront le plus.
- **Revue bibliographique** : PubMed passe par l'API officielle du NCBI (E-utilities), gratuite et sans jeton. `APIFY_PUBMED_ACTOR` est retiré ; `APIFY_TOKEN` ne sert plus qu'à Google Scholar, en option.
- **Envoi à Claude** : le texte est pseudonymisé sur le poste avant l'envoi (`LLM_PSEUDONYMIZE=0` pour le désactiver).
- **CSV en clés techniques** : les noms de colonne ne portent plus l'unité (`temperature`, et non `temperature (°C)`) : à reprendre dans un script qui lisait l'ancien nom.
- **Réglages contrôlés au démarrage** : `TABLE_MAX_*`, `BIBLIO_PUBMED_MAX`, `BIBLIO_IMPORT_MAX_MB`, `NCBI_TIMEOUT_MS` ; une valeur hors bornes arrête le démarrage.
- **Base** : deux migrations (2 : import de tableaux ; 3 : journal de recherche PRISMA-S), appliquées seules au démarrage. Une version 1.5.0 refuse ensuite cette base : sauvegardez avant la mise à jour.

### Extraction par les règles

- **Qualificatifs des mentions** oui/non, dans leur proposition (leur phrase pour les antécédents) : hypothèse (« suspicion de », « ? », « probable », « à éliminer », « évoqué ») et « non renseigné » ne donnent ni « Oui » ni « Non » ; absence établie (« éliminé », « ex-fumeur », « ancien fumeur », « sevré ») vaut « Non » ; épisode passé et clos (« fébrile en 2019 », « gestationnel », « résolutif ») n'est pas actuel ; négation contredite (« pas de … mais … ») ou restreinte (« immédiate ») n'est pas un « Non » sûr. Les mentions écartées restent visibles.
- **Toutes les mentions** : une règle lit toutes ses mentions dans tous les documents ; pour une variable oui/non, libellés et mots-clés sont mis en commun. Règle de sélection par variable : la première ou la dernière (ordre d'import), la plus grande, la plus petite, « Oui » dès qu'une mention l'affirme, ou la réunion des valeurs ; la justification garde alors les autres valeurs trouvées, et la confiance baisse. Un choix unique qui cite plusieurs options (« favorable puis décès ») est signalé.
- **Nouveaux réglages** : « Ignorer les mentions placées dans les antécédents » (règle mot-clé) ; « Proposer sans remplir » (variables de synthèse : examens réalisés, traitements reçus — les mentions sont proposées, une modalité DICOM remplit toujours) ; « Valeur à l'arrivée seulement » (les mentions « à J4 », « en postopératoire », « au cours du séjour » sont écartées).
- **Lecture** : unité entre parenthèses dans un en-tête de tableau (« Leucocytes (/mm3) 9 800 ») replacée après la valeur et contrôlée ; valeur antérieure à l'arrivée (« dernier bilan », « de base ») ou évolution pendant le séjour (« baisse de l'hémoglobine à… ») écartée des variables d'arrivée ; « non prêt au sevrage » n'est pas un « non » ; négation limitée dans le temps (« pas d'HTA connue avant la grossesse ») et tabagisme passif ne donnent pas de valeur ; durée en jours tirée d'une période (« Séjour du 14/01 au 21/01 ») et une date jamais lue comme un nombre ; unité écrite dans la cellule suivante d'un tableau, contrôlée ; unité à barre inconnue (« Hmol/L ») signalée ; lettre substituée par l'OCR à un chiffre (« 2O », « 6l ») écartée ; « 38°5 » vaut 38,5 ; correspondances d'options de la plus longue à la plus courte ; ligne de PDF coupée au milieu d'une négation recollée ; numéro de dossier sans débris d'OCR.
- **Fiche par défaut** (nouvelles bases) : sigles du diabète (DT1, DT2, DNID, DID), « Entré(e) le », « T 38°5 » ; fièvre et complications de l'épisode en cours ; bilan d'entrée lu à l'arrivée ; imagerie et traitement proposés sans remplir.

### Extraction par Claude

- Une valeur n'est retenue que si sa citation la **contient** : un nombre ou une date doit y figurer, un « oui » ne peut pas reposer sur une citation qui nie, doute ou relègue au passé. La raison du rejet est gardée.
- **Pseudonymisation locale** avant tout envoi : noms précédés d'une civilité ou d'un titre, champs « Nom » et « Prénom », dates de naissance, numéros de sécurité sociale, téléphones, adresses électroniques et postales, identifiants annoncés (IPP, NDA, N° de séjour) deviennent `[NOM]`, `[TÉLÉPHONE]`… Les citations sont vérifiées sur le texte masqué puis ramenées au document : l'extrait surligné reste celui du dossier. C'est une pseudonymisation, **pas une anonymisation**.
- Le **modèle qui a réellement répondu** (le repli côté serveur peut en désigner un autre) est celui que nomment la valeur, la passe et le coût ; tarif des identifiants datés.
- Mode « Règles puis Claude » : la consigne décrit toujours la fiche entière et reste en cache d'un dossier à l'autre.

### Import de tableaux de cohorte

- *Dossiers patients › Importer un tableau (Excel, CSV)* : `.xlsx`, CSV, TSV ; cinq étapes — fichier, feuille et ligne d'en-tête, colonne des codes et correspondances proposées, **simulation** (valeurs à écrire, refusées avec motif, conflits), écriture et bilan.
- Jamais par-dessus une décision de relecteur ni une valeur extraite ou importée différente, sauf option explicite ; écriture refusée si les données ont changé depuis la simulation.
- Provenance « Importé » partout : justification par fichier (téléchargeable, empreinte SHA-256), feuille, cellule, en-tête et contenu brut ; journal (import n°) ; rapport « Méthodes » (phrase, table des imports, limite). Une passe ne remplace pas une valeur importée ; un relecteur peut la confirmer ou la corriger ; la fiabilité ne la compte pas.
- Lecteur `.xlsx` maison en lecture seule, dans les fils d'analyse isolés : formules jamais évaluées, macros et liaisons ignorées, plafonds `TABLE_MAX_ROWS`, `TABLE_MAX_COLUMNS`, `TABLE_MAX_CELLS`, `TABLE_MAX_XML_MB`, `TABLE_MAX_TOTAL_MB`. Un tableau déposé avec les comptes rendus renvoie vers l'import de tableau.

### Revue bibliographique

- **PubMed prêt à l'emploi** par les E-utilities : nombre total et traduction de l'équation consignés, toutes les notices (jusqu'à `BIBLIO_PUBMED_MAX`, 10 000) ou les N premières, découpage par dates au-delà de 9 999 résultats, 3 requêtes/s (10 avec `NCBI_API_KEY`), `NCBI_EMAIL`, nouvelles tentatives sur 429/5xx.
- **Import de références** RIS, MEDLINE (`.nbib`), BibTeX, CSV (Embase, CENTRAL, Scopus, WoS, LiSSa, registres, Zotero…), base d'origine rangée dans sa colonne PRISMA ; `BIBLIO_IMPORT_MAX_MB`.
- **Diagramme de flux juste** : relancer une recherche ne gonfle plus les notices identifiées ; identifiées par base de données, registre et autres méthodes (Scholar en fait partie) ; motif d'exclusion facultatif au tri sur titre et résumé.
- **Journal de recherche PRISMA-S** : équation envoyée, traduction PubMed, fichier importé, résultats annoncés et récupérés, avertissements ; export CSV.
- Dédoublonnage : des PMID différents, ou des DOI différents pour un rapprochement par titre, ne fusionnent plus deux notices. Export RIS : type de référence (JOUR, CONF, BOOK, CHAP…) et PMCID (C2).
- Une passe dont toutes les sources échouent répond en erreur (502) et reste consignée ; Google Scholar ne reçoit plus les balises de champ PubMed.

### Résultats et exports

- Classeur Excel, feuille « Synthèse » : une valeur manquante n'est plus comptée comme un zéro ; mêmes calculs que l'écran et le diaporama ; quartiles et effectifs n (%).
- Choix multiples : pourcentages sur les dossiers renseignés ; mention « plusieurs réponses possibles » à l'écran, dans le classeur et sur la planche.
- Avertissement au-delà de 20 % de valeurs manquantes.
- CSV : clés techniques sans unité ; option « sans le libellé des dossiers » (`deidentify=1`) ; journal d'audit : colonne `import`.

### Version prête à l'emploi

- `npm run package -- --target win-x64|mac-arm64|mac-x64|linux-x64|all` : une archive par système (Node.js officiel vérifié, dépendances de production, OCR hors ligne), reproductible, avec son empreinte SHA-256 ; lanceurs `PubResearcher.cmd`, `PubResearcher.command`, `pubresearcher.sh` ; `LISEZMOI.txt`.
- Données dans le dossier de l'utilisateur (`%LOCALAPPDATA%\PubResearcher`, `~/Library/Application Support/PubResearcher`, `~/.local/share/pubresearcher`), jamais dans le dossier de l'application ; `DATA_DIR` l'emporte.
- Archives **non signées** ; seule l'archive Linux a été essayée de bout en bout.

### Tests et outillage

- **1 044 tests** (828 en 1.5.0) ; banc d'essai du moteur : **119 / 119 corrects, 0 valeur fausse**.
- **Porte 1** ([rapport de validation, § 1.6 et 5.3](validation.md)) : précision des règles mesurée sur 20 dossiers fictifs **jamais vus** (56 documents) avant toute correction — **94,8 %** (202/213, IC 95 % 91,0–97,1 %), contre 82,1 % avant la phase 1 sur un premier jeu ; objectif de 95 % manqué de peu. Les causes générales de ses erreurs sont corrigées depuis (98,5 % sur ce jeu, devenu jeu de mise au point) ; la prochaine certification demandera un troisième jeu inédit. Démonstration : précision 100 %, rappel 93,3 % (traitements désormais proposés, non remplis).
- Nouveaux fichiers de test : `engine-qualifiers`, `engine-precision`, `quote-check`, `pseudonymize`, `table-read`, `table-import`, `biblio-eutils`, `biblio-import`, `data-dir` ; `env-check` compare le tableau des bornes du guide de l'administrateur au code.
- Flux `.github/workflows/package.yml` : construction et essai des archives sur chaque système.

### Documentation

- Mis à jour : README, [Guide du chercheur](guide-chercheur.md) (import de tableaux, § 2.2 à 2.6, § 5, revue, limites, messages), [Guide de l'administrateur](guide-administrateur.md) (§ 2 version prête à l'emploi, § 3, § 4.3, 4.5, 4.6, 4.8), [Référence de l'API](reference-api.md) (`/api/table-imports`, `/api/biblio/imports`, journal de recherche), [Revue bibliographique](revue-bibliographique.md), [Sécurité et données personnelles](securite-et-donnees.md) (§ 2.1 pseudonymisation), [Architecture](architecture.md), [Méthodes et reproductibilité](methodes-et-reproductibilite.md), [Rapport de validation](validation.md) (§ 1.6, § 5).

## 1.5.0 — 11 octobre 2026

**Personne ne se perd en chemin vers sa clé, et la valeur de l'outil se voit dès l'inscription.**

### Application

- **Page « Activer Claude »** (colonne de gauche ; l'entrée devient « Claude » une fois la clé en service) : en mots simples, ce qu'est une clé d'API et ce que coûte Claude, puis trois étapes chez Anthropic — créer son compte, ajouter du crédit, créer la clé —, chacune avec un bouton qui ouvre **directement la bonne page de la console** (`platform.claude.com`), les réglages à choisir et la précision qui évite de se tromper ; enfin le champ où coller la clé (avec « Afficher » pour vérifier ce qu'on a collé). Chaque étape se coche et se replie ; un dépannage répond aux cas courants (clé refusée, crédit épuisé, clé expirée, se passer de Claude, données des patients).
- Sur *Extraction* et *Rédaction*, tant que Claude n'est pas activé : un encadré court qui mène au guide, avec le raccourci « J'ai déjà une clé ». La pastille du plan de travail et l'encadré de *Dossiers patients* y mènent aussi.
- **Toute clé fonctionne** : une clé personnelle qui vaut pour plusieurs espaces de travail d'Anthropic (qui doit sinon nommer son espace à chaque requête) est acceptée — la vérification trouve seule l'espace par défaut et l'enregistre avec la clé. Côté serveur administré : `ANTHROPIC_WORKSPACE_ID`.
- **Refus traduits en plus** : limite de dépenses atteinte, plafond mensuel du compte, clé expirée — chacun avec quoi faire, et sans réessai inutile.
- **Correctif** : les compteurs du rail et du plan de travail restaient périmés après un import, une passe ou une relecture jusqu'au rechargement de la page ; ils se recomptent maintenant après chaque écriture.

### Page d'accueil

- **Présentation vidéo à la première inscription** : avant le profil, « Bienvenue dans PubResearcher » montre l'application réelle en 1 min 35 — import avec la charte d'anonymisation, extraction, relecture d'une valeur et de sa source, résultats, export, Claude en option —, sur des dossiers fictifs. Jamais de lecture automatique ; sans son, sous-titrée ; son déroulé écrit se déplie dessous ; « Commencer le parcours » la passe, et elle ne revient pas dans la même session. La même vidéo est sur la page d'accueil (« Voir la démonstration ») et sur la page d'accès.
- **Page publique « Activer Claude »** (`/activer-claude`) : le même guide que l'application, mot pour mot, pour préparer sa clé avant d'installer l'outil — sans aucun champ : la clé se colle dans l'application, jamais sur le site. Liée depuis la page d'accès, la question sur le coût et le pied de page.

### Tests et outillage

- **828 tests** (816 en 1.4.0) ; **27 parcours** de bout en bout du site (25 en 1.4.0) ; le serveur statique des parcours sert aussi la vidéo.
- Le contrôle des secrets du site cherche une vraie clé (`sk-ant-` suivi d'au moins vingt caractères), plus la simple mention du préfixe, que le guide cite.
- Versions : `pubresearcher`, `@pubresearcher/server`, `@pubresearcher/web`, `@pubresearcher/landing` en 1.5.0.

### Documentation

- Mis à jour : README (la vidéo, le guide), [Guide du chercheur](guide-chercheur.md) (§ 5, messages), [Guide de l'administrateur](guide-administrateur.md) (§ 4.5 : espaces de travail, `ANTHROPIC_WORKSPACE_ID`), [Sécurité et données personnelles](securite-et-donnees.md), [Architecture](architecture.md), [Référence de l'API](reference-api.md) (`workspace`), [Page d'accueil](page-d-accueil.md), [Rapport de validation](validation.md) (§ 1.5).

## 1.4.0 — 11 octobre 2026

**Votre clé, votre facture.** Chacun utilise désormais **sa propre clé d'API Anthropic**, saisie dans l'application : PubResearcher ne facture rien et ne revend pas d'IA ; ce que consomment l'extraction par Claude et la rédaction assistée est facturé directement sur le compte Anthropic du titulaire de la clé, au prix public. Avant chaque passe, l'écran donne une **fourchette de coût en dollars** ; après, le **coût constaté**.

**Changement à connaître** : le modèle par défaut devient **Claude Opus 5.5** (`claude-opus-5-5`, 4 $US par million de jetons lus, 20 $US par million écrits) au lieu de `claude-opus-5`. Une installation qui fixe `LLM_MODEL` n'est pas concernée. `ANTHROPIC_API_KEY` fonctionne comme avant, mais une clé saisie dans l'application l'emporte sur elle.

**Aucun changement du schéma de la base** : une base, une fiche ou une sauvegarde de la 1.3.0 s'ouvre telle quelle.

### Application

- **Panneau « Clé d'API Anthropic »** sur la page *Extraction* (et sur *Rédaction* tant qu'aucune clé n'est disponible) : la marche à suivre (créer la clé dans la console d'Anthropic, y fixer une limite de dépenses), une saisie masquée, *Vérifier et enregistrer*, puis *Changer de clé* et *Retirer* ; *Utiliser ma propre clé* quand le serveur en fournit une. Enregistrer une clé choisit le mode « Règles puis Claude ».
- **Vérification avant enregistrement** : la forme d'abord (une clé d'administration `sk-ant-admin…` est refusée : elle n'interroge pas de modèle), puis **une requête gratuite à Anthropic**, qui prouve que la clé est valide et qu'elle a accès au modèle configuré. Clé erronée ou désactivée, sans accès, limite de débit, Anthropic injoignable : chaque cas a son message, et **rien n'est enregistré**.
- **Stockage** : `DATA_DIR/anthropic-key.json`, droits `0600` dès la création, écriture atomique, **hors de la base, des sauvegardes et des exports**. La clé ne repart jamais vers l'interface (provenance et quatre derniers caractères seulement), ni dans un message d'erreur, ni dans le journal. Elle sert aussitôt, sans redémarrage.
- **Coût** : fourchette en dollars avant une passe par Claude, calculée sur le texte réel des dossiers ; confirmation demandée au-delà de 5 $US ; coût constaté dans le bilan de passe (*Extraction*, *Dossiers patients*) et après chaque réponse de l'assistant de rédaction. Barème intégré des modèles Claude 5 ; un modèle absent du barème n'affiche que les jetons.
- **Erreurs d'Anthropic en clair** : clé révoquée en cours d'usage (« enregistrez-en une nouvelle »), **crédit épuisé** (« rechargez-le dans la console d'Anthropic ») — une passe interrompue n'efface rien.
- Le modèle s'affiche sous son nom (« Claude Opus 5.5 ») plutôt que son identifiant.

### API

- Nouvelles routes : `GET`, `PUT`, `DELETE /api/llm/key` (état, enregistrement après vérification, retrait) et `GET /api/llm/estimate` (fourchette de coût). Voir la [référence](reference-api.md#clé-dapi-anthropic-et-coût).
- `POST /api/records/extraction/run` renvoie aussi `model` et `costUsd` ; l'événement `done` de la rédaction, `costUsd` ; `GET /api/documents-capabilities`, `llm.keySource` et `llm.keyHint`.

### Page d'accueil

- Nouvelle question « Combien cela coûte-t-il ? » : l'application ne coûte rien ; les fonctions de Claude se paient avec sa propre clé, directement à Anthropic.

### Tests et outillage

- **816 tests** (793 en 1.3.0) : +20 pour la clé et le barème (`api-key.test.ts`, contre un faux Anthropic : forme, fichier `0600`, refus sans écriture, priorité sur l'environnement, masquage, routes, `Origin` étrangère, passe facturée sur la clé saisie, crédit épuisé), +3 pour l'affichage du coût et des noms de modèles.
- Versions : `pubresearcher`, `@pubresearcher/server`, `@pubresearcher/web`, `@pubresearcher/landing` en 1.4.0.

### Documentation

- Mis à jour : README (« Votre clé, votre facture »), [Guide du chercheur](guide-chercheur.md) (§ 5 et messages), [Guide de l'administrateur](guide-administrateur.md) (§ 3 et § 4.5), [Sécurité et données personnelles](securite-et-donnees.md) (ce qui sort, menaces, liste de contrôle, incidents), [Architecture](architecture.md), [Référence de l'API](reference-api.md), [Rapport de validation](validation.md) (§ 1.4), [Page d'accueil](page-d-accueil.md).

## 1.3.0 — 11 octobre 2026

**Une charte d'anonymisation avant tout import, et une page d'accueil publique.** L'application demande désormais, avant de laisser déposer le moindre fichier, de confirmer cinq engagements d'anonymisation. Un site public (`landing/`, à déployer sur Vercel) présente l'outil, permet de créer un accès avec Google ou une adresse e-mail et mène, par un court parcours d'accueil, jusqu'à ce même engagement. [Mise en service et fonctionnement](page-d-accueil.md).

**Aucun changement du moteur d'extraction, du schéma de la base, ni des routes de l'API** : `server/src` est inchangé. Une base, une fiche ou une sauvegarde de la 1.2.0 s'ouvre telle quelle.

### Application

- **Charte d'anonymisation devant l'import** (« Importer des dossiers », « Ajouter des documents ») : *PubResearcher n'anonymise rien* ; cinq engagements à cocher — identifiants directs retirés, angles morts vérifiés (en-têtes, tampons, noms de fichiers, texte des images, balises DICOM), code d'étude sans lien avec l'identité, base légale et autorisations, aucun envoi à une API sans autorisation. Tant qu'ils ne sont pas tous cochés, l'écran de dépôt n'existe pas. L'engagement est mémorisé dans le navigateur, **pour une version du texte** : quand le texte change, il est redemandé. Ensuite, un rappel d'une ligne reste affiché au-dessus de l'import et se déplie pour relire les engagements. C'est un rappel, pas un contrôle : l'outil ne peut pas savoir si un document est anonymisé.
- Le libellé facultatif d'un dossier rappelle de n'y mettre ni nom, ni initiales, ni date de naissance (il s'affiche dans les listes et les exports).

### Page d'accueil (nouveau : `landing/`)

- Site autonome (React, Vite), **même identité visuelle** que l'application : les jetons de couleur, les polices et l'illustration sont des copies exactes, qu'un test compare.
- **Pages** : accueil (les outils, deux captures de l'application en thème clair et sombre, le parcours, « PubResearcher n'anonymise rien », l'installation, les questions) ; inscription et connexion (**Google** ou e-mail et mot de passe) ; parcours d'accueil en trois étapes (profil, étude, **engagement**) ; accès (« Ouvrir l'application », premier lancement, récapitulatif, rappel adapté à l'état de l'autorisation éthique) ; mot de passe oublié ; confidentialité ; déconnexion.
- **Données** : Supabase Auth (flux PKCE) et deux tables, `profiles` et `consents` — ce dernier en **ajout seul**, une ligne par engagement avec la version du texte — protégées par des règles d'accès par ligne et des **droits accordés colonne par colonne** (migration SQL fournie) : les dates sont posées par la base, un engagement ne peut pas être antidaté. Aucune donnée de patient : aucune colonne ne peut en recevoir.
- **Projet Supabase en place** : « PubResearcher » (région `eu-west-3`, Paris), migration appliquée et vérifiée sur le projet réel (17 contrôles des règles et des droits, conseiller de sécurité sans remarque) ; son adresse et sa clé publique sont dans `landing/.env.production`. Restent les réglages du tableau de bord (adresses de retour, Google, envoi des courriels) et le déploiement Vercel : [mise en service](page-d-accueil.md#5-mettre-le-site-en-ligne--pas-à-pas).
- Tant que Google n'est pas activé dans le projet, « Continuer avec Google » le dit sur le site au lieu de mener à la page d'erreur brute du service.
- **Liens reçus par e-mail valables sur tout appareil** : avec les modèles de courriels fournis, la confirmation et la réinitialisation mènent directement au site, qui échange lui-même le jeton (à usage unique) — on peut s'inscrire sur son ordinateur et confirmer depuis son téléphone, et un logiciel de sécurité de messagerie qui visite le lien ne le consomme pas. Un lien qui n'a pas pu servir est expliqué là où l'on arrive, y compris sur la page « mot de passe ».
- **Déconnexion** limitée à ce navigateur (les autres appareils restent connectés), et confirmée quand on arrive sur `/deconnexion` autrement que par un bouton du site.
- Messages en français pour l'envoi refusé par le serveur de courriels par défaut de Supabase et pour une adresse refusée ; compilation autonome du site (types de Node déclarés dans `landing/`, comme l'exige Vercel).
- **Mode aperçu** sans configuration : tout le parcours se visite, rien n'est envoyé ni conservé, un bandeau le dit sur chaque page.
- **Sécurité** : politique de sécurité du contenu stricte (aucun script ni style en ligne ; connexions limitées au site et à Supabase ; `frame-ancestors 'none'`), pas de redirection ouverte après connexion, messages du service d'authentification toujours traduits (jamais de texte technique à l'écran), aucun secret dans le code.
- **Accessibilité** : WCAG 2.2 AA (axe-core, contraste mesuré sur le rendu), parcours au clavier, lien d'évitement, focus déplacé à chaque changement de page, de 320 à 1 440 px.

### Tests et outillage

- **793 tests** (690 en 1.2.0) : +7 pour la charte de l'application, +83 pour la logique, la migration et la configuration de déploiement de la page d'accueil (dont : la charte du site = celle de l'application mot pour mot, les options du parcours = les contraintes SQL, les jetons de couleur identiques), +13 pour les contrastes de la feuille de style de la page d'accueil.
- **Parcours de bout en bout** de la page d'accueil (`landing/e2e/`, 25 scénarios, Playwright) contre un **faux Supabase** en mémoire qui vérifie le PKCE, les jetons, les règles d'accès par ligne et les droits par colonne de la migration ; le site y est servi avec les en-têtes de `vercel.json`.
- Versions : `pubresearcher`, `@pubresearcher/server`, `@pubresearcher/web`, `@pubresearcher/landing` en 1.3.0.

### Documentation

- Nouveau : [Page d'accueil](page-d-accueil.md) — ce que le site conserve et ne reçoit jamais, la charte et sa version, mise en service pas à pas (Supabase, Google, Vercel), modèles de courriels en français, contrôles, limites, dépannage.
- Mis à jour : README, [Sécurité et données personnelles](securite-et-donnees.md) (la charte, le site), [Guide du chercheur](guide-chercheur.md) (l'import), [Identité visuelle](identite-visuelle.md) (le site), [Rapport de validation](validation.md) (§ 1.3 et § 13).

## 1.2.0 — 10 octobre 2026

**PubResearcher.** L'application change de nom — « Research Tool » dans les paquets, la bannière de démarrage et le domaine d'authentification, « Espace de recherche » à l'écran — et d'identité visuelle : indigo nuit, poussière d'or, bleu pervenche, police Poppins. [Description de la charte](identite-visuelle.md).

**Aucun changement du moteur d'extraction, du schéma de la base, ni des routes de l'API** (seul le nom du domaine d'authentification change, voir plus bas). Une base, une fiche ou une sauvegarde de la 1.1.0 s'ouvre telle quelle ; les noms de fichiers de données (`research-tool.db`, `.research-tool.lock`, `research-tool-sauvegarde-…`) sont conservés pour cela. Les extractions refaites donnent les mêmes valeurs qu'en 1.1.0.

### Interface

- **Charte** refondue : jetons de couleur des deux thèmes, police **Poppins** embarquée (quatre graisses, licence SIL OFL jointe : rien n'est téléchargé), cartes à grands rayons, ombres diffuses teintées d'indigo, étiquettes en capitales espacées.
- **Carte d'en-tête** du plan de travail : dégradé indigo traversé d'un arc d'or poudré (image générée de façon déterministe : `scripts/make-hero-art.mjs`), mode d'extraction en pastille, chiffres-clés en pastilles de verre.
- **Rail d'outils** en pastille de verre sombre, l'outil courant allumé en bleu pervenche. Sous 1 000 px, il devient une **pastille flottante** au bas de l'écran (libellés courts, défilement horizontal, outil courant recentré) ; les zones collées au bas de l'écran (barre d'enregistrement, saisie de la rédaction, notifications) se décalent d'autant.
- **Tuiles de chiffres** : valeur en gras et centrée, libellé dessous ; deux par ligne sur écran étroit.
- **Marque** : médaillon et mot-symbole « Pub » / « Researcher » dessinés en SVG, icône d'onglet. Le mécanisme de logo institutionnel (`web/public/logo-hopital.*`) est retiré : le dépôt ne contient plus aucune marque tierce.
- La barre supérieure et les titres d'onglet portent le nouveau nom.

### Textes et exports

- Bannière de démarrage « PubResearcher 1.2.0 — prêt sur … » ; domaine d'authentification HTTP Basic `PubResearcher`.
- Le rapport « Méthodes et traçabilité » nomme l'application **PubResearcher** (paragraphe « Méthodes » et tableau des versions) : un rapport généré par la 1.1.0 dit « Research Tool ».
- Le diaporama de figures (PPTX) et le rapport HTML reprennent les couleurs de la charte (bleu pervenche à la place du vert).

### Paquets et outillage

- Paquets npm renommés `pubresearcher`, `@pubresearcher/server`, `@pubresearcher/web` ; commandes inchangées (`npm start`, `npm test`…).
- Tests : le contrôle des contrastes couvre désormais le rail, la carte d'en-tête, les boutons pleins et les couples propres aux composants (13 tests au lieu de 7) ; 690 tests en tout (684 en 1.1.0).
- Les sorties Apify enregistrées pour les tests (`server/test/apify-fixtures/`) ne contiennent plus les adresses électroniques d'auteurs qu'elles portaient : des données de tiers, inutiles aux tests.
- Nouveau : `docs/identite-visuelle.md` (la charte), `scripts/make-hero-art.mjs` (l'illustration d'en-tête, déterministe), `docs/img/social-preview.png` (carte de partage du dépôt).
- Validation : le rapport (`docs/validation.md`) distingue les mesures de la 1.1.0 de ce qui a été rejoué pour la 1.2.0 (§ 1.2) et décrit la refonte (§ 9). Parmi les défauts que ces contrôles ont fait corriger, un contraste de 3,3:1 sur le compteur de l'outil actif du rail, que l'audit automatisé ne détecte pas (fond en dégradé translucide).

## 1.1.0 — 9 octobre 2026

Révision complète pour l'usage en recherche : fiabilité des données, durcissement, accessibilité, documentation.

**Un changement de comportement à connaître.** L'outil n'écoute plus que sur le poste (`HOST=127.0.0.1`) ; la 1.0.0 écoutait sur toutes les interfaces. Pour l'ouvrir au réseau, il faut le demander (`HOST=0.0.0.0`) et, de préférence, fixer `APP_PASSWORD` (guide de l'administrateur, § 5). Derrière un proxy inverse qui relaie vers le poste, le nom public doit être déclaré (`ALLOWED_HOSTS`), sans quoi l'outil répond 403.

**Côté données, aucune rupture** : une base créée par la 1.0.0 monte seule vers le schéma 1 au premier démarrage, et reste relisible par la 1.0.0 (une migration ajoute des colonnes facultatives et des tables, elle ne retire ni ne renomme rien).

**Des extractions plus justes, donc parfois différentes.** Le moteur est plus strict (mots entiers, négations, valeurs seuil, unités) : réextraire un corpus avec la 1.1.0 peut donner d'autres valeurs que la 1.0.0, et c'est voulu. Le rapport « Méthodes et traçabilité » consigne la version de l'outil de chaque passe.

### Ce que le chercheur y gagne

**Relecture traçable.**
- *Confirmer*, *corriger*, *vider* ou *rendre la main* à l'extraction : une valeur relue garde ce que la machine avait proposé. Vider une valeur est une décision qui survit aux passes suivantes.
- **Historique** par variable : chaque événement (passe, relecture) avec l'ancienne et la nouvelle valeur.
- Saisie contrôlée : entier à virgule refusé (plus d'arrondi silencieux), dates du calendrier réel (pas de 31 février), nombres avec virgule ou point quelle que soit la langue du navigateur (« 12,5 » n'est plus lu 125), **bornes de plausibilité à confirmer** (« Valeur inhabituelle »), brouillons conservés, garde à la fermeture.
- **Une passe ne retire que ce qu'elle a pu produire** : une passe « règles seules » laisse intactes les valeurs proposées par Claude, et un appel à Claude qui échoue n'efface pas celles d'une passe précédente.

**Mesure de la fiabilité.**
- Page *Fiabilité* : concordance (précision) et rappel, avec intervalle de Wilson à 95 %, global et par variable, calculés à partir des gestes de relecture.
- Rapport **« Méthodes et traçabilité »** (Markdown, HTML autonome, JSON ; français, anglais) : corpus, fiche et son **empreinte SHA-256**, passes (nombre total, première et dernière, moteurs et modèles employés, détail des 25 plus récentes), origine des valeurs, fiabilité, journal, versions logicielles, limites, et un paragraphe « Méthodes » rédigé avec les chiffres de la base.
- **Journal d'audit** (CSV) : chaque changement de valeur, avant/après, origine, passe. Aucune fonction de l'outil ne le modifie ; il ne disparaît qu'avec le dossier, la variable ou la fiche concernés.
- **Journal des passes** : fiche (empreinte), mode, modèle, version de l'outil, effectifs.

**Moteur d'extraction plus juste.**
- Mots entiers pour les sigles (« mme » n'est plus trouvé dans « homme », « hta » n'est plus « HTAP »).
- Négations : limitées à la proposition, prolongées par « ni », lues aussi après le terme (« diabète : non », « HTA exclue »), sans contaminer « non insulinodépendant ».
- **Contextes à ignorer** (antécédents familiaux) : ni affirmés ni niés.
- **Valeurs seuil** (« CRP < 5 ») écartées au lieu d'être lues « 5 » ; **unités de temps** différentes (« 6 mois » pour des ans) écartées ; **unités courantes différentes** (« 85 µmol/L » pour du mg/L) écartées et signalées ; entier décimal écarté.
- Choix multiples reconnus avec leurs liaisons (« scanner et IRM »), sans doublon d'une option contenue dans une autre.
- **Valeurs écartées visibles** : le banc d'essai de l'éditeur, le bilan de passe (page Extraction et page Dossiers) et la relecture montrent ce qui a été trouvé puis refusé, avec la raison — une variable vide n'est plus ambiguë. Le banc d'essai applique l'unité en cours d'édition, même non enregistrée.
- Nombres : `1.200,5`, `1,200.5`, `12 500` ; signe moins collé conservé (« -3,2 »).
- Apostrophes : l'apostrophe droite et celle que Word insère (’) sont équivalentes dans les libellés, les termes et les expressions régulières.
- **Expressions régulières surveillées** : un motif catastrophique (`(\w+\s?)+:`) ne fige plus le serveur ; interrompu, il est écarté avec sa raison.

**Import.**
- **OCR des pages scannées d'un PDF** (jusqu'à 30 pages par document, réglable), avec bandeau « texte reconnu par OCR » à la relecture.
- Texte brut, RTF, HTML ; encodage détecté (UTF-8, Windows-1252, UTF-16).
- Noms de fichier en UTF-8 (« opératoire », plus « opÃ©ratoire »).
- Dossiers déposés : détection d'une **cohorte** (un sous-dossier = un patient) et choix explicite si la forme est ambiguë.
- Doublons par empreinte, y compris sur deux envois simultanés. **Supprimer un dossier supprime aussi ses fichiers.**
- Fichier vide refusé ; messages d'échec de lecture traduits et sans fuite technique.
- **Un document lu en partie le dit** (texte tronqué au plafond, pages PDF non lues) : au bilan d'import (« Importés, mais lus en partie »), puis en bandeau « Lecture incomplète » à la relecture — une coupure ne passe plus pour une absence de valeur.
- **Un fichier trop gros ne fait plus échouer les autres** : si le serveur refuse un lot en bloc, ses fichiers repartent un par un ; seul le fautif est signalé, avec la variable à relever (`MAX_UPLOAD_BYTES`).

**Exports.**
- Virgule décimale cohérente (CSV, Excel, graphiques, diaporama), en-têtes en clair complets (y compris les trois premières colonnes), dictionnaire avec type lisible (`type_libelle`), noms de fichiers sans répétition.
- Exports bibliographiques **complets** (au-delà de 1 000 notices) et nommés d'après leur contenu.
- Le rapport « Méthodes et traçabilité » et le journal d'audit rejoignent les exports ; le compteur « formats de sortie » du plan de travail est tiré de la liste réelle.

**Revue bibliographique.** Recherche dans la bibliothèque en plusieurs mots, sans accents ni casse, entre guillemets pour une expression ; sources et exports mieux libellés.

### Ce que l'administrateur y gagne

- **Écoute sur le poste par défaut** (`HOST=127.0.0.1`) ; avertissement net si le réseau est ouvert sans mot de passe ; **`APP_PASSWORD`** (HTTP Basic, comparaison à temps constant, blocage après dix échecs en cinq minutes) ; `TRUST_PROXY`, `ALLOWED_HOSTS`, `ALLOWED_ORIGINS`.
- **Garde des requêtes** : liste blanche des noms d'hôte (anti « DNS rebinding »), refus des écritures venues d'un autre site (anti-CSRF).
- En-têtes de sécurité et CSP stricte ; `Cache-Control: no-store` sur l'API.
- **Sauvegarde et restauration vérifiables** (`npm run backup` / `restore`, disponibles aussi depuis la racine du projet, ainsi que `npm run demo`) : instantané cohérent pendant que l'outil tourne, manifeste d'empreintes, restauration refusée si la sauvegarde est altérée, données remplacées mises de côté.
- **Démarrage sans piège** : `npm start` vérifie la version de Node et compile l'application à la première utilisation (avant, démarrer sans avoir compilé donnait une trace « Cannot find module » que rien n'expliquait) ; `lancer.bat` (Windows) et `lancer.command` (macOS, Linux) installent, démarrent et ouvrent le navigateur en un double-clic (essayés sous Linux seulement).
- **Un seul processus par dossier de données** (verrou) ; démarrage vérifié (Node ≥ 22.13, dossier inscriptible, base ouvrable, configuration valide) avec un message qui dit quoi corriger plutôt qu'une trace de pile ; `GET /api/health` qui interroge réellement la base.
- **Arrêt propre** : à `SIGTERM` ou `SIGINT`, le serveur cesse d'accepter, laisse cinq secondes aux requêtes en cours, arrête les fils d'analyse et l'OCR, puis ramène le journal de la base dans le fichier principal. Après un arrêt normal, `research-tool.db` seul est complet (ni `-wal` ni `-shm`) : on peut le copier tel quel.
- **Analyse des fichiers dans des fils séparés** : délai ferme, mémoire bornée, surveillance de croissance ; un PDF piégé (arbre de pages bouclé, flux qui se gonfle) échoue seul. Un document dont l'analyse échoue est enregistré en erreur **avec le motif**.
- Plafonds explicites et réglables (pages PDF, texte, taille décompressée Word, mégapixels, simultanéité), chacun avec un message qui dit lequel et comment le relever. Les tailles s'écrivent en clair (« 20 ko », « 3,4 Mo »), jamais « 0 Mo ».
- **Réglages d'environnement validés** : les 21 réglages numériques ont des bornes (`PORT=abc`, `MAX_TEXT_CHARS=0` ou `OCR_PDF_SCALE=9` arrêtent le démarrage avec la liste des valeurs refusées, au lieu d'être ignorés ou de produire un comportement imprévisible), ainsi que `LLM_EFFORT` ; identifiants d'URL strictement décimaux ; JSON trop gros → 413 ; corps mal formés → 400, jamais 500.
- **Écritures atomiques** : une passe d'extraction ou une série de corrections tient en une transaction par dossier ; un arrêt brutal ne laisse jamais une fiche à moitié écrite (vérifié par 25 arrêts `kill -9`).
- Migrations de schéma versionnées (`PRAGMA user_version`), base plus récente que l'outil refusée.
- Réponses d'erreur **sans message SQL ni chemin disque** ; jeton Apify masqué sous toutes ses formes, clé de l'API Claude masquée dans les erreurs.
- Délais HTTP adaptés (envoi de 200 Mo sur liaison lente : 30 min ; en-têtes : 60 s).
- **Ce qui part chez Anthropic est réduit à l'utile** : le texte des documents est présenté à Claude comme « Document 1 », « Document 2 »… (ni code de dossier ni nom de fichier) ; l'assistant de rédaction ne reçoit que des agrégats, et pour une variable en texte libre, seulement des effectifs (« valeurs non transmises »). Le texte des documents, lui, part tel quel : il peut contenir des identifiants (voir [Sécurité et données personnelles](securite-et-donnees.md)).
- **Versions de Node** : essayé de 22.13.0 à 26.11.1 (22.13.0, 22.22.2, 22.23.3, 24.21.0, 26.11.1). Deux défauts propres aux versions anciennes ont été corrigés : le décodeur `windows-1252` de Node 22.13 à 22.21 renvoie des caractères de contrôle pour les octets 0x80 à 0x9F (€, œ, guillemets…) — l'outil a sa propre table ; et l'ordre des événements d'un fil d'analyse n'est pas garanti, ce qui pouvait faire déclarer « indisponible » un fil qui démarrait.

### Accessibilité et interface

- Cible **WCAG 2.2 AA**, vérifiée par axe-core sur 8 pages × 4 largeurs (320, 390, 768, 1440 px) × 2 thèmes : 0 violation, 0 débordement horizontal, 0 erreur de console. Le contraste des jetons de couleur est vérifié par un test (texte ≥ 4,5:1 sur les six surfaces, bordure des champs et anneau de focus ≥ 3:1, thèmes clair, sombre et sombre du système identiques).
- Lien d'évitement, un `h1` par vue, **onglets au clavier** (flèches, Début, Fin), fenêtres modales qui piègent le focus et le rendent, noms accessibles contextuels (« Supprimer le dossier PAT-001 »), zones de défilement focalisables et nommées, cibles ≥ 24 px, annonces vocales, titre d'onglet par outil et par dossier, `lang="en"` sur les résumés anglais, `prefers-reduced-motion`.
- Libellés revus : apostrophe typographique (’) partout dans l'interface, accords (« 1 source testée »), plus de « Détail : » qui répète la consigne, plus de « Réessayer » sous « Dossier introuvable ».
- Thème clair/sombre appliqué **avant** le premier rendu ; stockage du navigateur protégé (plus de page blanche en navigation privée stricte).
- Double clic sur « Supprimer » : le second clic n'est plus une confirmation.
- Pagination des listes longues (dossiers, bilans, tableau) ; 2 000 dossiers se chargent en 1 à 1,6 s.
- Gros documents : le serveur reste réactif pendant l'extraction d'un texte de 50 Mo (gel maximal du serveur 23 s → 0,4 s et mémoire de pointe 3,3 Go → 346 Mo, mesurés avant et après correction ; le texte conservé est plafonné à 8 millions de caractères et signalé).

### Dépendances

`multer` 2.4, `@xmldom/xmldom` 0.8.15, `proxy-addr` 2.0.8, `qs`, `postcss`… : 9 avis → 3, les trois restants (modérés) viennent de la chaîne `mammoth` → `argparse` → `sprintf-js`, sans chemin atteignable. `react-router` reste en 7.18.2. Au 9 octobre 2026, `npm audit` : 3 modérés, 0 élevé.

### Tests

De 173 (README d'origine) à 684 tests répartis en 35 fichiers, dont 55 de durcissement de l'API (~3 000 requêtes hostiles), 33 d'isolation (sur de vrais fichiers piégés, puis sur des événements de fil simulés dans tous les ordres), 10 de démarrage en processus réel, un banc d'essai du moteur (88 cas à réponse connue, 0 valeur fausse). Voir le [rapport de validation](validation.md).

### Documentation

Guides du chercheur et de l'administrateur, référence de l'API, architecture, sécurité et données personnelles, méthodes et reproductibilité, rapport de validation, ce journal.

---

## 1.0.0 — 8 octobre 2026 (état reçu)

Application d'exploitation de dossiers patients : import (Word, PDF, images, DICOM), fiche d'exploitation paramétrable, extraction par règles ou par Claude avec vérification des citations, relecture, résultats, export CSV, classeur Excel typé, diaporama de figures, dictionnaire des variables, fiche au format JSON, plus la page **Revue bibliographique** (PubMed et Google Scholar par acteurs Apify, dédoublonnage, tri PRISMA, exports RIS/BibTeX/CSV).
