/**
 * Modèles ouverts recommandés, tâche par tâche, pour tourner sur le poste du chercheur avec Ollama.
 *
 * Choix arrêtés en octobre 2026 (sources et raisonnement : `docs/modeles-locaux.md`). Chaque étiquette a été vérifiée
 * dans la bibliothèque d'Ollama (registry.ollama.ai) ; les tailles sont celles du téléchargement par défaut (quantifié
 * en 4 bits), la mémoire est un ordre de grandeur pour un contexte de 16 à 32 k jetons.
 *
 * Trois profils par tâche : un défaut raisonnable sur un portable de 16 Go, une variante légère (8 Go), une variante
 * plus forte (station de travail, 32 Go ou carte graphique de 16 Go et plus). Aucun de ces modèles n'est « médical » :
 * l'extraction repose sur le suivi des consignes et le respect du schéma JSON, que les garde-fous de l'outil
 * (citation vérifiée, typage) encadrent ensuite comme pour Claude.
 */

export type ModelTask = 'extraction' | 'form-import' | 'writing' | 'search-query';
export const MODEL_TASKS: readonly ModelTask[] = ['extraction', 'form-import', 'writing', 'search-query'];

export const TASK_LABELS: Record<ModelTask, string> = {
  extraction: 'Extraction des valeurs',
  'form-import': 'Import de fiche',
  writing: 'Rédaction',
  'search-query': 'Recherche bibliographique',
};

export interface CatalogModel {
  /** Étiquette exacte dans la bibliothèque d'Ollama. */
  tag: string;
  family: string;
  /** Taille du téléchargement, en Go. */
  downloadGb: number;
  /** Mémoire vive (ou vidéo) conseillée, en Go. */
  ramGb: number;
  licence: string;
  /** Remarque sur la licence quand elle impose des conditions. */
  licenceNote?: string;
  french: 'excellent' | 'bon' | 'correct';
  note: string;
}

const M = {
  'qwen3.5:4b': {
    tag: 'qwen3.5:4b', family: 'Qwen 3.5 (Alibaba)', downloadGb: 3.3, ramGb: 8, licence: 'Apache 2.0', french: 'bon',
    note: 'Petit modèle très discipliné sur le JSON ; pour un portable de 8 Go. Plus de valeurs manquées que le 9b.',
  },
  'qwen3.5:9b': {
    tag: 'qwen3.5:9b', family: 'Qwen 3.5 (Alibaba)', downloadGb: 6.6, ramGb: 12, licence: 'Apache 2.0', french: 'bon',
    note: 'Meilleur compromis précision / mémoire pour une sortie structurée ; 201 langues dont le français.',
  },
  'qwen3.5:27b': {
    tag: 'qwen3.5:27b', family: 'Qwen 3.5 (Alibaba)', downloadGb: 17.5, ramGb: 32, licence: 'Apache 2.0', french: 'bon',
    note: 'Version dense plus forte ; lente sans carte graphique.',
  },
  'qwen3.5:2b': {
    tag: 'qwen3.5:2b', family: 'Qwen 3.5 (Alibaba)', downloadGb: 2.7, ramGb: 6, licence: 'Apache 2.0', french: 'correct',
    note: 'Suffit pour transformer une question en équation de recherche ; à relire.',
  },
  'mistral-small3.2:24b': {
    tag: 'mistral-small3.2:24b', family: 'Mistral Small 3.2 (Mistral AI)', downloadGb: 15.2, ramGb: 24, licence: 'Apache 2.0',
    french: 'excellent', note: 'Conçu en France, excellent en français médical, très bon suivi des consignes et du JSON.',
  },
  'ministral-3:8b': {
    tag: 'ministral-3:8b', family: 'Ministral 3 (Mistral AI)', downloadGb: 6.0, ramGb: 10, licence: 'Apache 2.0',
    french: 'excellent', note: 'Petit modèle de Mistral AI, français natif ; demande Ollama 0.13.1 ou plus récent.',
  },
  'ministral-3:14b': {
    tag: 'ministral-3:14b', family: 'Ministral 3 (Mistral AI)', downloadGb: 9.1, ramGb: 16, licence: 'Apache 2.0',
    french: 'excellent', note: 'Rédaction française soignée sur un portable de 16 Go.',
  },
  'gemma4:12b': {
    tag: 'gemma4:12b', family: 'Gemma 4 (Google)', downloadGb: 8.0, ramGb: 16, licence: 'Apache 2.0',
    french: 'bon', note: 'Alternative solide ; Gemma 4 est sous Apache 2.0 (les Gemma 3 et MedGemma ont des conditions propres).',
  },
} satisfies Record<string, CatalogModel>;

type Tag = keyof typeof M;

export interface TaskRecommendation {
  recommended: CatalogModel;
  light: CatalogModel;
  strong: CatalogModel;
  why: string;
}

const rec = (recommended: Tag, light: Tag, strong: Tag, why: string): TaskRecommendation => ({
  recommended: M[recommended],
  light: M[light],
  strong: M[strong],
  why,
});

export const RECOMMENDATIONS: Record<ModelTask, TaskRecommendation> = {
  extraction: rec(
    'qwen3.5:9b',
    'qwen3.5:4b',
    'mistral-small3.2:24b',
    'Relever une valeur et sa citation exacte demande surtout de suivre le schéma JSON sans broder : Qwen 3.5 y est le plus régulier à taille égale. Mistral Small 3.2 lit mieux les tournures françaises, au prix de 24 Go de mémoire.',
  ),
  'form-import': rec(
    'qwen3.5:9b',
    'qwen3.5:4b',
    'mistral-small3.2:24b',
    'Même exercice que l’extraction (structure imposée) sur un document court : le même modèle sert aux deux, inutile d’en télécharger un second.',
  ),
  writing: rec(
    'ministral-3:14b',
    'ministral-3:8b',
    'mistral-small3.2:24b',
    'Rédiger un texte scientifique en français : les modèles de Mistral AI ont la meilleure plume française à taille égale. Le relevé de cohorte (agrégats) tient largement dans leur contexte.',
  ),
  'search-query': rec(
    'qwen3.5:4b',
    'qwen3.5:2b',
    'qwen3.5:9b',
    'Traduire une question en équation PubMed (termes MeSH, opérateurs) est court et structuré : un petit modèle suffit, l’équation est relue avant d’être lancée.',
  ),
};

/** Le modèle local proposé par défaut pour une tâche. */
export const defaultLocalModel = (task: ModelTask): string => RECOMMENDATIONS[task].recommended.tag;

/** Toutes les fiches du catalogue, sans doublon. */
export const CATALOG: CatalogModel[] = Object.values(M);

/** Un modèle médical a-t-il sa place ? Réponse honnête, affichée telle quelle. */
export const MEDICAL_MODEL_NOTE =
  'MedGemma (Google, medgemma:4b et medgemma:27b dans Ollama) est entraîné sur des textes médicaux, mais : ses conditions d’utilisation (Health AI Developer Foundations) ne sont pas une licence libre, il n’a été évalué que sur des consignes en anglais, et Google précise qu’il n’est pas destiné à éclairer directement une décision clinique. Pour relever des valeurs écrites en toutes lettres dans un compte rendu français, un modèle généraliste qui suit bien les consignes fait au moins aussi bien. Il reste utilisable : choisissez-le dans la liste, et mesurez sa précision avec « Tester » et l’évaluation sur le corpus de démonstration.';

/** Instructions d'installation d'Ollama, système par système (l'outil n'installe jamais de logiciel lui-même). */
export const OLLAMA_INSTALL = {
  url: 'https://ollama.com/download',
  steps: {
    windows: 'Téléchargez « OllamaSetup.exe » sur https://ollama.com/download/windows, lancez-le : Ollama démarre seul et reste dans la zone de notification.',
    macos: 'Téléchargez Ollama pour macOS sur https://ollama.com/download/mac, glissez-le dans Applications et ouvrez-le une fois.',
    linux: 'Dans un terminal : curl -fsSL https://ollama.com/install.sh | sh  (ou le paquet de votre distribution), puis « ollama serve » s’il ne démarre pas comme service.',
  },
} as const;
