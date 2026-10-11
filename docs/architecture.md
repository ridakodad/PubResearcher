# Architecture

Ce document décrit comment l'outil est construit et **pourquoi**. Il s'adresse à qui doit l'exploiter, l'auditer ou le modifier. Les noms de fichiers sont ceux du dépôt.

## 1. Vue d'ensemble

```
┌────────────────────────── navigateur ──────────────────────────┐
│  React 18 + react-router 7 (SPA compilée par Vite)              │
│  Plan de travail · Dossiers · Fiche · Extraction · Résultats    │
│  Revue bibliographique · Rédaction                              │
└───────────────▲─────────────────────────────────────────────────┘
                │ HTTP (même origine), JSON — `Cache-Control: no-store`
┌───────────────┴────────────── un seul processus Node ≥ 22.13 ───────────────┐
│  Express 4                                                                    │
│   ├─ en-têtes de sécurité · garde Hôte/Origine · mot de passe (HTTP Basic)    │
│   ├─ routes : patients, documents, table-imports, templates, records,         │
│   │          analytics, export, biblio, redaction, health                     │
│   └─ front compilé (web/dist) servi en production                             │
│                                                                               │
│  Moteur d'extraction (fil principal, cède la main entre deux variables)       │
│   fold → règles (libellé, regex surveillée, mots-clés, DICOM) → qualificatifs │
│   → typage → mentions concordantes ou signalées                               │
│   → [Claude : pseudonymisation, schéma imposé, citation retrouvée et          │
│      contenant la valeur, typage] → transaction                               │
│                                                                               │
│  Analyse des fichiers  ──►  pool de fils (worker_threads, 2 par défaut)       │
│   PDF · Word · image · DICOM · texte      mémoire bornée, délai ferme         │
│   tableaux de cohorte (.xlsx, CSV, TSV)                                       │
│        └── OCR (tesseract.js, un seul moteur, dans le fil principal)          │
│                                                                               │
│  SQLite intégré à Node (node:sqlite) : WAL, clés étrangères, transactions     │
└───────────┬───────────────────────────────────────────┬──────────────────────┘
            │ DATA_DIR/research-tool.db                 │ DATA_DIR/uploads/<dossier>/<uuid>.<ext>
            ▼                                           ▼
         la base                              les fichiers d'origine, tels quels

 Sorties hors de la machine, **seulement si configurées** :
   Clé Anthropic     → texte pseudonymisé des documents (modes « Claude ») et agrégats (Rédaction) ;
                       clé de l'utilisateur (DATA_DIR/anthropic-key.json) ou ANTHROPIC_API_KEY
   Recherche PubMed  → équation de recherche vers le NCBI (E-utilities), sans réglage
   APIFY_TOKEN       → équation de recherche vers Google Scholar (option) — jamais de donnée de patient
```

**Principes de conception**, qui expliquent la plupart des choix ci-dessous :

1. **Rien de ce qui entre dans le jeu de données n'y entre sans trace.** Chaque valeur garde sa source, son justificatif et son historique.
2. **Une valeur absente vaut mieux qu'une valeur inventée.** Les règles écartent ce qu'elles ne peuvent pas typer, ce qui n'est qu'une hypothèse, et ne départagent pas au hasard des mentions discordantes ; le modèle ne peut rien proposer sans citation retrouvée qui contienne la valeur.
3. **Le travail humain est sacré.** Une relecture — et une valeur importée d'un tableau tenu par l'équipe — n'est jamais écrasée par une passe ordinaire ; seule l'option explicite `overwriteManual` le fait, et elle n'est jamais le défaut.
4. **Un fichier hostile ne doit pas pouvoir arrêter l'outil** pour tous ceux qui l'utilisent.
5. **Rien à compiler, aucun service à installer** : `npm install`, `npm run build`, `npm start` (quelques binaires précompilés sont livrés avec les dépendances : `@napi-rs/canvas`, `esbuild`) — ou une archive prête à l'emploi par système, Node.js compris (§ 8).
6. **Par défaut, rien ne sort de la machine et rien n'est joignable du réseau.**

## 2. Arborescence

```
server/
  src/
    index.ts            Démarrage : verrou, base, ménage, écoute, arrêt propre
    boot-lock.ts        Réglages vérifiés (lib/env-guard.ts), version de Node, verrou du dossier de données (importé en premier)
    app.ts              Construction de l'application Express (testable sans écouter)
    config.ts           Variables d'environnement (PORT, DATA_DIR, HOST…) ; bornes de tous les réglages numériques dans lib/env-check.ts ;
                        dossier de données par défaut dans lib/data-dir.ts (sources ou version prête à l'emploi)
    db/                 index.ts (connexion, transactions imbriquées), schema.ts, migrations.ts, seed.ts
    domain/             types.ts (fiches, règles, valeurs), labels.ts
    extract/            Un extracteur par format, plafonds, OCR, isolation en fils
    engine/             fold, règles, qualificatifs des mentions (qualifiers.ts), typage, regex surveillées,
                        passe d'extraction, Claude, pseudonymisation du texte envoyé (pseudonymize.ts),
                        contrôle valeur/citation (quote-check.ts), clé d'API de l'utilisateur (api-key.ts),
                        refus d'Anthropic traduits (anthropic-errors.ts), barème et estimation du coût (pricing.ts)
    table/              Tableaux de cohorte : lecteurs .xlsx (xlsx-read.ts) et CSV/TSV (csv-read.ts), correspondances
                        colonne -> variable (mapping.ts), simulation cellule par cellule (plan.ts)
    repo/               Accès aux données (patients, documents, templates, records, runs, events, quality, methods,
                        imports, biblio)
    routes/             Une route par ressource
    biblio/             PubMed par les E-utilities (eutils.ts), import RIS/nbib/BibTeX/CSV (importers.ts), client Apify
                        et adaptateurs (Scholar), normalisation, exports RIS/BibTeX/CSV
    lib/                http, schemas (zod), security, csv, xlsx, pptx, zip (écriture et lecture), xml (lecteur sans
                        dépendance), backup, data-lock, data-dir, stats, report…
  scripts/              generate-demo.ts, backup.ts, restore.ts
  test/                 38 fichiers de test (node:test), dont la logique de la page d'accueil
web/
  src/
    App.tsx             Coquille : rail d'outils (pastille flottante sur écran étroit), routes
    styles.css          Charte : jetons des deux thèmes, composants (voir identite-visuelle.md)
    fonts/              Poppins (woff2, quatre graisses) et sa licence
    assets/             hero-dust.svg : illustration de la carte d'en-tête (générée)
    pages/              Une page par outil
    components/         Marque, éditeurs (variable, règle, valeur), visionneuse de document, graphiques, biblio
                        (dont ImportForm), TableImport (l'import de tableau en cinq étapes),
                        AnonymisationGate (la charte devant tout import), ApiKeyPanel et KeyForm (la clé d'API Anthropic)
    lib/                Client d'API, types (dupliqués du serveur), formats, regroupement des dossiers déposés,
                        anonymisation.ts (texte et version de la charte, mémorisation de l'engagement),
                        claudeGuide.ts (le guide « Activer Claude », copié tel quel sur le site)
  public/               Icône (favicon.svg), theme-init.js (thème avant le premier rendu)
landing/                Site public, déployé à part (Vercel) — voir page-d-accueil.md
  src/lib/              Logique pure (charte, formulaires, parcours, adresses), session Supabase, profil
  src/pages/            Accueil, inscription, connexion, parcours d'accueil (présentation vidéo d'abord), accès,
                        mot de passe, confidentialité, « Activer Claude »
  public/video/         La présentation (MP4 H.264 et WebM VP9, 1 min 35, sous-titres incrustés) et son affiche
  supabase/migrations/  Tables profiles et consents, règles d'accès par ligne
  e2e/                  Parcours dans un navigateur, contre un faux Supabase
scripts/                ensure-build.mjs (démarrage), package.mjs et package/ (archives prêtes à l'emploi : lanceurs,
                        LISEZMOI, essai), make-hero-art.mjs (illustration d'en-tête)
docs/                   Cette documentation
```

## 3. Les flux

### 3.1 Import d'un fichier

1. **Réception sur disque** (multer, nom UUID dans `uploads/.incoming/`) : jamais en mémoire, pour qu'un envoi de plusieurs fichiers de 200 Mo ne couche pas le serveur. Plafonds : taille du fichier, nombre de fichiers, taille de l'envoi.
2. **Empreinte SHA-256** et recherche de doublon (même dossier, même empreinte). Un index unique de la base tranche les envois simultanés : le perdant est un doublon, pas une erreur.
3. **Analyse isolée** (§ 5) : détection du type d'après le contenu et le nom, extraction du texte, plafonnement du texte (`MAX_TEXT_CHARS`), avertissement si coupé.
4. **Rangement** : renommage (même disque, aucune recopie) vers `uploads/<patientId>/<uuid>.<ext>` ; **le chemin ne dépend du client que par l'extension** (au plus dix caractères alphanumériques, tirée du nom d'origine).
5. **Insertion** de la ligne `documents` ; en cas d'échec après le rangement, le fichier est retiré — jamais de fichier de patient sans ligne qui le référence.
6. **Ménage garanti** du dépôt provisoire, y compris sur erreur ; purge complète au démarrage.

Un fichier qui échoue donne un résultat `error` pour **ce fichier**, jamais un échec de l'envoi.

### 3.2 Passe d'extraction

`POST /api/records/extraction/run` → pour chaque dossier, en série :

1. `startRun` : une ligne `extraction_runs` (fiche, **empreinte SHA-256 des règles**, mode, modèle, version de l'outil).
2. Chargement des documents du dossier ; **repliage** du texte (minuscules, sans diacritiques) avec table de correspondance vers les positions d'origine (§ 4.1).
3. Pour chaque variable non tranchée par un humain ni importée d'un tableau : règles dans l'ordre ; une règle lit toutes ses mentions dans tous les documents, et la première règle qui produit une valeur typable l'emporte — concordantes, ses mentions donnent la valeur ; discordantes, la règle de sélection de la variable tranche ou la variable reste vide, signalée (§ 4.2). Sinon, valeurs écartées conservées (3 au plus) avec leur raison.
4. Mode `hybrid`/`llm` : les variables restées vides sont soumises au modèle (§ 4.5). Le modèle qui a réellement répondu est noté par dossier, puis sur la passe (`setRunModel`) s'il diffère de celui demandé.
5. **Une transaction** (`applyAutomaticValues`) écrit les valeurs, le journal et la date de passe : on compare à l'état précédent, une valeur retrouvée à l'identique ne change rien, une variable plus trouvée perd sa valeur automatique (événement `unset`) — mais **une passe ne retire que ce qu'elle a pu produire** : les règles ne retirent pas une valeur de Claude, et un appel au modèle en échec n'efface rien. Un arrêt brutal ne laisse jamais une fiche à moitié écrite.
6. Le calcul est **coopératif** : le moteur cède la boucle d'événements entre deux variables dès que ~40 ms de calcul se sont écoulées, et entre deux dossiers, si bien qu'une cohorte entière ne fige pas le serveur ; seuls le repli d'un document (§ 4.1) et l'application d'une règle à un document sont indivisibles.
7. `finishRun` : effectifs et statut (`done`, ou `failed`). Au redémarrage, une passe restée `running` est marquée `failed`.

### 3.3 Relecture

`PUT …/values` → `applyHumanEdits`, une transaction par appel : la valeur devient `manual`, **garde en `origin_*` ce que la machine (ou le tableau importé) avait proposé** (c'est la matière des mesures de fiabilité), date la décision (`reviewed_at`) et inscrit l'événement (`edit`, `confirm`, `clear`, `release`). `release` est le geste qui autorise l'extraction à rejouer sur la variable (l'option `overwriteManual` d'une passe peut aussi écraser les valeurs relues : explicite, jamais par défaut).

### 3.4 Analyses et exports

Calculés **à la demande** depuis la base, sans cache ni table dérivée : une figure ne peut donc pas contredire le tableau dont elle est tirée (les stats servent aussi au diaporama et à la feuille « Synthèse » du classeur). Le jeu de données se lit en deux requêtes quelle que soit la taille de la cohorte (la vue « rendement de l'extraction » interroge en plus les documents dossier par dossier) ; les justifications, qui pèsent plus de la moitié du volume, sont laissées de côté quand l'écran n'en a pas besoin.

### 3.5 Import d'un tableau de cohorte (`routes/imports.ts`, `table/`)

1. **Réception** comme un document (sur disque, `MAX_UPLOAD_BYTES`), empreinte SHA-256, rangement sous `uploads/imports/<uuid>.<format>`, ligne `table_imports` à l'état `draft`. Le classeur est lu **dans un fil d'analyse** (§ 5) : lecteur `.xlsx` maison, en lecture seule, sur le lecteur ZIP de `lib/zip.ts` (chaînes partagées, styles et formats de date, numéros de série en calendrier 1900 ou 1904, cellules fusionnées, feuilles masquées ; formule jamais évaluée, valeur enregistrée lue ; macros et liaisons ignorées, `DOCTYPE` refusé ; tailles décompressées annoncées vérifiées avant d'ouvrir, décompression arrêtée à la taille annoncée), lecteur CSV/TSV RFC 4180 (séparateur reconnu ou ligne `sep=`, encodage détecté comme pour les comptes rendus). Plafonds `TABLE_MAX_*`.
2. **Colonnes et propositions** (`mapping.ts`) : colonne des codes (en-tête explicite, sinon première colonne sans doublon ni case vide), variable par libellé, clé, libellés des règles et unité de l'en-tête.
3. **Simulation** (`plan.ts`), cellule par cellule, avec `coerce` comme l'extraction (le facteur `scale` ne s'applique pas ; l'unité de l'en-tête est contrôlée) ; codes normalisés comme les noms de dossier. Le plan a une **empreinte** (`planHash`).
4. **Écriture** : le plan est recalculé **dans la transaction** et comparé à l'empreinte montrée par la simulation (`409 plan_changed` sinon) ; jamais par-dessus une décision de relecteur ni une valeur extraite ou importée différente, sauf option explicite. Source `import`, justification de cellule (`ImportEvidence` : fichier, empreinte, feuille, cellule, en-tête, contenu brut), événement `import` avec `value_events.import_id`. Les brouillons de plus d'un jour sont effacés au démarrage ; un import confirmé ne se supprime pas.

Une valeur importée est **protégée** comme une relecture (`protectedFieldIds`) : une passe ne la retire ni ne la remplace. Elle n'entre pas dans les mesures de fiabilité (`repo/quality.ts`) ; le rapport « Méthodes » la compte à part et liste les imports.

### 3.6 Revue bibliographique (`biblio/`, `routes/biblio.ts`)

PubMed passe par les **E-utilities** du NCBI (`biblio/eutils.ts`) : `esearch` avec historique (nombre total, traduction de l'équation), puis `efetch` XML par lots de 500, lu par un lecteur XML sans dépendance (`lib/xml.ts`) ; au-delà de 9 999 résultats, découpage par tranches de dates. Un limiteur partagé par tout le processus tient 3 requêtes par seconde (10 avec `NCBI_API_KEY`) ; 429, 5xx et coupures sont réessayés (1, 2, 4 s, ou `Retry-After`). Une passe est tout ou rien. Google Scholar reste un acteur Apify, derrière `APIFY_TOKEN`, à qui les balises de champ PubMed sont retirées. Les imports (`biblio/importers.ts` : RIS, MEDLINE, BibTeX, CSV ; encodage détecté ; 50 000 notices au plus) se consignent comme des recherches (`kind = 'import'`) et passent par le même dédoublonnage (DOI, PMID, PMCID, titre ; refusé entre deux PMID, ou deux DOI pour un titre, différents). Le diagramme de flux (`prisma()` dans `repo/biblio.ts`) compte, par source, les notices **distinctes** des recherches réussies (`biblio_hits`, avec `copies` pour les doublons internes d'un export).

## 4. Le moteur d'extraction

### 4.1 Repliage (`engine/fold.ts`)

Chercher sans souci des accents **et** citer l'extrait exact avec sa casse impose de relier chaque position du texte replié à celle du texte d'origine. `foldText` produit `{ folded, map, original }` ; `toOriginalRange` convertit un intervalle. La table est un tableau typé (`Uint32Array`) ; les plages ASCII, qui sont l'essentiel d'un compte rendu, sont traitées d'un bloc et le repli de chaque lettre accentuée est mémorisé (un texte de 8 millions de caractères se replie en un quart de seconde, contre trois secondes avec l'implémentation caractère par caractère, dont un test différentiel prouve l'équivalence).

### 4.2 Règles (`engine/rules.ts`)

Quatre familles (libellé, expression régulière, mots-clés, tag DICOM), évaluées dans l'ordre pour chaque document ; la première valeur **typable** l'emporte. Particularités qui comptent pour la qualité :

- **Mots entiers** pour les termes courts (≤ 4 lettres), racines admises au-delà.
- **Négation limitée à la proposition**, prolongée par « ni », lue aussi après le terme (« diabète : non », « HTA exclue »), jamais sur « non insulinodépendant ».
- **Contextes à ignorer** (antécédents familiaux) : ni affirmés ni niés.
- **Qualificatifs** (`engine/qualifiers.ts`) d'une mention oui/non, dans sa proposition (sa phrase pour les antécédents) : `not-documented` et `uncertain` (hypothèse, « ? ») ne donnent rien ; `ruled-out` (« éliminé », « ex-fumeur », « sevré ») vaut négation ; `contradicted` (négation contredite ou restreinte) et `past` (épisode clos) ne donnent rien ; `history` (antécédents) n'est écarté que par une règle `history: 'exclude'`. Indices étroits, motifs bornés : coût linéaire. Une mention écartée reste visible comme valeur écartée.
- **Toutes les mentions** : une règle lit toutes ses mentions, dans tous les documents (pour une variable oui/non, libellés et mots-clés sont mis en commun ; pour un choix multiple `select: 'any'`, chaque règle apporte ses options). Concordantes, elles donnent la valeur. Discordantes : la règle de sélection `select` (`first`, `last` — ordre d'import des documents puis du texte —, `max`, `min`, `any`) tranche, la justification garde les autres valeurs (`alternatives`, `selection`) et la confiance baisse de 0,15 ; sans `select`, la variable reste vide et un rejet `conflict` est consigné, **sans repli** sur la règle suivante (texte libre : la première). Un choix unique qui cite plusieurs options est traité de même.
- **Variables de synthèse** (`suggestOnly`) : les mentions sont consignées comme proposition (rejet « mentions trouvées … à valider »), la variable n'est pas remplie, sauf par une règle DICOM. **Variables d'arrivée** (`episode: 'admission'`) : les mentions situées plus tard dans le séjour (« à J4 », « en postopératoire », « pic fébrile le … », « au cours du séjour ») sont écartées.
- **Texte de PDF** : une ligne coupée au milieu d'une phrase est recollée quand la suivante commence par une minuscule.
- **Confiance** = base de la famille (DICOM 0,95 ; libellé 0,85 ; regex 0,80 ; mot-clé 0,70) − 0,03 par rang de repli (− 0,15 si une règle de sélection a départagé des mentions). **Ce n'est pas une probabilité** ; elle ordonne la relecture.

### 4.3 Typage (`engine/coerce.ts`)

Convertit la valeur brute vers le type de la variable : nombres à la française et à l'anglaise (`1.200,5`, `1,200.5`, `12 500`), dates (`12 mars 2021`, `12/03/21`, `20210312`, jour d'abord, **31 février refusé**), booléens (« oui », « absence de », « (-) »), options (casse et accents repliés, correspondance partielle, multi-choix sans « diabète » dans « diabète gestationnel »). Ce qu'il **refuse** plutôt que d'inventer : une valeur seuil (« < 5 »), un décimal pour un entier, une **unité différente** de celle de la variable (« 6 mois » pour des années, « 85 µmol/L » pour du mg/L — pour les unités courantes d'une liste fermée, sauf si un facteur de conversion est déclaré ; l'unité peut être écrite plus loin, « 98 (N : 60-110) µmol/L », ou dans la cellule suivante d'un tableau ; une unité à barre inconnue, « Hmol/L », est refusée), une lettre substituée à un chiffre par l'OCR (« 1O », « 7l »), une valeur hors bornes. Il sait aussi lire « 38°5 » (38,5) et calculer une durée en jours d'une période (« du 14/01 au 21/01 ») ; une date n'est jamais lue comme un nombre. Les correspondances d'options et de traductions vont de la plus longue à la plus courte (« défavorable » avant « favorable »). Ces refus remontent comme *valeurs écartées* — visibles, jamais silencieuses.

### 4.4 Expressions régulières surveillées (`engine/safe-regex.ts`)

Un motif saisi par l'utilisateur peut être catastrophique (`(\w+\s?)+:`) et un seul suffit à figer un serveur mono-fil. Une analyse statique repère les motifs qui peuvent exploser (quantificateurs imbriqués, alternative sous un quantificateur, références arrière, quatre quantificateurs ouverts ou plus, plusieurs `.*`). Seuls ceux-là s'exécutent dans un **contexte isolé** (`node:vm`) avec un **délai d'interruption** (`REGEX_BUDGET_MS`, 250 ms) : passé ce délai, l'exécution est interrompue, le motif est « disjoncté » — il n'est plus évalué sur les dossiers suivants, qui donneraient le même résultat — et la règle l'annonce comme valeur écartée, avec la raison en clair. Un motif jugé sain mais qui dépasse le délai en exécution libre est classé à risque pour la suite. Au plus 500 correspondances par motif et par texte. Les motifs trop longs ou trop profonds pour V8 sont écartés de la même façon (`SyntaxError`/`RangeError` interceptés).

### 4.5 Modèle de langage (`engine/llm.ts`, `llm-schema.ts`, `llm-verify.ts`)

Un appel par dossier ; consigne et dictionnaire de variables mis en cache. La consigne décrit **toujours la fiche entière** : en mode `hybrid`, la liste des variables restées vides passe dans le message, et la consigne, identique d'un dossier à l'autre, reste en cache.

**Pseudonymisation** (`engine/pseudonymize.ts`, active sauf `LLM_PSEUDONYMIZE=0`) : avant l'envoi, noms annoncés par une civilité ou un champ « Nom », dates de naissance annoncées, NIR, téléphones, adresses électroniques et postales, identifiants annoncés (IPP, NDA…) sont remplacés par une étiquette. Motifs bornés, sans répétition imbriquée. Chaque remplacement garde sa position d'origine : le modèle ne lit que le texte masqué, ses citations y sont vérifiées, puis ramenées au texte du document (`toOriginal`). Ce n'est pas une anonymisation (voir [Sécurité et données](securite-et-donnees.md#21-la-pseudonymisation-avant-claude-et-ses-limites)).

Trois contrôles avant d'accepter une valeur :

1. **Justification retrouvée** : le modèle doit recopier un extrait du document ; il est recherché dans le texte réel (casse, accents, apostrophes et mise en forme tolérés, rien d'autre). À défaut, la **valeur elle-même** est recherchée dans les documents (si elle compte au moins quatre caractères). Ni l'une ni l'autre : écartée — et une valeur courte (un âge) sans citation retrouvée l'est donc toujours.
2. **Citation qui contient la valeur** (`engine/quote-check.ts`, quand la citation a été retrouvée) : un nombre doit y figurer (virgule ou point, espaces de milliers tolérés ; un nombre collé à une lettre n'en est pas un), une date sous l'une de ses écritures usuelles, et un « oui » ne peut pas reposer sur une citation qui nie, doute ou relègue au passé. Texte et options ne sont pas contrôlés ici (leur formulation varie trop). Le contrôle penche vers le rejet ; la raison est gardée (`unverified[].reason`).
3. **Typage par la fiche** : mêmes contrôles que les règles (type, options, bornes).

L'extrait affiché en relecture est celui **du document**, pas celui recopié par le modèle. Confiance : 0,90 si la citation est retrouvée, 0,75 si seule la valeur l'est. Une valeur retrouvée seule ne prouve pas qu'elle a été lue à cet endroit : c'est la raison de la confiance plus basse. Le modèle ne voit ni le code du dossier ni les noms de fichiers : les documents lui sont présentés sous les noms « Document 1 », « Document 2 »…, et sa réponse est retraduite avant la vérification. L'échec du modèle sur un dossier ne détruit ni les valeurs des règles ni les dossiers suivants. Le **modèle qui a répondu** (`message.model`, que le repli côté serveur peut faire différer de `LLM_MODEL`) est celui que nomment la justification (`Claude (<modèle>)`), la passe et le coût.

**La clé** (`engine/api-key.ts`, routes `/api/llm/key`). Chaque utilisateur paie l'IA avec sa propre clé ; l'outil ne revend rien. La page *Activer Claude* de l'interface (`pages/ClaudePage.tsx`) l'y mène pas à pas : trois étapes chez Anthropic, chacune avec le lien direct vers la page de la console, puis le champ de la clé (`components/KeyForm.tsx`). La clé saisie est contrôlée sur sa forme, puis **vérifiée auprès d'Anthropic** par une seule requête gratuite (`models.retrieve` sur le modèle configuré : elle prouve à la fois la validité de la clé et l'accès au modèle) ; refusée, rien n'est écrit. Une clé personnelle qui vaut pour plusieurs espaces de travail reçoit d'Anthropic un refus qui réclame l'en-tête `anthropic-workspace-id` : la vérification liste alors les espaces (`GET /v1/organizations/workspaces`, avec puis sans l'espace par défaut — celui que la seconde liste omet est l'espace par défaut, essayé en premier), retient le premier où la clé lit la fiche du modèle, et l'enregistre avec la clé ; le client du SDK l'envoie ensuite en en-tête par défaut. Acceptée, la clé est écrite dans `DATA_DIR/anthropic-key.json` — fichier temporaire créé en `0600`, puis renommé : la clé n'existe jamais dans un fichier lisible par d'autres —, **hors de `uploads/` et de la base**, donc hors des sauvegardes et des exports. Priorité : clé de l'application, puis `ANTHROPIC_API_KEY` (et `ANTHROPIC_WORKSPACE_ID`). Le client du SDK est recréé quand la clé ou l'espace changent : pas de redémarrage. Aucune réponse ne contient la clé (provenance et quatre derniers caractères seulement), et tout message d'erreur passe par un masquage des deux clés connues.

**Les refus d'Anthropic** (`engine/anthropic-errors.ts`) que l'utilisateur peut lever lui-même — crédit épuisé, limite de dépenses fixée (`400`), plafond mensuel du palier (`429` portant `enforced_spend_limit_reached`, qu'aucun réessai ne lève), espace de travail manquant — sont reconnus avant les erreurs génériques et traduits en une phrase qui dit quoi faire ; ils ne sont pas réessayés.

**Le coût** (`engine/pricing.ts`). Barème par modèle (dollars par million de jetons : entrée, sortie, lecture et écriture du cache). *Avant* la passe, `GET /api/llm/estimate` donne une fourchette : le texte réel de chaque dossier, plafonné comme il le sera à l'envoi, à 3,2 caractères par jeton (estimation prudente pour du français médical) ; la consigne écrite une fois au cache puis relue ; en sortie, de 40 jetons par variable + 300 (bas) à 90 par variable + 4 000 de raisonnement (haut), sans dépasser `LLM_MAX_TOKENS`. *Après*, la réponse de la passe et la fin du flux de la rédaction portent le **coût constaté**, calculé sur les jetons que l'API a facturés, dossier par dossier au tarif du modèle qui a répondu (un identifiant daté prend le tarif du modèle dont il est la déclinaison ; un tarif inconnu donne `null` plutôt qu'un montant faux). Un modèle absent du barème n'a pas de montant (`null`) : l'interface n'affiche alors que les jetons.

## 5. Isolation de l'analyse des fichiers (`extract/isolation.ts`)

Les plafonds de `limits.ts` (pages, taille de texte, taille décompressée, mégapixels) protègent des fichiers *volumineux*, pas d'un fichier qui *piège* sa bibliothèque de lecture : un PDF dont l'arbre de pages se mord la queue, un flux qui se gonfle de mille fois sa taille. Pendant ce temps le fil principal — donc le serveur pour tous — ne répond plus, et un signal d'arrêt n'y change rien.

Chaque fichier — document ou tableau de cohorte — est donc lu dans un **fil dédié** (`worker_threads`) :

- **Pool** de `PARSE_CONCURRENCY` fils (2) vivant en permanence — démarrer pdf.js coûte plus que lire un compte rendu — remplacés après 200 tâches (les fuites lentes ne s'accumulent pas).
- **Délai ferme** (`PARSE_HARD_TIMEOUT_MS`, délai du PDF + 60 s) : le fil est arrêté (`terminate`) et remplacé.
- **Mémoire bornée** : plafond du tas du fil (`PARSE_WORKER_MB`), **plus** surveillance de la croissance de la mémoire du processus (`PARSE_MAX_GROWTH_MB`) qui couvre la mémoire hors tas et le cas où Node a été lancé avec `--max-old-space-size` (qui annule le réglage du fil).
- **Verdict** : `timeout`, `memory` ou `crash` → le document est enregistré **en erreur, avec le motif**, pour que le chercheur saisisse ses valeurs ou réimporte une version saine. Les autres fichiers ne s'aperçoivent de rien. `unavailable` (aucun fil n'a jamais pu démarrer sur cette plateforme) est l'exception : l'outil le dit une fois dans le journal, puis lit les fichiers dans le fil principal, **sans isolation**, pour le reste du processus.
- **Plantage immédiat ou fil impossible à démarrer ?** L'annonce « prêt » d'un fil et l'erreur d'un fil qui plante aussitôt arrivent par deux canaux dont Node ne garantit pas l'ordre (observé sur Node 22.13, 24 et 26 quand le fil principal est occupé). La décision se prend donc à la **sortie** du fil, moment où l'annonce est fiable, et un fil qui meurt au démarrage après que d'autres ont servi est une erreur de ce fichier, pas une plateforme sans fils.
- **Transfert sans copie** du tampon vers le fil ; environnement figé par tâche.
- L'**OCR** reste dans le fil principal (un seul moteur tesseract) : les fils lui envoient des demandes (RPC).
- `PARSE_ISOLATION=0` désactive l'isolation (diagnostic seulement).

## 6. Modèle de données

SQLite, une base, mode WAL, clés étrangères activées, `busy_timeout` de 5 s, version du schéma dans `PRAGMA user_version`.

| Table | Rôle | Points d'attention |
|---|---|---|
| `patients` | Un dossier : `code` (unique), libellé, notes | La suppression cascade sur tout ce qui suit **et** supprime les fichiers sur disque |
| `documents` | Un fichier : nom d'origine, nom de stockage, nature, MIME, taille, `sha256`, statut d'analyse, **texte extrait**, métadonnées JSON | Index unique `(patient_id, sha256)` : pas de doublon |
| `templates` | Une fiche (une seule `is_active`) | |
| `fields` | Une variable : clé (unique par fiche), type, section, unité, options, position, règles (JSON) | |
| `records` | Une fiche remplie : un `(template, patient)` | Index unique ; `last_extraction_at` |
| `record_values` | Une cellule : valeur (JSON), `source` (`auto`/`llm`/`import`/`manual`/`empty`), confiance, justification (JSON : document et extrait, ou cellule d'un tableau importé), **`origin_source`, `origin_value`, `reviewed_at`** | Les trois derniers portent ce que la machine (ou le tableau importé) avait proposé avant la décision humaine |
| `extraction_runs` | Une passe : fiche, **empreinte**, mode, modèle, version, dates, effectifs, statut | Jamais supprimée ; `template_id` devient `NULL` si la fiche est supprimée |
| `value_events` | Le journal : action, valeur et source avant/après, passe ou import (`import_id`) | **Ajout seul** : aucune fonction ne modifie un événement. Suppression en cascade avec le dossier, la variable ou la fiche concernés (effacer un dossier efface son historique) |
| `table_imports` | Un tableau de cohorte importé : fichier conservé (nom, nom de stockage, format, taille, `sha256`), fiche et son empreinte, feuille, ligne d'en-tête, colonne des codes, correspondances, options, statut (`draft`, `done`), bilan | Un import confirmé ne se supprime pas ; `template_id` devient `NULL` si la fiche est supprimée |
| `biblio_searches`, `biblio_refs`, `biblio_hits` | Revue bibliographique : journal de recherche (recherches et imports : `kind`, équation envoyée, traduction PubMed, fichier, total annoncé, avertissements), références dédoublonnées (`ref_type`), lien recherche ↔ référence (`copies`) | Aucune table ne lit de donnée de patient |

**Migrations** (`db/migrations.ts`) : appliquées dans l'ordre, une seule fois, chacune dans sa transaction (2 : import de tableaux de cohorte ; 3 : PubMed officiel, imports et journal PRISMA-S). Règle d'écriture : *une migration ne retire et ne renomme jamais rien* (la 1.0.0, qui ignore les numéros de schéma, relit une base migrée par la 1.1.0). Une base **plus récente** que l'outil est refusée avec un message (l'ouvrir risquerait de l'abîmer) : une version ancienne ne rouvre donc pas une base qu'une version récente a migrée.

**Transactions** : `node:sqlite` n'en fournit pas ; l'adaptateur (`db/index.ts`) les ajoute, avec points de sauvegarde pour l'imbrication (une transaction interne qui échoue n'annule que sa portion).

## 7. Sécurité en couches

Détail et modèle de menaces : [Sécurité et données](securite-et-donnees.md). En bref :

| Couche | Mécanisme |
|---|---|
| Exposition | Écoute sur `127.0.0.1` par défaut ; avertissement net si `HOST` ouvre le réseau sans mot de passe |
| Hôte | Liste blanche de l'en-tête `Host` (anti « DNS rebinding ») |
| Écritures | Refus des requêtes modifiantes dont l'`Origin` désigne un autre site (anti-CSRF) |
| Accès | Mot de passe HTTP Basic optionnel, comparaison à temps constant, verrouillage après 10 échecs en 5 min |
| En-têtes | CSP stricte (pas de script ni de ressource extérieure), `nosniff`, `X-Frame-Options`, `Referrer-Policy: no-referrer`, `Cross-Origin-*`, `no-store` sur l'API |
| Fichiers | Nom de stockage aléatoire, type servi d'après une liste fermée, `inline` seulement pour PDF, images et texte brut |
| Entrées | Validation zod de tout corps JSON, identifiants décimaux stricts, plafonds de taille partout, réglages numériques vérifiés au démarrage |
| Expressions | Motifs utilisateur surveillés (§ 4.4) |
| Fichiers hostiles | Isolation en fils (§ 5) |
| Erreurs | Jamais de message SQL ni de chemin dans une réponse ; référence retrouvable dans le journal |
| Jetons | `APIFY_TOKEN`, `NCBI_API_KEY` et la clé Anthropic (saisie ou d'environnement) restent côté serveur ; la clé saisie est dans un fichier `0600` hors base et hors sauvegardes ; des tests établissent qu'aucune ne figure dans une réponse, messages d'erreur compris |

## 8. Fiabilité et exploitation

- **Un seul processus par dossier de données** : un fichier de verrou (`.research-tool.lock`, avec le numéro de processus) interdit une seconde instance ; un verrou laissé par un processus disparu est repris seul.
- **Démarrage vérifié** : version de Node, dossier de données inscriptible, base ouvrable, configuration valide — chaque échec produit une phrase qui dit quoi corriger et un code de sortie 1, jamais une trace de pile.
- **Arrêt** : `SIGINT`/`SIGTERM` ferment l'écoute (cinq secondes aux requêtes en cours), les fils d'analyse et l'OCR, puis la base, dont le journal WAL est ramené dans `research-tool.db` ; un arrêt brutal est supporté (WAL, transactions, passes `running` marquées `failed`, dépôt provisoire purgé).
- **Délais HTTP** : requête jusqu'à 30 min (un envoi de 200 Mo sur liaison lente), en-têtes 60 s, keep-alive 65 s.
- **Sauvegarde** (`scripts/backup.ts`) : copie cohérente de la base par `VACUUM INTO` pendant que l'outil tourne, fichiers, `MANIFEST.json` avec empreinte SHA-256 de chaque fichier ; la restauration **vérifie les empreintes avant de remplacer quoi que ce soit** et met les données actuelles de côté.
- **Supervision** : `GET /api/health` interroge réellement la base.
- **Version prête à l'emploi** (`scripts/package.mjs`, `npm run package`) : une archive par système (Windows x64, macOS Apple et Intel, Linux x64) avec le Node.js officiel vérifié par empreinte, le serveur et l'interface compilés, les seules dépendances de production — dont le module natif de rendu des PDF scannés **de la cible** (`npm ci --omit=dev --os --cpu`) — et les données françaises de l'OCR ; archive reproductible (fichiers triés, dates et droits fixés). Le lanceur (`scripts/package/launcher.mjs`) démarre le Node.js fourni et ouvre le navigateur. Repérée par `pubresearcher-package.json`, cette version range ses données dans le dossier de l'utilisateur (`lib/data-dir.ts`), jamais dans le dossier de l'application qu'une mise à jour remplace. `scripts/package/smoke-test.mjs` essaie une archive sur son système, sans réseau ni Node.js du poste ; `.github/workflows/package.yml` le fait sur chaque système.

## 9. Le front

- **React 18, react-router 7, Vite 6**, TypeScript strict, **CSS écrit à la main** (pas de framework), jetons de couleur dans `styles.css` (charte décrite dans [identite-visuelle.md](identite-visuelle.md)) ; **Poppins** embarquée (aucune police chargée à l'exécution : la politique de sécurité n'admet que `'self'`).
- **Pas de gestionnaire d'état global** : un contexte léger (`lib/workspace.tsx`) porte les compteurs du plan de travail ; chaque page charge ce dont elle a besoin. Toute écriture réussie de l'API (import, passe, relecture, fiche, clé) le fait recompter (`onDataWrite` dans `lib/api.ts`), au plus une fois toutes les 1,2 s : le rail et le plan de travail ne restent pas périmés après un import ou une passe. La vue courante des résultats vit **dans l'URL** (`?vue=…`) : un lien reste partageable.
- **Types dupliqués** du serveur (`web/src/lib/types.ts`) : toute modification de `server/src/domain/types.ts` doit y être répercutée.
- **Accessibilité** (cible WCAG 2.2 AA, vérifiée par axe-core sur toutes les pages) : lien d'évitement, un `h1` par vue, onglets au clavier (rôles ARIA, flèches, Début/Fin), noms accessibles contextuels (« Supprimer le dossier PAT-004 »), zones de défilement focalisables et nommées, cibles ≥ 24 px, annonces vocales des actions, titre de page par route, langue des résumés anglais, `prefers-reduced-motion`, aucun reflux horizontal jusqu'à 320 px.
- **Thèmes** clair/sombre/système, appliqué par un script avant le premier rendu (pas d'éclair), préférence mémorisée dans `localStorage` avec repli si le stockage est bloqué.
- **Volumes** : les listes longues sont paginées côté client (dossiers : 200 lignes ; tableau : 100) ; 2 000 dossiers se chargent en 1 à 1,6 s.
- **Charte d'anonymisation** (`components/AnonymisationGate.tsx`) : elle enveloppe le composant d'import (`FolderUploader`) ; tant que l'engagement n'est pas mémorisé pour la version courante du texte (`localStorage`, `anonymisation:ack`), elle s'affiche **à la place** de la zone de dépôt — le composant d'import n'est pas monté. Le texte et sa version vivent dans `lib/anonymisation.ts`, dont la page d'accueil garde une copie que `landing-logic.test.ts` compare.

## 10. Stratégie de test

38 fichiers sous `server/test`, chacun exécuté dans son **propre processus** (l'environnement — dossier de données, OCR — est fixé avant l'import de l'application). Deux familles :

- **Unitaires** : moteur (repliage, typage, règles, négation, regex surveillées), formats d'import, exports, statistiques.
- **Intégration** : l'application complète sur de vrais fichiers PDF, DOCX, images et DICOM fabriqués par les fixtures ; un **vrai processus serveur** (démarrage, verrou, réglages invalides, arrêt par signal ; les arrêts brutaux `kill -9` sont rejoués par un script de la validation, non par la suite) ; le SDK d'Anthropic contre un **faux serveur HTTP** ; l'isolation sur de vrais fichiers piégés ; l'API de la revue bibliographique contre un **faux service E-utilities** et un **faux serveur Apify** qui rejouent des réponses réelles enregistrées.

La page d'accueil (`landing/`) a ses propres parcours de bout en bout, dans un vrai navigateur, contre un **faux Supabase** en mémoire (`landing/e2e/`, Playwright) ; sa logique pure, sa migration et sa configuration de déploiement sont testées depuis `server/test/landing-logic.test.ts`, avec le reste de la suite.

Voir le [rapport de validation](validation.md) pour les résultats, ce qui est couvert et ce qui ne l'est pas.

## 11. Décisions et compromis assumés

| Décision | Pourquoi | Contrepartie |
|---|---|---|
| `node:sqlite` plutôt qu'un module natif | Aucun compilateur C++ à installer (Windows) | Module encore « expérimental » côté Node ; Node ≥ 22.13 requis |
| Un seul processus, base locale | Poste de chercheur, installation en trois commandes | Pas de montée en charge horizontale ; une seule instance par données |
| Extraction **synchrone** (la requête dure autant que la passe) | Simplicité, résultat immédiat, pas de file | Derrière un proxy, relever les délais de lecture ; une passe sur des milliers de dossiers dure des minutes |
| Pas de cache des analyses | Cohérence garantie entre tableau, figures et exports | Chaque lecture recalcule : de 0,3 à 1,2 s côté serveur pour 5 000 dossiers (voir la [validation](validation.md#7-montée-en-charge)) |
| Écriture **dernière arrivée gagnante** sur un même champ | Pas de gestion de verrous d'édition | Deux onglets sur le même dossier ne se préviennent pas |
| Mot de passe unique partagé | Équipe d'une étude, pas de comptes | Pas de traçabilité par personne ; pas de rôles |
| Pas d'anonymisation ; une pseudonymisation de secours avant Claude seulement | Ce n'est pas son rôle, et un outil qui prétend anonymiser engage sa responsabilité ; masquer ce qui est annoncé (civilité, libellés, formats de numéros) réduit ce qui part chez le sous-traitant | Les documents doivent être pseudonymisés **avant** import ; ce qu'aucun motif n'annonce part |
| Mentions discordantes signalées, non départagées | « La première trouvée » dépendait de l'ordre d'import, invisible au relecteur | Plus de variables vides à trancher, tant qu'aucune règle de sélection n'est choisie |
| Clé d'API de l'utilisateur plutôt que revente de crédits | Aucun compte de facturation à tenir, aucune marge sur l'IA : l'utilisateur paie Anthropic au prix public et garde la main (limite de dépenses, révocation) | Il faut un compte Anthropic et une carte ; la clé est celle de l'**instance**, pas d'une personne : sur une instance partagée, tous ceux qui y accèdent dépensent sur ce compte |
| Confiance = indice de rang, pas probabilité | Aucune calibration honnête n'est possible sans vérité de terrain par étude | C'est la page *Fiabilité*, mesurée sur les relectures, qui fait foi |

## 12. Limites connues

Voir aussi le [rapport de validation](validation.md#11-limites-et-ce-qui-na-pas-été-vérifié).

- Les règles lisent du **texte** ; la qualité de l'OCR plafonne celle des valeurs venues d'un scan (lettre O prise pour un zéro).
- Le vocabulaire des négations et des sigles est **français**.
- Une règle « libellé » s'arrête au point-virgule et au saut de ligne ; pour du texte long, employer une expression régulière.
- Google Scholar passe par un acteur Apify tiers dont les champs peuvent changer, et n'autorise pas l'extraction automatisée.
- Le diagramme de flux bibliographique compte les références sur titre et résumé, pas l'évaluation sur texte intégral.
- « Premier » et « dernier » d'une règle de sélection suivent l'ordre d'import des documents, pas la chronologie clinique.
- La paire clair/sombre et la mise en page ont été vérifiées sous Chromium uniquement.
