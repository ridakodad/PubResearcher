import type { TemplateField } from '../domain/types.js';

/**
 * Construction du schéma de sortie et de la consigne envoyés au modèle.
 *
 * Isolé du client HTTP pour être testable sans appeler l'API.
 */

/** Réponse attendue du modèle pour une variable. */
export interface LlmFinding {
  /** Valeur relevée, chaîne vide si la variable n'est pas documentée. */
  value: string;
  /** Citation littérale du document justifiant la valeur. */
  quote: string;
  /** Nom du fichier d'où provient la citation. */
  document: string;
}

export interface LlmResponse {
  fields: Record<string, LlmFinding>;
}

/**
 * Schéma JSON contraignant la réponse.
 *
 * Toutes les valeurs sont des chaînes — le typage est fait ensuite par le
 * moteur de coercition déjà utilisé par les règles, ce qui garantit que les
 * deux modes d'extraction produisent exactement les mêmes types. Les champs
 * facultatifs sont représentés par la chaîne vide plutôt que par `null` :
 * les unions nullables ne font pas partie du sous-ensemble de JSON Schema
 * garanti par les sorties structurées.
 */
export function buildOutputSchema(fields: TemplateField[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const field of fields) {
    properties[field.key] = {
      type: 'object',
      description: `${field.label}${field.unit ? ` (${field.unit})` : ''}`,
      properties: {
        value: { type: 'string', description: expectedValue(field) },
        quote: {
          type: 'string',
          description:
            'Extrait recopié mot pour mot du document, contenant la valeur. ' +
            'Chaîne vide si la variable n’est pas documentée.',
        },
        document: {
          type: 'string',
          description: 'Nom du document contenant la citation, tel qu’il figure dans l’attribut « nom » (« Document 1 », « Document 2 »…).',
        },
      },
      required: ['value', 'quote', 'document'],
      additionalProperties: false,
    };
  }

  return {
    type: 'object',
    properties: {
      fields: {
        type: 'object',
        properties,
        required: fields.map((f) => f.key),
        additionalProperties: false,
      },
    },
    required: ['fields'],
    additionalProperties: false,
  };
}

/** Décrit à quoi doit ressembler la valeur attendue pour une variable. */
function expectedValue(field: TemplateField): string {
  switch (field.type) {
    case 'integer':
      return 'Nombre entier, sans unité (ex. « 54 »).';
    case 'number':
      return 'Nombre, point décimal, sans unité (ex. « 12.5 »).';
    case 'date':
      return 'Date au format AAAA-MM-JJ.';
    case 'boolean':
      return '« Oui » ou « Non ».';
    case 'enum':
      return `Exactement l’une de ces options : ${field.options.join(' | ')}.`;
    case 'multi':
      return `Une ou plusieurs de ces options, séparées par « | » : ${field.options.join(' | ')}.`;
    default:
      return 'Texte relevé dans le document.';
  }
}

/**
 * Consigne système.
 *
 * Identique d'un patient à l'autre : placée en tête et mise en cache, elle
 * n'est facturée au tarif plein qu'une fois par série de dossiers.
 */
export function buildSystemPrompt(fields: TemplateField[], templateName: string): string {
  const sections = new Map<string, TemplateField[]>();
  for (const field of fields) {
    const list = sections.get(field.section) ?? [];
    list.push(field);
    sections.set(field.section, list);
  }

  const dictionary = [...sections.entries()]
    .map(([section, list]) => {
      const lines = list.map((f) => {
        const parts = [`- ${f.key} — ${f.label}`];
        if (f.unit) parts.push(`unité : ${f.unit}`);
        parts.push(expectedValue(f));
        if (f.description) parts.push(f.description);
        return parts.join(' · ');
      });
      return `## ${section}\n${lines.join('\n')}`;
    })
    .join('\n\n');

  return `Tu relèves des variables de recherche clinique dans des dossiers patients, pour la fiche d'exploitation « ${templateName} ».

Tu reçois les documents d'un seul patient. Pour chaque variable, tu indiques la valeur relevée et la citation du document qui la justifie.

# Règles

1. Ne relève que ce qui est **écrit** dans les documents. Ne déduis rien, ne calcule rien, n'utilise aucune connaissance médicale extérieure pour combler un vide.
2. La citation doit être **recopiée mot pour mot** depuis le document, avec sa ponctuation. Elle est vérifiée automatiquement : une citation introuvable dans le document fait rejeter la valeur.
3. Variable non documentée : laisse \`value\`, \`quote\` et \`document\` à la chaîne vide. Une case vide est préférable à une valeur incertaine.
4. Distingue l'absence documentée de l'absence d'information. « pas de diabète » se relève « Non » ; un dossier qui ne parle jamais du diabète se laisse vide.
5. La négation ne porte que sur son propre élément. Dans « pas de diabète, HTA sous traitement », le diabète vaut « Non » et l'HTA « Oui ».
6. Respecte le format attendu de chaque variable. Pour les variables à choix, reprends une option **à l'identique**, sans la reformuler.
7. Une valeur contredite ailleurs dans le dossier, ou dont tu n'es pas sûr, se laisse vide.

# Variables à relever

${dictionary}`;
}

/**
 * Nom sous lequel un document est présenté au modèle.
 *
 * Le nom d'un fichier est souvent celui d'un patient (« DUPONT_Jean_CR.pdf ») : il ne quitte pas la machine. Le modèle
 * ne reçoit que « Document 1 », « Document 2 »… et le serveur retraduit sa réponse.
 */
export const documentAlias = (index: number): string => `Document ${index + 1}`;

/**
 * Message contenant les documents d'un patient. Ni le code du dossier ni les noms de fichiers n'y figurent : `name` est
 * l'alias de `documentAlias`.
 */
export function buildUserPrompt(documents: { name: string; text: string }[], maxCharsPerDocument: number): string {
  const blocks = documents.map((doc) => {
    const truncated = doc.text.length > maxCharsPerDocument;
    const body = truncated ? doc.text.slice(0, maxCharsPerDocument) : doc.text;
    // La troncature est signalée au modèle : sans cela il pourrait conclure à
    // une absence là où l'information a simplement été coupée.
    const note = truncated ? '\n[document tronqué]' : '';
    return `<document nom="${doc.name}">\n${body}${note}\n</document>`;
  });

  return `Documents d'un patient\n\n${blocks.join('\n\n')}`;
}
