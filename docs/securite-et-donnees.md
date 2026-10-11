# Sécurité et données personnelles

Cet outil manipule des comptes rendus de patients. Ce document dit ce qu'il protège, ce qu'il ne protège pas, ce qui sort de la machine, et ce qu'il faut décider *avant* de s'en servir. Il décrit le comportement de l'outil ; il ne remplace ni l'avis de votre délégué à la protection des données, ni celui du comité d'éthique, et ne constitue pas un conseil juridique.

## 1. L'essentiel

1. **Par défaut, rien ne sort de la machine et rien n'y entre depuis le réseau.** L'outil écoute sur `127.0.0.1`, extrait par des règles locales, fait son OCR hors connexion.
2. **Trois fonctions peuvent faire sortir des données, et seulement si vous les configurez** : l'extraction par Claude (envoie le texte des documents à l'API d'Anthropic), la rédaction assistée (lui envoie des agrégats de la cohorte) et la revue bibliographique (envoie l'équation de recherche à Apify). Voir § 2.
3. **L'outil n'anonymise rien.** Ce qu'il lit est ce qu'il stocke et, le cas échéant, ce qu'il envoie. Importez des documents **pseudonymisés**, avec des codes de dossier sans lien avec l'identité. Avant tout import, l'interface fait confirmer une **charte d'anonymisation** (cinq engagements, redemandés à chaque nouvelle version du texte) : c'est un rappel, pas un contrôle (§ 5).
4. **Il n'y a ni chiffrement au repos, ni comptes individuels.** La base et les fichiers sont en clair dans `DATA_DIR`. Un mot de passe unique, partagé, peut protéger l'accès réseau. Le reste relève du poste : disque chiffré, droits du système de fichiers, sauvegardes protégées.
5. **Sur un réseau, mettez-le derrière HTTPS.** Le mot de passe HTTP Basic circule en clair sans TLS.

## 2. Ce qui sort de la machine

| Fonction | Condition | Ce qui est transmis | À qui |
|---|---|---|---|
| Extraction « Règles seules » (défaut) | — | **Rien** | — |
| Extraction « Règles puis Claude » / « Claude seul » | `ANTHROPIC_API_KEY` défini **et** mode choisi à chaque passe | Le **texte des documents** des dossiers traités (au plus `LLM_MAX_CHARS_PER_DOC` caractères par document, 60 000 par défaut), présentés sous les noms « Document 1 », « Document 2 »… — **ni les noms de fichier ni le code du dossier ne partent** —, le nom de la fiche, et les libellés, unités, définitions et options des variables | API d'Anthropic |
| Rédaction assistée | `ANTHROPIC_API_KEY` défini | Des **agrégats** de la cohorte : nom et objet de la fiche, effectifs, complétude, et pour chaque variable ses indicateurs (moyenne, écart type, médiane, quartiles, extrêmes) ou ses modalités avec leurs effectifs, plus les définitions des variables. **Une variable en texte libre ne donne que ses effectifs** : aucune de ses valeurs, aucun code de dossier, aucun nom de fichier ne part | API d'Anthropic |
| Revue bibliographique | `APIFY_TOKEN` défini | L'**équation de recherche** saisie, la période, le nombre de résultats | Apify, qui interroge PubMed ou Google Scholar |
| OCR | — | **Rien** : le moteur et les données de langue française sont installés avec l'outil | — |
| Installation (`npm install`) | — | Téléchargement des dépendances depuis le registre npm | npm |
| Mise en ligne de l'interface | — | **Aucune ressource externe** : ni police, ni script, ni statistique ; la politique de sécurité du contenu l'interdit | — |

**Conséquences pratiques**

- Le **mode « Règles seules »** est le seul qui reste intégralement dans l'établissement. Si l'étude n'a pas obtenu l'autorisation de transférer des données de santé à un sous-traitant, **ne renseignez pas `ANTHROPIC_API_KEY`** : sans elle, les deux autres modes sont indisponibles (l'interface le dit).
- **Le texte part tel quel.** Les noms de fichier et le code du dossier restent sur la machine (le modèle ne voit que « Document 1 », « Document 2 »…), mais un compte rendu qui commence par « Nom : DUPONT Jean » transmet ce nom au sous-traitant : l'outil ne le retire pas. Pseudonymisez les documents **avant** l'import.
- Si vous l'activez, le transfert est un traitement par un sous-traitant : à déclarer, à encadrer contractuellement, à décrire dans le protocole. Vérifiez les conditions d'utilisation et de conservation de votre compte API, et l'éventuelle option de non-conservation des données.
- **N'écrivez aucune donnée de patient dans l'équation bibliographique** (nom, date de naissance, numéro de dossier…).
- Pour qu'un envoi ne parte jamais par inadvertance, laissez la clé **hors** de l'environnement habituel de l'outil et ne la définissez que le temps d'une passe voulue.

## 3. Modèle de menaces

| Menace | Mesure | Résiduel |
|---|---|---|
| **Un site web ouvert dans le même navigateur lit l'API** (« DNS rebinding » : le site fait pointer son nom vers `127.0.0.1`) | Liste blanche de l'en-tête `Host` : `localhost`, `127.0.0.1`, `[::1]`, plus `ALLOWED_HOSTS` | Aucun tant que l'outil n'écoute que sur le poste |
| **Un site tiers écrit dans l'outil** (CSRF : envoi d'un fichier, changement de fiche active, relance d'extraction) | Refus de toute requête modifiante dont l'`Origin` désigne un autre site ou vaut `null` | Un script local sans `Origin` (curl) passe : il tourne déjà sur le poste |
| **Un voisin du réseau** atteint l'outil | Écoute sur `127.0.0.1` par défaut ; si `HOST` ouvre le réseau, avertissement au démarrage tant qu'aucun mot de passe n'est défini | L'ouverture au réseau est un choix de l'administrateur ; mot de passe + HTTPS requis |
| **Devinette du mot de passe** | Comparaison à temps constant ; 10 échecs en 5 minutes ferment l'accès 5 minutes (par adresse) ; l'adresse réelle se lit derrière un proxy de confiance (`TRUST_PROXY`) | Un mot de passe faible reste faible ; pas d'authentification à deux facteurs |
| **Fichier piégé** (PDF dont les pages se bouclent, flux compressé qui se gonfle, Word qui se décompresse en gigaoctets, image de 100 mégapixels) | Plafonds (pages, texte, taille décompressée, mégapixels) **et** analyse dans un fil séparé avec délai ferme et mémoire bornée : le fichier échoue seul, le serveur répond toujours | Un fichier qui s'analyse « correctement » mais dont le contenu est trompeur (texte caché) donne des valeurs fausses : la relecture existe pour cela |
| **Expression régulière malveillante ou maladroite** dans une fiche importée | Analyse statique des motifs à risque (quantificateurs imbriqués, alternative sous un quantificateur, références arrière, quatre quantificateurs ouverts ou plus), exécution des motifs repérés sous un délai d'interruption (`REGEX_BUDGET_MS`, 250 ms), disjoncteur, raison affichée ; plafonds de longueur | Un motif que l'analyse croit sain mais qui est lent (trois quantificateurs ouverts enchaînés, par exemple) s'exécute sans délai à sa **première** évaluation : le serveur la subit, puis le motif est classé à risque |
| **Fiche importée mal formée** | Validation stricte du JSON (types, longueurs, nombre de règles) ; création **en entier ou pas du tout** | — |
| **Injection de formule dans Excel** via une valeur extraite (`=CMD(…)`) | Les cellules texte qui commencent par `=`, `+`, `-`, `@` sont préfixées d'une apostrophe dans les CSV ; jamais pour un nombre | Ouvrir un CSV dans un tableur reste à vos risques : relisez les sources non fiables |
| **Chemin de fichier forgé** (`../../…`) | Nom de stockage généré par le serveur ; nom d'affichage purgé de tout chemin ; type servi d'après une liste fermée, `nosniff`, `inline` réservé au PDF, aux images et au texte brut (`.txt`, servi en `text/plain`) | — |
| **Fuite par message d'erreur** | Aucune réponse ne contient de message SQL ni de chemin disque ; une référence aléatoire renvoie à la pile dans le **journal du serveur** | Le journal du serveur peut contenir des noms de fichiers : protégez-le comme les données |
| **Fuite d'un jeton** | `ANTHROPIC_API_KEY` et `APIFY_TOKEN` ne quittent jamais le serveur ; des tests établissent qu'aucune réponse de l'API, messages d'erreur compris, ne les contient — y compris quand une passerelle répète les en-têtes de la requête dans son refus (jeton Apify : `api-hardening.test.ts` ; clé Anthropic : `llm-secrets.test.ts`, avec un faux serveur) | Une clé placée dans un fichier `.env` ou un historique de shell reste exposée à qui lit ce fichier |
| **Contenu actif servi** (un `.html` déposé comme « document ») | Les fichiers sont servis d'après une liste fermée d'extensions ; tout ce qui n'est pas PDF, image ou texte brut est servi en téléchargement | — |
| **Deux instances sur les mêmes données** | Verrou du dossier de données | — |
| **Perte de données** (crash, coupure, disque plein) | WAL, transactions atomiques par dossier, passes `running` marquées `failed` au redémarrage, dépôt provisoire purgé ; **sauvegarde/restauration vérifiables** | Une sauvegarde non faite ne se rattrape pas : planifiez-les |
| **Altération du journal** | Table en ajout seul : aucune route ne modifie un événement. Il disparaît avec le dossier, la variable ou la fiche qu'il concerne (supprimer un dossier efface son historique) | Quelqu'un qui édite directement le fichier SQLite peut tout modifier : le journal est un témoin de l'usage normal, pas un coffre infalsifiable |

## 4. Les en-têtes de sécurité

Posés sur toutes les réponses : `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (caméra, micro, géolocalisation, paiement, USB interdits), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`. Sur les pages : une **politique de sécurité du contenu** (`default-src 'self'`, `script-src 'self'`, `connect-src 'self'`, `frame-ancestors 'self'`, `base-uri 'self'`, `form-action 'self'` ; les styles en ligne sont admis pour React ; `img-src 'self' data: blob:` pour les aperçus, `font-src 'self' data:`, `object-src 'self'` et `frame-src 'self'` pour l'aperçu PDF). Sur l'API : `Cache-Control: no-store` (sauf le flux de la rédaction assistée, `no-cache, no-transform`).

## 5. Ce que l'outil ne fait pas

- **Anonymiser ou pseudonymiser.** Il n'y a aucune détection de noms, de dates de naissance ni d'identifiants dans le texte. Un document nominatif importé reste nominatif. La **charte d'anonymisation** que l'interface fait confirmer avant l'import (« Avant d'importer des données de patients ») rend l'engagement de l'utilisateur explicite et daté — dans le navigateur, pour une version du texte — ; elle ne vérifie rien de ce que contiennent les fichiers.
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
- [ ] Les clés (`ANTHROPIC_API_KEY`, `APIFY_TOKEN`) ne sont pas dans un fichier partagé, un dépôt, un historique de commandes ; une **limite d'usage** est fixée côté fournisseur.

**Données**

- [ ] Les documents sont **pseudonymisés avant** l'import ; les codes de dossier n'ont aucun lien avec l'identité (ni numéro de dossier hospitalier, ni initiales, ni date de naissance).
- [ ] Chaque personne qui importe des documents a lu et confirmé la charte d'anonymisation de l'interface — et sait ce qu'elle engage : en-têtes, tampons, noms de fichiers, texte incrusté dans les scans et balises DICOM compris.
- [ ] La table de correspondance code ↔ identité est **ailleurs**, sous le contrôle de l'investigateur.
- [ ] Une **sauvegarde** est planifiée, rangée à part, chiffrée, et sa restauration a été essayée une fois (`npm run restore --workspace server -- <sauvegarde> --verify`).
- [ ] La durée de conservation est fixée ; la procédure de destruction (dossier de données, sauvegardes, exports) est écrite.

**Exports**

- [ ] Un jeu de données exporté contient les codes de dossier et des valeurs cliniques : il se range et se transmet comme les dossiers eux-mêmes.
- [ ] Le rapport « Méthodes et traçabilité » ne contient aucune donnée de patient (effectifs et noms de variables seulement) ; le journal d'audit CSV, lui, contient les codes de dossier et les valeurs.

## 7. En cas d'incident

| Situation | À faire |
|---|---|
| Clé `ANTHROPIC_API_KEY` ou `APIFY_TOKEN` exposée | La **révoquer** chez le fournisseur et en créer une nouvelle ; contrôler l'usage facturé |
| Poste perdu ou volé | Si le disque était chiffré, le signaler et révoquer les accès ; sinon traiter comme une violation de données selon la procédure de l'établissement |
| Outil resté ouvert sur un réseau sans mot de passe | Arrêter l'outil, définir `APP_PASSWORD` ou revenir à `127.0.0.1`, consulter le journal du serveur et le journal d'audit des valeurs pour repérer ce qui a changé, informer le délégué à la protection des données |
| Export envoyé au mauvais destinataire | Procédure de violation de données de l'établissement : l'export contient des codes de dossier et des valeurs de santé |
| Données corrompues | Arrêter l'outil, restaurer la dernière sauvegarde vérifiée (`npm run restore --workspace server -- <dossier> --force` met les données actuelles de côté) |

## 8. Dépendances

`npm audit` au 9 octobre 2026 : **3 avis, tous modérés**, dans une même chaîne (`mammoth` → `argparse` → `sprintf-js` : déni de service par précision non bornée d'un format `sprintf`). Aucun chemin ne l'atteint avec une entrée utilisateur dans cette application ; la « correction » proposée par `npm audit fix --force` est un **retour en arrière** de `mammoth` (0.3.29), qui réintroduirait d'autres défauts : ne la lancez pas. À revérifier à chaque mise à jour (`npm audit`).

Aucune dépendance native n'est compilée à l'installation ; aucun script `preinstall`/`postinstall` n'est exécuté par le projet lui-même.

## 9. La page d'accueil publique (`landing/`)

Le dépôt contient aussi un **site public**, déployé à part (sur Vercel) : présentation, création d'un accès (Google ou e-mail), parcours d'accueil, engagement d'anonymisation. Il **ne reçoit aucune donnée de patient** et ne communique pas avec l'application : il conserve, dans un projet Supabase du responsable du site, le profil professionnel de l'utilisateur (nom, adresse, fonction, établissement, pays, type d'étude, état de l'autorisation) et la trace de l'engagement pris (version du texte, date), protégés par des règles d'accès par ligne et des droits accordés colonne par colonne (la date d'un engagement est posée par la base : il ne peut pas être antidaté). Il **ne protège pas l'application** : c'est une porte d'entrée, pas une serrure. Ce qu'il conserve, chez qui, comment le mettre en service et ses limites : [Page d'accueil](page-d-accueil.md).
