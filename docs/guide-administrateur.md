# Guide de l'administrateur

Installer, configurer, exposer, sauvegarder, mettre à jour et dépanner l'outil. Pour l'usage quotidien, voir le [guide du chercheur](guide-chercheur.md) ; pour le détail des protections, [Sécurité et données](securite-et-donnees.md).

## 1. Prérequis

| | |
|---|---|
| **Node.js** | **22.13 ou plus récent.** Essayé sous 22.13.0, 22.22.2, 22.23.3, 24.21.0 et 26.11.1 : la suite complète y passe (voir le [rapport de validation](validation.md#versions-de-node)). Le stockage utilise le module SQLite intégré à Node, qui n'existe pas avant 22.5 et ne s'emploie sans option de lancement qu'à partir de 22.13. Sur une version plus ancienne, l'outil s'arrête avec une phrase qui dit quoi installer |
| **Système** | Essayé sous **Linux** seulement. Rien dans le code n'est propre à un système et aucun module n'est à compiler (pas de chaîne C++, pas de Visual Studio), mais macOS et Windows n'ont pas été essayés |
| **Mémoire** | 1 Go suffit pour quelques centaines de dossiers ordinaires. **Prévoyez 2 Go** si des Word ou des PDF très volumineux sont possibles : la lecture d'un Word de 100 000 paragraphes (283 Ko) a porté le serveur à 1,03 Go dans l'essai de fichiers hostiles. Grandes cohortes : § 8 (860 Mo mesurés après 5 000 dossiers) |
| **Disque** | Les fichiers d'origine sont conservés tels quels : prévoyez leur taille, plus ~11 Mo de base par millier de dossiers |
| **Navigateur** | Navigateur récent. Vérifié sous Chromium ; Firefox et Safari n'ont pas été testés |

## 2. Installer et lancer

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

Tout est dans **`DATA_DIR`** (par défaut `./data` à la racine du projet).

```
DATA_DIR/
  research-tool.db            la base SQLite (+ .db-wal et .db-shm tant que l'outil tourne)
  uploads/
    <identifiant du dossier>/
      <uuid>.<extension>      les fichiers d'origine, sous un nom généré
    .incoming/                dépôt provisoire des envois en cours (vidé à chaque démarrage)
  sauvegardes/                destination par défaut de `npm run backup`
  .research-tool.lock         verrou : une seule instance par dossier de données
```

Les noms `research-tool.db`, `.research-tool.lock` et `research-tool-sauvegarde-…` sont ceux d'avant le changement de nom en PubResearcher (1.2.0) : ils sont **conservés** pour qu'une base ou une sauvegarde créée par une version antérieure s'ouvre telle quelle.

Le nom d'origine d'un fichier n'existe que dans la base. **Copier `DATA_DIR` à chaud** (fichier par fichier) peut donner une base incohérente : utilisez `npm run backup`. Les fichiers `.db-wal` et `.db-shm` n'existent que pendant que l'outil tourne : un arrêt propre (Ctrl+C, `SIGTERM`) ramène le journal dans `research-tool.db`, qui contient alors toutes les données à lui seul ; après un arrêt brutal, ils restent et la base les relit seule au redémarrage (ne copiez jamais le `.db` sans eux dans ce cas).

## 4. Configuration

Toute la configuration passe par des variables d'environnement, lues au démarrage (sauf mention contraire). Une valeur numérique invalide **arrête le démarrage** : toutes celles qui le sont sont annoncées d'un coup, avec la plage attendue (`PORT=abc`, `PDF_MAX_PAGES=-5`, `LLM_MAX_CHARS_PER_DOC=60 000` — l'espace n'est pas un séparateur), au lieu d'être ignorées. Il en va de même de `LLM_EFFORT`. Les bornes acceptées sont au § 4.8. Les autres variables (`HOST`, `DATA_DIR`, `OCR_LANG`, `APIFY_*`…) ne sont pas contrôlées avant leur emploi.

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
| `DATA_DIR` | `./data` | Dossier des données (base + fichiers) |
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

| Variable | Défaut | Rôle |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Clé API. **Sans elle, seules les règles sont disponibles** et rien ne sort de la machine |
| `LLM_MODEL` | `claude-opus-5` | Modèle utilisé (extraction et rédaction). **À vérifier contre les modèles de votre compte** : l'identifiant par défaut n'a pas été éprouvé, et l'outil ne teste pas l'existence du modèle avant le premier appel. La famille Claude 5 compte des identifiants plus récents (par exemple `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`) ; un modèle plus petit réduit le coût |
| `LLM_EFFORT` | `high` | Profondeur de raisonnement (`low`, `medium`, `high`, `xhigh`, `max` ; toute autre valeur arrête le démarrage) ; `medium` ou `low` réduisent le coût sur de grandes séries |
| `LLM_MAX_CHARS_PER_DOC` | `60000` | Texte transmis par document ; au-delà, tronqué et signalé au modèle |
| `LLM_MAX_TOKENS` | `16000` | Plafond de génération de l'extraction |
| `CHAT_MAX_TOKENS` | `8000` | Plafond de génération de la rédaction |

> **Ce qui part chez Anthropic**, mode « Claude » : le **texte des documents** (présentés au modèle sous les noms « Document 1 », « Document 2 »… : ni le code du dossier ni les noms de fichiers ne partent), les libellés, unités, définitions et options des variables, et le nom de la fiche. **Le texte d'un compte rendu contient souvent le nom du patient** : l'outil ne le retire pas. Pour la rédaction : des agrégats seulement (voir [Sécurité et données](securite-et-donnees.md#2-ce-qui-sort-de-la-machine)).
>
> L'API réelle d'Anthropic **n'a pas été appelée** par la validation de cette version (aucune clé ni crédit ; voir le [rapport de validation](validation.md)). Le SDK est exercé contre un faux serveur HTTP — requête, réponse structurée, erreurs, masquage de la clé — et ce qui l'entoure (schéma imposé, recherche des citations, typage, tri retenues/écartées) est testé. Essayez d'abord sur quelques dossiers pseudonymisés.

### 4.6 Revue bibliographique

| Variable | Défaut | Rôle |
|---|---|---|
| `APIFY_TOKEN` | — | Jeton Apify (*Settings › API & Integrations*). Sans lui, aucune recherche ne part. **Reste côté serveur** |
| `APIFY_PUBMED_ACTOR` | `labrat011/pubmed-scraper` | Acteur interrogé pour PubMed |
| `APIFY_SCHOLAR_ACTOR` | `george.the.developer/google-scholar-scraper` | Acteur pour Scholar ; `johnvc/google-scholar-api` est aussi pris en charge |
| `BIBLIO_MAX_RESULTS` | `100` | Plafond de résultats par source et par passe (chaque résultat est facturé) |
| `APIFY_TIMEOUT_MS` | `290000` | Attente maximale d'une passe (Apify coupe à 300 s) |
| `APIFY_API_BASE` | `https://api.apify.com` | Point d'accès — pour des tests ou une passerelle |

Fixez aussi une **limite d'usage mensuelle** dans votre compte Apify (*Settings › Billing*) : c'est le seul garde-fou que l'application ne peut pas contourner.

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
| `LLM_MAX_CHARS_PER_DOC` | 1 000 | 10 000 000 |  |
| `LLM_MAX_TOKENS` | 256 | 1 000 000 |  |
| `CHAT_MAX_TOKENS` | 256 | 1 000 000 |  |
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
