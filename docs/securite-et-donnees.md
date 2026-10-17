# Sécurité et données personnelles

Cet outil manipule des comptes rendus de patients. Ce document dit ce qu'il protège, ce qu'il ne protège pas, ce qui sort de la machine, et ce qu'il faut décider *avant* de s'en servir. Il décrit le comportement de l'outil ; il ne remplace ni l'avis de votre délégué à la protection des données, ni celui du comité d'éthique, et ne constitue pas un conseil juridique.

## 1. L'essentiel

1. **Par défaut, rien ne sort de la machine et rien n'y entre depuis le réseau.** L'outil écoute sur `127.0.0.1`, extrait par des règles locales, fait son OCR hors connexion. La version prête à l'emploi ne se connecte pas non plus au premier lancement (Node.js et les données de l'OCR sont dans l'archive).
2. **Trois fonctions peuvent faire sortir des données, et seulement quand vous les employez** : l'extraction par Claude (envoie le texte des documents, pseudonymisé sur le poste, à l'API d'Anthropic), la rédaction assistée (lui envoie des agrégats de la cohorte) et la revue bibliographique (envoie l'équation de recherche au NCBI pour PubMed, à Apify pour Google Scholar). Les deux premières demandent une **clé d'API Anthropic** — celle de l'utilisateur, saisie dans l'application, ou celle de l'environnement du serveur — et sont facturées sur le compte de son titulaire ; PubMed ne demande aucun réglage. Voir § 2.
3. **L'outil n'anonymise rien.** Ce qu'il lit est ce qu'il stocke. Avant un envoi à Claude, il **pseudonymise** le texte (noms annoncés par une civilité, téléphones, dates de naissance, identifiants…), sans garantie : ce n'est pas une anonymisation (§ 2.1). Importez des documents **pseudonymisés**, avec des codes de dossier sans lien avec l'identité. Avant tout import, l'interface fait confirmer une **charte d'anonymisation** (cinq engagements, redemandés à chaque nouvelle version du texte) : c'est un rappel, pas un contrôle (§ 5).
4. **Il n'y a ni chiffrement au repos, ni comptes individuels.** La base et les fichiers sont en clair dans `DATA_DIR`. Un mot de passe unique, partagé, peut protéger l'accès réseau. Le reste relève du poste : disque chiffré, droits du système de fichiers, sauvegardes protégées.
5. **Sur un réseau, mettez-le derrière HTTPS.** Le mot de passe HTTP Basic circule en clair sans TLS.

## 2. Ce qui sort de la machine

| Fonction | Condition | Ce qui est transmis | À qui |
|---|---|---|---|
| Extraction « Règles seules » (défaut) | — | **Rien** | — |
| Extraction « Règles puis Claude » / « Claude seul » | Une clé d'API Anthropic disponible (saisie dans l'application ou `ANTHROPIC_API_KEY`) **et** mode choisi à chaque passe | Le **texte des documents** des dossiers traités, **pseudonymisé sur le poste** (§ 2.1 ; au plus `LLM_MAX_CHARS_PER_DOC` caractères par document, 60 000 par défaut), présentés sous les noms « Document 1 », « Document 2 »… — **ni les noms de fichier ni le code du dossier ne partent** —, le nom de la fiche, les libellés, clés, unités, définitions et options de **toutes** les variables de la fiche (même en mode « Règles puis Claude », pour que la consigne reste en cache), et la liste des clés des variables restées vides | API d'Anthropic |
| Rédaction assistée | Une clé d'API Anthropic disponible | Des **agrégats** de la cohorte : nom et objet de la fiche, effectifs, complétude, et pour chaque variable ses indicateurs (moyenne, écart type, médiane, quartiles, extrêmes) ou ses modalités avec leurs effectifs, plus les définitions des variables. **Une variable en texte libre ne donne que ses effectifs** : aucune de ses valeurs, aucun code de dossier, aucun nom de fichier ne part | API d'Anthropic |
| Extraction, import de fiche ou rédaction par un **modèle local** | « Modèle local » choisi pour la tâche (page Modèles d'IA) | **Rien** : le texte est lu par Ollama sur le poste (`127.0.0.1`). Une adresse hors du poste est refusée sauf `LOCAL_MODEL_ALLOW_REMOTE=1` — les textes partent alors, pseudonymisés, vers cette machine | — (ou le serveur désigné) |
| Téléchargement d'un modèle local | Bouton « Télécharger » | Le **nom du modèle** demandé ; aucune donnée d'étude | Bibliothèque d'Ollama (`registry.ollama.ai`) |
| Vérification d'une clé saisie | L'utilisateur enregistre une clé dans l'application | La **clé** elle-même et l'identifiant du modèle configuré (une requête, qui demande la fiche du modèle) ; pour une clé valable dans plusieurs espaces de travail, deux lectures de la liste des espaces de l'organisation, puis l'identifiant de l'espace retenu. **Aucune donnée d'étude** | API d'Anthropic |
| Revue bibliographique, PubMed | Une recherche lancée (aucun réglage) | L'**équation de recherche** saisie, la période, l'ordre, le nom de l'outil (`tool=PubResearcher`) et, si elles sont définies, l'adresse `NCBI_EMAIL` et la clé `NCBI_API_KEY` | NCBI (National Library of Medicine, États-Unis) |
| Revue bibliographique, Google Scholar | `APIFY_TOKEN` défini **et** Scholar coché | L'équation (sans les balises de champ PubMed), la période, le nombre de résultats | Apify, qui interroge Google Scholar |
| Import de références (RIS, nbib, BibTeX, CSV) | — | **Rien** : le fichier est lu sur le poste | — |
| Import de tableau de cohorte | — | **Rien** : le fichier est lu et conservé sur le poste | — |
| OCR | — | **Rien** : le moteur et les données de langue française sont installés avec l'outil | — |
| Installation (`npm install`) | — | Téléchargement des dépendances depuis le registre npm (pas pour la version prête à l'emploi, qui les contient) | npm |
| Mise en ligne de l'interface | — | **Aucune ressource externe** : ni police, ni script, ni statistique ; la politique de sécurité du contenu l'interdit | — |

**Conséquences pratiques**

- Un **modèle local** (Ollama, voir [Modèles d'IA locaux](modeles-locaux.md)) garde lui aussi tout sur le poste : c'est l'option à retenir quand le transfert à un sous-traitant n'est pas autorisé mais qu'une aide à la lecture du texte rédigé est souhaitée. Sa précision se mesure avant usage.
- Le **mode « Règles seules »** est, avec un modèle local, le seul qui reste intégralement dans l'établissement. Si l'étude n'a pas obtenu l'autorisation de transférer des données de santé à un sous-traitant, **n'enregistrez aucune clé d'API Anthropic** — ni dans l'application, ni dans `ANTHROPIC_API_KEY` : sans clé, les deux autres modes sont indisponibles (l'interface le dit).
- **Le texte part pseudonymisé, pas anonymisé.** Les noms de fichier et le code du dossier restent sur la machine (le modèle ne voit que « Document 1 », « Document 2 »…) ; « Nom : DUPONT Jean » ou « Mme Dupont » deviennent `[NOM]`, mais un nom sans civilité au milieu d'une phrase, un lieu ou une profession rare partent (§ 2.1). Pseudonymisez les documents **avant** l'import.
- Si vous l'activez, le transfert est un traitement par un sous-traitant : à déclarer, à encadrer contractuellement, à décrire dans le protocole. Vérifiez les conditions d'utilisation et de conservation de votre compte API, et l'éventuelle option de non-conservation des données.
- **N'écrivez aucune donnée de patient dans l'équation bibliographique** (nom, date de naissance, numéro de dossier…).
- **La clé est celle de l'instance.** Une clé saisie dans l'application sert à toute personne qui accède à l'outil : sur une instance partagée, chacun peut lancer des passes facturées sur ce compte (sans jamais pouvoir lire la clé). Une instance par étude, et une **limite de dépenses** fixée dans la console d'Anthropic.
- Pour qu'un envoi ne parte jamais par inadvertance, n'enregistrez la clé que le temps des passes voulues (*Retirer* l'efface), et ne la placez pas dans l'environnement habituel de l'outil.
- **Un tableau de cohorte importé est conservé en entier** (`DATA_DIR/uploads/imports/`), toutes feuilles et toutes colonnes, y compris celles qui n'ont pas été reprises dans la fiche : un tableau d'équipe porte souvent un nom, un numéro de dossier hospitalier ou une date de naissance. Retirez ces colonnes **avant** l'import. Le fichier est compris dans les sauvegardes, téléchargeable depuis la justification de chaque valeur importée, et un import confirmé ne se supprime pas par l'interface (il justifie les valeurs qu'il a posées).

### 2.1 La pseudonymisation avant Claude, et ses limites

Avant tout envoi à l'API d'Anthropic, le texte de chaque document est pseudonymisé **sur le poste** (`engine/pseudonymize.ts`) — la méthodologie de référence MR-004, en France, n'admet un transfert hors de l'Union que de données pseudonymisées et strictement nécessaires. Sont remplacés par une étiquette :

| Ce qui est repéré | Étiquette |
|---|---|
| Nom à majuscule initiale précédé d'une civilité ou d'un titre (M., Mme, Monsieur, Dr, Pr…), soignants compris ; champs « Nom », « Prénom », « Patient : » | `[NOM]` |
| Date de naissance annoncée (« né le », « date de naissance », « DDN ») | `[DATE DE NAISSANCE]` |
| Numéro de sécurité sociale | `[N° SÉCURITÉ SOCIALE]` |
| Téléphone | `[TÉLÉPHONE]` |
| Adresse électronique | `[E-MAIL]` |
| Identifiant annoncé par son libellé (IPP, NIP, NDA, N° de dossier, de patient, de séjour) | `[IDENTIFIANT]` |
| Adresse postale (numéro, puis rue, avenue, boulevard…) | `[ADRESSE]` |

Le libellé qui annonce la donnée reste en clair (« Né le [DATE DE NAISSANCE] ») : la phrase reste lisible pour le modèle. Les valeurs cliniques — examens, dates de soins, traitements — ne sont pas touchées : ce sont elles qu'il doit relever. Les citations du modèle sont vérifiées sur le texte masqué, puis ramenées au document d'origine : l'extrait surligné à la relecture est celui du dossier. `LLM_PSEUDONYMIZE=0` désactive le masquage.

**C'est une pseudonymisation, pas une anonymisation.** Elle repose sur des motifs : un nom sans civilité au milieu d'une phrase (« vu avec Martin ce matin ») ou écrit en minuscules après la civilité, un surnom, une ville, une profession rare, une date d'admission, une combinaison de détails cliniques passent. Les données envoyées restent des données personnelles de santé : le transfert demande les mêmes autorisations, et la charte d'anonymisation affichée avant l'import garde tout son sens.

## 3. Modèle de menaces

| Menace | Mesure | Résiduel |
|---|---|---|
| **Un site web ouvert dans le même navigateur lit l'API** (« DNS rebinding » : le site fait pointer son nom vers `127.0.0.1`) | Liste blanche de l'en-tête `Host` : `localhost`, `127.0.0.1`, `[::1]`, plus `ALLOWED_HOSTS` | Aucun tant que l'outil n'écoute que sur le poste |
| **Un site tiers écrit dans l'outil** (CSRF : envoi d'un fichier, changement de fiche active, relance d'extraction) | Refus de toute requête modifiante dont l'`Origin` désigne un autre site ou vaut `null` | Un script local sans `Origin` (curl) passe : il tourne déjà sur le poste |
| **Un voisin du réseau** atteint l'outil | Écoute sur `127.0.0.1` par défaut ; si `HOST` ouvre le réseau, avertissement au démarrage tant qu'aucun mot de passe n'est défini | L'ouverture au réseau est un choix de l'administrateur ; mot de passe + HTTPS requis |
| **Devinette du mot de passe** | Comparaison à temps constant ; 10 échecs en 5 minutes ferment l'accès 5 minutes (par adresse) ; l'adresse réelle se lit derrière un proxy de confiance (`TRUST_PROXY`) | Un mot de passe faible reste faible ; pas d'authentification à deux facteurs |
| **Fichier piégé** (PDF dont les pages se bouclent, flux compressé qui se gonfle, Word ou classeur qui se décompresse en gigaoctets, image de 100 mégapixels) | Plafonds (pages, texte, taille décompressée, mégapixels, lignes et cellules d'un tableau) **et** analyse dans un fil séparé avec délai ferme et mémoire bornée : le fichier échoue seul, le serveur répond toujours. Classeur : tailles annoncées vérifiées avant décompression, formules jamais évaluées, macros et liaisons externes ignorées, `DOCTYPE` refusé | Un fichier qui s'analyse « correctement » mais dont le contenu est trompeur (texte caché) donne des valeurs fausses : la relecture existe pour cela |
| **Expression régulière malveillante ou maladroite** dans une fiche importée | Analyse statique des motifs à risque (quantificateurs imbriqués, alternative sous un quantificateur, références arrière, quatre quantificateurs ouverts ou plus), exécution des motifs repérés sous un délai d'interruption (`REGEX_BUDGET_MS`, 250 ms), disjoncteur, raison affichée ; plafonds de longueur | Un motif que l'analyse croit sain mais qui est lent (trois quantificateurs ouverts enchaînés, par exemple) s'exécute sans délai à sa **première** évaluation : le serveur la subit, puis le motif est classé à risque |
| **Fiche importée mal formée** | Validation stricte du JSON (types, longueurs, nombre de règles) ; création **en entier ou pas du tout** | — |
| **Injection de formule dans Excel** via une valeur extraite (`=CMD(…)`) | Les cellules texte qui commencent par `=`, `+`, `-`, `@` sont préfixées d'une apostrophe dans les CSV ; jamais pour un nombre | Ouvrir un CSV dans un tableur reste à vos risques : relisez les sources non fiables |
| **Chemin de fichier forgé** (`../../…`) | Nom de stockage généré par le serveur ; nom d'affichage purgé de tout chemin ; type servi d'après une liste fermée, `nosniff`, `inline` réservé au PDF, aux images et au texte brut (`.txt`, servi en `text/plain`) | — |
| **Fuite par message d'erreur** | Aucune réponse ne contient de message SQL ni de chemin disque ; une référence aléatoire renvoie à la pile dans le **journal du serveur** | Le journal du serveur peut contenir des noms de fichiers : protégez-le comme les données |
| **Fuite d'un jeton** | La clé Anthropic (saisie ou d'environnement), `NCBI_API_KEY` et `APIFY_TOKEN` ne quittent jamais le serveur, sauf vers leur fournisseur ; des tests établissent qu'aucune réponse de l'API, messages d'erreur compris, ne les contient — y compris quand une passerelle répète les en-têtes de la requête dans son refus (jeton Apify : `api-hardening.test.ts` ; clé Anthropic : `llm-secrets.test.ts` et `api-key.test.ts`, avec un faux serveur). Une clé saisie dans l'application est écrite dans `DATA_DIR/anthropic-key.json`, droits `0600` dès la création, **hors de la base, des sauvegardes et des exports** ; l'interface n'en reçoit que les quatre derniers caractères, le journal aussi | Le fichier de la clé est en clair sur le disque, lisible du compte de service (et de l'administrateur du poste) : protégez `DATA_DIR`. Une clé placée dans un fichier `.env` ou un historique de shell reste exposée à qui lit ce fichier |
| **Un site tiers remplace la clé** (pour faire passer les envois par son compte) ou l'efface | Les routes de la clé (`PUT`/`DELETE /api/llm/key`) sont modifiantes : refus d'une `Origin` étrangère (CSRF) et liste blanche de l'en-tête `Host` (DNS rebinding), comme le reste de l'API ; la nouvelle clé doit en outre être acceptée par Anthropic | Qui a accès à l'outil (mot de passe) peut changer la clé : c'est un réglage de l'instance |
| **Dépense imprévue** (passe lancée sur toute une cohorte, boucle d'essais) | Fourchette de coût affichée avant chaque passe par Claude, confirmation au-delà de 5 $US, coût constaté après ; aucune relance automatique d'une passe | La seule borne ferme est la **limite de dépenses** du compte Anthropic : fixez-la |
| **Contenu actif servi** (un `.html` déposé comme « document ») | Les fichiers sont servis d'après une liste fermée d'extensions ; tout ce qui n'est pas PDF, image ou texte brut est servi en téléchargement | — |
| **Deux instances sur les mêmes données** | Verrou du dossier de données | — |
| **Perte de données** (crash, coupure, disque plein) | WAL, transactions atomiques par dossier, passes `running` marquées `failed` au redémarrage, dépôt provisoire purgé ; **sauvegarde/restauration vérifiables** | Une sauvegarde non faite ne se rattrape pas : planifiez-les |
| **Altération du journal** | Table en ajout seul : aucune route ne modifie un événement. Il disparaît avec le dossier, la variable ou la fiche qu'il concerne (supprimer un dossier efface son historique) | Quelqu'un qui édite directement le fichier SQLite peut tout modifier : le journal est un témoin de l'usage normal, pas un coffre infalsifiable |

## 4. Les en-têtes de sécurité

Posés sur toutes les réponses : `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (caméra, micro, géolocalisation, paiement, USB interdits), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`. Sur les pages : une **politique de sécurité du contenu** (`default-src 'self'`, `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'self'`, `base-uri 'self'`, `form-action 'self'` ; les styles en ligne sont admis pour React ; `img-src 'self' data: blob:` pour les aperçus, `font-src 'self' data:`, `object-src 'self'` et `frame-src 'self'` pour l'aperçu PDF). Sur l'API : `Cache-Control: no-store` (sauf le flux de la rédaction assistée, `no-cache, no-transform`).

## 5. Ce que l'outil ne fait pas

- **Anonymiser.** Un document nominatif importé reste nominatif dans la base, les exports et les sauvegardes. La seule détection de noms, dates de naissance et identifiants est la pseudonymisation du texte **envoyé à Claude** (§ 2.1) : elle ne touche pas ce qui est stocké, et elle laisse passer ce qu'aucun motif n'annonce. La **charte d'anonymisation** que l'interface fait confirmer avant l'import (« Avant d'importer des données de patients ») rend l'engagement de l'utilisateur explicite et daté — dans le navigateur, pour une version du texte — ; elle ne vérifie rien de ce que contiennent les fichiers.
- **Chiffrer la base ou les fichiers.** Utilisez le chiffrement du disque (BitLocker, FileVault, LUKS) du poste ou du serveur.
- **Gérer des comptes, des rôles, un journal d'accès.** Un mot de passe unique ; le journal des *valeurs* dit ce qui a changé et quand, mais pas **qui** l'a changé.
- **Servir en HTTPS** lui-même. Placez un proxy TLS devant (voir le [guide de l'administrateur](guide-administrateur.md#5-exposer-loutil-sur-un-réseau)).
- **Effacer de façon sécurisée.** Supprimer un dossier supprime ses fichiers et ses lignes (historique des valeurs compris), mais pas les blocs du disque, ni les sauvegardes déjà faites, ni le journal du système.
- **Garantir l'exactitude de l'extraction.** C'est une aide : la fiabilité se mesure par relecture (page *Fiabilité*), elle ne se présume pas.

## 6. Avant de démarrer une étude — liste de contrôle

**Cadre réglementaire et éthique** *(à confirmer avec votre délégué à la protection des données et votre comité d'éthique)*

- [ ] La base légale et l'autorisation de réutiliser les données de santé sont acquises (selon votre juridiction : par exemple le RGPD dans l'Union européenne, ou la loi n° 09-08 et la CNDP au Maroc).
- [ ] L'étude est inscrite au registre des traitements ; une analyse d'impact est faite si elle est exigée.
- [ ] Les patients sont informés (ou la dérogation est documentée).
- [ ] Si le mode « Claude » est envisagé : le transfert vers le sous-traitant, son lieu de traitement et sa durée de conservation sont autorisés **par écrit**.

**Poste ou serveur**

- [ ] Disque chiffré ; session verrouillée ; accès limité aux personnes de l'étude.
- [ ] `DATA_DIR` dans un dossier accessible **seulement** à l'utilisateur qui lance l'outil.
- [ ] L'outil reste sur `127.0.0.1`. S'il doit être partagé : `HOST`, `APP_PASSWORD` (long, unique), HTTPS devant, `ALLOWED_HOSTS` défini.
- [ ] Les clés (Anthropic, `NCBI_API_KEY`, `APIFY_TOKEN`) ne sont pas dans un fichier partagé, un dépôt, un historique de commandes ; une **limite de dépenses** est fixée côté fournisseur. Une clé Anthropic se saisit de préférence dans l'application (fichier `0600` hors sauvegardes) plutôt que dans l'environnement.

**Données**

- [ ] Les documents sont **pseudonymisés avant** l'import ; les codes de dossier n'ont aucun lien avec l'identité (ni numéro de dossier hospitalier, ni initiales, ni date de naissance).
- [ ] Chaque personne qui importe des documents a lu et confirmé la charte d'anonymisation de l'interface — et sait ce qu'elle engage : en-têtes, tampons, noms de fichiers, texte incrusté dans les scans et balises DICOM compris.
- [ ] La table de correspondance code ↔ identité est **ailleurs**, sous le contrôle de l'investigateur.
- [ ] Un tableau de cohorte à importer ne contient **que** le code d'étude et les variables : colonnes nominatives retirées avant l'import (le fichier entier est conservé).
- [ ] Une **sauvegarde** est planifiée, rangée à part, chiffrée, et sa restauration a été essayée une fois (`npm run restore --workspace server -- <sauvegarde> --verify`).
- [ ] La durée de conservation est fixée ; la procédure de destruction (dossier de données, sauvegardes, exports) est écrite.

**Exports**

- [ ] Un jeu de données exporté contient les codes de dossier et des valeurs cliniques : il se range et se transmet comme les dossiers eux-mêmes. Pour le partager, cochez « Sans le libellé des dossiers » (CSV, `deidentify=1`) : le libellé libre d'un dossier peut contenir un nom ou des initiales.
- [ ] Le rapport « Méthodes et traçabilité » ne contient aucune donnée de patient (effectifs et noms de variables seulement) ; le journal d'audit CSV, lui, contient les codes de dossier et les valeurs.

## 7. En cas d'incident

| Situation | À faire |
|---|---|
| Clé Anthropic ou `APIFY_TOKEN` exposée | La **révoquer** chez le fournisseur et en créer une nouvelle ; contrôler l'usage facturé. Pour une clé saisie dans l'application : *Changer de clé* (ou *Retirer*) une fois la nouvelle créée |
| Dépense anormale sur le compte Anthropic | Retirer la clé de l'application (ou de l'environnement), consulter l'usage dans la console d'Anthropic, puis le journal du serveur (chaque enregistrement de clé y est noté avec ses quatre derniers caractères) |
| Poste perdu ou volé | Si le disque était chiffré, le signaler et révoquer les accès ; sinon traiter comme une violation de données selon la procédure de l'établissement |
| Outil resté ouvert sur un réseau sans mot de passe | Arrêter l'outil, définir `APP_PASSWORD` ou revenir à `127.0.0.1`, consulter le journal du serveur et le journal d'audit des valeurs pour repérer ce qui a changé, informer le délégué à la protection des données |
| Export envoyé au mauvais destinataire | Procédure de violation de données de l'établissement : l'export contient des codes de dossier et des valeurs de santé |
| Données corrompues | Arrêter l'outil, restaurer la dernière sauvegarde vérifiée (`npm run restore --workspace server -- <dossier> --force` met les données actuelles de côté) |

## 8. Dépendances

`npm audit` au 9 octobre 2026 : **3 avis, tous modérés**, dans une même chaîne (`mammoth` → `argparse` → `sprintf-js` : déni de service par précision non bornée d'un format `sprintf`). Aucun chemin ne l'atteint avec une entrée utilisateur dans cette application ; la « correction » proposée par `npm audit fix --force` est un **retour en arrière** de `mammoth` (0.3.29), qui réintroduirait d'autres défauts : ne la lancez pas. À revérifier à chaque mise à jour (`npm audit`).

Aucune dépendance native n'est compilée à l'installation ; aucun script `preinstall`/`postinstall` n'est exécuté par le projet lui-même.

## 9. La page d'accueil publique (`landing/`)

Le dépôt contient aussi un **site public**, déployé à part (sur Vercel) : présentation, création d'un accès (Google ou e-mail), parcours d'accueil, engagement d'anonymisation. Il **ne reçoit aucune donnée de patient** et ne communique pas avec l'application : il conserve, dans un projet Supabase du responsable du site, le profil professionnel de l'utilisateur (nom, adresse, fonction, établissement, pays, type d'étude, état de l'autorisation) et la trace de l'engagement pris (version du texte, date), protégés par des règles d'accès par ligne et des droits accordés colonne par colonne (la date d'un engagement est posée par la base : il ne peut pas être antidaté). Il **ne protège pas l'application** : c'est une porte d'entrée, pas une serrure. Ce qu'il conserve, chez qui, comment le mettre en service et ses limites : [Page d'accueil](page-d-accueil.md).
