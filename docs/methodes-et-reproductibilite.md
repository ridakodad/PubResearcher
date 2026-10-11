# Méthodes et reproductibilité

Comment décrire, dans un article ou un dossier d'éthique, ce que l'outil a fait ; comment mesurer la fiabilité de l'extraction sur **vos** dossiers ; comment refaire la même extraction plus tard.

> L'outil produit des **faits** (corpus, fiche, passes, origine des valeurs, relectures, version) et un **paragraphe de départ**. Il ne produit pas la justification de votre étude, ni votre déclaration réglementaire, et il ne décide pas de la façon de relire : cela reste à l'investigateur.

## 1. Le rapport « Méthodes et traçabilité »

*Résultats › Export*, boutons « Rapport (HTML) », « Markdown » (français) et « English » (Markdown anglais) — ou `GET /api/export/methods?format=md|html|json&lang=fr|en`, seul moyen d'obtenir le JSON et le HTML anglais. Il est établi **à partir de la base** : aucun chiffre n'y est saisi à la main.

| Section | Ce qu'elle dit | D'où ça vient |
|---|---|---|
| **Paragraphe « Méthodes »** | Un texte prêt à adapter, avec les chiffres de votre base | Toutes les sections ci-dessous |
| **Corpus** | Dossiers, documents par nature (PDF, Word, DICOM, image, texte), documents sans texte exploitable, lus par OCR, **lus partiellement** | `documents` |
| **Fiche d'exploitation** | Les variables (clé, type, unité, bornes, nombre de règles de chaque famille) et l'**empreinte SHA-256** des règles | `fields` |
| **Passes d'extraction** | Le nombre de passes, leurs dates extrêmes, leurs modes et leurs modèles (toutes les passes de la fiche), puis le détail des **25 plus récentes** : date, mode, modèle éventuel, empreinte de la fiche, effectifs, état | `extraction_runs` |
| **Origine des valeurs** | Part des cellules du tableau venue des règles, du modèle, d'une décision de relecteur | `record_values` |
| **Fiabilité** | Valeurs relues, confirmées, corrigées, écartées, ajoutées ; **concordance et rappel avec intervalle de confiance de Wilson à 95 %** pour l'ensemble ; par variable, les effectifs et la concordance (l'intervalle et le rappel par variable sont dans le JSON) | Les gestes de relecture |
| **Journal des modifications** | Nombre de changements par type ; le journal complet s'exporte en CSV | `value_events` |
| **Environnement logiciel** | Versions : outil, schéma, Node.js, système, pdf.js, mammoth, tesseract.js, exifr, dicom-parser, SDK d'Anthropic | Le processus en cours |
| **Limites à signaler** | Quatre limites génériques à reprendre dans la discussion | Texte fixe |

Un extrait réel (24 dossiers de démonstration, relecture scriptée de 8 dossiers pour l'exemple — **ces chiffres ne mesurent pas l'outil**) :

```
## Passes d'extraction
| # | Début              | Mode  | Modèle | Empreinte    | Dossiers | Extraites | Non trouvées | Gardées (relues) | État     |
| 2 | 9 oct. 2026, 02:44 | rules | —      | 7fc4005260e6 | 24       | 475       | 28           | 25               | terminée |
| 1 | 9 oct. 2026, 02:44 | rules | —      | 7fc4005260e6 | 24       | 500       | 28           | 0                | terminée |

## Origine des valeurs
| Règles (non relues)                        | 475 | 90,0 % |
| Décision d'un relecteur                    |  25 |  4,7 % |
| Cellules renseignées (toutes origines)     | 498 | 94,3 % |
```

## 2. Paragraphes « Méthodes » à adapter

Le rapport génère le paragraphe avec vos chiffres. Voici les variantes, pour les cas que le rapport ne devine pas. Les passages entre `[crochets]` sont à remplir par vous.

### 2.1 Règles seules, avec relecture d'un échantillon aléatoire

> **Français.** Les données ont été extraites rétrospectivement de [N] documents ([M] dossiers) à l'aide de l'application PubResearcher, version [1.5.0], selon une fiche d'exploitation de [K] variables définies par [les investigateurs] avant l'extraction (empreinte SHA-256 des règles : [7fc4005260e6…]). L'extraction a été réalisée par des règles déterministes (libellés, expressions régulières, mots-clés, tags DICOM), sans modèle de langage. Chaque valeur extraite conserve le document et l'extrait qui la justifient, et toute modification ultérieure est consignée dans un journal horodaté. Un échantillon de [n] dossiers ([p] % du corpus), tiré au hasard [par … à l'aide de …], a été relu en entier par [un investigateur / deux investigateurs indépendants] sans connaissance de [l'hypothèse de l'étude]. Parmi les [r] valeurs proposées par l'extraction et relues, [c] ont été confirmées, [x] corrigées et [e] écartées : la concordance était de [64,0 %] (IC à 95 % de Wilson [44,5–79,8 %]) et le rappel de [69,6 %] ([49,1–84,4 %]). Les valeurs corrigées ou saisies par les relecteurs l'emportent sur l'extraction automatique dans le jeu de données final.

> **English.** Data were retrospectively extracted from [N] documents ([M] records) using the PubResearcher application, version [1.5.0], according to a data collection form of [K] variables defined by [the investigators] before extraction (SHA-256 fingerprint of the rules: [7fc4005260e6…]). Extraction was carried out with deterministic rules (labels, regular expressions, keywords, DICOM tags), without any language model. Each extracted value keeps the document and the excerpt that support it, and any later change is recorded in a time-stamped log. A random sample of [n] records ([p]% of the corpus), drawn [by … using …], was fully reviewed by [one investigator / two independent investigators] [blinded to the study hypothesis]. Of the [r] values proposed by the extraction and reviewed, [c] were confirmed, [x] corrected and [e] discarded: agreement was [64.0%] (95% Wilson CI [44.5–79.8%]) and recall [69.6%] ([49.1–84.4%]). Values corrected or entered by the reviewers take precedence over automatic extraction in the final dataset.

### 2.2 Règles, puis modèle de langage pour les variables restées vides

> Pour les variables que les règles n'avaient pas renseignées, un modèle de langage ([identifiant du modèle], niveau de raisonnement [high]) a été interrogé sur le texte des documents. Une valeur proposée par le modèle n'était retenue que si l'extrait qu'il avait recopié du document — ou, à défaut, la valeur elle-même — était **retrouvé** dans le texte du document, et si elle respectait le type, les options et les bornes de plausibilité de la fiche ; [n] valeurs proposées ont été écartées pour ces motifs. Toutes les valeurs d'origine « modèle » ont été relues par [un investigateur]. [Les documents ont été pseudonymisés avant transmission ; le transfert a été autorisé par … le …]

*À préciser* : retrouver la valeur seule (confiance plus basse dans l'outil) ne prouve pas qu'elle a été lue à cet endroit ; c'est une raison de plus de relire les valeurs « modèle ». Le modèle ne reçoit ni le code du dossier ni les noms de fichiers, mais bien le texte. *À joindre* : l'identifiant exact du modèle (le rapport le consigne), la date des passes, et l'autorisation de transfert. Une extraction par modèle **n'est pas strictement reproductible** (versions de modèle retirées, variabilité des réponses) : archivez les valeurs, pas seulement la méthode.

### 2.3 Documents scannés

> [n] documents scannés ou photographiés ont été lus par reconnaissance optique de caractères (tesseract.js [7.0.0], langue française, confiance moyenne [xx] %). Les valeurs issues de ces documents ont été relues contre l'image d'origine.

Le rapport donne le nombre de documents lus par OCR et la confiance moyenne. Rappelez dans la discussion que l'OCR confond des caractères (la lettre O et le zéro) et peut perdre une négation.

### 2.4 Sans relecture (à éviter)

Si aucune valeur n'a été relue, le rapport l'écrit : « la fiabilité de l'extraction n'est pas estimée ». N'en déduisez pas qu'elle est bonne.

## 3. Mesurer la fiabilité sur vos dossiers

### 3.1 Ce que mesurent concordance et rappel

Chaque fois qu'un relecteur **confirme**, **corrige** ou **vide** une valeur proposée par la machine, il dit si elle avait raison, sans effort supplémentaire. Chaque fois qu'il **saisit** une valeur là où la machine n'avait rien trouvé, il dit ce qu'elle a manqué.

| Mesure | Définition | Se lit comme |
|---|---|---|
| **Concordance** (précision) | confirmées ÷ (confirmées + corrigées + vidées) | « Quand l'extraction propose une valeur, elle est juste dans x % des cas » |
| **Rappel** | confirmées ÷ (confirmées + corrigées + ajoutées) | « Parmi les valeurs justes, l'extraction en a trouvé x % » |
| **IC à 95 %** | Intervalle de Wilson | La précision de la mesure elle-même : large si peu de valeurs relues |

*Limites de cette mesure.* Un relecteur peut se tromper, et deux relecteurs peuvent différer : la mesure compare la machine **au relecteur**, pas à une vérité absolue. Pour une étude où la qualité des données est un critère de jugement, faites relire un sous-échantillon par deux relecteurs indépendants et calculez l'accord inter-relecteurs (kappa de Cohen) **hors de l'outil** : il ne le calcule pas.

### 3.2 Un échantillon tiré au hasard

> **Ces mesures ne valent que si les dossiers relus sont tirés au hasard.** Relire d'abord les valeurs douteuses fait baisser la concordance affichée ; relire d'abord les dossiers faciles la fait monter ; relire « les premiers » dépend de l'ordre d'import.

Procédure recommandée : (1) figer la fiche et lancer la passe ; (2) tirer au hasard [n] codes de dossier parmi les [M] (tableur, `sample()` en R, `random.sample` en Python), en notant la **graine** du tirage ; (3) relire ces dossiers **en entier**, toutes variables, sans choisir ; (4) lire la page *Fiabilité* ; (5) si la concordance d'une variable est insuffisante, corriger la règle et relancer — les valeurs relues sont conservées — puis tirer un **nouvel** échantillon pour mesurer l'effet (le premier a servi à corriger).

### 3.3 Combien de dossiers relire ?

L'intervalle de confiance dépend du nombre de **valeurs relues** (n = dossiers × variables relues), pas du nombre de dossiers. Demi-largeur de l'IC de Wilson à 95 % :

| Valeurs relues | Concordance observée 80 % | 90 % | 95 % |
|---:|---:|---:|---:|
| 20 | ± 16,8 pts (58,4–91,9) | ± 13,7 (69,9–97,2) | ± 11,4 (76,4–99,1) |
| 40 | ± 12,1 (65,2–89,5) | ± 9,5 (76,9–96,0) | ± 7,6 (83,5–98,6) |
| 100 | ± 7,8 (71,1–86,7) | ± 6,0 (82,6–94,5) | ± 4,5 (88,8–97,8) |
| 200 | ± 5,5 (73,9–85,0) | ± 4,2 (85,1–93,4) | ± 3,1 (91,0–97,3) |
| 400 | ± 3,9 (75,8–83,6) | ± 3,0 (86,7–92,6) | ± 2,2 (92,4–96,7) |
| 800 | ± 2,8 (77,1–82,6) | ± 2,1 (87,7–91,9) | ± 1,5 (93,3–96,3) |

Repères : pour connaître une concordance globale d'environ 90 % à ± 5 points, il faut environ **140 valeurs relues** (soit 7 dossiers de 20 variables) ; pour une concordance de 95 % à ± 3 points, environ **210**. **Par variable**, les effectifs fondent vite : 8 dossiers relus ne donnent que 8 valeurs par variable — l'intervalle est alors très large (voir la ligne de 20 ci-dessus). Pour estimer une variable précise (celle qui porte le critère de jugement de l'étude, par exemple), relisez davantage de dossiers.

## 4. Reproduire une extraction

### 4.1 Ce qui est déterministe

En mode **« Règles seules »**, deux passes de même empreinte de fiche sur les mêmes documents donnent **les mêmes valeurs** : les règles ne font appel à aucun hasard ni à aucun réseau. Deux dépendances au contexte. **Le temps** : les années à deux chiffres (« 12/03/21 ») sont lues en prenant l'année courante comme pivot (21 → 2021, mais 45 → 1945 en 2026 ; en 2045, « 45 » deviendra 2045) — préférez des documents à quatre chiffres, ou relisez les dates concernées. **La machine** : une expression régulière jugée à risque est interrompue au bout de `REGEX_BUDGET_MS` (250 ms) puis mise hors service pour la durée du processus ; sur une machine plus lente ou plus chargée, un motif lourd peut donc être écarté alors qu'ailleurs il aboutissait — l'outil l'annonce alors comme valeur écartée, avec sa raison. Évitez les motifs à risque (quantificateurs imbriqués) dans une fiche qui doit être rejouée. Les décisions humaines, elles, sont dans le journal.

| Ce qui peut faire varier le résultat | Comment le contrôler |
|---|---|
| La fiche (règles, bornes, options, facteurs) | L'**empreinte** de chaque passe ; la fiche JSON archivée |
| Les documents | Les empreintes SHA-256 de chaque fichier (base) ; la sauvegarde |
| La version de l'outil et de ses bibliothèques de lecture (pdf.js, mammoth, tesseract.js…) | Le rapport « Méthodes » consigne les versions ; archivez `package-lock.json` |
| L'OCR (version du moteur, langue, qualité d'image) | Idem ; l'OCR n'est pas strictement reproductible d'une version à l'autre |
| Un modèle de langage | **Non reproductible strictement** : archivez les valeurs et l'identifiant du modèle |
| Les décisions des relecteurs | Le journal des modifications (CSV) : quelle valeur, avant/après, quand, quelle origine, quelle passe — **pas qui** : l'outil n'a pas de comptes individuels |

### 4.2 Que conserver avec une publication

| Pièce | Où la trouver | Pourquoi |
|---|---|---|
| Fiche d'exploitation (JSON) | *Export › Fiche au format JSON* | C'est la définition exacte des variables et des règles |
| Dictionnaire des variables (CSV) | *Export › Dictionnaire des variables* | Rend le jeu de données interprétable par un tiers |
| Jeu de données (CSV et/ou Excel) | *Export* | Le résultat. Contient des codes de dossier : même précaution que les dossiers |
| Rapport « Méthodes et traçabilité » (HTML ; JSON par l'API) | *Export › Rapport (HTML)* ; `GET /api/export/methods?format=json` | Passes, empreintes, versions, fiabilité |
| Journal des modifications (CSV) | *Export › Journal des modifications (CSV)* | Tout ce qui a changé après l'extraction |
| `package-lock.json` et la version de Node | Dépôt, rapport | Reconstruire le même environnement |
| Sauvegarde (base + fichiers) | `npm run backup` | Rejouer l'étude à l'identique ; **données de patients** : conservation et accès selon l'autorisation de l'étude |

### 4.3 Rejouer

1. Installer la même version de l'outil (`npm ci` avec le même `package-lock.json`) et la même version de Node.
2. Restaurer la sauvegarde (`npm run restore`), **ou** importer à nouveau les mêmes documents et la fiche JSON (*Importer une fiche*).
3. Lancer une passe en « Règles seules » : comparer l'**empreinte** de la fiche à celle du rapport, puis les valeurs extraites au jeu de données publié, en tenant compte des valeurs relues (journal).

## 5. Citer et rapporter

**Citer l'outil.** PubResearcher, version [x.y.z], [établissement], [année]. Indiquez la version : le comportement du moteur évolue (le [journal des versions](changelog.md) liste ce qui a changé).

**Guides de rapport utiles** (références vérifiées dans PubMed le 9 octobre 2026) :

- Gilbert EH, Lowenstein SR, Koziol-McLain J, Barta DC, Steiner J. *Chart reviews in emergency medicine research: where are the methods?* Ann Emerg Med. 1996;27(3):305-8. [doi:10.1016/s0196-0644(96)70264-0](https://doi.org/10.1016/s0196-0644(96)70264-0) — huit critères de méthode d'une revue de dossiers (sélection des cas, définition des variables, formation des relecteurs, formulaire standardisé, suivi des relecteurs, aveugle, accord inter-relecteurs mentionné et testé). Sur 244 articles d'urgentologie fondés sur des revues de dossiers (1989-1993), les critères d'inclusion étaient décrits dans 98 % des cas et la définition des variables dans 73 % ; les autres critères étaient rarement mentionnés, de 18 % (formation des relecteurs) à 0,4 % (accord inter-relecteurs testé statistiquement). D'après PubMed.
- Kaji AH, Schriger D, Green S. *Looking through the retrospectoscope: reducing bias in emergency medicine chart review studies.* Ann Emerg Med. 2014;64(3):292-8. [doi:10.1016/j.annemergmed.2014.03.025](https://doi.org/10.1016/j.annemergmed.2014.03.025)
- von Elm E, Altman DG, Egger M, Pocock SJ, Gøtzsche PC, Vandenbroucke JP. *The Strengthening the Reporting of Observational Studies in Epidemiology (STROBE) statement: guidelines for reporting observational studies.* Lancet. 2007;370(9596):1453-7. [doi:10.1016/S0140-6736(07)61602-X](https://doi.org/10.1016/S0140-6736(07)61602-X)
- Benchimol EI, Smeeth L, Guttmann A, et al. *The REporting of studies Conducted using Observational Routinely-collected health Data (RECORD) statement.* PLoS Med. 2015;12(10):e1001885. [doi:10.1371/journal.pmed.1001885](https://doi.org/10.1371/journal.pmed.1001885)

**Ce que l'outil vous aide à rapporter** parmi les critères de ces guides : la définition des variables (dictionnaire, fiche), le formulaire d'abstraction standardisé (la fiche), le suivi de la performance (page *Fiabilité*), la traçabilité (journal, empreinte, versions). **Ce qu'il ne couvre pas** : la formation des relecteurs, l'aveugle, l'accord inter-relecteurs, la sélection des cas, l'éthique — à décrire par vous.
