import { LlmError } from '../engine/llm.js';
import { generateStructured, ModelCallError, routeFor, taskAvailable } from '../engine/model-router.js';
import { z } from 'zod';
import { pseudonymize } from '../engine/pseudonymize.js';
import { EutilsClient, EutilsError, eutilsConfig } from './eutils.js';

/**
 * Recherche bibliographique en langage naturel : d'une question (« chez l'adulte avec une pneumopathie
 * communautaire, une antibiothérapie courte est-elle aussi efficace… ? ») à une équation PubMed relue.
 *
 * Les règles suivies sont celles d'une recherche systématique (Cochrane Handbook, chapitre 4 ; PRISMA-S) :
 * 1. la question est découpée en concepts (PICO) ; d'ordinaire seuls la Population et l'Intervention entrent
 *    dans l'équation — le comparateur et le critère de jugement sont souvent mal décrits dans les résumés, et
 *    les ajouter fait perdre des articles pertinents ;
 * 2. chaque concept est un bloc « OU » : vocabulaire contrôlé (`"Terme"[Mesh]`) et synonymes en texte libre
 *    (`terme*[tiab]`, variantes d'orthographe, acronymes), en anglais puisque PubMed indexe en anglais ;
 * 3. les blocs sont combinés par « ET » ; un filtre validé de type d'étude s'y ajoute quand l'utilisateur le
 *    demande (filtre Cochrane très sensible pour les essais randomisés…) ;
 * 4. les années ne vont PAS dans l'équation : la recherche les passe déjà à PubMed (`mindate`/`maxdate`), et le
 *    journal les consigne à part.
 *
 * Puis vient la vérification, avec de vrais nombres PubMed : chaque descripteur MeSH est éprouvé (`"X"[Mesh]`
 * doit rendre au moins un article, sinon il passe en texte libre), chaque bloc et l'équation entière sont
 * comptés ; zéro résultat → le concept le moins important est retiré (trois tours au plus) ; plusieurs milliers
 * → un avertissement propose de resserrer.
 *
 * Le brouillon vient de Claude quand une clé est disponible, sinon de règles déterministes (petit dictionnaire
 * français → anglais), de moindre qualité — la réponse le dit. Dans les deux cas l'utilisateur relit et valide
 * l'équation avant de lancer la recherche ; c'est ce que le journal consigne.
 */

/* ───────────────────────────────── Types ───────────────────────────────── */

export type StudyType = 'rct' | 'systematic_review' | 'observational' | 'diagnostic';
export const STUDY_TYPES: readonly StudyType[] = ['rct', 'systematic_review', 'observational', 'diagnostic'];

export const STUDY_TYPE_LABELS: Record<StudyType, string> = {
  rct: 'Essais randomisés',
  systematic_review: 'Revues systématiques et méta-analyses',
  observational: 'Études observationnelles',
  diagnostic: 'Études diagnostiques',
};

export type ConceptRole = 'population' | 'intervention' | 'comparison' | 'outcome' | 'other';

export interface Pico {
  population: string;
  intervention: string;
  comparison: string;
  outcome: string;
  studyDesign: string;
}

export interface StrategyConcept {
  name: string;
  role: ConceptRole;
  /** 1 = indispensable, 3 = accessoire : l'ordre dans lequel les concepts sont retirés quand rien ne sort. */
  importance: number;
  mesh: string[];
  freeText: string[];
  /** Le bloc « OU » tel qu'il entre dans l'équation. */
  block: string;
}

export interface SearchStrategy {
  question: string;
  pico: Pico;
  concepts: StrategyConcept[];
  equation: string;
  filters: string[];
  counts: { total: number | null; perConcept: { name: string; count: number | null }[] };
  rationale: string;
  warnings: string[];
  model: string | null;
  method: 'llm' | 'rules';
}

export interface BuildInput {
  question: string;
  lang?: 'fr' | 'en';
  yearFrom?: number;
  yearTo?: number;
  studyTypes?: StudyType[];
}

/** Ce que la vérification demande à PubMed : un nombre de résultats (et les termes que PubMed n'a pas compris). */
export type PubmedCounter = (term: string, years?: { yearFrom?: number; yearTo?: number }) => Promise<{ count: number; warnings: string[] }>;

/** Compteur réel : le client E-utilities du serveur, avec son limiteur de débit partagé (3 ou 10 requêtes/s). */
export function pubmedCounter(client: EutilsClient = new EutilsClient(eutilsConfig())): PubmedCounter {
  return async (term, years = {}) => {
    const r = await client.esearch(term, {
      mindate: years.yearFrom ? String(years.yearFrom) : undefined,
      maxdate: years.yearTo ? String(years.yearTo) : undefined,
    });
    return { count: r.count, warnings: r.warnings };
  };
}

/* ─────────────────────────── Filtres de type d'étude ─────────────────────── */

/**
 * Filtres publiés et validés, recopiés tels quels :
 * - essais randomisés : Cochrane Highly Sensitive Search Strategy, version « sensibilité maximale » pour PubMed
 *   (Cochrane Handbook, Technical Supplement to Chapter 4, 3.6.1) ;
 * - revues systématiques : le sous-ensemble `systematic[sb]` de PubMed, élargi aux méta-analyses ;
 * - observationnelles et diagnostiques : blocs sensibles usuels (MeSH + texte libre), sans prétention de validation.
 */
export const STUDY_FILTERS: Record<StudyType, string> = {
  rct:
    '((randomized controlled trial[pt] OR controlled clinical trial[pt] OR randomized[tiab] OR placebo[tiab] OR drug therapy[sh] OR randomly[tiab] OR trial[tiab] OR groups[tiab]) NOT (animals[mh] NOT humans[mh]))',
  systematic_review: '(systematic[sb] OR meta-analysis[pt] OR "systematic review"[tiab] OR meta-analy*[tiab] OR metaanaly*[tiab])',
  observational:
    '("Cohort Studies"[Mesh] OR "Case-Control Studies"[Mesh] OR cohort*[tiab] OR "case control"[tiab] OR "case-control"[tiab] OR observational[tiab] OR registry[tiab] OR retrospective*[tiab] OR prospective*[tiab])',
  diagnostic:
    '("Sensitivity and Specificity"[Mesh] OR sensitivity[tiab] OR specificity[tiab] OR "predictive value*"[tiab] OR accuracy[tiab] OR "ROC Curve"[Mesh] OR "area under the curve"[tiab])',
};

/* ──────────────────────────── Mise en forme PubMed ───────────────────────── */

/** Un terme débarrassé de ce qu'un modèle ou un utilisateur y aurait mis : guillemets, balises, opérateurs. */
export function cleanTerm(raw: string): string {
  return raw
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/["“”«»()]/g, ' ')
    .replace(/\b(AND|OR|NOT)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

export const meshTag = (term: string): string => `"${cleanTerm(term)}"[Mesh]`;

/** Texte libre : expression entre guillemets si plusieurs mots ou un tiret, troncature `*` conservée. */
export function tiabTag(term: string): string {
  const t = cleanTerm(term);
  return /[\s-]/.test(t) ? `"${t}"[tiab]` : `${t}[tiab]`;
}

export function conceptBlock(mesh: string[], freeText: string[]): string {
  const parts = [...new Set([...mesh.map(cleanTerm).filter(Boolean).map(meshTag), ...freeText.map(cleanTerm).filter(Boolean).map(tiabTag)])];
  if (parts.length === 0) return '';
  return parts.length === 1 ? parts[0]! : `(${parts.join(' OR ')})`;
}

export function assembleEquation(concepts: { block: string }[], studyTypes: StudyType[]): string {
  const blocks = concepts.map((c) => c.block).filter(Boolean);
  for (const s of studyTypes) blocks.push(STUDY_FILTERS[s]);
  return blocks.join(' AND ');
}

/* ────────────────────────────── Règles (sans clé) ─────────────────────────── */

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\u0153/g, 'oe')
    .replace(/\u00e6/g, 'ae')
    .replace(/[’']/g, ' ');

interface DictEntry {
  /** Formes françaises ou anglaises (repliées : minuscules, sans accents). */
  keys: string[];
  name: string;
  role: ConceptRole;
  importance: number;
  mesh: string[];
  freeText: string[];
}

/**
 * Petit dictionnaire médical français → anglais pour le mode sans clé. Il ne prétend pas couvrir la médecine :
 * il donne un point de départ correct sur les questions courantes, que l'utilisateur complète. Les rôles servent
 * au découpage PICO ; les âges sont des concepts accessoires (retirés les premiers si rien ne sort).
 */
const DICTIONARY: DictEntry[] = [
  // — Populations / pathologies
  { keys: ['pneumopathie communautaire', 'pneumonie communautaire', 'community acquired pneumonia', 'community-acquired pneumonia'], name: 'Pneumopathie communautaire', role: 'population', importance: 1, mesh: ['Community-Acquired Infections', 'Pneumonia'], freeText: ['community-acquired pneumonia', 'community acquired pneumonia', 'CAP'] },
  { keys: ['pneumopathie', 'pneumonie', 'pneumonia'], name: 'Pneumopathie', role: 'population', importance: 1, mesh: ['Pneumonia'], freeText: ['pneumonia*'] },
  { keys: ['diabete de type 2', 'diabete type 2', 'diabetique de type 2', 'diabetiques de type 2', 'type 2 diabetes'], name: 'Diabète de type 2', role: 'population', importance: 1, mesh: ['Diabetes Mellitus, Type 2'], freeText: ['type 2 diabetes', 'T2DM', 'NIDDM'] },
  { keys: ['diabete de type 1', 'diabete type 1', 'diabetique de type 1', 'diabetiques de type 1', 'type 1 diabetes'], name: 'Diabète de type 1', role: 'population', importance: 1, mesh: ['Diabetes Mellitus, Type 1'], freeText: ['type 1 diabetes', 'T1DM'] },
  { keys: ['diabete', 'diabetique', 'diabetes', 'diabetic'], name: 'Diabète', role: 'population', importance: 1, mesh: ['Diabetes Mellitus'], freeText: ['diabet*'] },
  { keys: ['hypertension arterielle', 'hypertension', 'hta'], name: 'Hypertension', role: 'population', importance: 1, mesh: ['Hypertension'], freeText: ['hypertensi*', 'high blood pressure'] },
  { keys: ['insuffisance cardiaque', 'heart failure'], name: 'Insuffisance cardiaque', role: 'population', importance: 1, mesh: ['Heart Failure'], freeText: ['heart failure', 'cardiac failure'] },
  { keys: ['infarctus du myocarde', 'infarctus', 'myocardial infarction'], name: 'Infarctus du myocarde', role: 'population', importance: 1, mesh: ['Myocardial Infarction'], freeText: ['myocardial infarction', 'heart attack', 'STEMI', 'NSTEMI'] },
  { keys: ['fibrillation atriale', 'fibrillation auriculaire', 'atrial fibrillation'], name: 'Fibrillation atriale', role: 'population', importance: 1, mesh: ['Atrial Fibrillation'], freeText: ['atrial fibrillation', 'auricular fibrillation'] },
  { keys: ['accident vasculaire cerebral', 'avc', 'stroke'], name: 'AVC', role: 'population', importance: 1, mesh: ['Stroke'], freeText: ['stroke', 'cerebrovascular accident*', 'CVA'] },
  { keys: ['asthme', 'asthma'], name: 'Asthme', role: 'population', importance: 1, mesh: ['Asthma'], freeText: ['asthma*'] },
  { keys: ['bpco', 'bronchopneumopathie chronique obstructive', 'copd'], name: 'BPCO', role: 'population', importance: 1, mesh: ['Pulmonary Disease, Chronic Obstructive'], freeText: ['COPD', 'chronic obstructive pulmonary disease'] },
  { keys: ['sepsis', 'choc septique', 'septic shock'], name: 'Sepsis', role: 'population', importance: 1, mesh: ['Sepsis', 'Shock, Septic'], freeText: ['sepsis', 'septic*'] },
  { keys: ['appendicite', 'appendicitis'], name: 'Appendicite', role: 'population', importance: 1, mesh: ['Appendicitis'], freeText: ['appendicitis'] },
  { keys: ['cancer du sein', 'breast cancer'], name: 'Cancer du sein', role: 'population', importance: 1, mesh: ['Breast Neoplasms'], freeText: ['breast cancer*', 'breast neoplasm*', 'breast tumor*', 'breast tumour*'] },
  { keys: ['cancer de la prostate', 'cancer prostatique', 'prostate cancer'], name: 'Cancer de la prostate', role: 'population', importance: 1, mesh: ['Prostatic Neoplasms'], freeText: ['prostate cancer*', 'prostatic neoplasm*'] },
  { keys: ['cancer colorectal', 'colorectal cancer'], name: 'Cancer colorectal', role: 'population', importance: 1, mesh: ['Colorectal Neoplasms'], freeText: ['colorectal cancer*', 'colorectal neoplasm*'] },
  { keys: ['cancer du poumon', 'cancer bronchique', 'lung cancer'], name: 'Cancer du poumon', role: 'population', importance: 1, mesh: ['Lung Neoplasms'], freeText: ['lung cancer*', 'lung neoplasm*', 'NSCLC'] },
  { keys: ['hypertrophie benigne de la prostate', 'adenome de prostate', 'hbp', 'benign prostatic hyperplasia'], name: 'Hypertrophie bénigne de la prostate', role: 'population', importance: 1, mesh: ['Prostatic Hyperplasia'], freeText: ['benign prostatic hyperplasia', 'BPH', 'prostatic hyperplasia'] },
  { keys: ['insuffisance renale chronique', 'maladie renale chronique', 'chronic kidney disease'], name: 'Insuffisance rénale chronique', role: 'population', importance: 1, mesh: ['Renal Insufficiency, Chronic'], freeText: ['chronic kidney disease', 'CKD', 'chronic renal insufficiency'] },
  { keys: ['depression', 'episode depressif'], name: 'Dépression', role: 'population', importance: 1, mesh: ['Depression', 'Depressive Disorder'], freeText: ['depress*'] },
  { keys: ['obesite', 'obese', 'obesity'], name: 'Obésité', role: 'population', importance: 1, mesh: ['Obesity'], freeText: ['obes*'] },
  { keys: ['covid-19', 'covid', 'sars-cov-2'], name: 'COVID-19', role: 'population', importance: 1, mesh: ['COVID-19'], freeText: ['COVID-19', 'SARS-CoV-2', 'coronavirus disease 2019'] },
  { keys: ['infection urinaire', 'pyelonephrite', 'urinary tract infection'], name: 'Infection urinaire', role: 'population', importance: 1, mesh: ['Urinary Tract Infections'], freeText: ['urinary tract infection*', 'UTI', 'pyelonephritis'] },
  { keys: ['fracture du col du femur', 'fracture de hanche', 'hip fracture'], name: 'Fracture de hanche', role: 'population', importance: 1, mesh: ['Hip Fractures'], freeText: ['hip fracture*', 'femoral neck fracture*'] },
  { keys: ['douleur postoperatoire', 'postoperative pain'], name: 'Douleur postopératoire', role: 'population', importance: 1, mesh: ['Pain, Postoperative'], freeText: ['postoperative pain', 'post-operative pain'] },
  { keys: ['grossesse', 'femme enceinte', 'femmes enceintes', 'pregnancy', 'pregnant'], name: 'Grossesse', role: 'population', importance: 2, mesh: ['Pregnancy'], freeText: ['pregnan*'] },
  // — Âges : concepts accessoires
  { keys: ['nouveau-ne', 'nouveau-nes', 'neonate', 'newborn'], name: 'Nouveau-né', role: 'population', importance: 3, mesh: ['Infant, Newborn'], freeText: ['newborn*', 'neonat*'] },
  { keys: ['enfant', 'enfants', 'pediatrique', 'child', 'children', 'paediatric', 'pediatric'], name: 'Enfant', role: 'population', importance: 3, mesh: ['Child'], freeText: ['child*', 'pediatric*', 'paediatric*'] },
  { keys: ['personne agee', 'personnes agees', 'sujet age', 'sujets ages', 'elderly', 'older adults'], name: 'Sujet âgé', role: 'population', importance: 3, mesh: ['Aged'], freeText: ['elderly', 'older adult*', 'older people'] },
  { keys: ['adulte', 'adultes', 'adult', 'adults'], name: 'Adulte', role: 'population', importance: 3, mesh: ['Adult'], freeText: ['adult*'] },
  // — Interventions
  { keys: ['antibiotherapie', 'antibiotique', 'antibiotiques', 'antibiotic', 'antibiotics'], name: 'Antibiothérapie', role: 'intervention', importance: 1, mesh: ['Anti-Bacterial Agents'], freeText: ['antibiotic*', 'antimicrobial*', 'antibacterial*'] },
  { keys: ['courte duree', 'traitement court', 'courte', 'court', 'short course', 'short-course', 'duree', 'duration'], name: 'Durée de traitement', role: 'intervention', importance: 2, mesh: ['Drug Administration Schedule'], freeText: ['short course', 'short-course', 'duration', 'days'] },
  { keys: ['corticoide', 'corticoides', 'corticotherapie', 'corticosteroid', 'corticosteroids'], name: 'Corticoïdes', role: 'intervention', importance: 1, mesh: ['Adrenal Cortex Hormones', 'Glucocorticoids'], freeText: ['corticosteroid*', 'glucocorticoid*', 'steroid*', 'dexamethasone', 'prednisolone', 'hydrocortisone'] },
  { keys: ['anticoagulant', 'anticoagulants', 'anticoagulation'], name: 'Anticoagulation', role: 'intervention', importance: 1, mesh: ['Anticoagulants'], freeText: ['anticoagula*'] },
  { keys: ['metformine', 'metformin'], name: 'Metformine', role: 'intervention', importance: 1, mesh: ['Metformin'], freeText: ['metformin'] },
  { keys: ['statine', 'statines', 'statin', 'statins'], name: 'Statines', role: 'intervention', importance: 1, mesh: ['Hydroxymethylglutaryl-CoA Reductase Inhibitors'], freeText: ['statin*', 'atorvastatin', 'rosuvastatin', 'simvastatin'] },
  { keys: ['vaccin', 'vaccins', 'vaccination', 'vaccine', 'vaccines'], name: 'Vaccination', role: 'intervention', importance: 1, mesh: ['Vaccination', 'Vaccines'], freeText: ['vaccin*', 'immunization*', 'immunisation*'] },
  { keys: ['chirurgie', 'chirurgical', 'surgery', 'surgical'], name: 'Chirurgie', role: 'intervention', importance: 2, mesh: ['Surgical Procedures, Operative'], freeText: ['surg*', 'operative'] },
  { keys: ['laparoscopie', 'coelioscopie', 'laparoscopic', 'laparoscopy'], name: 'Cœlioscopie', role: 'intervention', importance: 1, mesh: ['Laparoscopy'], freeText: ['laparoscop*'] },
  { keys: ['appendicectomie', 'appendectomy'], name: 'Appendicectomie', role: 'intervention', importance: 1, mesh: ['Appendectomy'], freeText: ['appendectom*', 'appendicectom*'] },
  { keys: ['holep', 'enucleation prostatique au laser holmium'], name: 'HoLEP', role: 'intervention', importance: 1, mesh: [], freeText: ['HoLEP', 'holmium laser enucleation'] },
  { keys: ['rtup', 'resection transurethrale de prostate', 'turp'], name: 'RTUP', role: 'intervention', importance: 1, mesh: ['Transurethral Resection of Prostate'], freeText: ['TURP', 'transurethral resection'] },
  { keys: ['activite physique', 'exercice physique', 'reeducation', 'physical activity', 'exercise'], name: 'Activité physique', role: 'intervention', importance: 1, mesh: ['Exercise', 'Exercise Therapy'], freeText: ['exercise*', 'physical activit*', 'physical training'] },
  { keys: ['telemedecine', 'teleconsultation', 'telemedicine'], name: 'Télémédecine', role: 'intervention', importance: 1, mesh: ['Telemedicine'], freeText: ['telemedicine', 'telehealth', 'teleconsultation*'] },
  { keys: ['opioide', 'opioides', 'morphine', 'opioid', 'opioids'], name: 'Opioïdes', role: 'intervention', importance: 1, mesh: ['Analgesics, Opioid'], freeText: ['opioid*', 'morphine'] },
  { keys: ['paracetamol', 'acetaminophen'], name: 'Paracétamol', role: 'intervention', importance: 1, mesh: ['Acetaminophen'], freeText: ['paracetamol', 'acetaminophen'] },
  { keys: ['ains', 'anti-inflammatoire', 'anti-inflammatoires', 'nsaid', 'nsaids'], name: 'AINS', role: 'intervention', importance: 1, mesh: ['Anti-Inflammatory Agents, Non-Steroidal'], freeText: ['NSAID*', 'non-steroidal anti-inflammatory'] },
  { keys: ['ventilation non invasive', 'vni', 'non-invasive ventilation', 'noninvasive ventilation'], name: 'Ventilation non invasive', role: 'intervention', importance: 1, mesh: ['Noninvasive Ventilation'], freeText: ['non-invasive ventilation', 'noninvasive ventilation', 'NIV', 'CPAP'] },
  { keys: ['oxygenotherapie a haut debit', 'oxygene a haut debit', 'high-flow nasal', 'high flow nasal'], name: 'Oxygénothérapie à haut débit', role: 'intervention', importance: 1, mesh: ['Oxygen Inhalation Therapy'], freeText: ['high-flow nasal', 'high flow nasal cannula', 'HFNC'] },
  { keys: ['prophylaxie', 'prevention', 'prophylaxis'], name: 'Prévention', role: 'intervention', importance: 2, mesh: [], freeText: ['prophyla*', 'prevent*'] },
  // — Critères de jugement : hors équation par défaut (Cochrane), gardés dans le PICO
  { keys: ['mortalite', 'deces', 'mortality', 'death'], name: 'Mortalité', role: 'outcome', importance: 3, mesh: ['Mortality'], freeText: ['mortality', 'death*', 'survival'] },
  { keys: ['efficace', 'efficacite', 'efficacy', 'effectiveness'], name: 'Efficacité', role: 'outcome', importance: 3, mesh: ['Treatment Outcome'], freeText: ['efficacy', 'effectiveness', 'clinical cure'] },
  { keys: ['recidive', 'rechute', 'recurrence', 'relapse'], name: 'Récidive', role: 'outcome', importance: 3, mesh: ['Recurrence'], freeText: ['recurren*', 'relapse*'] },
  { keys: ['complications', 'complication', 'effets indesirables', 'adverse events'], name: 'Complications', role: 'outcome', importance: 3, mesh: ['Postoperative Complications'], freeText: ['complication*', 'adverse event*'] },
  { keys: ['duree de sejour', 'duree d hospitalisation', 'length of stay'], name: 'Durée de séjour', role: 'outcome', importance: 3, mesh: ['Length of Stay'], freeText: ['length of stay', 'hospital stay'] },
  { keys: ['qualite de vie', 'quality of life'], name: 'Qualité de vie', role: 'outcome', importance: 3, mesh: ['Quality of Life'], freeText: ['quality of life', 'QoL', 'HRQoL'] },
];

/** Repérage du type d'étude demandé dans la question elle-même. */
const DESIGN_CUES: { re: RegExp; type: StudyType }[] = [
  { re: /\b(essais?\s+(cliniques?\s+)?randomise|randomise|randomi[sz]ed|\brct\b|essais? controle)/, type: 'rct' },
  { re: /\b(revues?\s+systematiques?|meta-?analyse|systematic\s+review|meta-?analys)/, type: 'systematic_review' },
  { re: /\b(cohortes?|cas-temoins?|observationnel|cohort|case-control|observational|registre|registry)/, type: 'observational' },
  { re: /\b(sensibilite|specificite|diagnostique|diagnostic accuracy|sensitivity|specificity)/, type: 'diagnostic' },
];

const FR_STOP = new Set(
  'le la les l un une des du de d et ou en au aux a chez avec sans pour par sur dans est elle il ils elles sont etre plus moins aussi que qu qui quoi quel quelle quels quelles ce cette ces son sa ses leur leurs comme entre versus vs ne pas jours jour mois ans an semaine semaines efficace longue long courte court-elle t estelle est-elle'.split(' '),
);
const EN_STOP = new Set(
  'the a an of and or in on for with without to by is are be as than more less versus vs does do in adults adult patients patient people compared effect effects what which who how among'.split(' '),
);

export function detectLang(text: string): 'fr' | 'en' {
  const f = ` ${fold(text)} `;
  const fr = (f.match(/\s(le|la|les|des|chez|avec|une|est|pour|dans|qu|du|aux)\s/g) ?? []).length + (/[éèàùçêô]/.test(text) ? 2 : 0);
  const en = (f.match(/\s(the|with|in|of|is|for|and|does|versus|among)\s/g) ?? []).length;
  return en > fr ? 'en' : 'fr';
}

interface Draft {
  pico: Pico;
  concepts: Omit<StrategyConcept, 'block'>[];
  studyTypes: StudyType[];
  rationale: string;
  warnings: string[];
}

export function detectStudyTypes(question: string): StudyType[] {
  const f = fold(question);
  return DESIGN_CUES.filter((c) => c.re.test(f)).map((c) => c.type);
}

/** Brouillon déterministe : dictionnaire, plus longue correspondance d'abord. */
export function draftWithRules(question: string, lang: 'fr' | 'en'): Draft {
  let rest = ` ${fold(question).replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ')} `;
  const found: DictEntry[] = [];
  const keys = DICTIONARY.flatMap((entry) => entry.keys.map((key) => ({ key, entry }))).sort((a, b) => b.key.length - a.key.length);
  for (const { key, entry } of keys) {
    const needle = ` ${key} `;
    if (!rest.includes(needle)) continue;
    rest = rest.split(needle).join(' ¤ ');
    if (!found.includes(entry)) found.push(entry);
  }

  // Ce qui reste : en anglais, des mots utilisables tels quels ; en français, des mots à traduire (signalés).
  const stop = lang === 'en' ? EN_STOP : FR_STOP;
  const runs = rest
    .split('¤')
    .map((chunk) =>
      chunk
        .split(' ')
        .filter((w) => w.length >= 4 && !stop.has(w) && !/^\d+$/.test(w) && !FR_STOP.has(w))
        .join(' '),
    )
    .filter(Boolean);
  const designWords = /^(essais?|randomis\w*|trials?|randomi[sz]ed|revues?|systematiques?|reviews?|meta\w*|cohortes?|cohort|studies|etudes?)$/;
  const leftovers = runs.flatMap((r) => r.split(' ')).filter((w) => !designWords.test(w));

  const warnings: string[] = [];
  const concepts: Omit<StrategyConcept, 'block'>[] = found.map((e) => ({
    name: e.name,
    role: e.role,
    importance: e.importance,
    mesh: [...e.mesh],
    freeText: [...e.freeText],
  }));
  if (lang === 'en') {
    for (const run of runs) {
      const words = run.split(' ').filter((w) => !designWords.test(w) && !EN_STOP.has(w));
      if (words.length === 0) continue;
      const phrase = words.slice(0, 3).join(' ');
      concepts.push({ name: phrase, role: 'other', importance: 2, mesh: [], freeText: [words.length > 1 ? phrase : `${phrase}*`] });
    }
  } else if (leftovers.length > 0) {
    warnings.push(
      `Mots non reconnus, laissés hors de l’équation (le dictionnaire du mode sans clé est limité) : ${[...new Set(leftovers)].join(', ')}. Ajoutez leurs équivalents anglais à la main si ce sont des notions de la question.`,
    );
  }

  // Le découpage Cochrane : P et I dans l'équation ; O seulement s'il ne reste presque rien d'autre.
  const core = concepts.filter((c) => c.role !== 'outcome');
  const kept = core.length >= 2 ? core : concepts;
  const pick = (role: ConceptRole) => concepts.filter((c) => c.role === role).map((c) => c.name).join(', ');
  const studyTypes = detectStudyTypes(question);
  return {
    pico: {
      population: pick('population'),
      intervention: [pick('intervention'), pick('other')].filter(Boolean).join(', '),
      comparison: /\b(versus|vs|compar|aussi efficace|plutot que|par rapport)/.test(fold(question)) ? 'comparateur mentionné dans la question (non traduit en bloc)' : '',
      outcome: pick('outcome'),
      studyDesign: studyTypes.map((s) => STUDY_TYPE_LABELS[s]).join(', '),
    },
    concepts: kept,
    studyTypes,
    rationale:
      'Équation construite par règles, sans modèle de langage : chaque notion reconnue dans la question devient un bloc (descripteur MeSH OU synonymes en texte libre), les blocs sont combinés par ET. Les critères de jugement restent hors de l’équation quand la population et l’intervention suffisent (recommandation Cochrane), pour ne pas perdre d’articles.',
    warnings,
  };
}

/* ─────────────────────────────── Modèle de langage ────────────────────────── */

export const QUERY_SYSTEM_PROMPT = `Tu es documentaliste médical, spécialiste des recherches systématiques dans PubMed (Cochrane Handbook chapitre 4, PRISMA-S).
À partir d'une question de recherche (souvent en français), propose une stratégie de recherche PubMed :
- découpe la question en PICO ; les concepts de l'équation sont d'ordinaire la Population et l'Intervention (et parfois l'Outcome) — tout élément du PICO n'a pas à y figurer ;
- pour chaque concept : des descripteurs MeSH EXACTS (intitulés anglais officiels, sans balise ni guillemets), et des synonymes en texte libre EN ANGLAIS (variantes d'orthographe britannique/américaine, acronymes, pluriels via troncature « * » quand elle est sûre — jamais sur moins de 4 lettres) ;
- importance : 1 = indispensable, 2 = utile, 3 = accessoire (retiré en premier si l'équation ne rend rien) ;
- n'ajoute ni filtre de type d'étude ni limite de dates : l'application les applique elle-même ;
- rationale : 2 à 4 phrases en français expliquant les choix ; warnings : limites de la stratégie, en français.
Réponds uniquement en JSON conforme au schéma.`;

export const QUERY_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['pico', 'concepts', 'rationale', 'warnings'],
  properties: {
    pico: {
      type: 'object',
      additionalProperties: false,
      required: ['population', 'intervention', 'comparison', 'outcome', 'studyDesign'],
      properties: {
        population: { type: 'string' },
        intervention: { type: 'string' },
        comparison: { type: 'string' },
        outcome: { type: 'string' },
        studyDesign: { type: 'string' },
      },
    },
    concepts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'role', 'importance', 'mesh', 'freeText'],
        properties: {
          name: { type: 'string' },
          role: { type: 'string', enum: ['population', 'intervention', 'comparison', 'outcome', 'other'] },
          importance: { type: 'integer', enum: [1, 2, 3] },
          mesh: { type: 'array', items: { type: 'string' } },
          freeText: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    rationale: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
  },
};

const llmDraftSchema = z.object({
  pico: z.object({
    population: z.string().max(500),
    intervention: z.string().max(500),
    comparison: z.string().max(500),
    outcome: z.string().max(500),
    studyDesign: z.string().max(500),
  }),
  concepts: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        role: z.enum(['population', 'intervention', 'comparison', 'outcome', 'other']),
        importance: z.number().int().min(1).max(3),
        mesh: z.array(z.string().max(200)).max(10),
        freeText: z.array(z.string().max(200)).max(25),
      }),
    )
    .min(1)
    .max(6),
  rationale: z.string().max(3000),
  warnings: z.array(z.string().max(500)).max(10),
});

/**
 * L'appel au modèle, et lui seul : (consigne, message, schéma JSON) → texte JSON de la réponse.
 * C'est le point à remplacer pour changer de fournisseur (modèle local via Ollama…) ; le reste du module ne
 * connaît que cette signature.
 */
export type QueryModelCaller = (system: string, user: string, jsonSchema: Record<string, unknown>) => Promise<string>;

let callerOverride: QueryModelCaller | null = null;

/** Tests : substitue un faux modèle à l'API (et le considère disponible). `null` rétablit l'API. */
export function setQueryModelCaller(caller: QueryModelCaller | null): void {
  callerOverride = caller;
}

export const queryModelAvailable = (): boolean => callerOverride !== null || taskAvailable('search-query');

/** Nom du modèle consigné au journal. */
export const queryModelName = (): string => (callerOverride ? 'modèle de test' : routeFor('search-query').label);

/**
 * Passe par le routeur de modèles : Claude par défaut, modèle local (Ollama) si la tâche « search-query » le vise.
 * Les sauvegardes historiques (clé active, redaction, pseudonymisation en amont, JSON structuré) sont préservées.
 */
export async function callQueryModel(system: string, user: string, jsonSchema: Record<string, unknown>): Promise<string> {
  if (callerOverride) return callerOverride(system, user, jsonSchema);
  try {
    const { text } = await generateStructured({ task: 'search-query', system, user, schema: jsonSchema, maxTokens: 8_000 });
    return text;
  } catch (error) {
    if (error instanceof ModelCallError) throw new LlmError(error.message.slice(0, 200), error.retryable ?? false);
    if (error instanceof LlmError) throw error;
    throw new LlmError(String(error).slice(0, 200), false);
  }
}

async function draftWithModel(question: string, studyTypes: StudyType[]): Promise<Draft> {
  // Une question n'est pas une donnée de patient ; elle passe tout de même par la pseudonymisation.
  const masked = pseudonymize(question).text;
  const user = `<question>\n${masked}\n</question>${
    studyTypes.length ? `\nTypes d'études demandés (filtre appliqué par l'application) : ${studyTypes.map((s) => STUDY_TYPE_LABELS[s]).join(', ')}.` : ''
  }`;
  const raw = await callQueryModel(QUERY_SYSTEM_PROMPT, user, QUERY_JSON_SCHEMA);
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new LlmError('réponse illisible (JSON invalide)', true);
  }
  const parsed = llmDraftSchema.safeParse(json);
  if (!parsed.success) throw new LlmError('réponse non conforme au format attendu', true);
  const concepts = parsed.data.concepts
    .map((c) => ({ ...c, mesh: c.mesh.map(cleanTerm).filter(Boolean), freeText: c.freeText.map(cleanTerm).filter(Boolean) }))
    .filter((c) => c.mesh.length + c.freeText.length > 0);
  if (concepts.length === 0) throw new LlmError('aucun concept exploitable', true);
  return { pico: parsed.data.pico, concepts, studyTypes, rationale: parsed.data.rationale, warnings: parsed.data.warnings };
}

/* ─────────────────────────────── Vérification ────────────────────────────── */

/** Au-delà, une question ciblée a sans doute été mal découpée : on avertit et on propose de resserrer. */
export const BROAD_THRESHOLD = 5_000;
export const MAX_ROUNDS = 3;

async function safeCount(counter: PubmedCounter, term: string, years: { yearFrom?: number; yearTo?: number }, warnings: string[]): Promise<number | null> {
  try {
    const r = await counter(term, years);
    for (const w of r.warnings) if (!warnings.includes(w)) warnings.push(w);
    return r.count;
  } catch (error) {
    const msg = error instanceof EutilsError ? error.message : error instanceof Error ? error.message : String(error);
    const w = `Comptage PubMed impossible (${msg.slice(0, 200)}) : les nombres affichés sont incomplets.`;
    if (!warnings.includes(w)) warnings.push(w);
    return null;
  }
}

/**
 * Éprouve les descripteurs, compte blocs et équation, élargit quand rien ne sort.
 * Les descripteurs MeSH inexistants (0 article) deviennent du texte libre plutôt que d'être perdus.
 */
export async function verifyStrategy(draft: Draft, input: BuildInput, counter: PubmedCounter): Promise<Omit<SearchStrategy, 'question' | 'model' | 'method' | 'rationale'> & { rationale: string }> {
  const warnings = [...draft.warnings];
  const years = { yearFrom: input.yearFrom, yearTo: input.yearTo };
  const studyTypes = [...new Set([...(input.studyTypes ?? []), ...draft.studyTypes])];
  const filters = studyTypes.map((s) => STUDY_TYPE_LABELS[s]);
  let rationale = draft.rationale;

  // 1. Descripteurs MeSH : existent-ils ? (comptés sans limite de dates : on éprouve le vocabulaire, pas la période)
  const meshCache = new Map<string, number | null>();
  for (const c of draft.concepts) {
    const valid: string[] = [];
    for (const m of c.mesh) {
      if (!meshCache.has(m)) meshCache.set(m, await safeCount(counter, meshTag(m), {}, warnings));
      const n = meshCache.get(m);
      if (n === 0) {
        warnings.push(`Descripteur MeSH « ${m} » introuvable dans PubMed : remplacé par une recherche en texte libre.`);
        if (!c.freeText.some((f) => fold(f) === fold(m))) c.freeText.push(m);
      } else valid.push(m);
    }
    c.mesh = valid;
  }

  let concepts: StrategyConcept[] = draft.concepts
    .map((c) => ({ ...c, block: conceptBlock(c.mesh, c.freeText) }))
    .filter((c) => c.block);

  // 2. Boucle de vérification : au plus trois tours.
  let total: number | null = null;
  const perConcept = new Map<string, number | null>();
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    for (const c of concepts) if (!perConcept.has(c.block)) perConcept.set(c.block, await safeCount(counter, c.block, years, warnings));
    // Un bloc qui ne rend rien à lui seul est retiré d'emblée : il annulerait toute l'équation.
    const empty = concepts.filter((c) => perConcept.get(c.block) === 0);
    if (empty.length > 0 && empty.length < concepts.length) {
      concepts = concepts.filter((c) => !empty.includes(c));
      warnings.push(`Concept(s) sans aucun résultat dans PubMed, retiré(s) : ${empty.map((c) => c.name).join(', ')}.`);
    }
    const equation = assembleEquation(concepts, studyTypes);
    if (!equation) break;
    total = await safeCount(counter, equation, years, warnings);
    if (total !== 0 || round === MAX_ROUNDS) break;
    // Zéro : on élargit en retirant le concept le moins important (jamais le dernier qui reste).
    if (concepts.length > 1) {
      const victim = [...concepts].sort((a, b) => b.importance - a.importance || concepts.indexOf(b) - concepts.indexOf(a))[0]!;
      concepts = concepts.filter((c) => c !== victim);
      warnings.push(`Aucun résultat avec tous les concepts : « ${victim.name} » a été retiré pour élargir la recherche (tour ${round}).`);
      rationale += ` Élargissement automatique : le concept « ${victim.name} » a été retiré, l’équation complète ne rendant aucun article.`;
    } else if (studyTypes.length > 0) {
      warnings.push(`Aucun résultat avec le filtre de type d’étude (${filters.join(', ')}) : il a été retiré.`);
      studyTypes.length = 0;
      filters.length = 0;
    } else break;
  }

  const equation = assembleEquation(concepts, studyTypes);
  if (total === 0) warnings.push('Même élargie, l’équation ne rend aucun article : reformulez la question ou ajoutez des synonymes.');
  if (total !== null && total > BROAD_THRESHOLD) {
    warnings.push(
      `${total.toLocaleString('fr-FR')} articles : c’est beaucoup pour une question ciblée. Pour resserrer : ajoutez un concept (critère de jugement, comparateur), un filtre de type d’étude, des années, ou restreignez des termes au titre ([ti]).`,
    );
  }
  return {
    pico: draft.pico,
    concepts,
    equation,
    filters,
    counts: { total, perConcept: concepts.map((c) => ({ name: c.name, count: perConcept.get(c.block) ?? null })) },
    rationale,
    warnings,
  };
}

/* ─────────────────────────────── Point d'entrée ───────────────────────────── */

export async function buildStrategy(input: BuildInput, counter: PubmedCounter = pubmedCounter()): Promise<SearchStrategy> {
  const question = input.question.trim();
  const lang = input.lang ?? detectLang(question);
  const studyTypes = input.studyTypes ?? [];
  let draft: Draft | null = null;
  let model: string | null = null;
  const preWarnings: string[] = [];
  if (queryModelAvailable()) {
    try {
      draft = await draftWithModel(question, [...new Set([...studyTypes, ...detectStudyTypes(question)])]);
      draft.studyTypes = detectStudyTypes(question);
      model = queryModelName();
    } catch (error) {
      preWarnings.push(
        `Le modèle n’a pas pu construire la stratégie (${error instanceof Error ? error.message : String(error)}) : construction par règles, de moindre qualité.`,
      );
    }
  }
  const method: 'llm' | 'rules' = draft ? 'llm' : 'rules';
  if (!draft) {
    draft = draftWithRules(question, lang);
    if (preWarnings.length === 0) {
      preWarnings.push('Aucun modèle de langage disponible : équation construite par règles (dictionnaire limité), de moindre qualité. Relisez-la et complétez les synonymes.');
    }
  }
  draft.warnings = [...preWarnings, ...draft.warnings];
  if (draft.concepts.length === 0) {
    return {
      question,
      pico: draft.pico,
      concepts: [],
      equation: '',
      filters: [],
      counts: { total: null, perConcept: [] },
      rationale: draft.rationale,
      warnings: [...draft.warnings, 'Aucune notion reconnue dans la question : reformulez-la, ou passez en « Équation experte ».'],
      model,
      method,
    };
  }
  const verified = await verifyStrategy(draft, { ...input, studyTypes }, counter);
  return { question, ...verified, model, method };
}

/** Compte une équation (et, en option, chacun de ses blocs) : après une retouche à la main. */
export async function countEquation(
  equation: string,
  blocks: { name: string; block: string }[],
  years: { yearFrom?: number; yearTo?: number },
  counter: PubmedCounter = pubmedCounter(),
): Promise<{ total: number | null; perConcept: { name: string; count: number | null }[]; warnings: string[] }> {
  const warnings: string[] = [];
  const perConcept: { name: string; count: number | null }[] = [];
  for (const b of blocks) perConcept.push({ name: b.name, count: await safeCount(counter, b.block, years, warnings) });
  const total = await safeCount(counter, equation, years, warnings);
  return { total, perConcept, warnings };
}
