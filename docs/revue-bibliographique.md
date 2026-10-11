# Revue bibliographique

Page **Littérature › Revue bibliographique**. Elle est indépendante des dossiers patients : elle a ses propres tables et ne lit aucune donnée de patient.

![Revue bibliographique](img/bibliographie.png)

*(Capture : références de démonstration, tri simulé.)*

## Les sources

| Source | Par où | Ce qu'elle rend | Coût |
|---|---|---|---|
| **PubMed** (coché d'office) | API officielle du NCBI, les **E-utilities**, appelées **par le serveur** | Résumé complet (structuré), termes MeSH, types de publication, DOI, PMID, PMCID ; livres et chapitres | Gratuit, sans réglage |
| **Google Scholar** (option) | Acteur Apify `george.the.developer/google-scholar-scraper` | Titre, auteurs, revue, année, **extrait** (pas le résumé), nombre de citations, lien | 0,008 $ par résultat\* |
| **Autres bases** (Embase, Cochrane CENTRAL, Scopus, Web of Science, LiSSa, CINAHL, PsycINFO, ClinicalTrials.gov, ICTRP, Zotero…) | **Import** de leur export : RIS, MEDLINE (`.nbib`), BibTeX, CSV avec en-tête | Ce que contient l'export | — |

\* Tarif affiché par Apify le 8 octobre 2026 pour un compte gratuit ; il change, et dépend du plan.

### PubMed, prêt à l'emploi

Trois appels suffisent à une recherche complète : `esearch` donne le **nombre total** de résultats et la **traduction de l'équation par PubMed** (termes MeSH développés compris) — les deux pièces du journal de recherche que PRISMA-S demande — puis `efetch` rend les notices complètes en XML, par lots de 500. Au-delà de 9 999 résultats, que PubMed ne pagine plus, la recherche est découpée par tranches de dates de publication. Le NCBI demande au plus **3 requêtes par seconde** (10 avec une clé `NCBI_API_KEY`), le nom de l'outil (`tool=PubResearcher`) et, si possible, une adresse (`NCBI_EMAIL`) : tout cela est tenu par le serveur. Une limite de débit (429), une erreur du NCBI (5xx) ou une coupure sont réessayées trois fois, à 1, 2 puis 4 s d'intervalle ; les messages d'échec sont en français et disent quoi faire.

Deux façons de récupérer : **toutes les notices** (jusqu'au plafond `BIBLIO_PUBMED_MAX`, 10 000 par défaut), pour une revue systématique ; ou **les N premières** (au plus 9 999, par pertinence ou par date), pour explorer — le bilan le rappelle. Une passe est **tout ou rien** : si la récupération échoue en route, aucune notice n'est versée (le diagramme de flux ne compte pas une récupération partielle), mais la passe reste consignée avec son nombre annoncé et sa traduction. Une équation qui dépasse le plafond est refusée avec le nombre de résultats : resserrez-la, ou récupérez-en les N premières.

### À savoir avant de s'y fier

- **Google Scholar.** Google n'autorise pas l'extraction automatisée de Scholar (conditions d'utilisation, `robots.txt`). L'acteur la réalise par navigateur et proxys : elle peut être bloquée ou retirée à tout moment, et son usage relève de votre appréciation et des règles de votre établissement. Pour une revue systématique, **PubMed est la source de référence** ; Scholar complète (littérature grise, citations), il ne la remplace pas. Il ne comprend pas la syntaxe de PubMed : les balises de champ (`[tiab]`, `[MeSH]`…) lui sont retirées, et la passe consigne l'équation réellement envoyée. Un second acteur est pris en charge (`APIFY_SCHOLAR_ACTOR=johnvc/google-scholar-api`) ; un acteur sans adaptateur n'est pas lancé.
- **Extrait n'est pas résumé.** Scholar ne donne qu'un extrait ; l'interface l'étiquette ainsi, et la fusion garde le résumé de PubMed quand les deux sources trouvent le même article.
- **Les sources changent.** Les lecteurs (XML de PubMed, sorties des acteurs) sont testés sur des réponses **réelles** enregistrées en octobre 2026 ; l'appel réseau réel au NCBI et à Apify n'est pas exercé par les tests (voir le [rapport de validation](validation.md#11-limites-et-ce-qui-na-pas-été-vérifié)).

## Mise en route

Rien à faire pour PubMed : le poste doit seulement pouvoir joindre `eutils.ncbi.nlm.nih.gov`. Pour de grosses recherches, une clé NCBI gratuite (compte *My NCBI* › *API Key Management*) triple le débit. Pour Google Scholar :

```bash
export APIFY_TOKEN=apify_api_...      # Windows : setx APIFY_TOKEN apify_api_...
npm start
```

Le jeton se crée dans la console Apify : *Settings › API & Integrations*. Sans lui, Scholar reste grisé dans le formulaire, avec la marche à suivre.

Une passe dure de quelques secondes à quelques minutes, et la requête reste ouverte pendant ce temps. Derrière un proxy inverse, relevez son délai de lecture au-delà de 5 minutes (par exemple `proxy_read_timeout 330s` avec nginx). Si la connexion tombe, la passe va à son terme côté serveur : l'écran le détecte au retour et se met à jour. Une passe interrompue par l'arrêt du serveur est marquée en erreur au redémarrage.

| Variable | Défaut | Rôle |
|---|---|---|
| `NCBI_API_KEY` | — | Clé NCBI : 10 requêtes par seconde au lieu de 3. **Reste côté serveur** |
| `NCBI_EMAIL` | — | Adresse de contact transmise au NCBI |
| `NCBI_TIMEOUT_MS` | `60000` | Délai d'un appel au NCBI |
| `NCBI_EUTILS_BASE` | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | Point d'accès — pour les tests ou une passerelle |
| `BIBLIO_PUBMED_MAX` | `10000` | Notices PubMed au plus par passe « toutes les notices » |
| `BIBLIO_IMPORT_MAX_MB` | `50` | Taille maximale d'un fichier importé |
| `APIFY_TOKEN` | — | Jeton Apify, pour Scholar. **Reste côté serveur** |
| `APIFY_SCHOLAR_ACTOR` | `george.the.developer/google-scholar-scraper` | Acteur interrogé pour Scholar |
| `BIBLIO_MAX_RESULTS` | `100` | Plafond de résultats Scholar par passe |
| `APIFY_TIMEOUT_MS` | `290000` | Attente maximale d'une passe Scholar (Apify coupe à 300 s) |
| `APIFY_API_BASE` | `https://api.apify.com` | Point d'accès — pour les tests ou une passerelle |

`APIFY_PUBMED_ACTOR` n'existe plus (l'acteur Apify de PubMed est retiré).

## Ce que fait la page

1. **Rechercher.** Une équation (syntaxe de PubMed), une période de publication, un ordre (pertinence ou date) ; pour PubMed, toutes les notices ou les N premières ; pour Scholar, un nombre de résultats (20 par défaut, au plus `BIBLIO_MAX_RESULTS`). Le bilan dit le nombre total annoncé, le nombre récupéré et les avertissements de la passe. Une passe dont **toutes** les sources échouent affiche le détail de chacune.
2. **Importer des références** — *Importer des références (RIS, nbib, BibTeX, CSV)* : choisissez la **base d'origine** dans une liste rangée par colonne du diagramme (bases de données, registres, autres méthodes ; « Autre » avec un nom libre), puis le fichier. Le format est reconnu seul. Les lecteurs sont tolérants (fins de ligne Windows, marque d'ordre des octets, Latin-1, UTF-16, lignes de continuation) ; une notice sans titre est écartée et comptée, elle ne fait pas échouer le fichier. Au plus 50 Mo (`BIBLIO_IMPORT_MAX_MB`) et 50 000 notices par fichier : au-delà, découpez l'export. L'import est consigné comme une recherche (base, fichier, date, effectifs) et passe par le même dédoublonnage. Le fichier n'est pas conservé : il est lu, puis oublié.
3. **Regrouper.** Un article trouvé deux fois devient **une** référence. Le rapprochement se fait par DOI, puis PMID, puis PMCID (Scholar renvoie souvent vers la copie PMC), puis par titre normalisé : sans casse, sans accents, avec les exposants que PubMed aplatit (« 21(st) Century » = « 21st century »), les titres que Scholar tronque par « … », et des années compatibles à un an près. Un rapprochement est **refusé** quand les deux notices portent des PMID différents, ou — par le titre — des DOI différents : sur une vraie recherche PubMed (appendicite, 1 052 notices), 31 notices distinctes étaient sinon fusionnées à tort (lettres à l'éditeur de même titre, revue Cochrane et sa mise à jour). La fusion garde le résumé, les auteurs et la revue de PubMed (API ou `.nbib`), et le nombre de citations de Scholar. Rien n'est jamais effacé.
4. **Chercher dans la bibliothèque.** Plusieurs mots, sans égard aux accents ni à la casse, dans le titre, les auteurs, la revue, le résumé, les mots-clés, les termes MeSH et les identifiants ; tous doivent figurer, dans n'importe quel ordre ; une expression entre guillemets se cherche telle quelle. Filtre par source, ou « trouvées par plusieurs sources ».
5. **Trier.** *Retenir*, *À voir* ou *Exclure…*. Au tri sur titre et résumé, le **motif** d'exclusion est facultatif, comme le permet PRISMA 2020 (population, intervention, critère de jugement, schéma d'étude, langue, texte intégral introuvable, doublon de publication, autre) ; une exclusion sans motif est comptée « motif non précisé ». Une note libre est possible. **Rien ne se supprime** : une référence hors sujet s'exclut, et reste comptée dans le diagramme de flux.
6. **Suivre le diagramme de flux** PRISMA 2020. Aucun chiffre n'est saisi :
   - **notices identifiées**, source par source, rangées en bases de données, registres et autres méthodes (Google Scholar en fait partie) : pour chaque source, les notices **distinctes** que ses recherches et imports réussis ont rendues — relancer une équation, ou deux équations qui se recoupent, ne gonflent plus le total ; deux notices d'un même export qui désignent le même article comptent pour deux, comme dans le fichier ;
   - **doublons retirés** = identifiées − références uniques (un article trouvé par PubMed et par Embase compte une fois par source, puis une fois comme doublon) ;
   - **à trier**, exclues (par motif), à voir, retenues.

   Ainsi « identifiées − doublons = à trier » tient toujours. Le diagramme compte le tri sur titre et résumé ; l'évaluation sur texte intégral n'y est pas suivie.
7. **Consigner le journal de recherche** (PRISMA-S). Chaque passe et chaque import, réussis ou non, gardent leur équation, la **traduction par PubMed** ou la chaîne réellement envoyée à Scholar, leur date, la base, le service ou le format, le fichier importé, la période, le nombre **annoncé** et le nombre **récupéré**, les références nouvelles et déjà connues, les avertissements. Une source en échec n'annule pas l'autre (le message dit quoi corriger). « Reprendre » recharge l'équation, la période et l'ordre d'une passe dans le formulaire — sur une passe en échec, il ne coche que la source en cause ; il ne reste qu'à lancer.
8. **Exporter** — RIS (Zotero, EndNote, Mendeley), BibTeX, CSV (séparateur `;`, UTF-8 avec marque d'ordre des octets pour Excel), et le CSV du journal de recherche. Le RIS porte le type de chaque référence (`JOUR`, `CONF`, `BOOK`, `CHAP`… : celui de la base d'origine, sinon déduit des types de publication de PubMed) et le PMCID (`C2`) ; le BibTeX, le type correspondant. Le choix des références à exporter suit la décision de tri ; celle-ci, le motif d'exclusion et la note figurent dans le champ de note du RIS et dans les colonnes du CSV. **L'export est complet**, au-delà de 1 000 notices, et le nom du fichier dit son contenu (`references-retenues-2026-10-09.ris`).

## Coût, accès et données

- **PubMed est gratuit.** Le débit est limité côté serveur, pour tout le serveur (le NCBI compte les requêtes par adresse) ; **une seule passe à la fois**.
- **Chaque résultat Scholar est facturé.** Garde-fous côté serveur : `BIBLIO_MAX_RESULTS` plafonne chaque passe ; une seule passe à la fois (un double clic ne facture pas deux fois) ; le jeton ne quitte pas le serveur (masqué dans tout message d'erreur, y compris ceux qu'un acteur renvoie). Fixez en plus une **limite d'usage mensuelle** dans votre compte Apify (*Settings › Billing*) : c'est le seul garde-fou que l'application ne puisse pas contourner.
- **Accès.** Toute personne qui peut joindre le serveur peut lancer une recherche, facturée à votre compte pour Scholar. Par défaut l'outil n'écoute que sur le poste ; s'il est ouvert au réseau, définissez `APP_PASSWORD` et placez-le derrière HTTPS (voir le [guide de l'administrateur](guide-administrateur.md#5-exposer-loutil-sur-un-réseau)).
- **Seule l'équation de recherche sort**, avec la période : vers le NCBI pour PubMed (avec `tool`, l'adresse `NCBI_EMAIL` et la clé NCBI si elles sont définies), vers Apify pour Scholar. Aucune donnée de dossier patient n'est lue ni transmise par cette page : n'y saisissez pas de donnée de patient. La clé NCBI n'est ni journalisée, ni rendue dans une erreur, ni transmise à l'interface.
- Les liens renvoyés par les sources sont filtrés (http et https seulement — certains acteurs rendent `javascript:void(0)`), et les cellules CSV qui commencent par `=`, `+`, `-` ou `@` sont neutralisées pour Excel. Les exports RIS et BibTeX ne contiennent aucun caractère de contrôle. Un champ importé est borné en longueur (titre, résumé, auteurs, mots-clés).

## Tests

Sans réseau ni crédit :

- `biblio-eutils.test.ts` lit de **vraies réponses** d'`esearch` et d'`efetch` (octobre 2026, allégées des affiliations), rejouées par un faux service E-utilities (`eutils-fake.ts`) : notices (résumés structurés, MeSH, livres), débit, pagination, découpage par dates au-delà de 9 999 résultats, nouvelles tentatives, messages d'erreur, plafond ;
- `biblio-import.test.ts` couvre les quatre formats d'import, sur des exports de PubMed, Embase, Scopus et de l'outil lui-même, et leurs défauts (encodages, fins de ligne, auteurs, accents LaTeX, champs démesurés, fichiers sans colonne de titre ou illisibles) ;
- `biblio-adapters.test.ts` lit de vraies sorties des acteurs Scholar ; les sorties enregistrées (`server/test/apify-fixtures/`) ont été **expurgées des adresses électroniques** d'auteurs ;
- `biblio.test.ts` fait tourner l'API contre ces faux services : passes, imports, dédoublonnage (PMID et DOI discordants), diagramme de flux (recherches relancées, doublons internes d'un export), statuts 201 / 409 / 502 ;
- `biblio-search.test.ts` couvre la recherche dans la bibliothèque et l'export complet ;
- un test établit que le jeton Apify n'a figuré dans aucune réponse de l'API, messages d'erreur compris.
