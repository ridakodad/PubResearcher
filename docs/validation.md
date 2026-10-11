# Rapport de validation — PubResearcher 1.3.0

*Établi le 9 octobre 2026 pour la version 1.1.0 (alors nommée « Research Tool »), complété le 10 octobre 2026 pour la 1.2.0 (changement de nom et refonte visuelle) et le 11 octobre 2026 pour la 1.3.0 (charte d'anonymisation devant l'import, page d'accueil publique : § 1.3 et § 13). Les mesures des § 3 à 8 sont celles de la **1.1.0** : la 1.2.0 ne modifie ni le moteur d'extraction, ni le schéma de la base, ni les routes de l'API (voir le [journal des versions](changelog.md)) ; ce qui a été **rejoué** pour elle, et ce qui ne l'a pas été, est au § 1.2 et au § 9. Les mesures du code et de l'interface de la 1.1.0 (§ 5 à 8) ont été faites sur la version compilée dans l'environnement décrit au § 2 ; la suite de tests et les versions de Node (§ 3) sur une copie neuve du dépôt. Les scripts qui produisent les chiffres (dossier `qa/`, cité dans tout le rapport) ont été écrits pour cet environnement de validation, avec des chemins absolus : **ils ne sont pas publiés dans ce dépôt** (§ 12).*

**Ce que ce rapport est** : la liste de ce qui a été exécuté, de ce que cela a donné, et de ce qui n'a pas été vérifié.
**Ce qu'il n'est pas** : une validation clinique, ni une certification. Aucun dossier patient réel n'a servi : tout le corpus est synthétique ou fabriqué pour l'essai.

## 1. Résumé

### 1.1 Mesures d'origine (version 1.1.0)

| Contrôle | Résultat |
|---|---|
| Tests automatisés du serveur | **684 / 684 réussis**, 35 fichiers, chacun dans son processus ; refaits sur un **clone neuf** du dépôt (après `npm ci`, typage et compilation) avec le script `npm test` du dépôt : 684 / 684, 37 s |
| Versions de Node | La suite complète sous **22.13.0** (minimum déclaré), **22.22.2**, **22.23.3**, **24.21.0** et **26.11.1** : réussie partout (un test, propre aux Node 22.13 à 22.21, y est ignoré : § 3) ; deux défauts propres aux versions anciennes trouvés et corrigés |
| Typage (serveur et interface), compilation | Sans erreur ; interface : 72 modules, 364 Ko (112 Ko compressés) |
| Banc d'essai du moteur (fiche par défaut, 88 cas à réponse connue) | **88 / 88**, **0 valeur fausse**, 4 limites connues figées |
| Corpus de fichiers hostiles (97 fichiers, 36 Mo) | **0 anomalie** : aucun 500, aucun arrêt du serveur, latence maximale de la sonde de santé 142 ms |
| Arrêts brutaux (`kill -9`) pendant une passe — 25 essais, 40 dossiers, 280 valeurs | **0 valeur perdue**, 0 passe restée « en cours » |
| Document texte de 50 Mo | Importé en 1,2 à 1,3 s, extrait en 0,9 à 1,1 s ; gel maximal du serveur **0,4 s** (23 s avant) ; mémoire de pointe 346 Mo (3,3 Go avant) |
| Montée en charge, 1 000 → 5 000 dossiers | Import 103–140 dossiers/s ; extraction 15 s pour 5 000 ; lecture du jeu de données 0,75 s |
| Accessibilité automatisée (axe-core, WCAG 2.2 AA + bonnes pratiques) — 8 pages × 4 largeurs × 2 thèmes = 64 combinaisons | **0 violation**, 0 débordement horizontal, 0 erreur de console |
| Parcours clavier et interactions | 31 / 31 |
| Vérifications de l'interface issues de la contre-expertise (UI-01 … UI-40) et complémentaires | 28 + 22 + 16 réussies, 0 échec, 3 limites documentées |
| Contre-expertises indépendantes (API : 17 constats ; interface : 40) | 57 constats, **54 corrigés et rejoués**, **3 limites documentées** (§ 10) |
| Relectures indépendantes de la documentation contre le code (2 agents : 43 + 47 constats) | Chaque constat vérifié avant d'être appliqué ; passages faux ou trompeurs corrigés, 8 défauts de code corrigés (§ 10.3) |
| `npm audit` | 3 avis modérés, 0 élevé, sans chemin atteignable |

**À retenir sur ce qui n'est PAS établi** (détail § 11) : la justesse de l'extraction sur de vrais comptes rendus (aucun corpus réel) ; le mode « Claude » contre l'API réelle (non exercé) ; l'ouverture réelle des classeurs Excel et des diaporamas (jamais ouverts dans leur logiciel) ; tout navigateur autre que Chromium ; tout lecteur d'écran.

### 1.2 Rejeu pour la version 1.2.0

La 1.2.0 change le nom, la charte et quelques textes ; elle ne touche ni le moteur, ni l'import, ni la base, ni les routes de l'API. Entre la 1.1.0 et la 1.2.0, `server/src` ne diffère que dans **six fichiers (34 lignes)** : bannière de démarrage, domaine d'authentification, texte du rapport « Méthodes », couleurs du diaporama et du rapport HTML, sous-titre de l'export du diaporama ; `server/scripts` est identique ; les tests changent par leurs préfixes de dossiers temporaires, deux chaînes affichées (bannière, domaine) et le contrôle des contrastes. L'interface (feuille de style, marque, carte d'en-tête, rail, tuiles) est refaite.

| Contrôle | Résultat (1.2.0) |
|---|---|
| Typage, compilation | Sans erreur ; interface : 72 modules, 365 Ko de script (112 Ko compressés), 43 Ko de feuille de style (9 Ko compressés), police 4 × 8 Ko, illustration 19 Ko |
| Tests automatisés du serveur | **690 / 690 réussis** (684 en 1.1.0 ; les 6 de plus sont des contrôles de contraste), 35 fichiers ; refaits sur une **copie neuve** de l'arbre versionné : 690 / 690, 33 s |
| Versions de Node | Suite complète sous **22.13.0** (689 réussis, 1 ignoré, comme en 1.1.0), **22.22.2**, **22.23.3**, **24.21.0** et **26.11.1** (690 / 690) |
| Contraste des jetons (test automatique) | 13 tests, deux thèmes : texte, boutons pleins, couples propres aux composants, rail, carte d'en-tête |
| Contraste du texte **rendu** (échantillonnage de pixels) | 13 640 mesures, 12 routes × 3 largeurs × 2 thèmes : **0 sous le seuil** ; la plus faible 5,31:1 (§ 9) |
| Accessibilité automatisée (axe-core, WCAG 2.2 AA) — 64 combinaisons | **0 violation**, 0 débordement horizontal, 0 erreur de console |
| Parcours clavier et interactions | 31 / 31 |
| Constats de l'interface (UI-01 … UI-40) et complémentaires | 28 + 22 + 16 réussies, 0 échec, mêmes 3 limites documentées |
| Données de la 1.1.0 ouvertes par la 1.2.0 | Aucune migration (schéma 1) ; les jeux d'essai de la 1.1.0 s'ouvrent et passent les mêmes parcours |
| Corpus de fichiers hostiles, arrêts brutaux, gros document, montée en charge | Rejoués sur la version compilée avec les mêmes scripts qu'en 1.1.0 : **97 fichiers hostiles** — 0 anomalie (aucun 500, aucun arrêt, aucune sonde de santé au-delà d'une seconde) ; latence maximale de la sonde 60 ms au second passage, 535 ms au premier (un PDF de 30 000 nœuds, serveur à froid), 142 ms en 1.1.0 ; **25 arrêts brutaux** (`kill -9`) — 0 valeur perdue, 0 passe restée « en cours » ; **document de 50 Mo** — importé en 0,9 s, extrait en 0,6 s, sonde de santé 208 ms au plus ; **5 000 dossiers** — import 209 dossiers/s, extraction 10,6 s, lecture du jeu de données 0,42 s. Ces dernières mesures sont **plus rapides qu'en 1.1.0** (140 dossiers/s, 15,2 s, 0,75 s), y compris pour des opérations dont le code n'a pas changé : l'écart tient à la machine, pas à la version |
| `npm audit` | 3 avis modérés, 0 élevé (les mêmes qu'en 1.1.0 : `mammoth` → `argparse` → `sprintf-js`), sans chemin atteignable |

**Non rejoué pour la 1.2.0** : les deux contre-expertises indépendantes (API et interface) et les deux relectures de la documentation (§ 10) — elles portent sur des versions antérieures ; les passages de la documentation modifiés pour le nouveau nom ont été relus à la main et leurs liens vérifiés (93 liens internes, 0 défaut).

### 1.3 Rejeu pour la version 1.3.0

La 1.3.0 ajoute la **charte d'anonymisation** devant l'import (interface seulement) et la **page d'accueil** (`landing/`, un site à part). `server/src` et `server/scripts` sont **inchangés** (seule la version, lue dans `package.json`, change) : le moteur, l'import, la base et l'API sont ceux de la 1.2.0, et les mesures des § 5 à 7 restent valables.

| Contrôle | Résultat (1.3.0) |
|---|---|
| Typage (serveur, interface, page d'accueil), compilation | Sans erreur. Interface : 74 modules, 370 Ko de script (114 Ko compressés). Page d'accueil : script initial 269 Ko (85 Ko compressés), client Supabase dans un fichier à part, chargé après l'affichage, 228 Ko (59 Ko), feuille de style 38 Ko (8 Ko) |
| Tests automatisés | **793 / 793 réussis** (690 en 1.2.0 ; +7 charte de l'application, +83 page d'accueil, +13 contrastes de sa feuille de style), 37 fichiers |
| Charte de l'application, dans le navigateur | **78 vérifications** (aucun champ de fichier avant la confirmation, 3 engagements sur 5 ne suffisent pas, mémorisation avec version et date, rappel dépliable, non redemandée pour la même version, redemandée pour une version périmée, même charte dans « Ajouter des documents ») et **30 audits axe** — 3 largeurs × 2 thèmes : **0 constat** |
| Interface de l'application (axe-core, 8 pages × 4 largeurs × 2 thèmes) | **0 violation**, 0 débordement horizontal, 0 erreur de console (64 combinaisons, comme en 1.2.0) |
| Page d'accueil : parcours de bout en bout (faux Supabase) | **25 / 25** (§ 13.2) |
| Page d'accueil : accessibilité (axe-core, WCAG 2.2 AA + bonnes pratiques) | **248 audits, 0 violation**, 0 débordement horizontal (§ 13.3) |
| Page d'accueil : contraste du texte **rendu** | **5 984 mesures**, 0 sous le seuil ; la plus faible 4,96:1 (§ 13.3) |
| Page d'accueil : clavier | 392 arrêts de tabulation : tous avec un anneau de focus visible, aucun élément focalisable invisible (§ 13.3) |

**Non rejoué pour la 1.3.0**, parce que le code concerné n'a pas changé : corpus de fichiers hostiles, arrêts brutaux, gros document, montée en charge, suite sous cinq versions de Node (la suite complète a tourné sous Node 22.22.2 seulement). **Vérifié sur le projet Supabase réel** : règles d'accès, droits et réponses de l'API (§ 13.4). **Non vérifié** : un parcours dans un navigateur contre ce projet, un vrai client Google, un vrai envoi de courriels, et un vrai déploiement Vercel (§ 13.5).

## 2. Environnement de test

| | |
|---|---|
| Machine | Conteneur Linux (noyau 6.18), 4 cœurs, 16 Go de mémoire |
| Node.js / npm | 22.22.2 / 10.9.7 (référence) ; 22.13.0, 22.23.3, 24.21.0 et 26.11.1 pour la matrice du § 3 |
| Navigateur | Chromium 141.0.7390.37, piloté par Playwright 1.56.1 |
| Accessibilité | axe-core 4.10.2 (étiquettes `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`, `best-practice`) |
| Code | Serveur : 13 863 lignes TypeScript ; interface : 10 232 (TypeScript et TSX) et 1 642 de feuille de style ; tests : 9 578 (fichiers `.ts` de `server/test`) — comptées par `wc -l`, dépendances exclues. En 1.1.0 : 13 863 / 10 218 / 9 523, feuille de style 1 480 |
| Réseau | Sortant seulement, via un relais ; aucun appel à Apify ni à Anthropic pendant la validation (faux serveur Apify local ; aucune clé d'API) |
| Données | 24 dossiers de démonstration (`npm run demo`) ; cohortes synthétiques de 1 000 à 5 000 dossiers ; fichiers fabriqués |

OCR **désactivé** pour les mesures de volume (une page scannée coûte plusieurs secondes : l'inclure mesurerait l'OCR, pas l'outil), **activé** pour les parcours d'interface et les tests de PDF scannés.

## 3. Tests automatisés

`npm test` : `node --import tsx --test`, un processus par fichier (l'environnement — dossier de données, OCR — est fixé avant l'import de l'application).

| Fichier | Tests | Ce qu'il couvre |
|---|---:|---|
| `api-hardening` | 55 | Garde Hôte/Origine (DNS rebinding, CSRF), verrou du dossier de données, masquage des jetons, exports sans caractère de contrôle, dates Excel, écritures tout-ou-rien, règles démesurées, identifiants hors limites, **environ 3 000 requêtes hostiles** (chaque valeur de chaque clé de chaque corps remplacée par une valeur hostile) |
| `extract-isolation` | 33 | Analyse en fils séparés sur de vrais fichiers piégés : délai ferme, mémoire, plantage, remplacement du fil, transfert sans copie, arrêt propre ; **événements de fil simulés dans tous les ordres** (erreur avant ou après le signal « prêt », sortie sans signal) et démarrage impossible |
| `boot` | 10 | Démarrage d'un **vrai processus** : verrou avant la base, réglages invalides (un seul, plusieurs) et valides hors défaut, messages d'échec, arrêt propre (base fermée : `research-tool.db` seul, lisible), sonde de santé |
| `engine-benchmark` | 97 | 88 cas à réponse connue sur la fiche par défaut, 4 limites figées, valeurs écartées (seuil, bornes, unité) |
| `engine`, `engine-matching` | 51 + 31 | Repliage, typage (nombres, dates, booléens, choix), règles libellé / regex / mots-clés / DICOM, négations, contextes à ignorer, mots entiers, apostrophe droite ou typographique |
| `fold` | 6 | Repliage par blocs **identique** à l'ancienne version (400 chaînes aléatoires dont `İ`, émoji, moitiés de paire, apostrophes typographiques) et rapide |
| `units` | 8 | Unités discordantes écartées, unités équivalentes acceptées, facteur de conversion déclaré |
| `safe-regex` | 32 | Motifs catastrophiques interrompus et disjonctés, motifs ordinaires non ralentis |
| `pipeline` | 46 | Import réel de PDF, DOCX, DICOM → extraction → résultats → exports ; banc d'essai d'une règle avec son unité |
| `review` | 24 | Saisie contrôlée, bornes (422), confirmer / vider / rendre la main, historique |
| `traceability` | 14 | Fiabilité mesurée sur les relectures, rapport « Méthodes » (chiffres exacts, passes nombreuses : synthèse sur toutes, détail des 25 plus récentes), journal d'audit et son sort à la suppression d'un dossier |
| `import-limits`, `extract-errors`, `extract-text`, `extract-images`, `extract-pdf-ocr`, `extract-pdf-noocr` | 16 + 19 + 29 + 4 + 5 + 2 | Plafonds (PDF, Word, texte, images), noms UTF-8, envois simultanés, messages d'échec en français, encodages (table Windows-1252 propre à l'outil, comparée au décodeur de la plateforme quand celui-ci est fiable) / RTF / HTML, **images réelles** (PNG, JPEG avec et sans EXIF, TIFF) lues par l'OCR, OCR des pages scannées |
| `robustness`, `security`, `research-io`, `backup` | 15 + 13 + 11 + 9 | Ménage du disque, requêtes mal formées, messages 413 / 415, en-têtes et mot de passe, codes de dossier, CSV, sauvegarde / restauration |
| `biblio`, `biblio-adapters`, `biblio-search` | 30 + 24 + 13 | Revue bibliographique contre un faux serveur Apify rejouant de vraies sorties (octobre 2026), adaptateurs, recherche multi-mots, exports complets |
| `llm`, `chat`, `llm-secrets` | 19 + 12 + 11 | Mode « Claude » **sans appel réseau** (faux serveur HTTP) : schéma imposé, recherche des citations, typage, tri retenues / écartées, consigne de rédaction ; clé d'API masquée dans les erreurs, corps des requêtes sans code de dossier ni nom de fichier (documents présentés comme « Document 1 »…) et retour des citations vers les documents, valeurs de texte libre non transmises à l'assistant, une passe qui ne retire que ce qu'elle a pu produire |
| `env-check`, `http-timeouts`, `format-size` | 10 + 2 + 2 | Bornes des 21 réglages numériques et de `LLM_EFFORT` ; délais HTTP appliqués au serveur ; tailles écrites en clair |
| `start-script` | 7 | Démarrage par `npm start` : version de Node vérifiée avec une phrase qui dit quoi installer, compilation automatique à la première utilisation, échec de compilation expliqué (le script de démarrage est essayé sur de faux projets) |
| `node-version`, `web-logic`, `web-contrast` | 4 + 13 + 13 | Version de Node exigée ; logique pure de l'interface (saisie des nombres, regroupement des dossiers déposés) ; **contraste des jetons de couleur** (texte ≥ 4,5:1 sur six surfaces, bordure des champs et anneau de focus ≥ 3:1, boutons pleins, couples propres aux composants, rail d'outils et carte d'en-tête, thème du système identique au thème sombre explicite) — 7 tests en 1.1.0, 13 depuis la refonte visuelle |
| **Total** | **690** | **0 échec, 0 ignoré** (684 en 1.1.0 ; sous Node 22.13 à 22.21, un test est ignoré : voir plus bas) |

Durée cumulée des fichiers : environ 94 s (lancés deux à la fois).

**Contrôle sur une copie neuve.** La suite a aussi été rejouée sur une copie propre du dépôt, hors de l'arborescence de travail, après `npm ci`, `npm run typecheck` et `npm run build`, avec le script `npm test` du dépôt (et non le lanceur de la validation) : cela établit que le dépôt tel qu'il est versionné se suffit à lui-même, sans fichier resté seulement dans l'arborescence de travail. **1.1.0** : 684 / 684 en 37 s. **1.2.0** : la copie est l'arbre exact de ce qui a été versionné (fichiers indexés, exportés dans un dossier vide) ; `npm ci` 5,0 s (cache de paquets chaud), typage 8,3 s, compilation 10,6 s, **690 / 690 en 32,6 s** pour `npm test` (environ 86 s de temps processeur en mode utilisateur). Entre cet arbre et le dépôt publié, seuls des fichiers de documentation (`README.md`, `docs/` : les chiffres de ce rapport, qui ne pouvaient être écrits qu'après les mesures) et les fins de ligne de `lancer.bat` ont changé (CRLF rétablies : une réécriture les avait converties en LF ; aucun test ne lit ce fichier).

### Versions de Node

Le minimum déclaré (22.13) et trois versions plus récentes ont reçu la **suite complète**, chacune sur la même copie neuve (`npm test` avec le binaire de la version essayée). Mesures de la **1.1.0**, puis rejeu pour la **1.2.0** (690 tests) :

| Node | 1.1.0 | 1.2.0 | Durée de `npm test` (1.1.0 → 1.2.0) |
|---|---|---|---:|
| 22.13.0 (minimum) | 683 réussis, 0 échec, **1 ignoré** | 689 réussis, 0 échec, **1 ignoré** | 40 s → 33 s |
| 22.22.2 (référence) | 684 / 684 | 690 / 690 | 37 s → 33 s |
| 22.23.3 | 684 / 684 | 690 / 690 | 37 s → 32 s |
| 24.21.0 | 684 / 684 | 690 / 690 | 33 s → 32 s |
| 26.11.1 | 684 / 684 | 690 / 690 | 33 s → 31 s |

Le balayage de la 1.1.0 avait trouvé deux défauts, **corrigés** avant la livraison de cette version (avant correction, 22.13.0 donnait 614 / 616) :

- **Décodeur `windows-1252` de Node** : de 22.13.0 à 22.21.1 (onze versions essayées), `new TextDecoder('windows-1252')` rend les octets 0x80 à 0x9F comme des caractères de contrôle au lieu de « € », « œ », « — », des guillemets, etc. ; le défaut a disparu à partir de 22.22.2. L'outil décode désormais ces textes (et les séquences RTF `\'hh`) avec **sa propre table** de 256 entrées. Un test compare cette table au décodeur de la plateforme quand celui-ci est fiable ; il est **ignoré** sous les versions fautives, dont le décodeur ne peut pas servir de référence.
- **Ordre des événements d'un fil d'analyse** : Node n'assure pas qu'une erreur de démarrage d'un fil (`error`) et son signal « prêt » (`message`) arrivent dans l'ordre. Sous charge, l'outil pouvait déclarer « indisponible » un fil qui venait de démarrer (reproduit 4 fois sur 30 sous 22.13.0, 1 fois sur 30 sous 24.21.0 et 26.11.1, dans une sonde dédiée). La décision se prend maintenant à la sortie du fil, et l'outil ne se déclare indisponible que si **aucun** fil n'a jamais été prêt ; des tests rejouent tous les ordres possibles avec des fils simulés.

Les autres versions intermédiaires de Node (22.14 à 22.21, 23.x, 25.x) n'ont **pas** reçu la suite complète.

Aucun test automatisé ne pilote l'interface : celle-ci est validée par les scripts de navigateur du § 8.

## 4. Typage, compilation, dépendances

- `npm run typecheck` : serveur (`tsc --noEmit`) et interface (`tsc -b --noEmit`), TypeScript strict, 0 erreur.
- `npm run build` : serveur (`tsc`) et interface (Vite 6 : 72 modules ; JavaScript 364,4 Ko dont 112,0 Ko compressés, CSS 39,0 Ko dont 8,1 Ko compressés).
- `npm audit` (9 octobre 2026) : **3 avis modérés** (`mammoth` → `argparse` → `sprintf-js`, déni de service par un format `sprintf` à précision non bornée), 0 élevé, 0 critique. Aucun chemin de l'application ne l'atteint avec une entrée utilisateur ; la « correction » proposée est un retour en arrière de `mammoth` qui réintroduirait d'autres défauts.
- **Scripts d'installation** : aucun des paquets du projet n'en déclare. Dans les dépendances, le verrou en signale quatre entrées : `esbuild` (deux copies : vérification du binaire précompilé), `tesseract.js` (message de financement, sans effet : `|| true`) et `fsevents` (optionnel, macOS seulement, non installé sous Linux). Aucun module n'est compilé à l'installation ; les binaires natifs (`@napi-rs/canvas`, `esbuild`) sont précompilés.

## 5. Précision de l'extraction

### 5.1 Ce qui est mesuré : un banc d'essai synthétique

`engine-benchmark.test.ts` : **88 phrases cliniques courantes, rédigées à la main par les auteurs du moteur, dont la bonne réponse est connue**, appliquées à la fiche livrée par défaut (22 variables). Résultat : **88 / 88 corrects, 0 valeur fausse, 0 vide à tort** — la condition d'arrêt du test est « aucune valeur fausse ».

**Ce chiffre ne dit presque rien de la précision sur vos dossiers.** Le corpus est écrit par ceux qui ont écrit les règles ; il sert à (1) empêcher qu'un faux positif corrigé réapparaisse (« homme » lu « Féminin » parce qu'il contient « mme » ; « CRP < 5 » lu 5), (2) dire noir sur blanc ce que les règles ne savent pas faire, (3) donner un point de départ.

### 5.2 Les limites connues, figées par des tests

Si l'une d'elles change de résultat, le test échoue et force à mettre cette documentation à jour.

| Variable | Texte | Résultat | Pourquoi |
|---|---|---|---|
| Tabagisme | « Tabac : 20 paquets-années » | vide | une quantité n'est pas reconnue comme « oui » |
| Tabagisme | « Tabagisme sevré depuis 5 ans » | Oui | la fiche ne distingue pas actuel et sevré : à définir pour votre étude |
| Sexe | « Le patient a été admis pour douleurs abdominales. » | vide | « patient » est un masculin générique : un sexe inventé vaut moins qu'un vide |
| Hémoglobine | « 11 g/dL puis 9,5 g/dL à J3 » | 11 | la première valeur gagne : aucune notion de chronologie |

*Corrigée dans cette version* : « Créatinine : 85 µmol/L » était lue 85 mg/L ; elle est désormais **écartée et signalée** (unité différente).

### 5.3 Ce que vaut l'extraction sur vos dossiers

Seule la page **Fiabilité** le dit, sur un échantillon relu et **tiré au hasard** : voir [Méthodes et reproductibilité](methodes-et-reproductibilite.md#3-mesurer-la-fiabilité-sur-vos-dossiers) (définitions, intervalles de confiance, nombre de valeurs à relire).

## 6. Robustesse : fichiers hostiles, arrêts brutaux, gros documents

### 6.1 Corpus de fichiers hostiles — 97 fichiers, 36,1 Mo

Fabriqués pour casser un extracteur : PDF dont l'arbre de pages se mord la queue, PDF de 30 000 pages, flux compressés qui se gonflent, Word qui se décompresse en gigaoctets, tableaux imbriqués, images de 100 mégapixels, fichiers vides, tronqués, protégés, mal nommés, faux types (`.txt.exe`, `.svg`, `.js`, `.mht`, `.zip`). Chacun envoyé à un serveur réel, avec une sonde de santé interrogée en continu.

| Issue | Fichiers |
|---|---:|
| Importés, texte lu | 51 |
| Importés **avec une erreur de lecture explicite** (« PDF corrompu ou illisible. Réexportez-le… », « Document Word trop volumineux une fois décompressé… », « Format non pris en charge (…) : … ») | 44 |
| Importés, aucun texte | 2 |
| **Anomalies** (HTTP 5xx, erreur réseau, serveur arrêté, sonde de santé > 1 s) | **0** |

Latence maximale de la sonde de santé pendant tout le corpus : **142 ms**. Mémoire du serveur : **pic de 1,03 Go**, atteint en lisant un Word de 100 000 paragraphes (283 Ko, 5,3 s) — elle est restée voisine de 1 Go pendant les fichiers suivants, puis est retombée vers 260 Mo après l'arrêt d'un PDF piégé au délai ferme (le fil d'analyse est alors remplacé) ; 267 Mo à la fin. Pour dimensionner une machine, c'est le pic qui compte (guide de l'administrateur, § 8).

Le fichier le plus long est un PDF de 30 000 pages (8,7 Mo) : 15,1 s, **à la limite du délai ferme**, fixé à 15 s pour ce test (180 s par défaut). Selon la vitesse du moment, il est lu **partiellement** (« Lecture partielle : 28500 pages non lues (plafond de pages PDF_MAX_PAGES). », première exécution : 15 091 ms, `qa/corpus/result-before-last.json`) ou **interrompu au délai ferme** et enregistré en erreur avec le motif (seconde exécution, même machine : 15 104 ms, `qa/corpus/result.json`) ; dans les deux cas le serveur reste disponible, ce qui est la propriété éprouvée. Trois autres PDF piégés (arbre de pages en boucle, ramification profonde) ont été arrêtés au délai ferme dans les deux exécutions.

Avant l'isolation en fils séparés, un PDF de 1 Ko occupait pdf.js 21 s dans le fil principal (plus de 100 s pour 40 000 opérations) et un flux de 200 Ko se gonflait de 720 Mo.

### 6.2 Arrêts brutaux pendant une passe

40 dossiers de texte, extraction de référence (280 valeurs), puis **25 fois** : lancer une passe, `kill -9` après un délai aléatoire de 20 à 720 ms, redémarrer, comparer le nombre de valeurs de chaque dossier à la référence.

> **Résultat : 0 écart sur 25 itérations ; 0 dossier touché ; 0 passe restée « en cours »** (états vus : `done`, `failed`).
> Avant correction, le contre-expert avait mesuré **14 itérations sur 25 (56 %)** avec au moins un dossier à un nombre de valeurs différent — jusqu'à un dossier passé de 5 valeurs à 0 avec une date de passe toute neuve.

### 6.3 Gros document texte (50 Mo)

| | Avant (copie figée du contre-expert) | Après |
|---|---:|---:|
| Import | — | 1,2 à 1,3 s (texte plafonné à 8 millions de caractères, signalé) |
| Extraction | 9,4 s pour 20 Mo ; 23 s pour 50 Mo (texte non plafonné) | **0,9 à 1,1 s** (sur les 8 millions de caractères conservés) |
| Gel maximal du serveur (latence maximale de la sonde de santé) | **23 s** | **0,36 à 0,41 s** (deux mesures) |
| Mémoire de pointe | **3,3 Go** | **346 Mo** |

La cause du dernier gel était le repliage du texte (minuscules, sans accents, avec table de positions) fait caractère par caractère : 3 s pour 8 millions de caractères, d'un seul bloc. Il se fait désormais par blocs, avec une table en tableau typé ; le résultat est identique (test différentiel sur 400 chaînes aléatoires).

## 7. Montée en charge

Serveur compilé, un seul processus, OCR désactivé, cohortes synthétiques de **petits dossiers** : un compte rendu texte d'environ 1,2 Ko, plus un PDF pour un dossier sur 5 et un Word pour un sur 10 (**1,3 document par dossier** en moyenne), importés par 8 envois simultanés ; fiche par défaut de 22 variables, 16 à 17 valeurs extraites par dossier. Chaque lecture est mesurée deux fois, la meilleure est retenue. Une première série, faite avant la dernière compilation, donnait des temps comparables à quelques dizaines de pour cent près (import 7,3 s à 1 000 dossiers, 17,0 s à 5 000) : la machine d'essai n'est pas dédiée, et les écarts d'une exécution à l'autre sont de cet ordre. **Ces débits mesurent le travail du serveur, pas la lecture de gros PDF** : des dossiers de dix PDF de cinquante pages s'importeront plus lentement.

| | 1 000 dossiers | 2 500 | 5 000 |
|---|---:|---:|---:|
| Import | 9,7 s (103/s) | 12,2 s (123/s) | 17,9 s (140/s) |
| Latence maximale de `/api/health` pendant l'import | 34 ms | 36 ms | 26 ms |
| Première extraction | 4,5 s (16 663 valeurs) | 8,1 s (41 652) | 15,2 s (83 321) |
| Latence maximale pendant l'extraction | 76 ms | 99 ms | 267 ms |
| Seconde extraction | 3,9 s | 7,9 s | 15,5 s |
| `GET /analytics/dataset` (JSON) | 124 ms · 1,5 Mo | 335 ms · 3,7 Mo | 747 ms · 7,5 Mo |
| `GET /analytics/stats` | 127 ms | 310 ms | 645 ms |
| `GET /analytics/completeness` | 107 ms | 313 ms | 576 ms |
| `GET /analytics/extraction` | 266 ms | 655 ms | 1 379 ms |
| `GET /analytics/quality` | 52 ms | 144 ms | 291 ms |
| Export CSV | 113 ms | 315 ms | 775 ms |
| Export Excel | 224 ms | 593 ms | 1 257 ms |
| Export diaporama | 184 ms | 319 ms | 650 ms |
| Rapport « Méthodes » | 102 ms | 212 ms | 392 ms |
| Journal d'audit (CSV) | 202 ms · 1,5 Mo | 492 ms · 3,7 Mo | 1 124 ms · 7,3 Mo |
| Taille de la base | 10,6 Mo | 26,4 Mo | 52,8 Mo |
| Mémoire du processus (fin) | 347 Mo | 659 Mo | 860 Mo |

Lecture : le temps croît **linéairement** avec la cohorte ; l'import et l'extraction laissent le serveur réactif ; les lectures analytiques et les exports sont synchrones et **bloquent la boucle d'événements** le temps de leur durée (jusqu'à ~1,4 s à 5 000 dossiers). Mono-utilisateur : le serveur n'a pas été éprouvé avec plusieurs utilisateurs simultanés.

**Interface à 2 000 dossiers** (Chromium, bureau 1440 px) :

| Écran | Délai avant affichage | Nœuds DOM | Lignes rendues |
|---|---:|---:|---:|
| Dossiers patients | 1,09 s | 2 801 | 200 (pagination) |
| Tableau de données | 1,45 s | 9 404 | 100 (pagination) |
| Distributions | 1,57 s | 640 | — |
| Complétude | 1,39 s | 448 | 22 |
| Extraction | 1,16 s | 1 513 | — |
| Recherche d'un dossier | 0,16 s | | 1 résultat |

Avant les corrections, la contre-expertise mesurait 184 196 nœuds DOM et 4,4 s pour le tableau de 2 000 dossiers.

## 8. Interface

Chromium 141 piloté par Playwright, sur le serveur compilé, données de démonstration (24 dossiers, relecture scriptée de 8 dossiers).

### 8.1 Audit automatisé : 64 combinaisons

Rejoué sur la version finale, **après** la correction des contrastes (§ 8.5).

8 pages (plan de travail, dossiers, détail d'un dossier, fiche, extraction, rédaction, résultats, bibliographie) × 4 largeurs (320, 390, 768, 1 440 px) × 2 thèmes (clair, sombre).

| | Résultat |
|---|---|
| Débordement horizontal | **0** combinaison sur 64 |
| Violations axe-core (WCAG 2.2 AA + bonnes pratiques) | **0** |
| Erreurs ou avertissements de console, requêtes en échec | **0** |

### 8.2 Parcours clavier et interactions — 31 / 31

Lien d'évitement (premier arrêt de tabulation, visible, amène dans `main`) ; focus visible ; onglets (flèches, Début, Fin, tabulation itinérante) ; fenêtres modales (rôle `dialog`, `aria-modal`, nom accessible, arrière-plan neutralisé, 52 appuis sur Tab / Maj+Tab sans sortie, Échap qui rend le focus au bouton d'origine, saisie non détruite en silence) ; relecture ; cibles tactiles ; `prefers-reduced-motion` (aucune animation infinie) ; thème (choix conservé au rechargement, sans éclair).

### 8.3 Vérifications issues de la contre-expertise (UI-01 … UI-40) et complémentaires

Rejouées sur la version finale :

| Série | Résultat |
|---|---|
| `verify-ui` (UI-01 … UI-25, 36 … 39) | **28 réussies**, 0 échec, 2 informations. **Quatre des 28 sont des renvois** vers d'autres essais, codés en dur dans le script (UI-07 et UI-08 vers les tests de motifs et de fichiers piégés, UI-16 et UI-17 vers les parcours clavier) : 24 sont exécutées dans le navigateur |
| `verify-ui2` (UI-19, 20, 27 … 32, 34, 35, 40) | **22 réussies**, 0 échec, 1 information |
| `verify-ui3` (UI-26 et correctifs ultérieurs) | **16 réussies**, 0 échec |

Les informations sont des limites documentées : lettre O lue comme un zéro par l'OCR (UI-33b), deux onglets sur le même champ (UI-39), exclusion bibliographique par choix en ligne plutôt que par boîte de dialogue (UI-29c, sans conséquence).

`verify-ui3` n'existait pas lors de la contre-expertise : il rejoue ce que les deux premières séries ne couvraient pas — **UI-26** (libellés : compteur « formats de sortie » égal au nombre réel de formats, chaque entrée du menu reprise par le titre de page, l'onglet sélectionné ou le titre du document, pas de « Réessayer » sous « Dossier introuvable », pas de « Détail : » qui répète la consigne, accords du banc d'essai, apostrophe typographique partout dans le texte de l'interface), puis les correctifs apportés depuis : avertissement d'import d'un texte tronqué (bilan d'import et bandeau à la relecture), valeurs « trouvées mais écartées » au bilan de la page Dossiers, **lot refusé en bloc repris fichier par fichier** (un fichier au-delà de `MAX_UPLOAD_BYTES` : les deux autres sont importés), banc d'essai qui applique l'unité en cours d'édition (rien n'est enregistré), arrêt par `SIGTERM` de deux vrais serveurs (code 0, ni `-wal` ni `-shm`). Deux sous-points d'UI-26 ne sont pas rejoués dans le navigateur : l'accord « 0 référence rendue » du bilan bibliographique (relu dans le code) et les confiances constantes par famille de règle (choix documenté : la confiance est un indice, pas une probabilité).

> **Premier passage** : trois « échecs » apparus à la première exécution de `verify-ui` venaient du **banc d'essai lui-même** (un chemin de données codé en dur vers l'ancienne instance, une bibliothèque bibliographique vide dans la nouvelle) ; le produit n'était pas en cause. Le banc a été corrigé et rejoué ; seuls les résultats du second passage sont comptés. De même, la première version de `verify-ui3` lisait un résultat du banc d'essai avant l'arrivée du suivant (faux succès et faux échecs) : elle attend maintenant la réponse du serveur.

### 8.4 Captures

Les captures de la documentation (`docs/img/`, 10 fichiers) et de l'audit (`qa/ui/shots/`, 39 fichiers : 8 pages × 2 largeurs × 2 thèmes, plus 7 vues d'interactions) ont été examinées une par une lors de leur prise ; celles de `qa/ui/shots/` sont réécrites par chaque exécution de l'audit.

### 8.5 Contraste des couleurs

Le contre-expert de l'interface avait mesuré, par échantillonnage de pixels, le contraste du texte **rendu** sur 11 routes en thèmes clair et sombre : AA atteint, hors boutons désactivés (exemptés). Un calcul plus large, fait ensuite sur les **jetons** de la feuille de style (chaque couleur de texte sur chacune des six surfaces possibles), a montré **15 combinaisons sous 4,5:1 en thème clair et 4 en thème sombre** (texte discret, accents verts et ambre, avertissements) — toutes ne s'affichent pas aujourd'hui, mais la prochaine modification pouvait en faire apparaître — et une bordure de champ à 1,95:1 (sous les 3:1 attendus d'un composant d'interface).

Les jetons ont été corrigés (`--text-muted`, `--brand-lime` — supprimé depuis avec la charte verte —, `--series-2`, `--warning`, `--serious`, nouvelle `--control-border`) et un **test** (`web-contrast`) recalcule chaque rapport à partir de la feuille de style : une régression de couleur fait échouer la suite. Ce test porte sur les jetons, non sur les pixels : les 64 combinaisons d'axe-core (§ 8.1), rejouées après la correction, sont le contrôle sur la page réelle.

## 9. Refonte visuelle et changement de nom (1.2.0)

La 1.2.0 refait l'habillage (charte, police, composants, navigation) et renomme l'application. Ce qui pouvait casser — lisibilité, contraste, mise en page à toutes les largeurs, thème sombre, cohérence des textes — a été contrôlé **sur le rendu**, pas seulement sur la feuille de style.

### 9.1 Ce qui a été mesuré

| Contrôle | Méthode | Résultat |
|---|---|---|
| Contraste des jetons | `web-contrast` : chaque encre contre chaque surface, les deux thèmes (§ 8.5) | 13 tests, réussis |
| Contraste du texte **rendu** | `ui/render-contrast.mjs` : à chaque pas de défilement, boîtes et couleurs de tout le texte visible relevées, le texte rendu transparent, la fenêtre capturée, puis médiane et 5ᵉ / 95ᵉ centiles de luminance des pixels sous chaque boîte ; seuil 4,5:1 (3:1 pour le grand texte). 12 routes × 3 largeurs (1 440, 820, 390 px) × 2 thèmes | **13 640 mesures, 0 sous le seuil** ; la plus faible : 5,31:1 |
| Carte d'en-tête | Même méthode, texte de la carte seul, 11 largeurs de 320 à 1 440 px | 6,69:1 au plus bas |
| Accessibilité automatisée | `ui/audit.mjs` (axe-core, WCAG 2.2 AA + bonnes pratiques) : 8 pages × 4 largeurs × 2 thèmes | **64 combinaisons : 0 violation, 0 débordement horizontal, 0 erreur de console ni requête en échec** |
| Clavier, modales, cibles tactiles, mouvement réduit, thème | `ui/interact.mjs` | **31 / 31** |
| Constats de la contre-expertise de l'interface (UI-01 … UI-40) et complémentaires | `verify-ui`, `verify-ui2`, `verify-ui3` | **28 + 22 + 16 réussies, 0 échec**, mêmes 3 limites documentées qu'en 1.1.0 |
| Débordement horizontal aux largeurs de rupture | 600, 720, 721, 820, 1 001, 1 024, 1 100, 1 200 et 1 280 px, 11 routes, deux thèmes | Aucun |
| Données de la 1.1.0 | Les deux jeux d'essai de la 1.1.0 (base de l'audit, 24 dossiers de démonstration) ouverts tels quels par la 1.2.0 | Schéma 1, aucune migration, tout s'affiche |

Les captures de la documentation (`docs/img/`) ont été reprises sur la version finale, en thème clair ; les deux thèmes ont été regardés sur toutes les pages principales à 1 440 px, et sur la plupart à 820 et 390 px.

### 9.2 Défauts trouvés par ces contrôles, et corrigés

| Constat | Comment il a été vu | Correction |
|---|---|---|
| Le **compteur de l'outil actif** dans le rail (« 24 ») : texte blanc sur du blanc translucide posé sur le bleu de l'outil, **3,3:1** | Échantillonnage du rendu ; **axe-core ne le voit pas** (fond en dégradé et translucide) | Pastille assombrie (fond indigo translucide) : plus de 8:1 |
| Un **filet violet de 1 px** au bord gauche de la carte d'en-tête | Zoom sur les pixels | Les dégradés se répétaient sous la bordure : `background-origin: border-box` (carte d'en-tête, rail, tuiles, bouton plein) |
| L'**arc d'or traversait le texte** de la carte d'en-tête sur les cartes étroites (820 px, fenêtre de 1 000 à 1 300 px) | Capture à 820 px | Illustration poussée vers le bord droit selon la largeur ; largeur du texte bornée |
| Le **sous-titre de la marque** (« Dossiers · Littérature ») : 4,57:1 sur le verre de la barre supérieure, trop près du seuil pour un texte de 10 px | Échantillonnage du rendu | Passé de `--text-muted` à `--text-secondary` |
| Les **tuiles de chiffres** s'empilaient en une colonne sur mobile (cartes hautes, peu de contenu par écran) | Capture à 390 px | Deux par ligne sous 720 px |

**Premier passage du banc de mesure** : la première version du contrôle du texte rendu a signalé 626 lignes sous le seuil, **toutes fausses** : texte recouvert par la barre flottante, texte rogné par un conteneur à défilement, ombre de la barre flottante, capture pleine page qui déplaçait les éléments fixes. Le banc a été corrigé (ne mesurer que le texte lisible tel quel : non recouvert, entier, hors de l'ombre de la barre) avant d'être compté ; seuls les résultats du second passage figurent ci-dessus. Il a cependant, dès ce premier passage, trouvé le défaut réel du compteur.

### 9.3 Ce qui n'a pas été vérifié pour la refonte

- **Chromium uniquement**, comme en 1.1.0 : Firefox, Safari et iOS ne l'ont pas été. L'interface utilise `color-mix()` (Chrome 111, Safari 16.2, Firefox 113) et `backdrop-filter` (avec préfixe pour Safari) : un navigateur plus ancien perd des ombres et le flou, pas le contenu — **non essayé**.
- **Aucun lecteur d'écran**, comme en 1.1.0. Les libellés courts de la barre flottante (mobile) sont masqués aux lecteurs d'écran au profit du libellé complet ; cela repose sur la lecture de l'arbre d'accessibilité par axe-core, pas sur une écoute.
- **Mode « contraste élevé » de Windows** (couleurs forcées) : non essayé ; l'arc d'or et le verre dépoli y disparaîtront, le texte reste du texte.
- **Poppins** est servie en sous-ensemble latin : les caractères d'une autre écriture (grec, cyrillique, arabe) tombent sur la police du système.
- Les captures et les parcours ont été examinés par l'auteur de la refonte, **pas par un utilisateur** : aucun test d'usage.

## 10. Contre-expertises indépendantes

Deux agents de test, chacun sur une **copie figée du projet antérieure aux correctifs**, sans le code des correctifs : l'un sur l'API serveur, l'autre sur l'interface. Leurs rapports bruts sont dans `qa/api-agent-report.md` et `qa/ui-agent-report.md`. **Chaque constat a été rejoué sur la version finale**, soit par un test automatisé, soit par un script de la section précédente.

### 10.1 API serveur : 17 constats

| ID | Constat | Statut | Preuve |
|---|---|---|---|
| P0-1 | `DELETE` d'un dossier laissait ses fichiers sur le disque | Corrigé | `verify-ui` UI-15 ; `pipeline`, `robustness` |
| P0-2 | Un arrêt brutal en pleine passe perdait des valeurs (14 essais sur 25) | Corrigé (une transaction par dossier) | 25 `kill -9` : 0 écart (§ 6.2) ; `api-hardening` |
| P0-3 | Un message d'erreur d'acteur hostile pouvait porter le jeton Apify jusqu'à la base | Corrigé (masquage sous trois formes, borne de taille) | `api-hardening` « le jeton Apify ne sort jamais » |
| P1-1 | Une expression régulière catastrophique figeait tout le serveur (≥ 120 s) | Corrigé (surveillance, disjoncteur) | `safe-regex` (32) |
| P1-2 | Un document de 50 Mo : 23 s de gel, 3,3 Go | Corrigé | § 6.3 |
| P1-3 | PDF aux objets imbriqués : gel de 8 à 141 s, arrêt inopérant | Corrigé (fils séparés, délai ferme) | `extract-isolation` (26) ; corpus (0 anomalie) |
| P1-4 | Une position de variable au-delà de 2^53 cassait la fiche | Corrigé (bornes) | `api-hardening` |
| P1-5 | Deux processus sur un même dossier de données : 55 % d'échecs bruts | Corrigé (verrou) | `api-hardening`, `boot` |
| P1-6 | Envoi et activation déclenchables depuis un site tiers (CSRF) | Corrigé (garde Hôte et Origine) | `api-hardening` |
| P2-1 | JSON de plus de 5 Mo : 500 au lieu de 413 | Corrigé | `verify-ui` UI-37 |
| P2-2 | Date non calendaire : CSV différent de XLSX | Corrigé | `api-verify` ; `api-hardening` |
| P2-3 | Cellule Excel de plus de 32 767 caractères | Corrigé (32 000) — **jamais ouvert dans Excel** | `api-verify` ; `api-hardening` |
| P2-4 | Octet NUL non filtré en RIS / BibTeX | Corrigé | `api-hardening` |
| P3-1 | En-têtes de sécurité absents | Corrigé | `security` |
| P3-2 | Pas de délais HTTP explicites | Corrigé | `http-timeouts` (valeurs appliquées au serveur) ; code |
| P3-3 | Champs JSON inconnus à la racine ignorés sans avertissement (import de fiche) | **Non corrigé — limite documentée** | — |
| P3-4 | Messages internes bruts sur les corps JSON mal formés (16 routes) | Corrigé | `api-hardening` (~3 000 requêtes hostiles) |

Le même agent a vérifié que **tiennent** : injection SQL (~40 variantes), traversée de chemin (envoi, téléchargement, statique), usurpation d'extension ou de type MIME, injection de formule CSV, structure OOXML sous contenu hostile, exports RIS / BibTeX sous contenu hostile, absence de fuite de jeton sur 116 réponses, déduplication sous 12 envois simultanés, reprise après `kill -9` pendant un envoi.

### 10.2 Interface : 40 constats

| Gravité | Nombre | Statut |
|---|---:|---|
| P0 — perte ou corruption silencieuse de donnée, ou action destructrice sans vraie confirmation | 5 | **5 corrigés** : double clic sur « Supprimer » (UI-01), signe moins ignoré (UI-02), négatifs écrits en texte dans le CSV (UI-03), « 36,6 » lu 366 (UI-04), entier 12,5 arrondi à 13 (UI-05) |
| P1 — parcours bloqué ou application plantée | 5 | **5 corrigés** : page blanche sans `localStorage` (UI-06), regex catastrophique (UI-07), `.docx` piégé (UI-08), import de cohorte en un seul dossier (UI-09), modifications perdues sans avertissement (UI-10) |
| P2 — gêne réelle | 12 | **12 corrigés** : relancer l'extraction rétablit une valeur vidée (UI-11), valeurs aberrantes « vérifiées » (UI-12), fichiers inexploitables « importés » (UI-13), import de fiche non atomique (UI-14), fichiers d'un dossier supprimé conservés (UI-15), focus des modales (UI-16), fermeture sans confirmation (UI-17), titre de page unique (UI-18), 320 px et zoom (UI-19), tableau de 2 000 dossiers (UI-20), 202 documents (UI-21), décimales du CSV (UI-22) |
| P3 — finition | 18 | **16 corrigés** (dont les libellés d'UI-26, rejoués par `verify-ui3`) ; **2 limites documentées** : lettre O lue comme un zéro par l'OCR (UI-33, « 7O kg » donne 7) et deux onglets sur le même champ (UI-39, la dernière écriture l'emporte) |

### 10.3 Relectures indépendantes de la documentation

Deux autres agents ont relu la documentation **contre le code** : l'un le README, le guide du chercheur, les méthodes, la revue bibliographique et le journal (43 constats) ; l'autre le guide de l'administrateur, la référence de l'API, l'architecture, la sécurité et le rapport de validation (47 constats). Leurs rapports sont du texte produit par un modèle, **pas une preuve** : chaque constat a été vérifié dans le code (ou par une mesure) avant d'être appliqué. Condensés dans `qa/factcheck/`.

- **Passages faux ou trompeurs corrigés** dans la documentation : garanties trop fortes (« le journal n'est jamais supprimé » — il disparaît avec le dossier, la variable ou la fiche ; « 1 Go suffit » — pic mesuré de 1,03 à 1,07 Go sur deux exécutions ; « une valeur numérique invalide arrête le démarrage » — vrai de trois réglages seulement), libellés d'interface inexacts (boutons d'export, choix d'import de cohorte), chiffres mal rapprochés (cellules de la table de Wilson recalculées avec des effectifs entiers, « 1 à 1,6 s » qui mêlait serveur et navigateur), exemples inventés, fonctions présentées comme nouvelles alors qu'elles existaient en 1.0.0, « Aucune rupture » (l'écoute locale par défaut en est une).
- **Défauts de code corrigés** (confirmés puis réparés, avec test) : les 21 réglages numériques n'étaient pas tous validés ; la base n'était pas ramenée dans son fichier principal à l'arrêt ; la duplication d'une fiche ne validait pas le nom reçu ; le banc d'essai des règles n'appliquait pas l'unité ; les apostrophes typographiques de Word n'étaient pas reconnues par les mots-clés et les expressions régulières ; les avertissements d'import (texte tronqué) n'étaient jamais affichés ; `npm run demo`, `backup` et `restore` n'existaient pas à la racine ; l'assistant de rédaction transmettait des valeurs brutes de variables de texte libre, et l'extraction par Claude le code du dossier et les noms de fichiers.
- **Constaté à la livraison, corrigé** : démarrer (`npm start`) avant d'avoir compilé donnait une trace « Cannot find module … dist/index.js » que rien n'expliquait — le piège le plus probable pour qui n'est pas développeur. `npm start` vérifie maintenant la version de Node et compile à la première utilisation (`start-script`, 7 tests) ; les lanceurs à double-clic font installation, démarrage et ouverture du navigateur.
- **Constat documenté, non corrigé** : `GET /api/analytics/extraction` lit les documents dossier par dossier (une requête SQL par dossier) ; mesuré à 1,4 s pour 5 000 dossiers (§ 7).
- **Non vérifiable ici**, laissé tel quel au § 11 : tarifs et plafonds d'Apify, modèle Claude par défaut, ouverture réelle des classeurs.
- **Appliqué à ce rapport** : mesures de charge antérieures à la dernière compilation (refaites), « 28 réussies » dont quatre renvois (précisé au § 8.3), UI-26 sans rejeu (rejoué), délais HTTP sans test (ajouté), captures comptées à tort (4 écrans : 39 fichiers), citation de la lecture partielle d'un PDF (reprise telle que le serveur l'écrit).

## 11. Limites et ce qui n'a pas été vérifié

**Précision de l'extraction**
- **Aucun corpus clinique réel.** Le banc d'essai (88 cas) est écrit par les auteurs du moteur. La précision sur de vrais comptes rendus — leur diversité de mise en page, d'abréviations, de fautes — est **inconnue** ; elle se mesure par relecture d'un échantillon aléatoire.
- La **confiance** affichée est un indice par type de règle, pas une probabilité calibrée.
- **L'OCR** n'a été éprouvé que sur trois PDF scannés fabriqués. Sur de vraies photos, des lettres se confondent (« 7O kg » donne 7) et une négation peut se perdre.
- Le vocabulaire est **français** ; aucune autre langue n'a été essayée.
- Les années à deux chiffres se lisent avec l'année courante pour pivot : le même document peut se lire autrement dans quelques années.

**Modes qui dépendent d'un service tiers**
- **Mode « Claude »** (extraction et rédaction) : **jamais exécuté contre l'API réelle** (aucune clé). Sont testés : le schéma imposé, la recherche des citations dans les documents, le typage, le tri retenues / écartées, la consigne. Ne sont **pas** testés : les réponses réelles d'un modèle, le coût, la limite de débit, les erreurs réseau réelles.
- **Revue bibliographique** : les adaptateurs lisent de **vraies sorties** enregistrées en octobre 2026, mais tous les appels de la validation sont allés à un faux serveur local. La facturation, les quotas, la disponibilité des acteurs et les changements de leurs champs ne sont pas éprouvés. Google Scholar n'autorise pas l'extraction automatisée.

**Formats de sortie**
- Les classeurs `.xlsx` et les diaporamas `.pptx` n'ont **jamais été ouverts dans Excel, PowerPoint, LibreOffice ou Keynote** ; leur validité est établie par des contrôles structurels (archive, XML, types, dates) et par un validateur indépendant du contre-expert. Le comportement d'Excel face aux cellules très longues, aux dates avant 1900 et aux décimales n'est pas confirmé en conditions réelles.

**Environnements**
- **Linux uniquement** ; Windows et macOS non essayés (chemins, verrou de fichier, signaux, longueurs de chemin, disques réseau).
- **Lanceurs** : `lancer.command` a été exécuté sous Linux depuis une archive neuve (installation des dépendances, compilation, démarrage, page servie) ; `lancer.bat` et le double-clic sous macOS (autorisation du système, ouverture du navigateur) n'ont **jamais été exécutés**.
- **Node** : suite complète sous cinq versions (22.13.0, 22.22.2, 22.23.3, 24.21.0, 26.11.1 : § 3) ; les autres versions intermédiaires (22.14 à 22.21, 23, 25) n'ont reçu que la recherche du défaut du décodeur de texte, pas la suite.
- **Chromium uniquement** pour l'interface ; Firefox, Safari et les navigateurs mobiles réels ne l'ont pas été (l'émulation tactile de Chromium l'a été). Pour la charte de la 1.2.0 (verre dépoli, `color-mix()`, mode « contraste élevé » de Windows, polices non latines) : § 9.3.
- **Aucun lecteur d'écran** (NVDA, JAWS, VoiceOver, TalkBack) : l'accessibilité est établie par axe-core, qui ne détecte qu'une partie des défauts, et par des contrôles de clavier et de structure.

**Charge, durée, concurrence**
- Jusqu'à **5 000 dossiers**, un seul utilisateur ; ni plusieurs utilisateurs simultanés, ni cohortes plus grandes.
- **Aucun essai de longue durée** (jours) : la dérive de mémoire sur le long terme est inconnue ; les fils d'analyse sont remplacés après 200 tâches pour la limiter.
- Deux onglets qui modifient le même dossier : **la dernière écriture l'emporte**, sans avertissement.
- Le réglage `PARSE_WORKER_MB` est ignoré quand Node est lancé avec `--max-old-space-size` ; la surveillance de croissance (`PARSE_MAX_GROWTH_MB`) reste alors la protection.
- **Coupure de courant** : non simulée. Seul l'arrêt brutal du processus (`kill -9`) a été éprouvé, 25 fois (§ 6.2) ; le comportement de SQLite en mode WAL face à une vraie coupure repose sur sa documentation.
- **Grosses lectures** : les lectures analytiques et les exports sont synchrones et bloquent le serveur le temps de leur durée (§ 7). `GET /api/analytics/extraction` interroge la base dossier par dossier.

**Moteur et configuration**
- **Expressions régulières** : un motif jugé sain est évalué une première fois sans chronomètre (seuls les motifs jugés à risque sont surveillés) ; une heuristique peut laisser passer un motif lent.
- **Modèle Claude par défaut** (`LLM_MODEL`, `claude-opus-5`) : jamais interrogé ; l'outil ne vérifie pas que l'identifiant existe avant une passe. À régler selon les modèles de votre compte.
- Les champs inconnus à la racine d'une fiche JSON importée sont ignorés sans avertissement (P3-3, § 10.1).

**Sécurité**
- Aucun test d'intrusion par des humains. Les deux contre-expertises sont celles de testeurs automatisés sur une copie figée. L'outil est conçu pour un poste ou un réseau maîtrisé, pas pour une exposition publique.
- Pas de chiffrement au repos, pas de comptes individuels, pas de HTTPS natif (voir [Sécurité et données](securite-et-donnees.md)).

**Réglementaire, clinique, juridique** : rien n'a été évalué. Voir la liste de contrôle de [Sécurité et données](securite-et-donnees.md#6-avant-de-démarrer-une-étude--liste-de-contrôle).

**La documentation** n'a pas été relue par un chercheur utilisateur : signalez toute étape qui ne se déroule pas comme décrit.

## 12. Rejouer la validation

Depuis la racine du projet :

```bash
npm ci
npm run typecheck
npm run build
npm test                 # 793 tests, un processus par fichier
cd landing && npm ci && node --test e2e/flows.test.mjs    # 25 parcours de la page d'accueil (Playwright requis)
```

Les scripts qui ont produit les mesures ci-dessus (dossier `qa/` cité dans tout le rapport) ont été écrits pour l'environnement de validation : chemins absolus, serveurs d'essai sur des ports fixes, binaires de Node et Chromium installés à part. **Ils ne sont pas publiés dans ce dépôt** ; leur rôle est donné ici pour qui voudrait les reconstituer :

| Script | Produit |
|---|---|
| `qa/run_suite.py <racine> <sortie.json> 2` | Les tests, fichier par fichier, avec résumé |
| `qa/api-verify.mjs` | Arrêts brutaux ×25, document de 50 Mo, dates, texte démesuré |
| `qa/corpus/run.mjs` | Les 97 fichiers hostiles |
| `qa/scale/harness.mts` | 1 000, 2 500, 5 000 dossiers |
| `qa/ui/audit.mjs`, `interact.mjs`, `verify-ui.mjs`, `verify-ui2.mjs`, `verify-ui3.mjs`, `scale-ui.mjs` | Interface : accessibilité, clavier, constats UI-xx, correctifs ultérieurs (`verify-ui3` lance ses propres serveurs d'essai), 2 000 dossiers |
| `qa/node-matrix/run-matrix.sh <versions…>` | La suite sous plusieurs versions de Node (binaires installés à part) |
| `qa/docs-shots.mjs` | Les captures de la documentation |
| `qa/factcheck/` | Les rapports condensés des deux relectures de la documentation (§ 10.3) |

## 13. Page d'accueil et charte d'anonymisation (1.3.0)

### 13.1 Ce qui est testé dans le dépôt

`server/test/landing-logic.test.ts` (83 tests, avec le reste de la suite) : validation des formulaires, traduction des erreurs du service d'authentification (aucun texte technique à l'écran), reprise du parcours, lignes écrites dans la base, adresses de configuration et de retour (pas de redirection ouverte) ; **la charte du site est celle de l'application, mot pour mot**, version comprise ; **les jetons de couleur, les polices et l'illustration sont identiques** ; **les listes d'options du parcours sont les contraintes `check` de la migration** ; la migration elle-même (règles d'accès par ligne ; retrait de tous les droits **avant** de rendre les droits utiles, colonne par colonne ; aucun droit pour un visiteur ; dates et identifiant d'un engagement posés par la base ; journal des engagements en ajout seul ; aucune colonne pouvant recevoir une donnée de patient) ; **le site n'écrit que des colonnes qu'il a le droit d'écrire**, en création comme en mise à jour ; `.env.production` ne contient que l'adresse du projet et une clé `sb_publishable_…`, et les compilations d'essai ne le lisent pas ; **le site se compile seul** (les types qu'utilise sa configuration sont déclarés dans `landing/`, comme l'exige Vercel) ; liens « token_hash » reconnus, nettoyés de l'adresse, et modèles de courriels de la documentation conformes ; messages des liens de réinitialisation ratés ; la réécriture de `vercel.json` laisse `/assets/` répondre 404 ; la politique de sécurité du contenu et les en-têtes de `vercel.json` ; l'absence de script ou de style en ligne, de secret, d'API d'injection de HTML, de lien interne mort, d'apostrophe droite dans les textes. `web-contrast.test.ts` lit désormais les deux feuilles de style.

### 13.2 Parcours de bout en bout

`landing/e2e/flows.test.mjs`, dans Chromium, contre un **faux Supabase** en mémoire (`fake-supabase.mjs`) qui imite le protocole : formats de réponse et codes d'erreur de l'API `2024-01-01`, **PKCE vérifié** (le défi est recalculé à partir du vérificateur), jeton obligatoire sur les tables, règles d'accès par ligne, contraintes **et droits par colonne** lus dans la migration (une colonne non accordée est refusée par `42501`, comme sur le projet réel). Le site est servi avec les en-têtes de `vercel.json` : une ressource interdite par la politique de sécurité ferait échouer le parcours. Deux compilations : **configurée** (23 scénarios : inscription avec confirmation et renvoi du lien ; lien ouvert dans un autre navigateur ; lien de confirmation « token_hash » valable dans un autre navigateur, une seule fois ; réinitialisation demandée sur un ordinateur et lue sur un téléphone — lien par défaut expliqué sur place, lien « token_hash » abouti, lien périmé expliqué ; inscription refusée par le serveur d'envoi par défaut ; `/deconnexion` ouvert depuis ailleurs (confirmation demandée, session intacte) ; fragment illisible et fichier manquant ; parcours complet avec contrôle de chaque écriture ; Google ; Google pas encore activé dans le projet (message sur le site, aucun départ), puis réglages injoignables (la connexion part quand même) ; connexion en échec puis réussie ; adresse non confirmée ; pages protégées et cinq tentatives de redirection ouverte ; retours d'erreur dans la requête et dans le fragment ; mot de passe oublié — même réponse pour toute adresse — et nouveau mot de passe ; reprise ; modification ; pannes 500 et coupure réseau ; déconnexion et changement d'utilisateur ; valeurs refusées par la base ; clavier ; aucun défilement horizontal de 320 à 1 440 px sur six pages) et **aperçu** (2 scénarios : bandeau sur chaque page, **aucune requête hors du site**, rien de conservé après la fermeture de l'onglet). **25 / 25**, deux exécutions consécutives.

### 13.3 Contrôles visuels et d'accessibilité (scripts non publiés)

| Contrôle | Résultat |
|---|---|
| axe-core (WCAG 2.2 AA + bonnes pratiques) : 11 pages ou états de parcours (dont formulaires en erreur, charte cochée, rappel d'autorisation, tout déplié, menu ouvert) en mode aperçu, et 6 états propres au service (inscription envoyée, adresse non confirmée, mot de passe faux, retour refusé, lien de réinitialisation envoyé, nouveau mot de passe) — 5 largeurs (320 à 1 440 px) × 2 thèmes | **248 audits : 0 violation**, 0 débordement horizontal |
| Contraste du texte **rendu** (échantillonnage des pixels sous chaque ligne, dégradés, verre et images compris), 3 largeurs × 2 thèmes, pages publiques et pages connectées (accès, parcours aux étapes 1, 2 et 3) | **5 984 mesures, 0 sous le seuil** ; la plus faible 4,96:1 (le « Pub » de la marque, pastille de navigation sur la carte d'ouverture, 390 px, thème clair) ; partout ailleurs au-dessus de 5,2:1 |
| Parcours au clavier : chaque arrêt de tabulation | **392 arrêts** (4 pages × 2 largeurs × 2 thèmes) : tous portent un anneau de focus visible, aucun élément focalisable n'est invisible. Les seules cibles de moins de 24 px de haut sont 8 liens **insérés dans une phrase** (« Déjà un compte ? Se connecter »…), que le critère 2.5.8 exempte |
| axe-core, états ajoutés après la relecture indépendante : déconnexion à confirmer, lien de réinitialisation inutilisable, « Vérifiez votre boîte » avec son indice, Google non activé, envoi refusé — 3 largeurs × 2 thèmes | **30 audits : 0 violation**, 0 débordement horizontal |
| Débordement horizontal | 0, de 320 à 1 440 px, sur toutes les pages et tous les états audités |

**Défauts trouvés par ces contrôles, et corrigés** (avant publication) :

- **Course entre deux redirections à la déconnexion** (parcours de bout en bout) : se déconnecter depuis une page protégée menait tantôt à l'accueil, tantôt à la connexion, selon la redirection arrivée la dernière. La déconnexion passe désormais par une page à elle (`/deconnexion`) : trajet toujours identique.
- **Pastille de navigation** sur les cartes sombres : en défilant, le bleu de la marque n'y tenait que **3,69:1** (contraste du rendu ; un audit sur les jetons ne peut pas le voir, le fond étant du verre translucide). Verre plus opaque : 4,96:1 au plus bas.
- **Débordement de 24 px** de la page d'accès à 320 px (une grille dont la colonne minimale dépassait la largeur disponible) : toutes les grilles adaptatives bornent désormais leur colonne à la largeur disponible.
- **Bandeau du mode aperçu** hors de toute région de la page ; **tableau défilant** de la page de confidentialité inaccessible au clavier (axe) : corrigés.
- **Champs de saisie sans style** (inscription, parcours) : un champ sans attribut `type` échappait à la feuille de style (captures).
- **Bouton « Copier »** posé sur les longues commandes, **arc d'or** traversant les paragraphes (captures) : corrigés (barre au-dessus du code ; arc estompé du côté du texte).
- **Lien de confirmation ouvert dans un autre navigateur** que celui de l'inscription (relecture du flux PKCE) : l'échange du code ne peut pas aboutir, et l'utilisateur était renvoyé sans un mot vers la connexion. Un message dit désormais quoi faire ; le scénario est dans la suite de bout en bout.
- **Dates d'engagement fournies par le navigateur** (relecture de la migration avant son application) : les droits par défaut de Supabase laissaient un utilisateur écrire `accepted_at`, donc antidater son engagement. Les droits sont désormais accordés colonne par colonne ; refus vérifié sur le projet réel (§ 13.4).
- **« Continuer avec Google » avant l'activation de Google** (sonde du projet réel) : le service répond par une page d'erreur JSON, en anglais, hors du site. Le site vérifie désormais les réglages publics du service avant de partir.

**Défauts trouvés par la relecture indépendante du site, et corrigés** (vérifiés un à un dans le code et dans les sources du client Supabase) :

- **Le déploiement Vercel aurait échoué** : `tsc -b` ne trouvait les types de Node qu'en remontant jusqu'à la racine du dépôt, que Vercel n'installe pas (dossier racine `landing`). Reproduit sur une copie isolée de `landing/`, corrigé (`@types/node` déclaré dans `landing/`), et un test le garde.
- **Lien de réinitialisation ouvert sur un autre appareil, expiré ou déjà utilisé** : on arrivait sur un formulaire vide, sans un mot, et le message apparaissait plus tard sur la connexion, formulé pour une inscription. Il est désormais montré sur la page « mot de passe », formulé pour une réinitialisation. Les modèles de courriels de la documentation passent au format « token_hash » : liens valables sur tout appareil, non consommés par les logiciels de sécurité des messageries.
- **Envoi refusé par le serveur de courriels par défaut** (`email_address_not_authorized`, l'état actuel du projet) et adresse refusée (`email_address_invalid`) : « réessayez dans un instant » s'affichait. Messages dédiés.
- **Déconnexion de tous les appareils**, déclenchable par un simple lien posé ailleurs : limitée à ce navigateur, et confirmée quand on n'arrive pas par un bouton du site.
- **Changement de compte dans un autre onglet pendant le parcours** : les réponses saisies pour le premier compte pouvaient être enregistrées sous le second. La page repart de zéro à chaque changement d'utilisateur.
- Erreur Google affichée derrière une ancienne erreur ; un fragment d'adresse illisible (`/#%`) faisait tomber tout le site ; un échec de chargement du client Supabase n'était jamais retenté ; un fichier manquant sous `/assets/` était servi comme page HTML avec un cache d'un an ; une assertion des tests de bout en bout ne pouvait pas échouer ; les compilations d'essai pouvaient lire un `.env.local` ou hériter de `NODE_ENV`. Tous corrigés.
- Documentation : chemins du tableau de bord (*Advisors*, *Authentication › Emails › Templates*), domaines autorisés et champs de l'écran de consentement de Google, ordre de priorité des variables, causes du bandeau « Mode aperçu ».

### 13.4 Projet Supabase réel (11 octobre 2026)

Projet « PubResearcher », référence `oyzhlclaniaykyixhsjy`, région `eu-west-3`, Postgres 17. Migration appliquée sous la version `20261011011740` (l'outil d'application refuse toute instruction `drop`, même sans effet : la version appliquée est celle du dépôt sans ses lignes `drop … if exists`, identique sur une base neuve).

| Contrôle | Résultat |
|---|---|
| Tables, règles, droits relus dans le catalogue | RLS active sur les deux tables ; 5 règles, toutes `to authenticated` avec `(select auth.uid()) = user_id` ; `authenticated` : `SELECT` sur les deux tables, `INSERT`/`UPDATE` sur les seules colonnes du site ; `anon` : rien |
| Deux comptes simulés (`set role authenticated` + identité du jeton), transaction annulée | **17 / 17 conformes** : création et mise à jour de son profil par l'« upsert » du site, inscription de son engagement — acceptées ; écriture chez l'autre, lecture des lignes de l'autre (1 ligne visible sur 2), antidatage d'un engagement ou d'un profil, modification et effacement d'un engagement, effacement de son profil, transfert de son profil, `truncate`, lecture et écriture sans connexion — refusées (`42501`, ou 0 ligne touchée). Base vide après coup |
| HTTP, clé publique, sans connexion | lecture de `profiles`, écriture dans `consents` : `401` « permission denied » |
| HTTP, connexion à un compte inexistant | `400`, code `invalid_credentials` (traduit par le site : « E-mail ou mot de passe incorrect. ») |
| HTTP, réglages publics | e-mail activé, confirmation obligatoire, Google **non activé** (d'où le correctif ci-dessus) ; CORS : origine du site admise, en-tête `apikey` admis |
| Conseillers Supabase | sécurité : **aucune remarque** ; performance : « index inutilisé » sur `consents_user_kind_idx`, attendu sur une table vide |

**Non éprouvé ici** : un parcours complet dans un navigateur contre le projet réel. Le navigateur de l'environnement de préparation ne pouvait pas établir de connexion HTTPS vers l'extérieur ; la vérification TLS n'a pas été contournée. La première inscription réelle, selon la liste de la [mise en service](page-d-accueil.md#54-contrôle-de-mise-en-service), en tient lieu.

### 13.5 Ce qui n'a pas été vérifié

- **Aucun parcours dans un navigateur contre le projet réel, aucun vrai client Google, aucun vrai envoi de courriel, aucun déploiement Vercel réel** : le projet Supabase réel n'a été éprouvé qu'au niveau de la base et de son API (§ 13.4) ; le faux service imite le protocole de Supabase tel que le client 2.117 l'emploie ; les réglages du tableau de bord (adresses de retour, fournisseurs, courriels, limites de débit) ne sont éprouvés que par la liste de contrôle de mise en service ([Page d'accueil, § 5.4](page-d-accueil.md#54-contrôle-de-mise-en-service)), à faire une fois.
- Chromium seulement ; aucun lecteur d'écran.
- La page d'accueil ne protège pas l'application, et la charte ne vérifie pas l'anonymisation des documents : ce sont des choix, décrits dans [Page d'accueil](page-d-accueil.md), pas des défauts découverts.
