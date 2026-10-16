/**
 * Regroupement des fichiers déposés en dossiers patients.
 *
 * Un dossier déposé = un patient. Mais « le dossier qui contient les patients » et « le dossier d'un patient
 * qui contient des sous-dossiers » ont la même forme, et les confondre est le pire des deux erreurs : fusionner
 * vingt-quatre patients sous un seul code mélange leurs données sans que rien ne le signale. Quand la forme est
 * ambiguë, on le dit et on laisse choisir — la lecture « un sous-dossier = un patient » étant celle par défaut.
 */

export interface PathItem {
  /** Chemin relatif au dossier déposé, ex. « cohorte/PAT-001/scanner/coupe1.dcm ». */
  path: string;
}

/** cohort : un sous-dossier = un patient ; files : un fichier = un patient ; single : tout le dossier = un patient. */
export type Layout = 'cohort' | 'files' | 'single';

export interface Structure {
  /** Le seul dossier de premier niveau : la racine déposée. */
  root: string;
  /** Sous-dossiers de la racine qui contiennent des fichiers. */
  subfolders: string[];
  /** Fichiers posés directement dans la racine. */
  direct: number;
  /** Lecture proposée par défaut. */
  suggested: Layout;
}

/** Nom de dossier qui désigne un ensemble de patients plutôt qu'un patient. */
const COHORT_NAME = /cohort|patients|dossiers|etude|study|serie|inclus/i;

const segmentsOf = (path: string): string[] => path.split('/').filter(Boolean);

/**
 * La forme ambiguë : un seul dossier de premier niveau, avec au moins un sous-dossier ou au moins deux fichiers.
 * `null` dans tous les autres cas (plusieurs dossiers déposés = autant de patients, sans ambiguïté).
 */
export function detectStructure(items: PathItem[]): Structure | null {
  const roots = new Set<string>();
  for (const item of items) {
    const s = segmentsOf(item.path);
    if (s.length > 1) roots.add(s[0]!);
    else return null; // un fichier hors dossier : lot « racine », pas une cohorte
  }
  if (roots.size !== 1) return null;
  const root = [...roots][0]!;
  const sub = new Set<string>();
  let direct = 0;
  for (const item of items) {
    const s = segmentsOf(item.path);
    if (s.length === 2) direct++;
    else if (s.length >= 3) sub.add(s[1]!);
  }
  // Un seul dossier déposé : sa lecture est toujours demandée dès qu'elle est ambiguë. Avec un seul sous-dossier, ou
  // seulement des fichiers, le dossier lui-même devenait le patient — « cohorte » se retrouvait code de dossier.
  if (sub.size === 0 && direct < 2) return null;
  const plainName = root.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const cohortName = COHORT_NAME.test(plainName);
  // Plusieurs sous-dossiers, ou un seul sans fichier à côté (« cohorte/PAT-001/… ») : des patients. Un sous-dossier à
  // côté de fichiers (« PAT-001/scans/ » et « PAT-001/cr.pdf ») : un seul patient, sauf nom de cohorte explicite.
  const suggested: Layout =
    sub.size >= 2 || (sub.size === 1 && (direct === 0 || cohortName)) ? 'cohort' : sub.size === 0 && cohortName ? 'files' : 'single';
  return { root, subfolders: [...sub].sort((a, b) => a.localeCompare(b, 'fr', { numeric: true })), direct, suggested };
}

/**
 * Code du dossier patient d'un fichier. Chaîne vide : fichier hors dossier, dont le code reste à saisir.
 */
export function patientCodeOf(path: string, structure: Structure | null, layout: Layout): string {
  const s = segmentsOf(path);
  if (structure && layout === 'cohort' && s[0] === structure.root) return s.length >= 3 ? s[1]! : '';
  // Un fichier = un patient : son nom sans extension est le code (« PAT-001.pdf » → « PAT-001 »).
  if (structure && layout === 'files' && s[0] === structure.root) {
    return s.length === 2 ? s[1]!.replace(/\.[^.]+$/, '') : s[1]!;
  }
  return s.length > 1 ? s[0]! : '';
}

export function groupItems<T extends PathItem>(items: T[], structure: Structure | null, layout: Layout): { code: string; files: T[] }[] {
  const byCode = new Map<string, T[]>();
  for (const item of items) {
    const code = patientCodeOf(item.path, structure, layout);
    const list = byCode.get(code);
    if (list) list.push(item);
    else byCode.set(code, [item]);
  }
  return [...byCode.entries()]
    .map(([code, files]) => ({ code, files }))
    .sort((a, b) => a.code.localeCompare(b.code, 'fr', { numeric: true }));
}
