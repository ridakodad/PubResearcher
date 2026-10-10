import type { FieldType } from './types.js';

/**
 * Nom des types de variable tel qu'on l'écrit dans un document destiné à un lecteur (dictionnaire, synthèse).
 * Mêmes libellés que l'interface (`web/src/lib/types.ts`) : le dictionnaire joint à un article doit parler
 * comme l'écran qui l'a produit. La clé technique (`integer`, `enum`…) reste dans les colonnes lisibles par machine.
 */
export const FIELD_TYPE_LABELS_FR: Record<FieldType, string> = {
  text: 'Texte libre',
  number: 'Nombre',
  integer: 'Nombre entier',
  date: 'Date',
  boolean: 'Oui / Non',
  enum: 'Choix unique',
  multi: 'Choix multiple',
};

export const fieldTypeLabel = (type: string): string => FIELD_TYPE_LABELS_FR[type as FieldType] ?? type;
