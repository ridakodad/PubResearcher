# Modèles d'IA locaux (Ollama)

Version 1.8.2 · octobre 2026.

Chaque tâche qui faisait appel à Claude peut être confiée à un **modèle ouvert qui tourne sur l'ordinateur du chercheur**, servi par le logiciel libre [Ollama](https://ollama.com). Rien ne quitte alors le poste, aucune clé n'est nécessaire, rien n'est facturé. Le choix se fait tâche par tâche sur la page **« Modèles d'IA »** (`/modeles`).

| Tâche | Où dans l'outil | Ce que fait le modèle |
|---|---|---|
| Extraction des valeurs | Extraction, modes « Règles puis … » et « … seul » | Relève chaque variable avec une **citation exacte** du document |
| Import de fiche | Fiche › Importer (Word, Excel) | Propose les variables d'une fiche papier |
| Rédaction | Rédaction | Rédige à partir des agrégats de la cohorte (jamais des dossiers) |
| Recherche bibliographique | Revue bibliographique (assistant de requête) | Traduit une question en équation PubMed |

## 1. Ce qui ne change pas : les garde-fous

La réponse d'un modèle local passe par **exactement les mêmes contrôles** que celle de Claude (`server/src/engine/llm.ts`) :

1. la sortie est contrainte par le **même schéma JSON** (Ollama le reçoit dans `format` et contraint la génération) ;
2. chaque valeur doit être accompagnée d'une **citation retrouvée dans le document** (`llm-verify.ts`), sinon elle est rejetée ;
3. la citation ne doit pas **contredire** la valeur (« pas de diabète » ne justifie pas « diabète : oui », `quote-check.ts`) ;
4. la valeur passe par le **typage de la fiche** (listes d'options, bornes de plausibilité, `coerce.ts`).

Un modèle local n'a droit à aucune indulgence : un test automatique (`server/test/model-router.test.ts`) vérifie qu'une citation inventée par un modèle local est écartée.

Traçabilité : le modèle est consigné sous la forme `ollama:<étiquette>` (par exemple `ollama:qwen3.5:9b`) dans la passe d'extraction, dans la justification de chaque valeur (« Modèle local (ollama:qwen3.5:9b) ») et dans le rapport « Méthodes et traçabilité ».

## 2. Quels modèles, et pourquoi

Étiquettes vérifiées dans la bibliothèque d'Ollama (registry.ollama.ai) le 17 octobre 2026. Tailles : téléchargement par défaut (quantification 4 bits). Mémoire : ordre de grandeur pour un contexte de 16 à 32 k jetons, mémoire vive (processeur) ou vidéo (carte graphique).

| Tâche | Recommandé | Léger (8 Go) | Plus fort (32 Go / GPU 16 Go+) |
|---|---|---|---|
| Extraction | `qwen3.5:9b` — 6,6 Go, ~12 Go | `qwen3.5:4b` — 3,3 Go, ~8 Go | `mistral-small3.2:24b` — 15,2 Go, ~24 Go |
| Import de fiche | `qwen3.5:9b` (le même : un seul téléchargement) | `qwen3.5:4b` | `mistral-small3.2:24b` |
| Rédaction | `ministral-3:14b` — 9,1 Go, ~16 Go | `ministral-3:8b` — 6,0 Go, ~10 Go | `mistral-small3.2:24b` |
| Recherche bibliographique | `qwen3.5:4b` | `qwen3.5:2b` — 2,7 Go | `qwen3.5:9b` |

Autres choix proposés dans la liste : `gemma4:12b` (Google, 8,0 Go), `qwen3.5:27b` (17,5 Go). Tout modèle installé dans Ollama peut être choisi.

**Pourquoi Qwen 3.5 pour l'extraction.** L'exercice est surtout de **suivre un schéma JSON sans broder** et de recopier une citation à l'identique ; Qwen 3.5 (Alibaba, Apache 2.0, 201 langues dont le français) est, à taille égale, la famille la plus régulière sur la sortie structurée, et sa variante 4b tient sur un portable de 8 Go. Son mode « raisonnement » est désactivé pour ces tâches (`think: false`) : plus rapide, et la vérification des citations fait le reste.

**Pourquoi Mistral pour la rédaction.** Mistral Small 3.2 et Ministral 3 (Mistral AI, Apache 2.0) ont la meilleure plume française à taille égale et suivent bien une consigne système longue (« n'emploie que les chiffres fournis »). Ministral 3 demande Ollama 0.13.1 ou plus récent.

**Licences.** Tous les modèles recommandés sont sous **Apache 2.0** (usage, y compris commercial, et modification permis). Gemma 4 est passé sous Apache 2.0 (avril 2026) ; les **Gemma 3 et MedGemma** relèvent de conditions propres à Google (Gemma Terms of Use / Health AI Developer Foundations), et les **Llama** de la licence communautaire de Meta (conditions d'attribution et de seuil d'utilisateurs) : utilisables, mais à faire valider si l'étude a un cadre contractuel.

### Un modèle médical ?

MedGemma (`medgemma:4b`, `medgemma:27b`) est entraîné sur des textes médicaux. Nous ne le recommandons pas par défaut, honnêtement :

- ses conditions (Health AI Developer Foundations) ne sont pas une licence libre ;
- sa fiche indique qu'il a été évalué **essentiellement sur des consignes en anglais**, et qu'il n'est **pas destiné à éclairer directement une décision clinique** ;
- relever une valeur écrite dans un compte rendu est un exercice de lecture et de format, pas de connaissance médicale : un généraliste qui suit bien les consignes fait au moins aussi bien.

Il reste choisissable ; mesurez-le avec l'évaluation ci-dessous avant de vous y fier.

## 3. Installer

1. **Installer Ollama** (l'outil ne l'installe jamais lui-même) :
   - Windows : `OllamaSetup.exe` sur <https://ollama.com/download/windows> ;
   - macOS : <https://ollama.com/download/mac>, glisser dans Applications, ouvrir une fois ;
   - Linux : `curl -fsSL https://ollama.com/install.sh | sh` (ou le paquet de la distribution).
2. Ouvrir PubResearcher › **Modèles d'IA** : la page indique si Ollama répond, et sa version.
3. Pour une tâche : **Modèle local**, choisir le modèle, **Télécharger** (barre de progression), puis **Tester** — l'essai fait relever quatre valeurs d'un compte rendu fictif et vérifie JSON, citations et valeurs.
4. L'écran **Extraction** propose alors « Règles puis modèle local (…) » sans clé Anthropic ; le coût affiché est nul.

Aucun poids de modèle n'est livré dans les archives de PubResearcher : ils se téléchargent à la demande, par Ollama.

### Matériel

| Poste | Ce qui tourne confortablement |
|---|---|
| Portable 8 Go, sans GPU | `qwen3.5:4b` ; compter 2 à 4 minutes par dossier pour une fiche de 16 variables |
| Portable 16 Go (ou Mac Apple Silicon 16 Go) | `qwen3.5:9b`, `ministral-3:14b` |
| Station 32 Go, ou GPU 16–24 Go | `mistral-small3.2:24b`, `qwen3.5:27b` ; quelques secondes par dossier sur GPU |

Une carte graphique (NVIDIA, AMD) ou un Mac Apple Silicon accélère d'un facteur 10 à 50.

## 4. Réglages (administrateur)

| Variable | Défaut | Effet |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Adresse d'Ollama (même convention qu'Ollama : `0.0.0.0` est interrogé par 127.0.0.1) |
| `LOCAL_MODEL_ALLOW_REMOTE` | non | `1` autorise une adresse hors du poste (serveur de calcul de l'établissement) ; sinon refusée |
| `LOCAL_MODEL_TIMEOUT_MS` | 900000 (15 min) | Délai d'une réponse |
| `LOCAL_MODEL_MAX_CTX` | 32768 | Contexte maximal demandé (jetons) ; un dossier plus long est refusé avec un message, jamais tronqué en silence |

Les choix par tâche sont enregistrés dans `model-settings.json`, dans le dossier de données (comme la clé d'API : hors base, hors sauvegardes, hors exports). La précision mesurée est dans `model-evaluations.json`.

## 5. Mesurer la précision

```bash
npm run eval:models --workspace server -- qwen3.5:9b            # modèle local
npm run eval:models --workspace server -- qwen3.5:4b --limit 6  # 6 dossiers seulement
npm run eval:models --workspace server -- claude                 # Claude (clé requise, payant)
```

Le script (`server/scripts/eval-local-models.ts`) fait passer les 24 dossiers fictifs de démonstration (`scripts/demo-corpus.ts`, valeurs connues) par le chemin réel de l'extraction, 16 variables par dossier, et compte :

- **précision** : valeurs retenues exactes / valeurs retenues (après les garde-fous) ;
- **rappel** : valeurs retenues exactes / valeurs attendues ;
- **JSON invalide** : part des dossiers sans réponse exploitable (dont réponse tronquée) ;
- **citations écartées** : valeurs proposées puis rejetées par la vérification ;
- **latence** par dossier.

Le résultat s'affiche sur la page « Modèles d'IA ». **Ce n'est pas une validation clinique** : le corpus est synthétique, régulier, et écrit par les auteurs. Sur vos dossiers, mesurez la fiabilité sur un échantillon relu ([Méthodes et reproductibilité](methodes-et-reproductibilite.md)).

### Mesures obtenues pendant le développement

Machine de développement : 4 cœurs x86-64, 15 Go de mémoire, **sans carte graphique**, Ollama compilé depuis les sources (octobre 2026).

| Modèle | Dossiers | Précision | Rappel | JSON invalide | Citations écartées | Temps par dossier |
|---|---|---|---|---|---|---|
| `qwen3.5:4b` | 24 | **100 %** (380/380) | 99,0 % (380/384) | 0 % | 1,0 % (4 valeurs) | 146 s (processeur seul) |
| `qwen2.5:1.5b` | 2 (essai) | — | 0 % | **100 %** | — | 259 s |

- `qwen3.5:4b` : aucune valeur fausse retenue ; les 4 valeurs manquantes sont des citations que la vérification a écartées (le modèle n'a pas recopié le texte à l'identique) — le garde-fou a joué son rôle : une case vide plutôt qu'une valeur non justifiée.
- `qwen2.5:1.5b` (ancienne génération, 1,5 milliard de paramètres) s'emballe : la réponse dépasse le plafond de génération et n'est jamais un JSON complet. **Trop petit pour l'extraction** ; il n'est pas proposé.
- `qwen3.5:9b`, `mistral-small3.2:24b`, `ministral-3` et Claude **n'ont pas été mesurés ici** (mémoire et temps de calcul de la machine de développement). Le défaut `qwen3.5:9b` est recommandé par extrapolation au sein de la même famille ; mesurez-le sur votre poste avant de vous y fier.
- Ces chiffres valent pour un corpus synthétique très régulier (libellés « Âge : 54 ans ») ; ils ne disent rien de comptes rendus réels, plus variés.

## 6. Confidentialité

- **Modèle local** : les textes des dossiers sont lus par un programme du poste. Aucun envoi, donc pas de pseudonymisation par défaut (elle reste activable sur la page, si le protocole l'exige ; les citations sont ramenées au texte d'origine dans les deux cas).
- L'adresse d'Ollama est **bornée au poste** : une adresse sur le réseau est refusée sauf `LOCAL_MODEL_ALLOW_REMOTE=1`, et la page affiche alors un avertissement ; la pseudonymisation est alors **imposée**, comme pour Claude.
- **Téléchargement des modèles** : Ollama contacte `registry.ollama.ai` ; aucune donnée de patient n'y part.
- **Claude** : inchangé — textes pseudonymisés, envoyés à Anthropic ([Sécurité et données](securite-et-donnees.md)).

## 7. Sources

- Bibliothèque Ollama, pages et manifestes vérifiés : <https://ollama.com/library/qwen3.5>, <https://ollama.com/library/ministral-3>, <https://ollama.com/library/gemma4>, <https://ollama.com/library/medgemma>, <https://ollama.com/library/mistral-small3.2>.
- Sortie structurée d'Ollama (`format` = schéma JSON, température 0) : <https://docs.ollama.com/capabilities/structured-outputs>.
- Qwen 3.5, licence Apache 2.0, 201 langues, mode raisonnement par défaut : <https://huggingface.co/Qwen/Qwen3.5-9B>.
- Ministral 3, Apache 2.0, français : <https://ollama.com/library/ministral-3>.
- Gemma 4 sous Apache 2.0 : <https://www.techwyse.com/news/ai-search/google-deepmind-gemma-4-open-models-apache-2-0-release>, <https://www.mindstudio.ai/blog/gemma-4-apache-2-license-commercial-use>.
- MedGemma, conditions HAI-DEF, évaluation surtout en anglais, pas d'usage clinique direct : <https://huggingface.co/google/medgemma-27b-text-it>.
