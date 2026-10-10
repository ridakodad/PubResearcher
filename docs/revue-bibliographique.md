# Revue bibliographique

Page **Littérature › Revue bibliographique**. Elle est indépendante des dossiers patients : elle a ses propres tables et ne lit aucune donnée de patient.

![Revue bibliographique](img/bibliographie.png)

*(Capture : références de démonstration, tri simulé.)*

## Les deux sources

Les interrogations passent par des **acteurs Apify** — des extracteurs hébergés, facturés à l'usage — appelés **par le serveur**, jamais depuis le navigateur.

| Source | Acteur par défaut | Ce qu'il rend | Tarif public\* |
|---|---|---|---|
| PubMed | `labrat011/pubmed-scraper` | Résumé complet, termes MeSH, types de publication, DOI, PMID, PMCID — via les E-utilities de NCBI | 0,0008 $ par résultat |
| Google Scholar | `george.the.developer/google-scholar-scraper` | Titre, auteurs, revue, année, **extrait** (pas le résumé), nombre de citations, lien | 0,008 $ par résultat |

\* Tarif affiché par Apify le 8 octobre 2026 pour un compte gratuit ; il change, et dépend du plan. Vérifiez-le avant une grosse passe.

Un second acteur Scholar est pris en charge : `johnvc/google-scholar-api` (`APIFY_SCHOLAR_ACTOR=johnvc/google-scholar-api`). Un acteur sans adaptateur n'est pas lancé : l'application le signale et liste ceux qu'elle sait lire.

### À savoir avant de s'y fier

- **Google Scholar.** Google n'autorise pas l'extraction automatisée de Scholar (conditions d'utilisation, `robots.txt`). L'acteur la réalise par navigateur et proxys : elle peut être bloquée ou retirée à tout moment, et son usage relève de votre appréciation et des règles de votre établissement. Pour une revue systématique, **PubMed est la source de référence** ; Scholar complète (littérature grise, citations), il ne la remplace pas. PubMed offre d'ailleurs une API publique gratuite (E-utilities) si vous préférez vous passer d'Apify.
- **Plan gratuit d'Apify.** L'acteur PubMed y rend au plus **10 résultats par passe**. L'application le dit quand elle en reçoit exactement 10 pour une demande plus large.
- **Extrait n'est pas résumé.** Scholar ne donne qu'un extrait ; l'interface l'étiquette ainsi, et la fusion garde le résumé de PubMed quand les deux sources trouvent le même article.
- **Les acteurs changent.** Les adaptateurs lisent des sorties **réelles** enregistrées en octobre 2026 (`server/test/apify-fixtures/`) ; si un acteur modifie ses champs, refaites un enregistrement et ajustez l'adaptateur. L'appel réseau réel à Apify n'est pas exercé par les tests (voir le [rapport de validation](validation.md#11-limites-et-ce-qui-na-pas-été-vérifié)).

## Mise en route

```bash
export APIFY_TOKEN=apify_api_...      # Windows : setx APIFY_TOKEN apify_api_...
npm start
```

Le jeton se crée dans la console Apify : *Settings › API & Integrations*. Sans lui, la page reste consultable (bibliothèque, tri, exports) mais aucune recherche ne part, et l'écran donne la marche à suivre.

Une passe dure de quelques secondes à quelques minutes, et la requête reste ouverte pendant ce temps. Derrière un proxy inverse, relevez son délai de lecture au-delà de 5 minutes (par exemple `proxy_read_timeout 330s` avec nginx). Si la connexion tombe, la passe va à son terme côté serveur : l'écran le détecte au retour et se met à jour. Une passe interrompue par l'arrêt du serveur est marquée en erreur au redémarrage.

| Variable | Défaut | Rôle |
|---|---|---|
| `APIFY_TOKEN` | — | Jeton Apify. **Reste côté serveur** |
| `APIFY_PUBMED_ACTOR` | `labrat011/pubmed-scraper` | Acteur interrogé pour PubMed |
| `APIFY_SCHOLAR_ACTOR` | `george.the.developer/google-scholar-scraper` | Acteur interrogé pour Scholar |
| `BIBLIO_MAX_RESULTS` | `100` | Plafond de résultats par source et par passe |
| `APIFY_TIMEOUT_MS` | `290000` | Attente maximale d'une passe (Apify coupe à 300 s) |
| `APIFY_API_BASE` | `https://api.apify.com` | Point d'accès — pour les tests ou une passerelle |

## Ce que fait la page

1. **Rechercher.** Une équation, transmise **telle quelle** aux sources cochées ; période de publication, ordre (pertinence ou date) et nombre de résultats par source (20 par défaut, au plus `BIBLIO_MAX_RESULTS`).
2. **Regrouper.** Un article trouvé deux fois devient **une** référence. Le rapprochement se fait par DOI, puis PMID, puis PMCID (Scholar renvoie souvent vers la copie PMC), puis par titre normalisé : sans casse, sans accents, avec les exposants que PubMed aplatit (« 21(st) Century » = « 21st century »), les titres que Scholar tronque par « … », et des années compatibles à un an près. La fusion garde le résumé, les auteurs et la revue de PubMed, et le nombre de citations de Scholar. Rien n'est jamais effacé.
3. **Chercher dans la bibliothèque.** Plusieurs mots, sans égard aux accents ni à la casse, dans le titre, les auteurs, la revue, le résumé, les mots-clés, les termes MeSH et les identifiants ; tous doivent figurer, dans n'importe quel ordre ; une expression entre guillemets se cherche telle quelle.
4. **Trier.** *Retenir*, *À voir* ou *Exclure…* — l'exclusion exige son **motif** (population, intervention, critère de jugement, schéma d'étude, langue, texte intégral introuvable, doublon de publication, autre), et le serveur refuse une exclusion sans lui. Une note libre est possible. **Rien ne se supprime** : une référence hors sujet s'exclut avec son motif, et reste comptée dans le diagramme de flux.
5. **Suivre le diagramme de flux**, inspiré de PRISMA 2020 : références identifiées, doublons retirés, références à trier, exclusions par motif, références retenues. Aucun chiffre n'est saisi, tous sont calculés. Il compte des références sur titre et résumé ; l'évaluation sur texte intégral n'y est pas suivie, et une même équation relancée compte ses résultats répétés comme des doublons.
6. **Consigner les stratégies de recherche.** Chaque passe, réussie ou non, garde son équation, sa date, l'acteur interrogé, sa période et ses effectifs. Une source en échec n'annule pas l'autre (crédit épuisé, jeton refusé, délai dépassé : le message dit quoi corriger). « Reprendre » recharge l'équation, la période et l'ordre d'une passe dans le formulaire — sur une passe en échec, il ne coche que la source en cause ; il ne reste qu'à lancer. Rien ne repart sans votre clic : une recherche coûte.
7. **Exporter** — RIS (Zotero, EndNote, Mendeley), BibTeX, CSV (séparateur `;`, UTF-8 avec marque d'ordre des octets pour Excel), et le CSV des stratégies. Le choix des références à exporter suit la décision de tri ; celle-ci, le motif d'exclusion et la note figurent dans le champ de note du RIS et dans les colonnes du CSV. **L'export est complet**, au-delà de 1 000 notices, et le nom du fichier dit son contenu (`references-retenues-2026-10-09.ris`).

## Coût, accès et données

- **Chaque résultat est facturé.** Trois garde-fous côté serveur : `BIBLIO_MAX_RESULTS` plafonne chaque passe ; **une seule passe à la fois** (un double clic ne facture pas deux fois) ; le jeton ne quitte pas le serveur (masqué dans tout message d'erreur, y compris ceux qu'un acteur renvoie). Fixez en plus une **limite d'usage mensuelle** dans votre compte Apify (*Settings › Billing*) : c'est le seul garde-fou que l'application ne puisse pas contourner.
- **Accès.** Toute personne qui peut joindre le serveur peut lancer une recherche facturée à votre compte. Par défaut l'outil n'écoute que sur le poste ; s'il est ouvert au réseau, définissez `APP_PASSWORD` et placez-le derrière HTTPS (voir le [guide de l'administrateur](guide-administrateur.md#5-exposer-loutil-sur-un-réseau)).
- **Seule l'équation de recherche part chez Apify.** Aucune donnée de dossier patient n'est lue ni transmise par cette page : n'y saisissez pas de donnée de patient.
- Les liens renvoyés par les acteurs sont filtrés (http et https seulement — certains acteurs rendent `javascript:void(0)`), et les cellules CSV qui commencent par `=`, `+`, `-` ou `@` sont neutralisées pour Excel. Les exports RIS et BibTeX ne contiennent aucun caractère de contrôle.

## Tests

Sans réseau ni crédit :

- `biblio-adapters.test.ts` lit de **vraies sorties** des acteurs, avec leurs défauts (titres tronqués, `javascript:void(0)` à la place des liens PDF, extraits pris pour des résumés) plutôt que ce que leur documentation laisse espérer ;
- les sorties enregistrées (`server/test/apify-fixtures/`) ont été **expurgées des adresses électroniques** d'auteurs qu'elles contenaient : ce sont des données personnelles de tiers, inutiles aux tests ;
- `biblio.test.ts` fait tourner l'API contre un **faux serveur Apify** local qui rejoue ces sorties, vérifie l'en-tête d'autorisation, et simule crédit épuisé, panne et lenteur ;
- `biblio-search.test.ts` couvre la recherche dans la bibliothèque et l'export complet ;
- un test établit que le jeton n'a figuré dans aucune réponse de l'API, messages d'erreur compris.
