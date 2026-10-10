import { z } from 'zod';

/**
 * Messages de validation en français.
 *
 * Zod parle anglais par défaut, et ces messages arrivent tels quels dans les notifications de l'interface :
 * « String must contain at most 80 character(s) » n'aide personne dans une application de chercheurs
 * francophones. Les messages que les schémas fixent eux-mêmes (« Au moins un libellé est requis. »)
 * prennent toujours le pas : cette table ne remplace que les messages par défaut.
 */
const TYPES: Record<string, string> = {
  string: 'un texte',
  number: 'un nombre',
  integer: 'un entier',
  boolean: 'oui ou non',
  object: 'un objet',
  array: 'une liste',
  null: 'une valeur vide',
  undefined: 'une valeur',
  nan: 'un nombre',
  date: 'une date',
};

const type = (name: string): string => TYPES[name] ?? name;

const errorMap: z.ZodErrorMap = (issue, ctx) => {
  switch (issue.code) {
    case 'invalid_type':
      if (issue.received === 'undefined') return { message: 'Champ requis.' };
      return { message: `Attendu : ${type(issue.expected)}. Reçu : ${type(issue.received)}.` };
    case 'invalid_literal':
      return { message: `Valeur attendue : ${JSON.stringify(issue.expected)}.` };
    case 'unrecognized_keys':
      return { message: `Champ(s) inconnu(s) : ${issue.keys.join(', ')}.` };
    case 'invalid_union':
      return { message: 'Valeur invalide.' };
    case 'invalid_enum_value':
      return { message: `Valeur non reconnue : « ${String(issue.received)} ». Valeurs possibles : ${issue.options.join(', ')}.` };
    case 'invalid_string':
      if (issue.validation === 'email') return { message: 'Adresse e-mail invalide.' };
      if (issue.validation === 'url') return { message: 'Adresse web invalide.' };
      return { message: 'Format invalide.' };
    case 'too_small': {
      const min = Number(issue.minimum);
      if (issue.type === 'string') return { message: min <= 1 ? 'Ne peut pas être vide.' : `Au moins ${min} caractères.` };
      if (issue.type === 'array') return { message: min <= 1 ? 'Au moins un élément est requis.' : `Au moins ${min} éléments.` };
      return { message: `Doit être ${issue.inclusive ? 'supérieur ou égal à' : 'supérieur à'} ${min}.` };
    }
    case 'too_big': {
      const max = Number(issue.maximum);
      if (issue.type === 'string') return { message: `${max} caractères au plus.` };
      if (issue.type === 'array') return { message: `${max} éléments au plus.` };
      return { message: `Doit être ${issue.inclusive ? 'inférieur ou égal à' : 'inférieur à'} ${max}.` };
    }
    case 'not_multiple_of':
      return { message: `Doit être un multiple de ${issue.multipleOf}.` };
    case 'custom':
      return { message: issue.message ?? 'Valeur invalide.' };
    default:
      return { message: ctx.defaultError };
  }
};

z.setErrorMap(errorMap);
