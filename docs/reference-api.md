# Référence de l'API HTTP

L'interface web n'est qu'un client de cette API : tout ce qu'elle fait se fait aussi par script (R, Python, `curl`). Les réponses d'exemple ont été relevées sur un serveur réel (octobre 2026) ; elles sont abrégées (`…`) quand elles sont longues.

- **Base** : `http://localhost:4000/api` (ou l'hôte et le port de votre installation).
- **Format** : JSON en UTF-8, sauf l'envoi de fichiers (`multipart/form-data`) et les exports.
- **Version** : `GET /api/health` donne la version de l'outil et celle du schéma de la base.

## Sommaire

[Conventions](#conventions) · [Accès et garde-fous](#accès-et-garde-fous) · [Santé](#santé) · [Dossiers patients](#dossiers-patients) · [Documents](#documents) · [Fiches d'exploitation](#fiches-dexploitation) · [Fiches remplies et extraction](#fiches-remplies-et-extraction) · [Analyses](#analyses) · [Exports](#exports) · [Revue bibliographique](#revue-bibliographique) · [Clé d'API Anthropic et coût](#clé-dapi-anthropic-et-coût) · [Rédaction assistée](#rédaction-assistée) · [Recettes](#recettes)

---

## Conventions

**Identifiants.** Entiers strictement positifs, écrits en chiffres décimaux sans zéro initial (`/patients/7`). `0x10`, `1e3`, `007`, `5.0` sont refusés (400) : un même dossier n'a qu'une adresse.

**Dates.** Horodatages ISO 8601 en UTC (`2026-10-09T02:27:34.019Z`) ; dates de données au format `AAAA-MM-JJ`.

**Valeurs de variables** (`FieldValue`) : une chaîne, un nombre, un booléen, un tableau de chaînes (choix multiple) ou `null`.

**Erreurs.** Toujours du JSON, toujours un message en français qui dit quoi corriger :

```json
{ "error": "Paramètre « id » invalide : abc" }
```

| Statut | Quand | Forme |
|---|---|---|
| 400 | Requête mal formée ou valeur invalide | `{ "error": "Données invalides.", "details": [{ "path": "code", "message": "Le code du dossier ne peut pas être vide." }] }` pour un corps JSON qui ne passe pas la validation ; `{ "error": "…" }` sinon |
| 401 | Mot de passe requis ou faux | `WWW-Authenticate: Basic realm="PubResearcher", charset="UTF-8"` |
| 403 | Nom d'hôte non déclaré, ou requête d'écriture venue d'un autre site | `{ "error": "Nom d'hôte non autorisé (…). Pour y accéder sous ce nom, ajoutez-le à ALLOWED_HOSTS." }` |
| 404 | Ressource ou route inconnue | `{ "error": "Dossier patient introuvable." }` ; `{ "error": "Route inconnue." }` |
| 409 | Conflit (code déjà pris, recherche déjà en cours, jeton absent) | `{ "error": "…" }` |
| 413 | Fichier, envoi ou corps JSON trop volumineux | message avec la limite ; pour un fichier ou un envoi, il nomme `MAX_UPLOAD_BYTES` ou `MAX_REQUEST_BYTES` ; le corps JSON a une limite fixe de 5 Mo |
| 415 | Encodage non pris en charge : `charset` autre que UTF-8, ou `Content-Encoding` (compression) | `{ "error": "Type de contenu non pris en charge : attendu application/json en UTF-8, sans compression." }`. Un corps qui n'est pas du JSON (`text/plain`) n'est pas lu : la validation répond `400` |
| 422 | Valeur hors des bornes de plausibilité (voir `PUT …/values`) | `{ "error": "…", "code": "out_of_bounds", "details": [ … ] }` |
| 429 | Trop d'essais de mot de passe ; ou Anthropic limite le débit pendant la vérification d'une clé (`PUT /api/llm/key`) | `Retry-After` en secondes (mot de passe) ; `{ "error": "…", "code": "api-key-refused" }` (clé) |
| 500 | Erreur interne | `{ "error": "Erreur interne du serveur (référence a3f9c2d1). Le journal du serveur en donne le détail." }` — jamais de message SQL ni de chemin disque ; la référence retrouve la pile dans le journal du serveur |
| 502 | `PUT /api/llm/key` : Anthropic injoignable, la clé n'a pas pu être vérifiée | `{ "error": "…", "code": "api-key-refused" }` |
| 503 | `GET /api/health` : base inaccessible | `{ "status": "degraded", … }` |

**Mise en cache.** Les réponses `/api/*` portent `Cache-Control: no-store` : des données de patients ne séjournent ni dans le cache du navigateur ni dans celui d'un intermédiaire. Seule exception, le flux de la rédaction assistée, qui impose `no-cache, no-transform` pour qu'aucun intermédiaire ne le tamponne.

**Taille des corps JSON** : 5 Mo au plus (413 au-delà). Les fichiers passent par l'envoi multipart, pas par JSON.

---

## Accès et garde-fous

Appliqués à toute requête, dans cet ordre :

1. **Nom d'hôte.** Quand l'outil n'écoute que sur le poste (`HOST=127.0.0.1`, défaut), seuls `localhost`, `127.0.0.1` et `[::1]` sont acceptés dans l'en-tête `Host`, plus ceux de `ALLOWED_HOSTS`. Cela interdit à un site tiers de faire pointer son propre nom vers `127.0.0.1` pour lire l'API depuis le navigateur du chercheur (« DNS rebinding »). Sur le réseau (`HOST=0.0.0.0`), le contrôle ne s'applique que si `ALLOWED_HOSTS` est défini.
2. **Origine des écritures.** Toute requête qui modifie quelque chose (`POST`, `PUT`, `PATCH`, `DELETE`) et dont l'en-tête `Origin` désigne un autre site que l'outil est refusée (403) ; de même `Origin: null` (document sandboxé, fichier local). Les requêtes **sans** `Origin` (scripts, `curl`, R, Python) passent : ce ne sont pas des navigateurs. Origines supplémentaires : `ALLOWED_ORIGINS`, `CORS_ORIGINS` (développement).
3. **Mot de passe** (si `APP_PASSWORD` est défini). HTTP Basic : le nom d'utilisateur est ignoré, seul le mot de passe compte. Dix essais ratés en cinq minutes depuis une même adresse ferment l'accès pendant cinq minutes (429). `GET /api/health` reste ouvert pour la supervision.

```bash
curl -u "x:$APP_PASSWORD" http://localhost:4000/api/patients
```

Sans HTTPS, le mot de passe circule en clair : placez l'outil derrière un proxy TLS dès qu'il quitte le poste (voir le [guide de l'administrateur](guide-administrateur.md#5-exposer-loutil-sur-un-réseau)).

---

## Santé

### `GET /api/health`

Interroge réellement la base : un serveur qui répond mais ne peut plus lire ses données n'est pas « en bonne santé ». Aucune donnée de patient ni chemin dans la réponse.

```json
{ "status": "ok", "version": "1.4.0", "schemaVersion": 1, "uptimeSeconds": 80, "time": "2026-10-09T02:28:49.188Z" }
```

`503 { "status": "degraded", "version": "1.4.0", "error": "Base de données inaccessible." }` si la base ne répond pas. Accessible sans mot de passe.

---

## Dossiers patients

| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| `GET` | `/api/patients` | — | `200 { "patients": [Patient + documentCount + unreadableCount] }` |
| `POST` | `/api/patients` | `{ "code", "label"?, "notes"? }` | `201 { "patient" }` — `409` si le code existe (sans égard à la casse) |
| `POST` | `/api/patients/ensure` | `{ "code" }` | `200 { "patient" }` — renvoie le dossier de ce code, en le créant s'il n'existe pas (sert à l'import par lot) |
| `GET` | `/api/patients/:id` | — | `200 { "patient", "documents": [DocumentMeta] }` |
| `PATCH` | `/api/patients/:id` | `{ "code"?, "label"?, "notes"? }` | `200 { "patient" }` — `404`, `409` |
| `DELETE` | `/api/patients/:id` | — | `204` — supprime le dossier, ses documents, **leurs fichiers sur le disque**, ses valeurs et son historique |

**Code** : normalisé (caractères invisibles retirés, espaces typographiques ramenés à l'espace ordinaire), 1 à 80 caractères. `label` ≤ 200, `notes` ≤ 4 000 caractères.

```json
{
  "id": 1, "code": "PAT-001", "label": null, "notes": null,
  "createdAt": "2026-10-09T02:27:34.019Z", "updatedAt": "2026-10-09T02:27:34.019Z",
  "documentCount": 6, "unreadableCount": 0
}
```

`unreadableCount` : documents dont l'analyse n'a donné aucun texte exploitable.

---

## Documents

### `POST /api/patients/:patientId/documents`

Importe un ou plusieurs fichiers dans le dossier. `multipart/form-data`, champ `files` (répétable).

```bash
curl -F "files=@compte-rendu.pdf" -F "files=@bilan.docx" http://localhost:4000/api/patients/1/documents
```

Réponse `201` :

```json
{
  "results": [
    { "filename": "compte-rendu.pdf", "status": "imported", "documentId": 7, "kind": "pdf", "textLength": 1843 },
    { "filename": "bilan.docx", "status": "duplicate", "documentId": 4, "message": "Fichier identique déjà importé (bilan-biologique.docx)." },
    { "filename": "scan.png", "status": "imported", "documentId": 8, "kind": "image", "textLength": 15 }
  ],
  "documents": [ … ],
  "summary": { "imported": 2, "duplicates": 1, "errors": 0 }
}
```

- Chaque fichier a son issue (`imported`, `duplicate`, `error`) : un fichier illisible n'empêche pas d'importer les autres. Le champ `message` porte l'avertissement ou la raison ; un fichier `imported` avec un `message` a été **lu en partie** (« Texte tronqué : … », « Lecture partielle : N pages non lues … »). Une image a toujours un en-tête (nom, dimensions, EXIF) : son `textLength` n'est jamais 0 ; un PDF scanné lu sans OCR devient un document `empty`, sans message.
- Les doublons sont détectés par **empreinte SHA-256** du contenu, dans un même dossier. Deux envois simultanés du même fichier donnent un import et un doublon, jamais deux documents.
- Limites : **200 fichiers** par envoi (fixe) ; **200 Mo** par fichier (`MAX_UPLOAD_BYTES`) ; **2 Go** par envoi (`MAX_REQUEST_BYTES`, contrôlé d'après l'en-tête `Content-Length` annoncé) — dépassées, `413` avec la limite et la variable à relever. Un envoi coupé ou mal formé donne `400 « Envoi illisible »`.
- Les fichiers sont reçus **sur disque**, jamais en mémoire, et le dépôt provisoire est vidé quoi qu'il arrive (même sur une erreur 404 ou 400).
- Le nom de stockage est un identifiant aléatoire suivi de l'extension du nom d'origine (au plus dix caractères alphanumériques) : aucune autre donnée du client ne construit un chemin. Le nom affiché perd toute composante de chemin et les caractères de contrôle ou de sens d'écriture.
- Les noms de fichier sont lus en UTF-8 (`opératoire`, pas `opÃ©ratoire`).

### Autres routes

| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| `GET` | `/api/documents/:id` | — | `200 { "document": DocumentMeta }` |
| `GET` | `/api/documents/:id/text` | — | `200 { "text" }` — le texte intégral que le moteur interroge |
| `GET` | `/api/documents/:id/file` | — | Le fichier d'origine. Type servi d'après une liste fermée d'extensions, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline` pour ce qu'un navigateur affiche sans risque (PDF, images, texte brut `.txt` servi en `text/plain`), `attachment` sinon |
| `POST` | `/api/documents/:id/reparse` | — | `200 { "document" }` — relance l'analyse (après activation de l'OCR, par exemple) |
| `PATCH` | `/api/documents/:id` | `{ "filename" }` | `200 { "document" }` — renomme ; l'extension ne change pas (`400` sinon), pas de `/` ni de `\` |
| `DELETE` | `/api/documents/:id` | — | `204` — supprime la ligne **et** le fichier |
| `GET` | `/api/documents-capabilities` | — | `200 { "ocr": { "available", "lang", "reason" }, "llm": { "available", "model", "effort", "reason", "keySource", "keyHint" }, "maxUploadBytes" }` — `keySource` : `"app"`, `"env"` ou `null` (voir [Clé d'API Anthropic](#clé-dapi-anthropic-et-coût)) |

`DocumentMeta` :

```json
{
  "id": 7, "patientId": 1, "filename": "compte-rendu.pdf", "kind": "pdf", "mime": "application/pdf",
  "size": 1721, "sha256": "…", "createdAt": "…",
  "parseStatus": "ok", "parseError": null, "textLength": 1843, "previewable": true,
  "metadata": { "pageCount": 1, "textLayer": true, "pdfInfo": { … }, "ocrApplied": false }
}
```

`kind` : `pdf`, `docx`, `image`, `dicom`, `text`, `unknown`. `parseStatus` : `ok`, `empty` (aucun texte), `error`, `pending`. `parseError` porte aussi les **avertissements** d'un import réussi (« Texte tronqué : … », « Lecture partielle : N pages non lues … »). `metadata` varie selon le format (`pageCount`, `textLayer`, `ocrApplied`, `ocrConfidence`, `ocrPages`, `ocrSkippedPages`, `width` et `height` d'une image, date EXIF, `pagesRead`, `pagesTruncated`, `truncatedBecause`…).

---

## Fiches d'exploitation

| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| `GET` | `/api/templates` | — | `200 { "templates": [Template], "active": TemplateWithFields \| null }` |
| `POST` | `/api/templates` | `{ "name", "description"?, "isActive"? }` | `201 { "template" }` |
| `GET` | `/api/templates/:id` | — | `200 { "template": TemplateWithFields }` |
| `PATCH` | `/api/templates/:id` | `{ "name"?, "description"?, "isActive"? }` | `200 { "template" }` |
| `POST` | `/api/templates/:id/activate` | — | `200 { "template" }` — une seule fiche active à la fois |
| `POST` | `/api/templates/:id/duplicate` | `{ "name"? }` | `201 { "template" }` — copie avec ses variables et ses règles |
| `DELETE` | `/api/templates/:id` | — | `204` — `400` pour la dernière fiche |
| `POST` | `/api/templates/import` | Une fiche au format de `GET /api/export/template.json` | `201 { "template" }` — créée **en entier ou pas du tout** (aucune fiche amputée si une variable est invalide) |
| `POST` | `/api/templates/:id/fields` | `FieldInput` | `201 { "field" }` |
| `PATCH` | `/api/templates/fields/:fieldId` | `FieldInput` partiel | `200 { "field" }` |
| `DELETE` | `/api/templates/fields/:fieldId` | — | `204` |
| `POST` | `/api/templates/:id/fields/reorder` | `{ "fieldIds": [ … ] }` | `200 { "template" }` |
| `POST` | `/api/templates/fields/test` | `{ "field": FieldInput, "patientId"?, "sampleText"? }` | `200 { "found", "value", "confidence", "evidence", "rejected", "documentsTested" }` — **n'enregistre rien**. L'unité de `field` s'applique : le contrôle d'unité est le même que pendant une passe |

### `FieldInput`

```json
{
  "key": "age",
  "label": "Âge",
  "type": "integer",
  "section": "Identité",
  "unit": "ans",
  "description": "Âge à l'admission.",
  "required": true,
  "options": [],
  "extraction": {
    "enabled": true,
    "rules": [
      { "kind": "label", "labels": ["Âge", "Age"], "maxLength": 20 },
      { "kind": "regex", "pattern": "patient de (\\d{1,3}) ans" }
    ],
    "postProcess": { "min": 0, "max": 120 }
  }
}
```

| Propriété | Contrainte |
|---|---|
| `key` | `^[a-z][a-z0-9_]*$`, 1 à 60 caractères, **unique dans la fiche** |
| `label` | 1 à 200 caractères |
| `type` | `text`, `number`, `integer`, `date`, `boolean`, `enum`, `multi` |
| `options` | Obligatoire (≥ 1) pour `enum` et `multi` ; 100 au plus, 120 caractères chacune |
| `extraction.rules` | 30 au plus. Une fiche importée : 500 variables au plus |

Règles (`kind`) :

| `kind` | Propriétés |
|---|---|
| `label` | `labels` (1 à 50, ≤ 200 caractères chacun), `maxLength` (1–500, défaut 120) |
| `regex` | `pattern` (≤ 500 caractères, doit être une expression valide), `flags` (`gimsuy`), `group` (0–20, défaut 1) |
| `keyword` | `any` (1 à 100 termes), `none`, `noneWindow` (0–500, défaut 40), `skip`, `skipWindow`, `emit` (valeur), `emitIfNegated` |
| `dicom` | `tag` — mot-clé (`PatientAge`) ou code (`00101010`) |

Communes : `source` (`text` \| `dicom` \| `filename`), `docKinds` (restreint aux natures de document listées), `confidence` (0–1). `postProcess` : `valueMap` (texte → option canonique), `scale` (facteur), `min`, `max` (bornes de plausibilité).

Les expressions régulières fournies par l'utilisateur sont **surveillées** : un motif à risque (répétitions imbriquées) est exécuté sous chronomètre (`REGEX_BUDGET_MS`, 250 ms par défaut), puis écarté avec une raison en clair — il ne fige pas le serveur. Un motif que l'analyse croit sain mais qui est lent s'exécute sans délai à sa première évaluation (puis il est classé à risque). Un libellé ou mot-clé de plus de 200 caractères est refusé (400).

### `POST /api/templates/fields/test`

```json
{
  "found": true,
  "value": 54,
  "confidence": 0.85,
  "evidence": { "documentId": 0, "documentName": "Texte de test", "snippet": "… Âge : 54 ans …", "start": 12, "end": 14, "rule": "libellé « Âge » ou « Age »" },
  "rejected": [],
  "documentsTested": 1
}
```

Fournir `sampleText` (≤ 200 000 caractères), `patientId`, ou les deux. Si rien n'est retenu, `rejected` liste (3 au plus) les valeurs trouvées puis écartées, avec la raison : seuil (`< 5`), hors bornes, type incompatible, motif trop complexe.

---

## Fiches remplies et extraction

### `GET /api/records?patientId=:id[&templateId=:id]`

La fiche remplie d'un dossier (la fiche active si `templateId` est omis). `400` sans `patientId`.

```json
{
  "template": { "id": 1, "name": "…", "fields": [ … ] },
  "patient": { "id": 3, "code": "PAT-003", … },
  "record": {
    "id": 3, "templateId": 1, "patientId": 3, "lastExtractionAt": "2026-10-09T02:27:36.103Z",
    "values": [
      {
        "fieldId": 2, "value": 22, "source": "manual", "confidence": 0.85,
        "evidence": { "documentId": 13, "documentName": "compte-rendu.pdf", "snippet": "… Age : 22 ans …", "start": 58, "end": 64, "rule": "libellé « Âge » ou « Age »" },
        "origin": { "source": "auto", "value": 22 },
        "reviewedAt": "2026-10-09T02:27:36.059Z",
        "updatedAt": "2026-10-09T02:27:36.059Z"
      }
    ]
  }
}
```

| Champ | Sens |
|---|---|
| `source` | `auto` (règle), `llm` (modèle), `manual` (décision d'un relecteur), `empty` |
| `confidence` | Indice **relatif**, pas une probabilité (voir le [guide du chercheur](guide-chercheur.md#6-relire)) |
| `evidence` | Le document, l'extrait et la règle qui justifient une valeur automatique ; `null` pour une saisie |
| `origin` | Ce que la machine avait proposé avant la décision humaine ; sert aux mesures de fiabilité. `null` si la valeur n'a pas été relue ou a été saisie de zéro |
| `reviewedAt` | Date de la décision humaine |

### `PUT /api/records/:templateId/:patientId/values`

Enregistre les **décisions d'un relecteur**. Les valeurs sont marquées `manual` et **survivent aux extractions suivantes**.

```json
{
  "values": [
    { "fieldId": 2, "mode": "confirm" },
    { "fieldId": 5, "value": 11.8 },
    { "fieldId": 9, "value": null },
    { "fieldId": 12, "mode": "release" }
  ],
  "acceptOutOfBounds": false
}
```

| `mode` | Effet |
|---|---|
| `set` (défaut) | Fixe la valeur ; `null` la **vide** (elle reste vide aux passes suivantes) |
| `confirm` | Valide telle quelle la valeur proposée par la machine (`400` s'il n'y en a pas) |
| `release` | Retire la décision humaine : la prochaine passe pourra de nouveau remplir la variable |

1 à 1 000 valeurs par appel, **appliquées dans une seule transaction**. Contrôles, par type :

| Type | Règle |
|---|---|
| `text` | 20 000 caractères au plus |
| `number`, `integer` | Chiffres, signe, virgule ou point décimal (`« 12,5 »` accepté ; `1e3` et `0x10` refusés). Un entier refuse un décimal (`« 3,5 »` → 400), il ne l'arrondit pas |
| `date` | `AAAA-MM-JJ`, **existante au calendrier** (`2024-02-30` → 400 ; `2024-02-29` accepté) |
| `boolean` | `true`/`false`, ou `oui`/`non`/`1`/`0` |
| `enum` | Une option de la variable |
| `multi` | Un tableau d'options de la variable (doublons retirés) |

**Bornes de plausibilité.** Une valeur hors des bornes de la variable (`postProcess.min/max` ; pour une date : avant 1900 ou plus d'un an dans l'avenir) n'est pas interdite, mais demande confirmation :

```json
HTTP/1.1 422
{
  "error": "« Âge » : 200 est hors des bornes attendues (0 à 120).",
  "code": "out_of_bounds",
  "details": [ { "fieldId": 2, "key": "age", "label": "Âge", "value": 200, "min": 0, "max": 120 } ]
}
```

Rejouez avec `"acceptOutOfBounds": true` pour l'enregistrer quand même. Rien n'est écrit tant que la requête est refusée. Réponse `200 { "record" }` (la fiche à jour).

### `GET /api/records/:templateId/:patientId/history[?fieldId=:id][&limit=:n]`

Les événements d'une fiche, ou d'une seule variable, du plus récent au plus ancien (`limit` : 200 par défaut).

```json
{
  "events": [
    { "id": 508, "recordId": 3, "patientId": 3, "patientCode": "PAT-003", "fieldId": 2, "fieldKey": "age", "fieldLabel": "Âge",
      "at": "2026-10-09T02:27:36.059Z", "action": "confirm", "oldValue": 22, "oldSource": "auto", "newValue": 22, "newSource": "manual", "runId": null },
    { "id": 45, "…": "…", "action": "extract", "oldValue": null, "oldSource": null, "newValue": 22, "newSource": "auto", "runId": 1 }
  ]
}
```

`action` : `extract` (posée par une passe), `unset` (retirée parce que plus trouvée), `edit`, `confirm`, `clear` (vidée), `release`. Le journal est **en ajout seul** : aucune route ne modifie ni ne supprime un événement ; ses lignes disparaissent avec le dossier, la variable ou la fiche concernés.

### `GET /api/records/runs[?limit=:n]`

Les passes d'extraction, de la plus récente à la plus ancienne (50 par défaut, 500 au plus).

```json
{
  "runs": [
    { "id": 4, "templateId": 1, "templateName": "Fiche d'exploitation générale",
      "templateFingerprint": "7fc4005260e60df63fe46dd30cbc7beef70b33c53efaaccea499fe3e87bab521",
      "mode": "rules", "model": null, "overwriteManual": false, "appVersion": "1.4.0",
      "startedAt": "2026-10-09T02:31:22.806Z", "finishedAt": "2026-10-09T02:31:22.844Z", "status": "done",
      "patients": 1, "documents": 1, "extracted": 1, "notFound": 20, "keptManual": 1, "rejected": 0 }
  ]
}
```

`status` : `running`, `done`, `failed`. Une passe restée `running` parce que le serveur s'est arrêté pendant son exécution est marquée `failed` au redémarrage. `templateFingerprint` : SHA-256 de ce qui change le résultat d'une extraction au moment de la passe — clé, libellé, type, unité, caractère obligatoire, options, règles et post-traitements de chaque variable ; ni la section, ni la description, ni la position.

### `POST /api/records/extraction/run`

Lance l'extraction. **Synchrone** : la requête reste ouverte pendant la passe (les dossiers sont traités en série ; le serveur cède la main entre deux dossiers, il répond aux autres requêtes pendant ce temps).

```json
{ "templateId": 1, "patientIds": [1, 2, 3], "mode": "rules", "overwriteManual": false }
```

Tout est facultatif : sans `templateId`, la fiche active ; sans `patientIds`, tous les dossiers ; `mode` : `rules` (défaut), `llm`, `hybrid` ; `overwriteManual: true` écrase aussi les valeurs relues (à ne pas employer par défaut).

```json
{
  "runId": 5, "templateId": 1, "mode": "rules", "patientsProcessed": 24,
  "totals": { "extracted": 500, "notFound": 28, "keptManual": 0, "rejected": 0, "unverified": 0, "invalid": 0 },
  "usage": null, "model": null, "costUsd": null,
  "errors": [],
  "reports": [
    { "patientId": 1, "patientCode": "PAT-001", "documentCount": 6, "extracted": 21, "notFound": 1, "keptManual": 0,
      "rejected": 0, "unverified": 0, "invalid": 0, "llmError": null, "usage": null,
      "fields": [ { "fieldId": 1, "key": "numero_dossier", "label": "Numéro de dossier", "status": "extracted", "by": "rules", "confidence": 0.85, "rejected": null } ] }
  ]
}
```

- `status` d'un champ : `extracted`, `not-found`, `kept-manual` (déjà relu), `disabled`. `rejected` : la première valeur trouvée puis écartée (seuil, bornes, type), pour une variable restée vide.
- `unverified` / `invalid` (modes `llm`, `hybrid`) : valeurs proposées par le modèle puis écartées faute de citation retrouvée, ou incompatibles avec la fiche. `usage` : jetons consommés (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`) ; `model` : le modèle interrogé ; `costUsd` : leur prix en dollars, facturé sur le compte Anthropic du titulaire de la clé (indicatif, arrondi au centième de cent ; `null` en mode `rules` ou pour un modèle absent du barème) ; `errors` : échecs du modèle par dossier — un échec n'annule ni les règles ni les dossiers suivants.
- **Ce qu'une passe retire** : une variable qui n'est plus trouvée perd sa valeur automatique (événement `unset`), mais une passe ne retire que ce qu'elle a pu produire — `rules` ne retire que des valeurs `auto`, `llm` et `hybrid` retirent aussi des valeurs `llm` **quand l'appel au modèle a réussi** ; un appel en échec (`errors`) n'efface rien. Les valeurs relues (`manual`) ne sont retirées par aucune passe, sauf `overwriteManual`.
- **Atomicité** : pour chaque dossier, valeurs, journal et date de passe s'écrivent dans **une seule transaction**. Un arrêt brutal (`kill -9`, vérifié sur 25 passes interrompues à des instants aléatoires) au milieu d'une passe laisse chaque fiche exactement dans l'état d'avant ou d'après, jamais à moitié effacée. Une coupure de courant n'a pas été simulée.
- `400` si le mode demande un modèle indisponible (« Extraction par Claude indisponible : … ») ou s'il n'y a aucun dossier ; `404` pour un `patientId` inconnu.

---

## Analyses

Toutes acceptent `?templateId=:id` (sinon la fiche active). Elles ne modifient rien.

| Chemin | Contenu |
|---|---|
| `GET /api/analytics/dataset` | `{ template, rows, summary: { patients, fields, completeness } }` — un objet par dossier : `values`, `sources`, `confidences` indexés par **clé** de variable, `documentCount`, `filled` |
| `GET /api/analytics/stats` | `{ template, patientCount, stats }` — par variable : `n`, `missing`, et selon le type `chart: "histogram"` (`summary` : n, moyenne, écart type, min, q1, médiane, q3, max ; `bins`), `"categories"` (effectifs ; chronologique pour les dates) ou `"none"` (texte libre : valeurs les plus fréquentes, pour l'écran ; elles ne sont **jamais** transmises à Claude) |
| `GET /api/analytics/completeness` | `{ patientCount, fields: [{ key, label, section, required, auto, llm, manual, empty, rate }] }` |
| `GET /api/analytics/extraction` | `{ template, rows, summary: { patients, emptyPatients, barrenDocuments, documents } }` — rendement par dossier et par fichier ; `barrenDocuments` : fichiers qui n'ont justifié aucune valeur |
| `GET /api/analytics/quality` | `{ quality }` — fiabilité mesurée sur les relectures |

Les valeurs vides restent **vides** (comptées dans `missing`) : une variable à 40 % de manquants n'est jamais présentée comme entièrement « Non ».

### `GET /api/analytics/quality`

```json
{
  "quality": {
    "templateId": 1, "patients": 24, "patientsReviewed": 8,
    "overall": {
      "unreviewed": 475, "confirmed": 16, "corrected": 7, "emptied": 2, "added": 0, "confirmedEmpty": 0,
      "reviewed": 25,
      "agreement": { "value": 0.64, "low": 0.445, "high": 0.798, "of": 25 },
      "recall":    { "value": 0.696, "low": 0.491, "high": 0.844, "of": 23 }
    },
    "fields": [ { "fieldId": 1, "key": "numero_dossier", "…": "…" } ]
  }
}
```

| Mesure | Définition |
|---|---|
| `confirmed` / `corrected` / `emptied` | Valeurs proposées par la machine, relues, puis validées / remplacées / écartées |
| `added` | La machine n'avait rien trouvé, le relecteur a saisi une valeur |
| `reviewed` | `confirmed + corrected + emptied` |
| `agreement` (concordance, précision) | `confirmed / reviewed` |
| `recall` (rappel) | `confirmed / (confirmed + corrected + added)` |
| `low`, `high`, `of` | Intervalle de confiance **à 95 %** de Wilson, et dénominateur |

Ces mesures n'ont de portée que si les dossiers relus sont tirés **au hasard**.

---

## Exports

Toutes les routes acceptent `?templateId=:id`. Elles répondent en téléchargement (`Content-Disposition: attachment`).

| Chemin | Paramètres | Contenu |
|---|---|---|
| `GET /api/export/csv` | `delimiter` (`;` défaut, `,`), `decimal` (`,` ou `.` ; défaut : `,` avec `;`, `.` avec `,`), `booleans` (`numeric` défaut → `1`/`0`, `text` → `Oui`/`Non`), `labels=1` (en-têtes en clair) | Le jeu de données. UTF-8 **avec marque d'ordre des octets** (Excel affiche les accents). Premières colonnes : code dossier, libellé, nombre de documents. Choix multiple : options séparées par `\|`. Les cellules qui commencent par `=`, `+`, `-` ou `@` sont neutralisées pour Excel |
| `GET /api/export/dictionary.csv` | `delimiter` | `cle, libelle, section, type, unite, obligatoire, options, description, type_libelle` |
| `GET /api/export/template.json` | — | La fiche, réimportable (`POST /api/templates/import`) |
| `GET /api/export/xlsx` | `labels=1` (en-têtes en clair) | Classeur : feuille de données **typée** (dates, nombres), dictionnaire, synthèse de cohorte. Texte borné à 32 000 caractères par cellule |
| `GET /api/export/pptx` | — | Diaporama de figures (formes natives, modifiables), une par variable à histogramme ou à modalités ayant au moins une valeur ; les variables en texte libre n'ont pas de planche |
| `GET /api/export/methods` | `format` (`md` défaut, `html`, `json`), `lang` (`fr` défaut, `en`) | Rapport « Méthodes et traçabilité » ; la variante HTML est autonome (CSP `default-src 'none'`) |
| `GET /api/export/audit.csv` | `delimiter` | Le journal des modifications de valeur, du plus ancien au plus récent |

Colonnes de `audit.csv` : `evenement, horodatage, dossier, variable, libelle, action, valeur_avant, origine_avant, valeur_apres, origine_apres, passe`.

Clés de la variante `format=json` du rapport : `generatedAt`, `tool`, `template`, `corpus`, `runs` (les 25 plus récentes), `runSummary` (nombre, première et dernière date, modes et modèles de **toutes** les passes), `provenance`, `quality`, `audit`, `llm`.

```bash
curl -OJ "http://localhost:4000/api/export/csv?delimiter=,&decimal=.&booleans=numeric"
curl -OJ "http://localhost:4000/api/export/methods?format=html&lang=en"
```

---

## Revue bibliographique

Indépendante des dossiers patients. Chaque passe de recherche est **facturée** par Apify : voir les garde-fous ci-dessous.

| Méthode | Chemin | Corps / paramètres | Réponse |
|---|---|---|---|
| `GET` | `/api/biblio/status` | — | `{ configured, maxResults, running, sources: { pubmed, scholar }, exclusionReasons }` — le jeton n'y figure jamais |
| `GET` | `/api/biblio/overview` | — | `{ counts, prisma, searches }` |
| `POST` | `/api/biblio/searches` | `{ "query", "sources", "maxResults"?, "yearFrom"?, "yearTo"?, "sort"? }` | `201 { searches, counts, prisma }` |
| `GET` | `/api/biblio/refs` | `decision` (`pending`, `include`, `maybe`, `exclude`), `source` (`pubmed`, `scholar`, `both`), `q`, `sort` (`added`, `recent`, `cited`), `limit` (1–1000), `offset` | `{ refs, total }` |
| `PATCH` | `/api/biblio/refs/:id` | `{ "decision"?, "exclusionReason"?, "note"? }` | `200 { ref, counts, prisma }` |
| `GET` | `/api/biblio/export` | `format` (`csv` défaut, `ris`, `bibtex`, `searches`), `decision` (`all` défaut, `pending`, `include`, `maybe`, `exclude`) | Téléchargement, **sans plafond de taille** (toute la bibliothèque) |

**`POST /api/biblio/searches`** : `query` de 2 à 500 caractères, transmise **telle quelle** aux sources ; `sources` : `["pubmed"]`, `["scholar"]` ou les deux (lancées en parallèle, une source en échec n'annule pas l'autre) ; `maxResults` de 1 à `BIBLIO_MAX_RESULTS` (plafond : 100 par défaut ; 20 si `maxResults` est omis) ; `yearFrom`/`yearTo` entre 1800 et 2200 ; `sort` : `relevance` ou `date`.

| Statut | Cause |
|---|---|
| `400` | `maxResults` au-dessus du plafond ; équation absente ; année de début après l'année de fin |
| `409` | `APIFY_TOKEN` absent ; **une recherche est déjà en cours** (une seule à la fois : un double clic ne facture pas deux fois) |

**`GET /api/biblio/refs?q=`** : recherche en plusieurs mots, **sans égard aux accents ni à la casse**, dans le titre, les auteurs, la revue, le résumé, les mots-clés, les termes MeSH et les identifiants ; tous les mots doivent figurer, dans n'importe quel ordre ; une expression entre guillemets se cherche telle quelle ; 12 termes au plus.

**`PATCH /api/biblio/refs/:id`** : `decision` ∈ `pending|include|maybe|exclude`. Une exclusion **exige** son `exclusionReason` (`population`, `intervention`, `outcome`, `design`, `language`, `no_fulltext`, `duplicate_report`, `other`) : c'est lui que le diagramme de flux compte. Rien ne se supprime.

Noms de fichier des exports : `references-toutes-AAAA-MM-JJ.ris`, `references-retenues-…`, `references-a-voir-…`, `references-exclues-…`, `references-a-trier-…`, `strategies-de-recherche-….csv`.

---

## Clé d'API Anthropic et coût

Chaque utilisateur paie l'IA avec sa propre clé : elle se saisit dans l'interface (*Extraction › Clé d'API Anthropic*) ou par ces routes. **Aucune réponse ne contient la clé** : seulement sa provenance et ses quatre derniers caractères.

| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| `GET` | `/api/llm/key` | — | `200` état de la clé (ci-dessous) |
| `PUT` | `/api/llm/key` | `{ "key": "sk-ant-…" }` (400 caractères au plus, aucun autre champ) | `200` état de la clé, une fois la clé **vérifiée auprès d'Anthropic** et enregistrée |
| `DELETE` | `/api/llm/key` | — | `200` état de la clé : celle de l'application est effacée ; `ANTHROPIC_API_KEY`, s'il est défini, reprend la main |
| `GET` | `/api/llm/estimate[?templateId=:id]` | — | `200 { "estimate": { "model", "patients", "low", "high", "inputTokens" } }` : fourchette en dollars d'une passe par Claude sur tous les dossiers, pour la fiche donnée (ou active) ; `estimate` vaut `null` pour un modèle absent du barème. `404` sans fiche |

```json
{ "source": "app", "hint": "…AbCd", "savedAt": "2026-10-11T09:12:30.000Z", "model": "claude-opus-5-5", "available": true }
```

- `source` : `"app"` (clé saisie, dans `DATA_DIR/anthropic-key.json`), `"env"` (`ANTHROPIC_API_KEY`) ou `null` (aucune : seules les règles sont possibles). La clé saisie l'emporte sur celle de l'environnement.
- `PUT` contrôle d'abord la forme (`sk-ant-…`, sans espace ; une clé d'administration `sk-ant-admin…` est refusée), puis interroge Anthropic une fois (la fiche du modèle configuré). **Rien n'est écrit si la clé est refusée.** Erreurs, toutes avec `code: "api-key-refused"` et un message en français, sans la clé : `400` clé mal formée, refusée par Anthropic, sans accès à l'API ou au modèle ; `429` limite de débit d'Anthropic ; `502` Anthropic injoignable ou réponse inattendue.
- Ce sont des routes **modifiantes** : une `Origin` étrangère est refusée (`403`), comme partout.
- `low` / `high` : la longueur du raisonnement ne se prévoit pas, d'où une fourchette. En mode `hybrid`, les règles trouvent une partie des variables d'abord : la passe coûte moins que `high`. Le calcul est décrit dans l'[architecture](architecture.md#45-modèle-de-langage-enginellmts-llm-schemats-llm-verifyts).

---

## Rédaction assistée

| Méthode | Chemin | Corps | Réponse |
|---|---|---|---|
| `GET` | `/api/redaction/status` | — | `{ "available": false }` tant qu'aucune clé d'API Anthropic n'est disponible (ni saisie, ni `ANTHROPIC_API_KEY`) |
| `POST` | `/api/redaction/message` | `{ "templateId"?, "messages": [{ "role": "user"\|"assistant", "content" }] }` (1 à 60 messages de 40 000 caractères au plus) | `text/event-stream` |

Le contexte transmis au modèle ne contient que des **agrégats** : nom et objet de la fiche, effectifs, complétude, indicateurs ou modalités de chaque variable avec leurs effectifs, définitions des variables. Les variables en texte libre ne donnent que leurs effectifs (« valeurs non transmises ») : aucune ligne de patient, aucun code de dossier, aucun nom de fichier. Le flux émet des événements `delta` (`{ "text" }`), puis `done` (`{ "usage", "costUsd" }` : jetons consommés et leur prix en dollars, ou `null` hors barème), ou `error` (`{ "message" }`) — l'en-tête HTTP étant déjà parti, une erreur en cours de route voyage dans le flux.

---

## Recettes

**Importer une cohorte, extraire, lire les valeurs** (Python, sans dépendance) :

```python
import json, pathlib, urllib.request

BASE = "http://localhost:4000/api"

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method,
                                 headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read() or "null")

# 1. un dossier par sous-dossier ; l'envoi multipart est plus simple avec curl ou requests
for folder in sorted(pathlib.Path("cohorte").iterdir()):
    patient = call("POST", "/patients/ensure", {"code": folder.name})["patient"]
    # curl -F "files=@fichier" $BASE/patients/{id}/documents   (voir plus haut)

# 2. une passe sur tous les dossiers (mode « règles seules »)
run = call("POST", "/records/extraction/run", {})
print(run["totals"])

# 3. le jeu de données, avec l'origine de chaque valeur
dataset = call("GET", "/analytics/dataset")
for row in dataset["rows"][:3]:
    print(row["patientCode"], row["values"]["age"], row["sources"]["age"])
```

**Confirmer toutes les valeurs d'un dossier relu** :

```bash
# les identifiants de variables viennent de GET /api/records?patientId=…
curl -X PUT -H 'Content-Type: application/json' \
  -d '{"values":[{"fieldId":2,"mode":"confirm"},{"fieldId":3,"mode":"confirm"}]}' \
  http://localhost:4000/api/records/1/3/values
```

**Reproduire une analyse** : conservez `GET /api/export/template.json` (la fiche), `GET /api/records/runs` (les passes et leur empreinte) et `GET /api/export/audit.csv` (le journal) avec le jeu de données.
