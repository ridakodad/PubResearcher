import { z } from 'zod';

/** Liste d'identifiants pour une action groupée (sélection multiple dans l'interface). */
export const bulkIdsSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1, 'Aucun élément sélectionné.').max(5000, 'Au plus 5 000 éléments à la fois.'),
});
