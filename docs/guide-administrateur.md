# Guide de l'administrateur

Installer, configurer, exposer, sauvegarder, mettre à jour et dépanner l'outil. Pour l'usage quotidien, voir le [guide du chercheur](guide-chercheur.md) ; pour le détail des protections, [Sécurité et données](securite-et-donnees.md).

## 1. Prérequis

| | |
|---|---|
| **Node.js** | **Aucun pour la version prête à l'emploi** (§ 2.1), qui fournit le sien. Depuis les sources : **22.13 ou plus récent.** Essayé sous 22.13.0, 22.22.2, 22.23.3, 24.21.0 et 26.11.1 : la suite complète y passe (voir le [rapport de validation](validation.md#versions-de-node)). Le stockage utilise le module SQLite intégré à Node, qui n'existe pas avant 22.5 et ne s'emploie sans option de lancement qu'à partir de 22.13. Sur une version plus ancienne, l'outil s'arrête avec une phrase qui dit quoi installer |
| **Système** | Essayé sous **Linux** seulement. Rien dans le code n'est propre à un système et aucun module n'est à compiler (pas de chaîne C++, pas de Visual Studio), mais macOS et Windows n'ont pas été essayés |
| **Mémoire** | 1 Go suffit pour quelques centaines de dossiers ordinaires. **Prévoyez 2 Go** si des Word ou des PDF très volumineux sont possibles : la lecture d'un Word de 100 000 paragraphes (283 Ko) a porté le serveur à 1,03 Go dans l'essai de fichiers hostiles. Grandes cohortes : § 8 (860 Mo mesurés après 5 000 dossiers) |
| **Disque** | Les fichiers d'origine sont conservés tels quels : prévoyez leur taille, plus ~11 Mo de base par millier de dossiers |
| **Navigateur** | Navigateur récent. Vérifié sous Chromium ; Firefox et Safari n'ont pas été testés |

## 2. Installer et lancer

### 2.1 Version prête à l'emploi (sans Node.js)

Une archive par système, à décompresser puis double-cliquer : **rien à installer, aucune connexion au premier lancement**.

| Système | Archive | Lanceur |
|---|---|---|
| Windows 10/11, 64 bits | `PubResearcher-<version>-win-x64.zip` | `PubResearcher.cmd` |
| macOS 11 ou plus, puce Apple (M1…) | `PubResearcher-<version>-mac-arm64.zip` | `PubResearcher.command` (ou `PubResearcher.app`, après le premier lancement) |
| macOS 11 ou plus, Intel | `PubResearcher-<version>-mac-x64.zip` | idem |
| Linux x86-64 (glibc) | `PubResearcher-<version>-linux-x64.tar.gz` | `./pubresearcher.sh` |

Chaque archive (75 à 82 Mo) contient le dossier `PubResearcher/` : le lanceur, un `LISEZMOI.txt` (démarrage, données, sauvegarde, mise à jour), et `app/` — le Node.js officiel de la même majeure que `engines` (22.23.3, vérifié contre `SHASUMS256.txt` de nodejs.org), le serveur et l'interface compilés, les seules dépendances de production, dont le module natif de rendu des PDF scannés **propre à ce système** (`@napi-rs/canvas-…`) et les données de langue française de l'OCR (`@tesseract.js-data/fra`) : la lecture des scans fonctionne hors ligne. Un fichier `.sha256` accompagne chaque archive.

Le lanceur démarre le Node.js fourni (celui du poste, s'il existe, n'est pas utilisé), ouvre le navigateur dès que l'outil répond, et rouvre seulement le navigateur si l'outil tourne déjà. Fermer la fenêtre arrête l'outil proprement. `PUBRESEARCHER_NO_BROWSER=1` : pas de navigateur (serveur). Toutes les variables du § 4 s'appliquent (`PORT`, `DATA_DIR`, `HOST`…).

**Données : jamais dans le dossier de l'application**, qu'une mise à jour remplace entièrement. Par défaut, le dossier de données de l'utilisateur (§ 3) ; `DATA_DIR` l'emporte toujours. Une base créée depuis les sources (`./data`) se reprend en copiant ce dossier, outil arrêté, à cet emplacement (ou en désignant l'ancien par `DATA_DIR`).

**Paquets non signés.** Les archives ne portent pas (encore) de signature d'éditeur Windows ni de notarisation Apple : le système avertit au premier lancement.

- **Windows** : avant d'extraire, clic droit sur le `.zip` › Propriétés › cocher **Débloquer** › OK, puis « Extraire tout… ». Sans cela, SmartScreen (« Windows a protégé votre ordinateur ») demande **Informations complémentaires › Exécuter quand même**, ou l'avertissement « Éditeur inconnu » demande **Exécuter**. Le `node.exe` fourni est celui de nodejs.org, signé par la fondation OpenJS.
- **macOS 14 et avant** : clic droit (ou Ctrl+clic) sur `PubResearcher.command` › **Ouvrir** › Ouvrir, une seule fois. **macOS 15 et après** : double-clic, refus, puis Réglages Système › Confidentialité et sécurité › **Ouvrir quand même** (mot de passe). Le lanceur lève ensuite la marque de téléchargement (`com.apple.quarantine`) sur tout le dossier, pour que le moteur et ses modules ne soient pas bloqués un à un ; un administrateur peut le faire d'avance : `xattr -dr com.apple.quarantine PubResearcher`. `PubResearcher.app` ouvre `PubResearcher.command` dans le Terminal ; lancée avant toute autorisation, macOS l'exécute depuis une copie isolée (« translocation ») et elle renvoie alors vers `PubResearcher.command`.

**Mise à jour** : outil fermé, sauvegarde (§ 6, ou copie du dossier de données outil arrêté), puis remplacer le dossier `PubResearcher/` par celui de la nouvelle archive (le numéro de version est dans son nom). Les données restent où elles sont et la base est migrée au démarrage (§ 7). Pas de mise à jour automatique. Les scripts `npm run backup`/`restore` ne sont pas dans l'archive : sauvegardez en copiant le dossier de données **outil arrêté** (§ 3).

*Vérifié* sous Linux : archive décompressée dans un dossier neuf, profil utilisateur vide, `PATH` sans Node.js, sans réseau (espace de noms réseau isolé) : démarrage, `/api/health`, import d'un PDF scanné et d'une photo de compte rendu lus par l'OCR, données dans `~/.local/share/pubresearcher`, arrêt ordonné. Les archives Windows et macOS ont été construites et inspectées (binaires de la bonne plateforme) mais **pas encore lancées** sur ces systèmes : le flux GitHub Actions ci-dessous le fait.

### 2.2 Produire les archives

```bash
npm ci                                       # dépendances complètes : la compilation en a besoin
npm run package -- --target linux-x64        # ou win-x64, mac-arm64, mac-x64, all (séparées par des virgules)
node scripts/package/smoke-test.mjs dist-packages/PubResearcher-1.5.0-linux-x64.tar.gz   # essai, sur le système de l'archive
```

Le script (`scripts/package.mjs`) compile, télécharge Node.js (`--node-version`, 22.23.3 par défaut ; gardé dans `.package-cache/`, revérifié à chaque usage), installe les dépendances de production dans une copie de travail avec `npm ci --omit=dev --workspace server --os=… --cpu=…` (npm 10 ou plus : c'est ce qui place le module natif **de la cible** même depuis un autre système), retire ce qui ne sert pas à l'exécution (cartes de sources, déclarations TypeScript, constructions de pdf.js pour navigateur), puis écrit l'archive et son `.sha256` dans `dist-packages/` (`--out-dir`). L'archive est reproductible : fichiers triés, dates fixées à celle du dernier commit (`SOURCE_DATE_EPOCH` sinon), droits fixés (le `.command` reste exécutable). Toutes les cibles se construisent depuis un seul système ; l'essai, lui, demande le système de l'archive.

Le flux `.github/workflows/package.yml` (lancement manuel, ou étiquette `v*`) construit chaque cible **sur son système** (Windows, macOS Apple et Intel, Ubuntu), l'essaie avec `smoke-test.mjs`, et dépose archives et empreintes comme artefacts.

### 2.3 Depuis les sources

```bash
npm ci               # ou « npm install » ; reproduit exactement les versions du verrou (environ 290 Mo)
npm start            # http://localhost:4000 ; compile à la première utilisation (environ une minute)
```

`npm start` vérifie d'abord la version de Node (`scripts/ensure-build.mjs`, lancé par le script `prestart`), puis compile le serveur et l'interface **s'ils ne le sont pas déjà** ; il ne recompile jamais ce qui existe. Après une mise à jour du code, lancez donc `npm run build` vous-même. Pour un poste sans ligne de commande, `lancer.bat` (Windows) et `lancer.command` (macOS, Linux) font l'installation, le démarrage et l'ouverture du navigateur en un double-clic.

Un seul processus sert l'API et l'interface compilée. Au démarrage, l'outil affiche l'adresse, le dossier de données, et signale toute migration de base appliquée. Sous Node 22, il affiche aussi « ExperimentalWarning: SQLite is an experimental feature » : le module SQLite intégré de Node est encore marqué expérimental ; l'avertissement est sans conséquence.

| Commande | Effet |
|---|---|
| `npm run build` | Compile le serveur et l'interface (`npm start` ne le fait que s'ils manquent) |
| `npm run dev` | Mode développement : interface sur 5173 (rechargement à chaud), API sur 4000 |
| `npm run typecheck` | Vérification des types, serveur et interface |
| `npm test` | Tests du serveur (35 fichiers, 690 tests) |
| `npm run demo` | Écrit 24 dossiers factices dans `data/demo/` |
| `npm run demo -- --upload` | Les importe directement par l'API (l'outil doit tourner) ; `API_URL` pour viser un autre hôte |
| `npm run backup [-- <dossier>]` | Sauvegarde (voir § 6) |
| `npm run restore -- <sauvegarde> [--force] [--verify]` | Restauration (voir § 6) |

> `npm run build` se lance **depuis la racine** du projet. La racine contient les deux espaces de travail (`server`, `web`). `demo`, `backup` et `restore` sont des alias de la racine : `npm run backup` équivaut à `npm run backup --workspace server`, forme que les exemples plus bas emploient aussi.

**Arrêt** : `Ctrl+C` (ou `SIGTERM`). L'outil ferme l'écoute, les fils d'analyse et l'OCR. Un arrêt brutal est supporté : voir § 7.

## 3. Où sont les données

Tout est dans **`DATA_DIR`**. Par défaut : `./data` à la racine du projet depuis les sources ; pour la version prête à l'emploi (§ 2.1), le dossier de données de l'utilisateur, hors du dossier de l'application :

| Système | Dossier par défaut (version prête à l'emploi) |
|---|---|
| Windows | `%LOCALAPPDATA%\PubResearcher` |
| macOS | `~/Library/Application Support/PubResearcher` |
| Linux | `$XDG_DATA_HOME/pubresearcher`, sinon `~/.local/share/pubresearcher` |

L'outil affiche le dossier retenu au démarrage (« Données : … »).

```
DATA_DIR/
  research-tool.db            la base SQLite (+ .db-wal et .db-shm tant que l'outil tourne)
  uploads/
    <identifiant du dossier>/
      <uuid>.<extension>      les fichiers d'origine, sous un nom généré
    imports/                  les tableaux de cohorte importés (classeurs, CSV), sous un nom généré
    .incoming/                dépôt provisoire des envois en cours (vidé à chaque démarrage)
  sauvegardes/                destination par défaut de `npm run backup`
  anthropic-key.json          clé d'API Anthropic saisie dans l'application (droits 0600), si elle existe
  .research-tool.lock         verrou : une seule instance par dossier de données
```

`anthropic-key.json` n'est **ni sauvegardé ni restauré** : sur une nouvelle machine, l'utilisateur saisit à nouveau sa clé (§ 4.5).

`uploads/imports/` garde **le fichier entier** de chaque tableau de cohorte importé — toutes ses feuilles et toutes ses colonnes, y compris celles qui n'ont pas été reprises (un nom, une date de naissance s'y trouvent parfois) : c'est la pièce qui justifie chaque valeur importée. Il est compris dans les sauvegardes, et un import confirmé ne se supprime pas par l'interface. Un brouillon d'import abandonné (fenêtre fermée avant de confirmer) est effacé aussitôt, ou au démarrage suivant s'il a plus d'un jour.

Les noms `research-tool.db`, `.research-tool.lock` et `research-tool-sauvegarde-…` sont ceux d'avant le changement de nom en PubResearcher (1.2.0) : ils sont **conservés** pour qu'une base ou une sauvegarde créée par une version antérieure s'ouvre telle quelle.

Le nom d'origine d'un fichier n'existe que dans la base. **Copier `DATA_DIR` à chaud** (fichier par fichier) peut donner une base incohérente : utilisez `npm run backup`. Les fichiers `.db-wal` et `.db-shm` n'existent que pendant que l'outil tourne : un arrêt propre (Ctrl+C, `SIGTERM`) ramène le journal dans `research-tool.db`, qui contient alors toutes les données à lui seul ; après un arrêt brutal, ils restent et la base les relit seule au redémarrage (ne copiez jamais le `.db` sans eux dans ce cas).

## 4. Configuration

Toute la configuration passe par des variables d'environnement, lues au démarrage (sauf mention contraire). Une valeur numérique invalide **arrête le démarrage** : toutes celles qui le sont sont annoncées d'un coup, avec la plage attendue (`PORT=abc`, `PDF_MAX_PAGES=-5`, `LLM_MAX_CHARS_PER_DOC=60 000` — l'espace n'est pas un séparateur), au lieu d'être ignorées. Il en va de même de `LLM_EFFORT`. Les bornes acceptées sont au § 4.8. Les autres variables (`HOST`, `DATA_DIR`, `OCR_LANG`, `NCBI_*`, `APIFY_*`…) ne sont pas contrôlées avant leur emploi.

```bash
# macOS / Linux
PORT=4100 DATA_DIR=/srv/etude-x npm start
# Windows (PowerShell)
$env:PORT=4100; $env:DATA_DIR="D:\etude-x"; npm start
```

### 4.1 Réseau et accès

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `4000` | Port d'écoute (entier 1–65535) |
| `HOST` | `127.0.0.1` | Adresse d'écoute. Défaut : l'outil n'est joignable que depuis le poste. `0.0.0.0` l'ouvre au réseau (voir § 5) |
| `APP_PASSWORD` | — | Mot de passe d'accès (HTTP Basic). Vide : pas de contrôle d'accès |
| `ALLOWED_HOSTS` | — | Noms sous lesquels l'outil accepte d'être appelé, séparés par des virgules (`outil.chu.example`). Avec `HOST=127.0.0.1` (défaut), ils s'ajoutent à `localhost`, `127.0.0.1`, `[::1]`. Avec `HOST=0.0.0.0`, **seuls les noms listés passent** : ajoutez `localhost` si une sonde locale doit passer (sans liste, aucun nom n'est contrôlé) |
| `ALLOWED_ORIGINS` | — | Origines autorisées à écrire, en plus de celle de l'outil (`https://outil.chu.example`). Utile quand un proxy réécrit `Host` |
| `TRUST_PROXY` | — | Nombre de proxys de confiance (`1`) ou liste d'adresses : l'adresse du client se lit alors dans `X-Forwarded-For`, et l'origine d'une écriture est comparée aussi à `X-Forwarded-Host`. Le contrôle des noms d'hôte, lui, lit toujours l'en-tête `Host` : faites-le transmettre (`proxy_set_header Host $host`). **Sans `TRUST_PROXY`, derrière un proxy, tous les visiteurs ont la même adresse** : dix essais ratés verrouillent tout le monde |
| `CORS_ORIGINS` | `http://localhost:5173,http://127.0.0.1:5173` | Origines du front de développement |

### 4.2 Données

| Variable | Défaut | Rôle |
|---|---|---|
| `DATA_DIR` | `./data` (sources) ; dossier de l'utilisateur (version prête à l'emploi, § 3) | Dossier des données (base + fichiers) |
| `DB_PATH` | `$DATA_DIR/research-tool.db` | Emplacement de la base, si distinct |
| `MAX_UPLOAD_BYTES` | 200 Mo | Taille maximale d'un fichier (1 Ko à 100 Go) |
| `MAX_REQUEST_BYTES` | 2 Go | Taille maximale d'un envoi, tous fichiers confondus |

### 4.3 Analyse des fichiers

Chaque plafond est relu **à chaque fichier**, mais l'environnement d'un processus ne change pas en cours de route : **modifiez la variable, puis redémarrez l'outil**. Se heurter à un plafond produit un message qui nomme la variable à relever (la simultanéité, `PARSE_CONCURRENCY`, n'est pas un plafond : les fichiers attendent leur tour).

| Variable | Défaut | Rôle |
|---|---|---|
| `MAX_TEXT_CHARS` | `8000000` | Texte conservé par document (≈ 8 Mo). Au-delà, coupé à une fin de ligne et signalé |
| `PDF_MAX_PAGES` | `1500` | Pages lues par PDF |
| `PDF_PARSE_TIMEOUT_MS` | `120000` | Temps accordé à la lecture d'un PDF avant de rendre ce qui a été lu (≥ 1000) |
| `DOCX_MAX_XML_MB` | `32` | Taille décompressée des parties XML d'un Word |
| `DOCX_MAX_TOTAL_MB` | `512` | Taille décompressée de toute l'archive Word |
| `IMAGE_MAX_MEGAPIXELS` | `100` | Image maximale acceptée par l'OCR |
| `PARSE_CONCURRENCY` | `2` | Fichiers analysés en même temps (et nombre de fils d'analyse) |
| `PARSE_HARD_TIMEOUT_MS` | délai PDF + 60 000 | Délai **ferme** d'une analyse ; au-delà, le fil est arrêté (≥ 1000) |
| `PARSE_WORKER_MB` | `2048` | Mémoire du tas d'un fil d'analyse (≥ 128) |
| `PARSE_MAX_GROWTH_MB` | min(3072, 40 % de la RAM) | Croissance de la mémoire du serveur pendant une analyse au-delà de laquelle l'analyse la plus ancienne est arrêtée (≥ 64) |
| `PARSE_ISOLATION` | actif | `0` : analyse dans le fil principal, **sans protection** (diagnostic uniquement) |
| `REGEX_BUDGET_MS` | `250` | Délai accordé à une expression régulière à risque (≥ 10) |

> **Mémoire et `--max-old-space-size`.** Si Node est lancé avec cette option, elle annule `PARSE_WORKER_MB`. La surveillance de croissance (`PARSE_MAX_GROWTH_MB`) reste alors la protection.

**Tableaux de cohorte** (import Excel, CSV, TSV). Lus dans les mêmes fils isolés que les documents, avec leurs propres plafonds ; le fichier lui-même est borné par `MAX_UPLOAD_BYTES`. Une formule n'est jamais évaluée (sa dernière valeur enregistrée est lue), les macros et liaisons externes sont ignorées ; `.xls`, `.ods` et un classeur chiffré sont refusés avec la marche à suivre (l'enregistrer en `.xlsx` ou en CSV).

| Variable | Défaut | Rôle |
|---|---|---|
| `TABLE_MAX_ROWS` | `50000` | Lignes lues par feuille (un patient par ligne) |
| `TABLE_MAX_COLUMNS` | `2000` | Colonnes lues par feuille |
| `TABLE_MAX_CELLS` | `2000000` | Cellules renseignées dans tout le classeur |
| `TABLE_MAX_XML_MB` | `64` | Taille décompressée d'une partie d'un classeur (une feuille, la table des textes) |
| `TABLE_MAX_TOTAL_MB` | `256` | Taille décompressée de tout le classeur |

Les tailles décompressées annoncées par l'archive sont vérifiées avant de l'ouvrir, et la décompression s'arrête à la taille annoncée (archive qui ment).

### 4.4 Reconnaissance optique (OCR)

| Variable | Défaut | Rôle |
|---|---|---|
| `OCR_ENABLED` | actif | `0` désactive l'OCR (import plus rapide, mais les images et scans ne donnent aucun texte) |
| `OCR_LANG` | `fra` | Langue de reconnaissance. Les données françaises sont installées avec l'outil (hors connexion) |
| `OCR_LANG_PATH` | — | Dossier de données de langue personnel |
| `OCR_MAX_PAGES` | `30` | Pages d'un même PDF passées à l'OCR (`0` : jamais) — une page prend quelques secondes |
| `OCR_PDF_SCALE` | `3` | Facteur de rendu des pages à reconnaître (1–4 ; 3 ≈ 216 points par pouce) |

Autre langue : `npm install @tesseract.js-data/eng --workspace server` puis `OCR_LANG=eng`.

### 4.5 Extraction par Claude et rédaction

**Chaque utilisateur paie l'IA avec sa propre clé d'API Anthropic.** PubResearcher ne facture rien : il n'y a ni abonnement ni crédit à acheter auprès de l'outil, et la consommation est facturée directement sur le compte Anthropic du titulaire de la clé.

**Saisie dans l'application** (cas ordinaire). Page **Activer Claude** de l'application (colonne de gauche), qui guide l'utilisateur pas à pas jusqu'à sa clé, avec le lien direct vers chaque page de la console d'Anthropic (compte, crédit, clés) ; les pages **Extraction** et **Rédaction** y mènent tant qu'aucune clé n'est disponible, avec un raccourci « J'ai déjà une clé ». À l'enregistrement :

1. la clé est d'abord contrôlée sur sa forme (`sk-ant-…` ; une clé d'administration `sk-ant-admin…` est refusée : elle n'interroge pas de modèle) ;
2. puis **vérifiée auprès d'Anthropic** par une seule requête gratuite (la fiche du modèle configuré) : une clé erronée, expirée, désactivée, sans accès au modèle ou un réseau coupé donnent chacun leur message, et **rien n'est enregistré**. Une clé personnelle qui vaut pour **plusieurs espaces de travail** d'Anthropic doit nommer le sien à chaque requête (en-tête `anthropic-workspace-id`) : la vérification liste alors les espaces de l'organisation (deux lectures), essaie l'espace par défaut d'abord, et garde le premier où la clé interroge le modèle ; l'identifiant et le nom de l'espace sont enregistrés avec la clé et accompagnent ensuite chaque requête. Si le rôle de l'utilisateur ne lui permet pas de lister les espaces, la clé est refusée avec la marche à suivre (en créer une liée à un seul espace) ;
3. elle est alors écrite dans `DATA_DIR/anthropic-key.json`, avec les droits `0600` dès la création (écriture atomique), **hors de la base, des sauvegardes et des exports** ;
4. l'interface n'en reçoit plus que la provenance et les **quatre derniers caractères** (`…a1B2`) ; « Retirer » efface le fichier.

La clé sert aussitôt, sans redémarrage. Elle est **commune à l'instance** : sur une instance partagée (§ 5), toute personne qui a le mot de passe lance des passes facturées sur ce compte — une instance par étude, et une limite de dépenses fixée dans la [console d'Anthropic](https://console.anthropic.com/settings/limits).

**Clé d'environnement** (serveur administré). `ANTHROPIC_API_KEY` sert à défaut ; une clé saisie dans l'application l'emporte, et la retirer rend la main à celle de l'environnement. Sur une instance où aucune donnée ne doit sortir, ne renseignez ni l'une ni l'autre.

| Variable | Défaut | Rôle |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Clé de secours, si aucune n'est saisie dans l'application. **Sans clé, seules les règles sont disponibles** et rien ne sort de la machine |
| `ANTHROPIC_WORKSPACE_ID` | — | Identifiant de l'espace de travail (`wrkspc_…`, colonne *ID* de la page *Workspaces* de la console) à nommer avec `ANTHROPIC_API_KEY` quand celle-ci vaut pour plusieurs espaces. Inutile pour une clé saisie dans l'application, qui le trouve seule |
| `LLM_MODEL` | `claude-opus-5-5` | Modèle utilisé (extraction et rédaction). La clé est vérifiée contre lui à la saisie. `claude-sonnet-5-5` coûte deux fois moins ; `claude-haiku-5-5` bien moins encore, au prix de la finesse. Un modèle absent du barème de l'outil fonctionne, mais sans montant en dollars (jetons seuls) |
| `LLM_EFFORT` | `high` | Profondeur de raisonnement (`low`, `medium`, `high`, `xhigh`, `max` ; toute autre valeur arrête le démarrage) ; `medium` ou `low` réduisent le coût sur de grandes séries |
| `LLM_MAX_CHARS_PER_DOC` | `60000` | Texte transmis par document ; au-delà, tronqué et signalé au modèle |
| `LLM_MAX_TOKENS` | `16000` | Plafond de génération de l'extraction |
| `CHAT_MAX_TOKENS` | `8000` | Plafond de génération de la rédaction |
| `LLM_PSEUDONYMIZE` | actif | `0` désactive la pseudonymisation locale du texte avant l'envoi (ci-dessous). À ne faire que si les documents sont déjà pseudonymisés et que le masquage gêne l'extraction |

**Coût.** Avant une passe, l'écran d'extraction affiche une **fourchette en dollars**, calculée sur le texte réel des dossiers (3,2 caractères par jeton, consigne mise en cache), et demande confirmation au-delà de 5 $US ; après la passe, et après chaque réponse de l'assistant de rédaction, le **coût constaté** d'après les jetons facturés, au tarif du modèle **qui a réellement répondu** (le repli côté serveur d'Anthropic peut en désigner un autre que `LLM_MODEL` ; un identifiant daté, `claude-opus-5-5-…`, prend le tarif de son modèle). En mode « Règles puis Claude », la consigne décrit toujours la fiche entière, et la liste des variables restées vides passe dans le message : la consigne reste identique d'un dossier à l'autre, donc en cache. Barème intégré (octobre 2026, dollars par million de jetons, entrée / sortie) : Opus 5.5 4 / 20, Opus 5 5 / 25, Sonnet 5.5 et Sonnet 5 2 / 10, Haiku 5.5 0,10 / 0,50, Fable 5.1 10 / 50. Ces montants sont indicatifs : la facture qui fait foi est celle de la console d'Anthropic.

**Messages d'Anthropic.** Clé refusée ou expirée, crédit épuisé, limite de dépenses atteinte (celle que l'utilisateur fixe, `400`), plafond mensuel du palier du compte (`429` sans réessai possible), espace de travail manquant, limite de débit et modèle introuvable sont traduits en clair, avec ce qu'il faut faire (« Crédit épuisé sur votre compte Anthropic : ajoutez du crédit… ») ; aucun de ces refus n'est réessayé en boucle. La clé n'apparaît dans aucun message, aucune réponse, aucun journal — le journal ne note que ses quatre derniers caractères à l'enregistrement.

> **Ce qui part chez Anthropic**, mode « Claude » : le **texte des documents, pseudonymisé sur le poste** (présentés au modèle sous les noms « Document 1 », « Document 2 »… : ni le code du dossier ni les noms de fichiers ne partent), les libellés, unités, définitions et options des variables, et le nom de la fiche. Avant l'envoi, les noms précédés d'une civilité ou d'un titre (M., Mme, Dr…), les champs « Nom » et « Prénom », dates de naissance, numéros de sécurité sociale, téléphones, adresses électroniques et postales, et identifiants annoncés (IPP, NDA, N° de séjour) sont remplacés par une étiquette (`[NOM]`, `[TÉLÉPHONE]`…) ; les valeurs cliniques ne sont pas touchées. **C'est une pseudonymisation, pas une anonymisation** : un nom sans civilité au milieu d'une phrase part encore. Pour la rédaction : des agrégats seulement (voir [Sécurité et données](securite-et-donnees.md#2-ce-qui-sort-de-la-machine)).
>
> L'API réelle d'Anthropic **n'a pas été appelée** par la validation de cette version (aucune clé ni crédit ; voir le [rapport de validation](validation.md)). Le SDK est exercé contre un faux serveur HTTP — vérification de la clé, requête, réponse structurée, erreurs, masquage de la clé — et ce qui l'entoure (schéma imposé, recherche des citations, typage, tri retenues/écartées, coût) est testé. Essayez d'abord sur quelques dossiers pseudonymisés.

### 4.6 Revue bibliographique

**PubMed fonctionne sans réglage** : il passe par l'API officielle et gratuite du NCBI (E-utilities), au plus 3 requêtes par seconde (10 avec une clé). Le poste doit pouvoir joindre `eutils.ncbi.nlm.nih.gov`.

| Variable | Défaut | Rôle |
|---|---|---|
| `NCBI_API_KEY` | — | Clé d'API du NCBI (gratuite, compte *My NCBI*) : relève le débit de 3 à 10 requêtes par seconde. **Reste côté serveur** |
| `NCBI_EMAIL` | — | Adresse de contact transmise au NCBI avec chaque requête, comme il le demande (avec `tool=PubResearcher`) |
| `NCBI_TIMEOUT_MS` | `60000` | Délai d'un appel au NCBI ; trois nouvelles tentatives espacées (1, 2, 4 s, ou le délai demandé) sur 429, 5xx et coupure |
| `NCBI_EUTILS_BASE` | `https://eutils.ncbi.nlm.nih.gov/entrez/eutils` | Point d'accès — pour des tests ou une passerelle |
| `BIBLIO_PUBMED_MAX` | `10000` | Plafond de notices PubMed récupérées en une passe « toutes les notices » ; au-delà, la passe échoue et le dit (resserrez l'équation) |
| `BIBLIO_IMPORT_MAX_MB` | `50` | Taille maximale d'un fichier de références importé (RIS, nbib, BibTeX, CSV ; 50 000 notices au plus par fichier) |
| `APIFY_TOKEN` | — | Jeton Apify (*Settings › API & Integrations*), pour **Google Scholar** seulement, en option. Sans lui, Scholar est grisé. **Reste côté serveur** |
| `APIFY_SCHOLAR_ACTOR` | `george.the.developer/google-scholar-scraper` | Acteur pour Scholar ; `johnvc/google-scholar-api` est aussi pris en charge |
| `BIBLIO_MAX_RESULTS` | `100` | Plafond de résultats Google Scholar par passe (chaque résultat est facturé par Apify) |
| `APIFY_TIMEOUT_MS` | `290000` | Attente maximale d'une passe Scholar (Apify coupe à 300 s) |
| `APIFY_API_BASE` | `https://api.apify.com` | Point d'accès — pour des tests ou une passerelle |

`APIFY_PUBMED_ACTOR` n'existe plus : l'acteur Apify de PubMed est retiré (la variable est ignorée). Si vous activez Scholar, fixez une **limite d'usage mensuelle** dans votre compte Apify (*Settings › Billing*) : c'est le seul garde-fou que l'application ne peut pas contourner.

### 4.7 Diagnostic

| Variable | Rôle |
|---|---|
| `RT_DEBUG=1` | Ajoute le détail technique d'une erreur interne dans la réponse (`details`). Jamais en fonctionnement normal : c'est ce qui peut contenir un message SQL |

### 4.8 Bornes acceptées

Chaque réglage numérique est vérifié au démarrage contre ces bornes, **entiers décimaux seulement** : `60 000`, `1e3`, `0x20`, `12abc` et `1,5` sont refusés (`OCR_PDF_SCALE` accepte un point décimal). Une variable absente ou vide prend sa valeur par défaut.

| Variable | Minimum | Maximum | Remarque |
|---|---:|---:|---|
| `PORT` | 1 | 65 535 |  |
| `MAX_UPLOAD_BYTES` | 1 024 | 107 374 182 400 (100 Go) |  |
| `MAX_REQUEST_BYTES` | 1 024 | 1 099 511 627 776 (1 To) |  |
| `MAX_TEXT_CHARS` | 1 | 500 000 000 |  |
| `PDF_MAX_PAGES` | 1 | 1 000 000 |  |
| `PDF_PARSE_TIMEOUT_MS` | 1 000 | 86 400 000 (24 h) |  |
| `DOCX_MAX_XML_MB` | 1 | 100 000 |  |
| `DOCX_MAX_TOTAL_MB` | 1 | 1 000 000 |  |
| `IMAGE_MAX_MEGAPIXELS` | 1 | 10 000 |  |
| `PARSE_CONCURRENCY` | 1 | 64 |  |
| `PARSE_HARD_TIMEOUT_MS` | 1 000 | 86 400 000 (24 h) |  |
| `PARSE_WORKER_MB` | 128 | 1 048 576 |  |
| `PARSE_MAX_GROWTH_MB` | 64 | 1 048 576 |  |
| `REGEX_BUDGET_MS` | 10 | 60 000 |  |
| `OCR_MAX_PAGES` | 0 (jamais d'OCR) | 100 000 |  |
| `OCR_PDF_SCALE` | 1 | 4 | décimale admise (`2.5`) |
| `TABLE_MAX_ROWS` | 1 | 10 000 000 |  |
| `TABLE_MAX_COLUMNS` | 1 | 16 384 | le maximum d'Excel |
| `TABLE_MAX_CELLS` | 1 | 1 000 000 000 |  |
| `TABLE_MAX_XML_MB` | 1 | 100 000 |  |
| `TABLE_MAX_TOTAL_MB` | 1 | 1 000 000 |  |
| `LLM_MAX_CHARS_PER_DOC` | 1 000 | 10 000 000 |  |
| `LLM_MAX_TOKENS` | 256 | 1 000 000 |  |
| `CHAT_MAX_TOKENS` | 256 | 1 000 000 |  |
| `BIBLIO_PUBMED_MAX` | 1 | 200 000 |  |
| `BIBLIO_IMPORT_MAX_MB` | 1 | 500 |  |
| `NCBI_TIMEOUT_MS` | 1 000 | 600 000 (10 min) |  |
| `BIBLIO_MAX_RESULTS` | 1 | 10 000 |  |
| `APIFY_TIMEOUT_MS` | 1 000 | 3 600 000 (1 h) |  |

## 5. Exposer l'outil sur un réseau

Par défaut, **non** : l'outil n'écoute que sur le poste. Pour le partager avec l'équipe d'une étude :

1. **Un mot de passe** : `APP_PASSWORD='…'` (long, unique). Navigateur : une fenêtre de saisie ; le nom d'utilisateur est ignoré. Dix essais ratés en cinq minutes ferment l'accès cinq minutes.
2. **HTTPS devant**, sans exception : sans TLS, le mot de passe et les données circulent en clair. Terminez le TLS dans un proxy inverse (nginx, Caddy, Traefik, un équilibreur de l'établissement).
3. **L'écoute**, selon le montage. *Proxy sur la même machine* (recommandé) : **gardez `HOST=127.0.0.1`**, le proxy s'y connecte et rien d'autre ne peut joindre l'outil. *Accès direct depuis le réseau, sans proxy* (déconseillé : pas de TLS) : `HOST=0.0.0.0`, ou l'adresse de l'interface voulue.
4. **Les noms** : `ALLOWED_HOSTS=outil.chu.example`, et `TRUST_PROXY=1` si un proxy est devant.
5. **Les délais du proxy** : une extraction et une recherche bibliographique sont des requêtes **longues**. Relevez le délai de lecture au-delà de 5 minutes ; pour la rédaction assistée (flux d'événements), désactivez le tamponnage.

Exemple nginx :

```nginx
server {
  listen 443 ssl;
  server_name outil.chu.example;
  # ssl_certificate / ssl_certificate_key …

  client_max_body_size 2g;          # = MAX_REQUEST_BYTES
  proxy_read_timeout   1800s;       # extraction sur une grande cohorte, envois lents
  proxy_send_timeout   1800s;
  proxy_request_buffering off;      # les envois de fichiers vont directement au serveur

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;            # la rédaction assistée diffuse sa réponse au fil de l'eau
  }
}
```

```bash
HOST=127.0.0.1 PORT=4000 APP_PASSWORD='…' ALLOWED_HOSTS=outil.chu.example TRUST_PROXY=1 npm start
```

Si l'outil écoute sur le réseau **sans** mot de passe, il l'écrit en toutes lettres dans la console au démarrage. **Ne l'ignorez pas.**

## 6. Sauvegarde et restauration

```bash
npm run backup --workspace server                       # écrit dans DATA_DIR/sauvegardes
npm run backup --workspace server -- /mnt/disque-ext    # ailleurs (recommandé)
```

Une sauvegarde est un dossier autonome, daté :

```
research-tool-sauvegarde-20261009-031500/
  research-tool.db      copie cohérente de la base (VACUUM INTO)
  uploads/              les fichiers des dossiers, tels quels
  MANIFEST.json         version, effectifs, taille et empreinte SHA-256 de chaque fichier
```

- **L'outil peut rester en marche** : la base est copiée par un instantané cohérent.
- Le script **relit** la sauvegarde qu'il vient d'écrire et vérifie les empreintes ; il échoue sinon.
- **Elle contient des données de patients**, en clair : rangez-la, chiffrez-la et détruisez-la comme les dossiers eux-mêmes.

```bash
npm run restore --workspace server -- <sauvegarde> --verify   # contrôle seulement, ne restaure rien
npm run restore --workspace server -- <sauvegarde> --force    # remplace les données actuelles
```

La restauration, **outil arrêté** : vérifie d'abord les empreintes (une sauvegarde abîmée est refusée *avant* de remplacer quoi que ce soit), refuse d'écraser des données existantes sans `--force`, et **met les données actuelles de côté** (le script affiche où). Essayez une restauration une fois, sur une machine d'essai, avant d'en avoir besoin.

Planification (exemple cron, tous les soirs à 2 h 30) :

```cron
30 2 * * *  cd /opt/pubresearcher && npm run backup --workspace server -- /mnt/sauvegardes >> /var/log/rt-backup.log 2>&1
```

## 7. Exploitation courante

**Supervision.** `GET /api/health` répond `200 {"status":"ok","version","schemaVersion","uptimeSeconds"}` et interroge réellement la base (`503` si elle ne répond pas). Il reste accessible sans mot de passe pour une sonde. Aucune donnée de patient dans la réponse.

**Journal.** L'outil écrit sur la sortie standard et d'erreur ; un superviseur (systemd, pm2, Docker) le capte. Une erreur interne affiche une **référence** (`erreur non gérée a3f9c2d1`) que la réponse HTTP reprend : c'est la clé pour retrouver la pile. Le journal peut contenir des noms de fichiers : protégez-le comme les données.

**Redémarrage après un arrêt brutal.** Rien à faire : la base (WAL) est cohérente, chaque dossier d'une passe d'extraction s'écrit en une transaction, une passe restée « en cours » est marquée en échec (`failed` dans l'API, « interrompue » dans le rapport « Méthodes »), une recherche bibliographique interrompue aussi, le dépôt provisoire est vidé, un verrou laissé par un processus disparu est repris. *Vérifié* : 25 arrêts brutaux (`kill -9`) à des instants aléatoires pendant une passe sur 40 dossiers n'ont perdu aucune valeur.

**Un superviseur.** Exemple systemd :

```ini
[Unit]
Description=PubResearcher
After=network.target

[Service]
User=research
WorkingDirectory=/opt/pubresearcher
Environment=DATA_DIR=/srv/etude-x HOST=127.0.0.1 PORT=4000 TRUST_PROXY=1
EnvironmentFile=/etc/pubresearcher.env      # APP_PASSWORD, ALLOWED_HOSTS… ; droits 600
ExecStart=/usr/bin/node server/dist/index.js
Restart=on-failure
# Un arrêt (SIGTERM) est propre ; un arrêt brutal est supporté.

[Install]
WantedBy=multi-user.target
```

**Mise à jour.**

1. Sauvegardez (`npm run backup`).
2. Arrêtez l'outil, récupérez la nouvelle version, `npm ci`, `npm run build`.
3. Relancez : les migrations de base s'appliquent seules, chacune dans sa transaction, et sont annoncées (« Base mise à jour : version 0 -> 1 »). **Une migration ne retire et ne renomme jamais rien** : la structure existante est conservée (la 1.0.0, qui ignore les numéros de schéma, relit une base migrée par la 1.1.0). Mais à partir de la 1.1.0, une version **plus ancienne** que la base la refuse (point 4).
4. Une base **plus récente** que l'outil est refusée avec un message (« mettez l'outil à jour avant de l'ouvrir ») : revenir en arrière demande la sauvegarde d'avant.

**Plusieurs études.** Une instance par étude, chacune avec son `DATA_DIR`, son `PORT` et son mot de passe. Deux instances sur les mêmes données sont refusées par le verrou.

## 8. Dimensionnement

Mesuré sur la version 1.1.0, un seul processus, OCR désactivé, données jetables (voir [validation](validation.md#7-montée-en-charge)) :

| Dossiers | Import (petits dossiers, 1,3 document chacun) | Extraction (22 variables) | Lecture du jeu de données | Export Excel | Base | Mémoire (fin) |
|---:|---:|---:|---:|---:|---:|---:|
| 1 000 | 9,7 s (103/s) | 4,5 s | 0,12 s | 0,22 s | 10,6 Mo | 347 Mo |
| 2 500 | 12,2 s (123/s) | 8,1 s | 0,34 s | 0,59 s | 26,4 Mo | 659 Mo |
| 5 000 | 17,9 s (140/s) | 15,2 s | 0,75 s | 1,26 s | 52,8 Mo | 860 Mo |

- Le serveur reste réactif pendant l'import et l'extraction (latence maximale de `/api/health` mesurée : 26 ms à l'import et 267 ms à l'extraction sur 5 000 dossiers). Les lectures analytiques et les exports sont **synchrones** : sur 5 000 dossiers, ils bloquent la boucle d'événements de 0,3 s (qualité, méthodes) à 1,4 s (rendement de l'extraction), 1,3 s pour l'export Excel. Pour une cohorte de cette taille, évitez de lancer un export pendant qu'un collègue relit.
- Ces dossiers de mesure sont **petits** (un compte rendu texte, un PDF sur 5, un Word sur 10) : le temps d'analyse d'un fichier dépend de sa nature : un compte rendu texte, quelques millisecondes ; un PDF, la lecture de ses pages ; **un scan, plusieurs secondes par page** (OCR).
- Le plafond pratique est la **mémoire** : prévoyez 1 Go de plus que ce que vous attendez, et de la marge pour les fichiers lourds : la lecture d'un Word de 100 000 paragraphes (283 Ko) a porté le serveur à **1,03 Go** dans l'essai de fichiers hostiles ([validation § 6.1](validation.md#61-corpus-de-fichiers-hostiles--97-fichiers-361-mo)) ; le pic retombe quand le fil d'analyse est remplacé (après 200 fichiers, ou quand un fichier est arrêté au délai ferme). Au-delà de 5 000 dossiers, la lecture du jeu de données (JSON de ~7,5 Mo à 5 000) pèse aussi sur le navigateur.
- Un document texte de 50 Mo est importé (texte plafonné à 8 millions de caractères, signalé) et extrait en environ une seconde, sans geler le serveur (latence maximale de la sonde de santé 0,4 s, mémoire de pointe 346 Mo).

## 9. Dépannage

| Symptôme | Cause et remède |
|---|---|
| « Cette application demande Node.js 22.13 ou plus récent » ; « Node.js n'est pas installé » (lanceurs) | Installez la version LTS actuelle de Node.js ([nodejs.org](https://nodejs.org)), ouvrez un **nouveau** terminal |
| « Cannot find module … `server/dist/index.js` » | Archive antérieure au script `prestart` : l'application n'a pas été compilée. `npm run build`, puis `npm start` |
| La page ne s'ouvre pas (« connexion refusée ») | L'outil tourne sur une autre machine que celle du navigateur, ou le lanceur est fermé. Il n'écoute que sur le poste (`HOST=127.0.0.1`) : § 5 pour l'ouvrir au réseau |
| « Le port 4000 est déjà occupé » | Une autre instance tourne (fermez-la avec Ctrl+C) ou un autre programme utilise ce port. Pour deux instances **séparées** : `PORT=4100 DATA_DIR=./data-2 npm start` |
| « Ces données sont déjà utilisées par une autre instance » | Le verrou `.research-tool.lock` est tenu par un processus vivant. S'il n'y en a aucun, supprimez ce fichier |
| « Le dossier de données est inutilisable » | `DATA_DIR` pointe vers un fichier, un disque en lecture seule ou un dossier sans droit d'écriture. Le message en donne la cause |
| « La base de données n'a pas pu être ouverte » | Fichier corrompu ou mauvais chemin ; restaurez une sauvegarde (`npm run restore`) |
| « Base de données refusée … plus récente que cette version » | Elle a été ouverte par une version plus récente ; mettez l'outil à jour |
| « Configuration invalide : … n'est pas valide » | Une ou plusieurs variables numériques sont hors bornes (ou `LLM_EFFORT` est inconnu) ; le message les cite toutes avec la plage attendue (§ 4.8) |
| `403 Nom d'hôte non autorisé` | On accède à l'outil sous un nom non déclaré : ajoutez-le à `ALLOWED_HOSTS` |
| `403 Requête refusée : elle provient d’un autre site que l’outil.` | Un proxy réécrit `Host` : définissez `ALLOWED_ORIGINS` et `TRUST_PROXY` |
| `401` en boucle | Mot de passe faux (le nom d'utilisateur est ignoré). `429` : dix essais ratés, attendez cinq minutes |
| Tout le monde est verrouillé en même temps | Derrière un proxy sans `TRUST_PROXY` : toutes les requêtes semblent venir de la même adresse |
| Un envoi coupe à 5 minutes (502/504) | Délai de lecture du proxy trop court (voir § 5) |
| Images et scans sans texte | `OCR_ENABLED=0`, ou la langue de reconnaissance n'est pas installée ; l'écran « Dossiers patients » le signale. Après correction, **Ré-analyser** le document |
| « Texte tronqué » / « Lecture partielle » | Un plafond est atteint. Le chercheur le voit à l'import (bandeau « Importés, mais lus en partie ») et sur le document (« Lecture incomplète »). Relevez `MAX_TEXT_CHARS`, `PDF_MAX_PAGES` ou `PDF_PARSE_TIMEOUT_MS` si le document est légitime, **redémarrez**, puis **Ré-analyser** |
| « L'analyse de ce fichier a dépassé … (PARSE_HARD_TIMEOUT_MS) », « … a épuisé la mémoire qui lui est accordée … (PARSE_WORKER_MB) », « … a fait grossir la mémoire du serveur … (PARSE_MAX_GROWTH_MB) », « … a échoué de façon inattendue … » | Fichier piégé ou très lourd : le document est enregistré en erreur avec ce motif, les autres sont intacts. Si le fichier est légitime, relevez la variable nommée, redémarrez, puis **Ré-analyser** |
| Une extraction semble figer | Elle est synchrone : sur une grande cohorte elle dure des minutes ; l'outil répond aux autres requêtes pendant ce temps. Vérifiez `GET /api/records/runs` |
| `500 … (référence a3f9c2d1)` | Cherchez cette référence dans le journal du serveur ; `RT_DEBUG=1` ajoute le détail à la réponse |
