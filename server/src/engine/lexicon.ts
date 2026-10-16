/**
 * Lexique clinique français : synonymes, sigles et abréviations des notions qu'une fiche d'exploitation recueille.
 *
 * Une variable créée à la main ou importée d'un tableur n'arrive qu'avec son libellé (« CRP (mg/L) », « HTA »,
 * « Date d'entrée ») : sans règle écrite, le moteur ne la cherchait que sous ce libellé exact. Or un compte rendu dit
 * « protéine C réactive », un autre « CRP », un troisième « C-réactive » ; « HTA », « hypertension artérielle » et
 * « hypertendu » désignent la même notion. Ce lexique rattache un libellé libre à sa notion et en donne toutes les
 * écritures usuelles, pour que `suggest-rules.ts` construise des règles complètes sans intervention.
 *
 * Trois listes par notion, parce qu'un terme ne se cherche pas de la même façon selon sa nature :
 *
 * - `terms` : les écritures sûres, cherchées comme libellé (« CRP : 142 ») ET comme mot-clé (« HTA traitée ») ;
 * - `forms` : formes dérivées (« diabétique », « hypertendu », « fumeur ») — des mots-clés, jamais des libellés :
 *   « Diabétique : oui » se lit, mais « fumeur 20 PA » n'est pas un libellé suivi de sa valeur ;
 * - `labelOnly` : sigles ambigus hors d'un tableau — « IC » est aussi un intervalle de confiance, « PA » des
 *   paquets-années, « T » une lettre quelconque. Suivis d'un séparateur (« IC : oui », « PA : 130/80 »), ils sont
 *   fiables ; cherchés seuls dans le texte, ils inventeraient des valeurs.
 *
 * Les termes sont écrits avec leurs accents, pour la lecture : la recherche les replie (casse, accents, apostrophes).
 */
import { fold } from './fold.js';

export type ConceptCategory =
  | 'identite'
  | 'constante'
  | 'biologie'
  | 'comorbidite'
  | 'clinique'
  | 'imagerie'
  | 'traitement'
  | 'evolution'
  | 'date'
  | 'duree'
  | 'score'
  | 'rubrique';

export interface Concept {
  id: string;
  category: ConceptCategory;
  /** Écritures sûres : libellés et mots-clés. La première est la forme canonique. */
  terms: string[];
  /** Formes dérivées (adjectifs, noms de personne), cherchées comme mots-clés seulement. */
  forms?: string[];
  /** Sigles ambigus hors d'un couple « libellé : valeur » : libellés seulement. */
  labelOnly?: string[];
  /** Unité usuelle en France, pour borner la valeur quand la variable emploie la même. */
  unit?: string;
  /** Bornes de plausibilité dans `unit` : une valeur hors bornes est écartée et signalée, jamais retenue. */
  range?: [number, number];
  /**
   * Notion de l'épisode en cours (fièvre, complication, choc) : une mention placée dans les antécédents ne la
   * renseigne pas (« ATCD de pneumopathie fébrile »).
   */
  acute?: boolean;
  /** Rubrique générique (« antécédents », « traitement ») : retenue seulement si le libellé la nomme seule. */
  generic?: boolean;
}

/** Raccourci de déclaration. */
function c(
  id: string,
  category: ConceptCategory,
  terms: string[],
  more: Omit<Concept, 'id' | 'category' | 'terms'> = {},
): Concept {
  return { id, category, terms, ...more };
}

export const CONCEPTS: Concept[] = [
  // ───────────────────────────────────────────────────────────── identité, démographie
  c('age', 'identite', ['Âge', 'Age du patient', 'Âge au diagnostic', 'Âge à l’admission'], { unit: 'ans', range: [0, 120] }),
  c('sexe', 'identite', ['Sexe', 'Genre'], {}),
  c('poids', 'constante', ['Poids', 'Poids corporel'], { labelOnly: ['P', 'Pds'], unit: 'kg', range: [0.3, 400] }),
  c('taille', 'constante', ['Taille', 'Stature'], { labelOnly: ['Tle'], unit: 'cm', range: [20, 250] }),
  c('imc', 'constante', ['IMC', 'Indice de masse corporelle', 'BMI', 'Body mass index'], { unit: 'kg/m²', range: [8, 90] }),
  c('surface_corporelle', 'constante', ['Surface corporelle', 'SC', 'BSA'], { unit: 'm²', range: [0.1, 3.5] }),
  c('numero_dossier', 'identite', ['Numéro de dossier', 'N° de dossier', 'N° dossier', 'IPP', 'Numéro d’identification', 'NIP']),
  c('profession', 'identite', ['Profession', 'Métier', 'Activité professionnelle']),
  c('origine', 'identite', ['Origine', 'Provenance', 'Lieu de résidence', 'Domicile']),
  c('statut_marital', 'identite', ['Statut marital', 'Situation familiale', 'État civil']),
  c('niveau_socio', 'identite', ['Niveau socio-économique', 'Niveau socioéconomique', 'NSE']),
  c('couverture_sociale', 'identite', ['Couverture sociale', 'Mutuelle', 'Assurance maladie']),
  c('gestite', 'identite', ['Gestité', 'Gestite', 'Nombre de grossesses'], { labelOnly: ['G'] }),
  c('parite', 'identite', ['Parité', 'Parite', 'Nombre d’accouchements'], { labelOnly: ['P'] }),
  c('terme', 'identite', ['Terme', 'Âge gestationnel', 'AG', 'SA'], { unit: 'SA', range: [4, 45] }),
  c('poids_naissance', 'constante', ['Poids de naissance', 'Poids à la naissance', 'PN'], { unit: 'g', range: [200, 6500] }),

  // ───────────────────────────────────────────────────────────── dates et durées
  c('date_admission', 'date', [
    'Date d’admission', 'Date d’entrée', 'Date d’hospitalisation', 'Admission le', 'Admis le', 'Admise le',
    'Entré le', 'Entrée le', 'Hospitalisé le', 'Hospitalisée le', 'Date d’arrivée', 'Arrivée le', 'Date entrée',
  ]),
  c('date_sortie', 'date', ['Date de sortie', 'Sorti le', 'Sortie le', 'Sortant le', 'Date de fin d’hospitalisation']),
  c('date_naissance', 'date', ['Date de naissance', 'Né le', 'Née le', 'DDN']),
  c('date_intervention', 'date', ['Date de l’intervention', 'Date d’intervention', 'Opéré le', 'Opérée le', 'Date opératoire', 'Date de la chirurgie']),
  c('date_diagnostic', 'date', ['Date du diagnostic', 'Date de diagnostic', 'Diagnostiqué le', 'Diagnostiquée le']),
  c('date_deces', 'date', ['Date du décès', 'Date de décès', 'Décédé le', 'Décédée le', 'DC le']),
  c('date_consultation', 'date', ['Date de consultation', 'Date de la consultation', 'Vu le', 'Vue le', 'Consultation du']),
  c('date_examen', 'date', ['Date de l’examen', 'Date d’examen', 'Date de l’imagerie', 'Examen du', 'Réalisé le', 'Réalisée le']),
  c('date_debut_symptomes', 'date', ['Date de début des symptômes', 'Début des symptômes', 'Date de début', 'Début le']),
  c('date_derniere_nouvelle', 'date', ['Date des dernières nouvelles', 'Dernières nouvelles', 'DDN suivi', 'Date de dernier suivi', 'Dernier contrôle']),
  c('date_regles', 'date', ['Date des dernières règles', 'DDR']),
  c('duree_sejour', 'duree', [
    'Durée d’hospitalisation', 'Durée de séjour', 'Durée du séjour', 'DMS', 'Séjour', 'Durée d’hospit',
    'Nombre de jours d’hospitalisation',
  ], { unit: 'jours', range: [0, 400] }),
  c('duree_rea', 'duree', ['Durée de séjour en réanimation', 'Séjour en réanimation', 'Durée en réanimation', 'Durée de réa'], { unit: 'jours', range: [0, 400] }),
  c('duree_ventilation', 'duree', ['Durée de ventilation', 'Durée de ventilation mécanique', 'Jours de ventilation'], { unit: 'jours', range: [0, 400] }),
  c('delai_consultation', 'duree', ['Délai de consultation', 'Délai diagnostique', 'Délai de prise en charge', 'Délai'], { unit: 'jours' }),
  c('duree_operatoire', 'duree', ['Durée opératoire', 'Durée de l’intervention', 'Durée d’intervention'], { unit: 'min', range: [1, 1800] }),
  c('duree_evolution', 'duree', ['Durée d’évolution', 'Ancienneté des symptômes', 'Évolution depuis']),
  c('duree_suivi', 'duree', ['Durée de suivi', 'Recul', 'Suivi'], { generic: true }),

  // ───────────────────────────────────────────────────────────── constantes
  c('temperature', 'constante', ['Température', 'Temp', 'Temp.', 'T°', 'Température corporelle'], { labelOnly: ['T', 'TC', 'T °C'], unit: '°C', range: [30, 45] }),
  c('frequence_cardiaque', 'constante', ['Fréquence cardiaque', 'FC', 'Pouls', 'Rythme cardiaque', 'HR'], { labelOnly: ['Fc'], unit: 'bpm', range: [15, 300] }),
  c('pression_arterielle', 'constante', ['Pression artérielle', 'Tension artérielle', 'TA', 'Tension', 'Pression artérielle systolique/diastolique'], { labelOnly: ['PA'] }),
  c('pas', 'constante', ['Pression artérielle systolique', 'PAS', 'Tension systolique', 'TAS', 'Systolique'], { unit: 'mmHg', range: [30, 300] }),
  c('pad', 'constante', ['Pression artérielle diastolique', 'PAD', 'Tension diastolique', 'TAD', 'Diastolique'], { unit: 'mmHg', range: [10, 200] }),
  c('pam', 'constante', ['Pression artérielle moyenne', 'PAM'], { unit: 'mmHg', range: [20, 250] }),
  c('frequence_respiratoire', 'constante', ['Fréquence respiratoire', 'FR', 'Rythme respiratoire'], { unit: 'cycles/min', range: [2, 80] }),
  c('spo2', 'constante', ['SpO2', 'Saturation', 'Saturation en oxygène', 'Saturation pulsée en oxygène', 'Sat', 'SaO2', 'Sat O2'], { unit: '%', range: [30, 100] }),
  c('glasgow', 'score', ['Score de Glasgow', 'Glasgow', 'GCS', 'Glasgow Coma Scale'], { range: [3, 15] }),
  c('eva', 'score', ['EVA', 'Échelle visuelle analogique', 'Douleur EVA', 'EN', 'Échelle numérique'], { range: [0, 10] }),
  c('diurese', 'constante', ['Diurèse', 'Débit urinaire'], { unit: 'mL/24h' }),
  c('glycemie_capillaire', 'constante', ['Glycémie capillaire', 'Dextro', 'HGT', 'Dextrostix'], { unit: 'g/L', range: [0.1, 10] }),

  // ───────────────────────────────────────────────────────────── biologie : hématologie
  c('hemoglobine', 'biologie', ['Hémoglobine', 'Hb', 'Hgb', 'Hémoglobinémie', 'Taux d’hémoglobine'], { labelOnly: ['HB', 'HGB'], unit: 'g/dL', range: [1, 25] }),
  c('hematocrite', 'biologie', ['Hématocrite', 'Ht', 'Hte', 'Hct'], { unit: '%', range: [5, 80] }),
  c('globules_blancs', 'biologie', ['Globules blancs', 'GB', 'Leucocytes', 'WBC', 'Leucocytose', 'Taux de leucocytes', 'Numération leucocytaire'], { unit: '/mm3' }),
  c('globules_rouges', 'biologie', ['Globules rouges', 'GR', 'Hématies', 'RBC', 'Érythrocytes'], { unit: '10⁶/mm3' }),
  c('plaquettes', 'biologie', ['Plaquettes', 'PLQ', 'PLT', 'Numération plaquettaire', 'Taux de plaquettes', 'Thrombocytes'], { labelOnly: ['Plq'], unit: '/mm3' }),
  c('neutrophiles', 'biologie', ['Polynucléaires neutrophiles', 'PNN', 'Neutrophiles', 'PN neutrophiles'], { unit: '/mm3' }),
  c('lymphocytes', 'biologie', ['Lymphocytes', 'Lympho', 'Lymphocytes totaux'], { unit: '/mm3' }),
  c('eosinophiles', 'biologie', ['Polynucléaires éosinophiles', 'PNE', 'Éosinophiles'], { unit: '/mm3' }),
  c('vgm', 'biologie', ['VGM', 'Volume globulaire moyen', 'MCV'], { unit: 'fL', range: [40, 150] }),
  c('ccmh', 'biologie', ['CCMH', 'Concentration corpusculaire moyenne en hémoglobine', 'MCHC'], { unit: 'g/dL', range: [15, 45] }),
  c('reticulocytes', 'biologie', ['Réticulocytes', 'Réticulocytose']),
  c('tp', 'biologie', ['Taux de prothrombine', 'TP'], { unit: '%', range: [0, 150] }),
  c('inr', 'biologie', ['INR', 'International normalized ratio'], { range: [0.5, 15] }),
  c('tca', 'biologie', ['TCA', 'Temps de céphaline activée', 'TCK', 'Ratio TCA'], {}),
  c('fibrinogene', 'biologie', ['Fibrinogène', 'Fibrinogénémie', 'Fg'], { unit: 'g/L', range: [0, 15] }),
  c('d_dimeres', 'biologie', ['D-dimères', 'D dimères', 'DDimères', 'Dimères'], {}),
  c('vs', 'biologie', ['Vitesse de sédimentation', 'VS'], { unit: 'mm', range: [0, 200] }),
  c('groupe_sanguin', 'biologie', ['Groupe sanguin', 'Groupage', 'Groupe ABO', 'Groupe Rhésus']),

  // ───────────────────────────────────────────────────────────── biologie : inflammation, infection
  c('crp', 'biologie', ['CRP', 'Protéine C réactive', 'Protéine C-réactive', 'C-réactive protéine', 'C-réactive', 'PCR'], { unit: 'mg/L', range: [0, 600] }),
  c('pct', 'biologie', ['Procalcitonine', 'PCT'], { unit: 'ng/mL', range: [0, 1000] }),
  c('ferritine', 'biologie', ['Ferritine', 'Ferritinémie'], { unit: 'µg/L', range: [0, 100000] }),
  c('hemoculture', 'biologie', ['Hémoculture', 'Hémocultures', 'HC']),
  c('ecbu', 'biologie', ['ECBU', 'Examen cytobactériologique des urines', 'Uroculture']),
  c('lactates', 'biologie', ['Lactates', 'Lactatémie', 'Acide lactique'], { unit: 'mmol/L', range: [0, 30] }),

  // ───────────────────────────────────────────────────────────── biologie : rein, ionogramme
  c('creatinine', 'biologie', ['Créatinine', 'Créatininémie', 'Créat', 'Creat', 'Créatinine sérique', 'Créatinine plasmatique', 'Cr'], { unit: 'mg/L', range: [0, 200] }),
  c('uree', 'biologie', ['Urée', 'Urémie', 'Urée sanguine', 'BUN'], { unit: 'g/L', range: [0, 10] }),
  c('dfg', 'biologie', ['DFG', 'Débit de filtration glomérulaire', 'Clairance de la créatinine', 'Clairance', 'DFGe', 'eGFR', 'MDRD', 'CKD-EPI', 'Cockcroft'], { unit: 'mL/min', range: [0, 200] }),
  c('sodium', 'biologie', ['Natrémie', 'Sodium', 'Na', 'Na+'], { unit: 'mmol/L', range: [90, 190] }),
  c('potassium', 'biologie', ['Kaliémie', 'Potassium', 'K', 'K+'], { unit: 'mmol/L', range: [1, 10] }),
  c('chlore', 'biologie', ['Chlorémie', 'Chlore', 'Cl', 'Cl-'], { unit: 'mmol/L', range: [60, 150] }),
  c('bicarbonates', 'biologie', ['Bicarbonates', 'HCO3', 'HCO3-', 'Réserve alcaline', 'RA'], { unit: 'mmol/L', range: [2, 60] }),
  c('calcium', 'biologie', ['Calcémie', 'Calcium', 'Ca', 'Ca2+'], { unit: 'mg/L', range: [30, 200] }),
  c('phosphore', 'biologie', ['Phosphorémie', 'Phosphore', 'Phosphates'], {}),
  c('magnesium', 'biologie', ['Magnésémie', 'Magnésium', 'Mg'], {}),
  c('proteinurie', 'biologie', ['Protéinurie', 'Protéinurie des 24 heures', 'Protéinurie de 24h', 'PU24'], {}),
  c('acide_urique', 'biologie', ['Acide urique', 'Uricémie'], {}),

  // ───────────────────────────────────────────────────────────── biologie : foie, pancréas, cœur, métabolisme
  c('asat', 'biologie', ['ASAT', 'SGOT', 'AST', 'Aspartate aminotransférase', 'TGO'], { unit: 'UI/L', range: [0, 50000] }),
  c('alat', 'biologie', ['ALAT', 'SGPT', 'ALT', 'Alanine aminotransférase', 'TGP'], { unit: 'UI/L', range: [0, 50000] }),
  c('ggt', 'biologie', ['GGT', 'Gamma GT', 'γGT', 'Gamma-glutamyl transférase', 'Gamma glutamyl transpeptidase'], { unit: 'UI/L', range: [0, 10000] }),
  c('pal', 'biologie', ['PAL', 'Phosphatases alcalines', 'Phosphatase alcaline'], { unit: 'UI/L', range: [0, 10000] }),
  c('bilirubine', 'biologie', ['Bilirubine totale', 'Bilirubine', 'BT', 'Bilirubinémie'], { unit: 'mg/L', range: [0, 600] }),
  c('bilirubine_conjuguee', 'biologie', ['Bilirubine conjuguée', 'BC', 'Bilirubine directe']),
  c('lipase', 'biologie', ['Lipase', 'Lipasémie'], { unit: 'UI/L', range: [0, 50000] }),
  c('amylase', 'biologie', ['Amylase', 'Amylasémie'], { unit: 'UI/L' }),
  c('albumine', 'biologie', ['Albumine', 'Albuminémie'], { unit: 'g/L', range: [5, 70] }),
  c('proteines', 'biologie', ['Protides', 'Protidémie', 'Protéines totales'], { unit: 'g/L', range: [20, 140] }),
  c('troponine', 'biologie', ['Troponine', 'Troponine I', 'Troponine T', 'Tropo', 'TnI', 'TnT', 'Troponine hypersensible', 'Troponine us'], {}),
  c('bnp', 'biologie', ['BNP', 'NT-proBNP', 'NT pro BNP', 'Pro-BNP', 'Peptide natriurétique'], {}),
  c('cpk', 'biologie', ['CPK', 'CK', 'Créatine kinase', 'Créatine phosphokinase'], { unit: 'UI/L' }),
  c('ldh', 'biologie', ['LDH', 'Lacticodéshydrogénase', 'Lactate déshydrogénase'], { unit: 'UI/L' }),
  c('glycemie', 'biologie', ['Glycémie', 'Glycémie à jeun', 'Glucose', 'GAJ'], { unit: 'g/L', range: [0.1, 10] }),
  c('hba1c', 'biologie', ['HbA1c', 'Hémoglobine glyquée', 'Hb glyquée', 'A1c'], { unit: '%', range: [3, 20] }),
  c('cholesterol', 'biologie', ['Cholestérol total', 'Cholestérol', 'CT', 'Cholestérolémie']),
  c('ldl', 'biologie', ['LDL', 'LDL-cholestérol', 'LDL cholestérol', 'LDLc']),
  c('hdl', 'biologie', ['HDL', 'HDL-cholestérol', 'HDL cholestérol', 'HDLc']),
  c('triglycerides', 'biologie', ['Triglycérides', 'TG', 'Triglycéridémie']),
  c('tsh', 'biologie', ['TSH', 'Thyréostimuline', 'TSHus'], { unit: 'mUI/L', range: [0, 500] }),
  c('vitamine_d', 'biologie', ['Vitamine D', '25-OH vitamine D', '25 OH D', 'Vit D']),
  c('fer', 'biologie', ['Fer sérique', 'Sidérémie']),
  c('ph', 'biologie', ['pH', 'pH artériel', 'pH sanguin'], { range: [6.5, 8] }),
  c('pao2', 'biologie', ['PaO2', 'Pression artérielle en oxygène', 'PO2'], { unit: 'mmHg', range: [10, 700] }),
  c('paco2', 'biologie', ['PaCO2', 'Pression artérielle en CO2', 'PCO2'], { unit: 'mmHg', range: [5, 200] }),
  c('psa', 'biologie', ['PSA', 'Antigène prostatique spécifique'], { unit: 'ng/mL' }),
  c('ace', 'biologie', ['ACE', 'Antigène carcino-embryonnaire']),
  c('ca125', 'biologie', ['CA 125', 'CA125', 'CA-125']),
  c('ca199', 'biologie', ['CA 19-9', 'CA19-9', 'CA 19.9']),
  c('afp', 'biologie', ['Alpha-fœtoprotéine', 'Alphafoetoprotéine', 'AFP', 'αFP']),
  c('bhcg', 'biologie', ['βHCG', 'Beta HCG', 'bêta-HCG', 'BHCG', 'HCG']),

  // ───────────────────────────────────────────────────────────── comorbidités, facteurs de risque
  c('hta', 'comorbidite', ['HTA', 'Hypertension artérielle', 'Hypertension', 'Hypertension artérielle essentielle'], { forms: ['hypertendu', 'hypertendue', 'hypertendus', 'antihypertenseur', 'anti-hypertenseur'] }),
  c('diabete', 'comorbidite', ['Diabète', 'Diabète sucré', 'DT1', 'DT2', 'DNID', 'DID', 'Diabète de type 1', 'Diabète de type 2', 'Diabète insulinodépendant', 'Diabète non insulinodépendant'], { forms: ['diabétique', 'diabétiques'] }),
  c('tabac', 'comorbidite', ['Tabagisme', 'Tabac', 'Tabagisme actif', 'Intoxication tabagique'], { forms: ['tabagique', 'fumeur', 'fumeuse', 'paquets-années', 'paquets-année', 'paquets/année', 'PA/an'] }),
  c('alcool', 'comorbidite', ['Alcoolisme', 'Alcool', 'Éthylisme', 'Ethylisme', 'Consommation d’alcool', 'Intoxication alcoolique', 'OH'], { forms: ['éthylique', 'alcoolique', 'éthylo-tabagique', 'éthylotabagique'] }),
  c('dyslipidemie', 'comorbidite', ['Dyslipidémie', 'Hypercholestérolémie', 'Hyperlipidémie', 'Hypertriglycéridémie'], { forms: ['dyslipidémique', 'sous statine', 'statine'] }),
  c('obesite', 'comorbidite', ['Obésité', 'Obésité morbide', 'Surpoids'], { forms: ['obèse', 'obèses'] }),
  c('insuffisance_renale', 'comorbidite', ['Insuffisance rénale', 'IRC', 'IRA', 'MRC', 'Maladie rénale chronique', 'Insuffisance rénale chronique', 'Insuffisance rénale aiguë', 'Néphropathie', 'IRCT', 'Dialyse', 'Hémodialyse'], { forms: ['dialysé', 'dialysée', 'hémodialysé', 'hémodialysée', 'insuffisant rénal', 'insuffisante rénale'], labelOnly: ['IR'] }),
  c('insuffisance_cardiaque', 'comorbidite', ['Insuffisance cardiaque', 'ICC', 'Insuffisance cardiaque congestive', 'Insuffisance ventriculaire gauche', 'IVG', 'Défaillance cardiaque'], { forms: ['insuffisant cardiaque', 'insuffisante cardiaque'], labelOnly: ['IC'] }),
  c('cardiopathie_ischemique', 'comorbidite', ['Cardiopathie ischémique', 'Coronaropathie', 'Maladie coronarienne', 'Insuffisance coronarienne', 'Angor', 'Angine de poitrine'], { forms: ['coronarien', 'coronarienne', 'angineux'] }),
  c('idm', 'comorbidite', ['Infarctus du myocarde', 'IDM', 'SCA', 'Syndrome coronarien aigu', 'SCA ST+', 'SCA ST-', 'STEMI', 'NSTEMI', 'Infarctus'], {}),
  c('fa', 'comorbidite', ['Fibrillation atriale', 'Fibrillation auriculaire', 'FA', 'ACFA', 'Arythmie complète par fibrillation auriculaire', 'Flutter', 'Flutter auriculaire', 'Trouble du rythme'], {}),
  c('avc', 'comorbidite', ['AVC', 'Accident vasculaire cérébral', 'AIT', 'Accident ischémique transitoire', 'AVC ischémique', 'AVC hémorragique', 'Infarctus cérébral', 'Hémorragie cérébrale', 'Hématome intracérébral'], {}),
  c('aomi', 'comorbidite', ['AOMI', 'Artériopathie oblitérante des membres inférieurs', 'Artériopathie', 'Artérite des membres inférieurs'], { forms: ['artéritique', 'artéritiques'] }),
  c('mtev', 'comorbidite', ['Maladie thromboembolique veineuse', 'MTEV', 'Thrombose veineuse profonde', 'TVP', 'Embolie pulmonaire', 'Phlébite'], { labelOnly: ['EP'] }),
  c('bpco', 'comorbidite', ['BPCO', 'Bronchopneumopathie chronique obstructive', 'Bronchite chronique', 'Emphysème', 'Insuffisance respiratoire chronique'], { forms: ['emphysémateux'] }),
  c('asthme', 'comorbidite', ['Asthme', 'Maladie asthmatique'], { forms: ['asthmatique', 'asthmatiques'] }),
  c('saos', 'comorbidite', ['SAOS', 'Syndrome d’apnées obstructives du sommeil', 'Apnée du sommeil', 'SAHOS'], { forms: ['appareillé', 'PPC'] }),
  c('tuberculose', 'comorbidite', ['Tuberculose', 'Tuberculose pulmonaire', 'BK', 'Primo-infection tuberculeuse'], { forms: ['tuberculeux', 'tuberculeuse'] }),
  c('vih', 'comorbidite', ['VIH', 'HIV', 'Infection à VIH', 'SIDA', 'Séropositivité VIH'], { forms: ['séropositif', 'séropositive'] }),
  c('hepatite_b', 'comorbidite', ['Hépatite B', 'VHB', 'HBV', 'Ag HBs positif', 'AgHBs'], {}),
  c('hepatite_c', 'comorbidite', ['Hépatite C', 'VHC', 'HCV'], {}),
  c('cirrhose', 'comorbidite', ['Cirrhose', 'Cirrhose hépatique', 'Hépatopathie chronique', 'Insuffisance hépatocellulaire', 'Hépatopathie'], { forms: ['cirrhotique', 'cirrhotiques'] }),
  c('cancer', 'comorbidite', ['Cancer', 'Néoplasie', 'Tumeur maligne', 'Néoplasme', 'Carcinome', 'Adénocarcinome', 'Lymphome', 'Leucémie', 'Hémopathie maligne', 'Pathologie néoplasique'], { forms: ['néoplasique', 'cancéreux', 'métastatique'] }),
  c('immunodepression', 'comorbidite', ['Immunodépression', 'Immunosuppression', 'Corticothérapie au long cours', 'Greffe', 'Transplantation', 'Neutropénie'], { forms: ['immunodéprimé', 'immunodéprimée', 'greffé', 'greffée', 'transplanté', 'transplantée'] }),
  c('dysthyroidie', 'comorbidite', ['Dysthyroïdie', 'Hypothyroïdie', 'Hyperthyroïdie', 'Goitre', 'Thyroïdite', 'Maladie de Basedow'], { forms: ['hypothyroïdien', 'hypothyroïdienne'] }),
  c('epilepsie', 'comorbidite', ['Épilepsie', 'Epilepsie', 'Comitialité', 'Crise convulsive', 'Convulsions'], { forms: ['épileptique', 'comitial', 'comitiale'] }),
  c('demence', 'comorbidite', ['Démence', 'Troubles cognitifs', 'Maladie d’Alzheimer', 'Alzheimer', 'Syndrome démentiel'], { forms: ['dément', 'démente'] }),
  c('parkinson', 'comorbidite', ['Maladie de Parkinson', 'Parkinson', 'Syndrome parkinsonien'], { forms: ['parkinsonien', 'parkinsonienne'] }),
  c('depression', 'comorbidite', ['Dépression', 'Syndrome dépressif', 'Épisode dépressif', 'Trouble dépressif'], { forms: ['dépressif', 'dépressive', 'antidépresseur'] }),
  c('psychiatrique', 'comorbidite', ['Antécédents psychiatriques', 'Pathologie psychiatrique', 'Schizophrénie', 'Trouble bipolaire', 'Psychose'], {}),
  c('ulcere', 'comorbidite', ['Ulcère gastroduodénal', 'UGD', 'Ulcère gastrique', 'Ulcère duodénal', 'Ulcère peptique'], {}),
  c('mici', 'comorbidite', ['MICI', 'Maladie de Crohn', 'Crohn', 'Rectocolite hémorragique', 'RCH', 'Maladie inflammatoire chronique de l’intestin'], {}),
  c('drepanocytose', 'comorbidite', ['Drépanocytose', 'Syndrome drépanocytaire', 'Anémie falciforme'], { forms: ['drépanocytaire'] }),
  c('anemie', 'comorbidite', ['Anémie', 'Syndrome anémique'], { forms: ['anémique', 'anémié', 'anémiée'] }),
  c('allergie', 'comorbidite', ['Allergie', 'Allergies', 'Allergie médicamenteuse', 'Atopie'], { forms: ['allergique'] }),
  c('grossesse', 'clinique', ['Grossesse', 'Grossesse en cours', 'Gestation'], { forms: ['enceinte'] }),
  c('chirurgie_anterieure', 'comorbidite', ['Antécédents chirurgicaux', 'ATCD chirurgicaux', 'Chirurgie antérieure', 'Antécédent chirurgical'], {}),
  c('lupus', 'comorbidite', ['Lupus', 'Lupus érythémateux disséminé', 'LED', 'Lupus systémique'], { forms: ['lupique'] }),
  c('polyarthrite', 'comorbidite', ['Polyarthrite rhumatoïde', 'PR', 'Rhumatisme inflammatoire'], {}),

  // ───────────────────────────────────────────────────────────── clinique, symptômes, épisode
  c('fievre', 'clinique', ['Fièvre', 'Hyperthermie', 'Syndrome fébrile', 'État fébrile', 'Pic fébrile'], { forms: ['fébrile', 'fébriles'], acute: true }),
  c('douleur_thoracique', 'clinique', ['Douleur thoracique', 'Douleurs thoraciques', 'Précordialgie', 'Oppression thoracique'], { acute: true }),
  c('dyspnee', 'clinique', ['Dyspnée', 'Essoufflement', 'Détresse respiratoire', 'Polypnée', 'Orthopnée'], { forms: ['dyspnéique', 'polypnéique'], acute: true }),
  c('toux', 'clinique', ['Toux', 'Toux productive', 'Toux sèche', 'Expectorations'], { acute: true }),
  c('douleur_abdominale', 'clinique', ['Douleur abdominale', 'Douleurs abdominales', 'Abdominalgie', 'Abdominalgies', 'Épigastralgie'], { acute: true }),
  c('vomissements', 'clinique', ['Vomissements', 'Vomissement', 'Nausées et vomissements', 'Nausées'], { acute: true }),
  c('diarrhee', 'clinique', ['Diarrhée', 'Diarrhées', 'Selles liquides'], { acute: true }),
  c('cephalees', 'clinique', ['Céphalées', 'Céphalée', 'Maux de tête'], { acute: true }),
  c('syncope', 'clinique', ['Syncope', 'Malaise', 'Perte de connaissance', 'Lipothymie'], { labelOnly: ['PC'], acute: true }),
  c('confusion', 'clinique', ['Confusion', 'Syndrome confusionnel', 'Troubles de la conscience', 'Altération de la conscience', 'Coma'], { forms: ['confus', 'confuse', 'désorienté', 'désorientée', 'comateux'], acute: true }),
  c('deficit_neuro', 'clinique', ['Déficit neurologique', 'Hémiplégie', 'Hémiparésie', 'Déficit moteur', 'Aphasie', 'Paralysie faciale'], { forms: ['hémiplégique', 'aphasique'], acute: true }),
  c('hemorragie_digestive', 'clinique', ['Hémorragie digestive', 'Hématémèse', 'Méléna', 'Rectorragie', 'Rectorragies', 'Saignement digestif'], { acute: true }),
  c('ictere', 'clinique', ['Ictère', 'Jaunisse', 'Subictère'], { forms: ['ictérique'], acute: true }),
  c('oedemes', 'clinique', ['Œdèmes des membres inférieurs', 'Oedèmes des membres inférieurs', 'OMI', 'Œdèmes', 'Oedèmes'], { acute: true }),
  c('amaigrissement', 'clinique', ['Amaigrissement', 'Perte de poids', 'Altération de l’état général', 'AEG', 'Asthénie', 'Anorexie'], {}),
  c('choc', 'clinique', ['Choc', 'État de choc', 'Choc septique', 'Choc hémorragique', 'Choc cardiogénique', 'Collapsus', 'Défaillance hémodynamique'], { acute: true }),
  c('sepsis', 'clinique', ['Sepsis', 'Septicémie', 'Sepsis sévère', 'Bactériémie'], { forms: ['septique'], acute: true }),
  c('pneumopathie', 'clinique', ['Pneumopathie', 'Pneumonie', 'PAC', 'Pneumopathie infectieuse', 'Pneumonie aiguë communautaire', 'Infection pulmonaire'], { acute: true }),
  c('infection_urinaire', 'clinique', ['Infection urinaire', 'Pyélonéphrite', 'Cystite', 'Prostatite', 'IU', 'PNA'], { acute: true }),
  c('motif', 'clinique', ['Motif de consultation', 'Motif d’hospitalisation', 'Motif d’admission', 'Motif', 'Motif d’entrée', 'Plainte principale'], { generic: true }),
  c('diagnostic', 'clinique', ['Diagnostic', 'Diagnostic retenu', 'Diagnostic principal', 'Diagnostic final', 'Conclusion'], { generic: true }),
  c('histoire', 'clinique', ['Histoire de la maladie', 'HDM', 'Anamnèse'], { generic: true }),
  c('examen_clinique', 'clinique', ['Examen clinique', 'Examen physique', 'À l’examen'], { generic: true }),
  c('nyha', 'score', ['Stade NYHA', 'NYHA', 'Classe NYHA', 'Dyspnée NYHA']),
  c('asa', 'score', ['Score ASA', 'ASA', 'Classe ASA'], { range: [1, 6] }),
  c('oms_ps', 'score', ['Performance status', 'PS', 'OMS', 'Score OMS', 'ECOG'], { range: [0, 5] }),
  c('stade_tnm', 'score', ['Stade TNM', 'TNM', 'Classification TNM', 'Stade', 'pTNM'], {}),
  c('score_charlson', 'score', ['Score de Charlson', 'Charlson', 'Indice de Charlson'], {}),
  c('sofa', 'score', ['Score SOFA', 'SOFA'], { range: [0, 24] }),
  c('igs2', 'score', ['IGS II', 'IGS2', 'SAPS II'], {}),
  c('apgar', 'score', ['Score d’Apgar', 'Apgar'], { range: [0, 10] }),
  c('nihss', 'score', ['Score NIHSS', 'NIHSS'], { range: [0, 42] }),
  c('fevg', 'score', ['FEVG', 'Fraction d’éjection ventriculaire gauche', 'Fraction d’éjection', 'FE', 'LVEF'], { unit: '%', range: [5, 90] }),

  // ───────────────────────────────────────────────────────────── imagerie et explorations
  c('scanner', 'imagerie', ['Scanner', 'TDM', 'Tomodensitométrie', 'Angioscanner', 'Uroscanner', 'Coroscanner', 'CT-scan', 'CT scan', 'Body-scanner', 'Bodyscanner'], {}),
  c('irm', 'imagerie', ['IRM', 'Imagerie par résonance magnétique', 'Angio-IRM', 'Bili-IRM', 'Entéro-IRM', 'IRM cérébrale'], {}),
  c('echographie', 'imagerie', ['Échographie', 'Echographie', 'Écho', 'Echo', 'Écho-doppler', 'Échodoppler', 'Doppler', 'Échographie abdominale'], {}),
  c('echocardiographie', 'imagerie', ['Échocardiographie', 'ETT', 'ETO', 'Échographie cardiaque', 'Écho cœur', 'Échocardiographie transthoracique'], {}),
  c('radiographie', 'imagerie', ['Radiographie', 'Radio', 'RX', 'Cliché', 'Radiographie thoracique', 'Radio de thorax', 'Radiographie pulmonaire', 'RP', 'ASP', 'Abdomen sans préparation'], {}),
  c('tep', 'imagerie', ['TEP', 'TEP-scanner', 'TEP-TDM', 'PET-scan', 'PET-CT', 'TEP au FDG', 'Tomographie par émission de positons'], {}),
  c('scintigraphie', 'imagerie', ['Scintigraphie', 'Scintigraphie osseuse', 'Scintigraphie pulmonaire', 'Scintigraphie myocardique'], {}),
  c('mammographie', 'imagerie', ['Mammographie', 'Mammo'], {}),
  c('ecg', 'imagerie', ['ECG', 'Électrocardiogramme', 'Electrocardiogramme'], {}),
  c('eeg', 'imagerie', ['EEG', 'Électroencéphalogramme'], {}),
  c('fogd', 'imagerie', ['FOGD', 'Fibroscopie œsogastroduodénale', 'Fibroscopie', 'Gastroscopie', 'Endoscopie digestive haute', 'EOGD'], {}),
  c('coloscopie', 'imagerie', ['Coloscopie', 'Rectosigmoïdoscopie', 'Endoscopie digestive basse'], {}),
  c('bronchoscopie', 'imagerie', ['Bronchoscopie', 'Fibroscopie bronchique', 'Endoscopie bronchique', 'LBA', 'Lavage broncho-alvéolaire'], {}),
  c('coronarographie', 'imagerie', ['Coronarographie', 'Coro', 'Cathétérisme cardiaque', 'Angioplastie coronaire'], {}),
  c('biopsie', 'imagerie', ['Biopsie', 'Ponction-biopsie', 'Prélèvement biopsique', 'Biopsie guidée'], {}),
  c('anapath', 'imagerie', ['Anatomopathologie', 'Anapath', 'Histologie', 'Examen anatomopathologique', 'Résultat histologique', 'Type histologique'], {}),
  c('efr', 'imagerie', ['EFR', 'Explorations fonctionnelles respiratoires', 'Spirométrie', 'VEMS'], {}),
  c('ponction_lombaire', 'imagerie', ['Ponction lombaire', 'PL', 'LCR', 'Liquide céphalorachidien'], {}),
  c('imagerie', 'imagerie', ['Imagerie', 'Examens d’imagerie', 'Bilan radiologique', 'Examen radiologique', 'Modalité d’imagerie'], { generic: true }),

  // ───────────────────────────────────────────────────────────── traitements, prise en charge
  c('traitement', 'traitement', ['Traitement', 'TTT', 'Prise en charge', 'PEC', 'Conduite à tenir', 'CAT', 'Thérapeutique', 'Traitement reçu'], { generic: true }),
  c('traitement_habituel', 'traitement', ['Traitement habituel', 'Traitement de fond', 'Traitement en cours', 'Traitement à domicile', 'TTT habituel', 'Ordonnance'], { generic: true }),
  c('antibiotherapie', 'traitement', ['Antibiothérapie', 'ATB', 'Antibiotiques', 'Antibiotique', 'Amoxicilline', 'Augmentin', 'Ceftriaxone', 'C3G', 'Fluoroquinolone', 'Vancomycine', 'Pipéracilline-tazobactam'], { forms: ['antibiothérapie probabiliste'] }),
  c('chirurgie', 'traitement', ['Chirurgie', 'Intervention chirurgicale', 'Traitement chirurgical', 'Intervention', 'Opération', 'Laparotomie', 'Cœlioscopie', 'Coelioscopie', 'Exérèse'], { forms: ['opéré', 'opérée', 'chirurgical', 'chirurgicale'] }),
  c('chimiotherapie', 'traitement', ['Chimiothérapie', 'CTH', 'Chimio', 'Chimiothérapie néoadjuvante', 'Chimiothérapie adjuvante'], {}),
  c('radiotherapie', 'traitement', ['Radiothérapie', 'RTH', 'Radiothérapie externe', 'Curiethérapie', 'Radiochimiothérapie', 'RCT'], {}),
  c('immunotherapie', 'traitement', ['Immunothérapie', 'Thérapie ciblée', 'Anti-PD1', 'Anti-PD-L1'], {}),
  c('hormonotherapie', 'traitement', ['Hormonothérapie', 'Tamoxifène', 'Anti-aromatase', 'Hormonothérapie adjuvante'], {}),
  c('corticotherapie', 'traitement', ['Corticothérapie', 'Corticoïdes', 'Prednisone', 'Cortancyl', 'Solumédrol', 'Méthylprednisolone', 'Hydrocortisone', 'Dexaméthasone'], {}),
  c('anticoagulant', 'traitement', ['Anticoagulant', 'Anticoagulation', 'Anticoagulants', 'AVK', 'Antivitamine K', 'AOD', 'NACO', 'Héparine', 'HBPM', 'Enoxaparine', 'Lovenox', 'Apixaban', 'Rivaroxaban', 'Warfarine', 'Fluindione', 'Préviscan'], { forms: ['anticoagulé', 'anticoagulée'] }),
  c('antiagregant', 'traitement', ['Antiagrégant plaquettaire', 'Antiagrégants plaquettaires', 'Aspirine', 'Kardégic', 'Clopidogrel', 'Plavix', 'Ticagrélor', 'Brilique', 'Double antiagrégation', 'AAP'], {}),
  c('insuline', 'traitement', ['Insuline', 'Insulinothérapie', 'Lantus', 'Novorapid'], { forms: ['insulinotraité', 'insulinotraitée', 'sous insuline'] }),
  c('antidiabetique_oral', 'traitement', ['Antidiabétiques oraux', 'ADO', 'Metformine', 'Glucophage', 'Sulfamides', 'Gliclazide', 'Diamicron', 'Inhibiteur de DPP4', 'Sitagliptine', 'iSGLT2', 'Gliflozine'], {}),
  c('antihypertenseur', 'traitement', ['Antihypertenseur', 'Antihypertenseurs', 'IEC', 'ARA2', 'ARA II', 'Inhibiteur calcique', 'Amlodipine', 'Ramipril', 'Périndopril', 'Bêtabloquant', 'Bisoprolol', 'Diurétique', 'Furosémide', 'Lasilix'], {}),
  c('statine', 'traitement', ['Statine', 'Statines', 'Atorvastatine', 'Rosuvastatine', 'Simvastatine', 'Tahor', 'Crestor'], {}),
  c('ains', 'traitement', ['AINS', 'Anti-inflammatoires non stéroïdiens', 'Ibuprofène', 'Kétoprofène', 'Diclofénac'], {}),
  c('antalgique', 'traitement', ['Antalgiques', 'Antalgique', 'Paracétamol', 'Morphine', 'Morphiniques', 'Tramadol', 'Néfopam', 'Acupan', 'Analgésie'], {}),
  c('ipp', 'traitement', ['IPP', 'Inhibiteur de la pompe à protons', 'Oméprazole', 'Ésoméprazole', 'Pantoprazole', 'Inexium'], {}),
  c('transfusion', 'traitement', ['Transfusion', 'Transfusion sanguine', 'CGR', 'Culots globulaires', 'Concentrés de globules rouges', 'PFC', 'Plasma frais congelé', 'Culots plaquettaires'], { forms: ['transfusé', 'transfusée'] }),
  c('ventilation', 'traitement', ['Ventilation mécanique', 'Intubation', 'Ventilation invasive', 'VNI', 'Ventilation non invasive', 'Oxygénothérapie à haut débit', 'OHD', 'Optiflow'], { forms: ['intubé', 'intubée', 'ventilé', 'ventilée'] }),
  c('oxygenotherapie', 'traitement', ['Oxygénothérapie', 'Oxygène', 'O2', 'Lunettes à oxygène', 'Masque à haute concentration', 'MHC'], {}),
  c('amines', 'traitement', ['Amines vasopressives', 'Amines', 'Noradrénaline', 'Vasopresseurs', 'Dobutamine', 'Adrénaline'], {}),
  c('dialyse_aigue', 'traitement', ['Épuration extrarénale', 'EER', 'Hémodialyse en urgence', 'Hémodiafiltration'], {}),
  c('endoscopie_therapeutique', 'traitement', ['Endoscopie thérapeutique', 'CPRE', 'Sphinctérotomie', 'Ligature de varices', 'Polypectomie', 'Mucosectomie'], { forms: ['endoscopique'] }),
  c('angioplastie', 'traitement', ['Angioplastie', 'Stent', 'Pose de stent', 'Revascularisation', 'Thrombectomie', 'Thrombolyse', 'Fibrinolyse'], {}),
  c('kinesitherapie', 'traitement', ['Kinésithérapie', 'Kiné', 'Rééducation', 'Kinésithérapie respiratoire'], {}),
  c('nutrition', 'traitement', ['Nutrition entérale', 'Nutrition parentérale', 'Sonde nasogastrique', 'SNG', 'Gastrostomie', 'Compléments nutritionnels'], {}),
  c('drainage', 'traitement', ['Drainage', 'Drain', 'Drainage thoracique', 'Drainage percutané', 'Ponction évacuatrice'], {}),
  c('abstention', 'traitement', ['Abstention thérapeutique', 'Surveillance simple', 'Abstention', 'Soins de confort', 'Soins palliatifs', 'Surveillance'], {}),

  // ───────────────────────────────────────────────────────────── évolution, issue
  c('evolution', 'evolution', ['Évolution', 'Evolution', 'Devenir', 'Issue', 'Suites', 'Évolution clinique'], { generic: true }),
  c('deces', 'evolution', ['Décès', 'Mortalité', 'Décès hospitalier', 'Mortalité hospitalière', 'Mortalité à J30', 'DC'], { forms: ['décédé', 'décédée', 'est décédé', 'est décédée', 'mort'] }),
  c('complications', 'evolution', ['Complications', 'Complication', 'Complications postopératoires', 'Morbidité', 'Suites compliquées', 'Événement indésirable'], { forms: ['compliqué', 'compliquée', 'compliquées'], acute: true }),
  c('infection_site', 'evolution', ['Infection du site opératoire', 'ISO', 'Abcès de paroi', 'Infection de paroi', 'Suppuration pariétale'], { acute: true }),
  c('fistule', 'evolution', ['Fistule', 'Fistule anastomotique', 'Lâchage anastomotique', 'Désunion anastomotique'], { acute: true }),
  c('reintervention', 'evolution', ['Reprise chirurgicale', 'Réintervention', 'Ré-intervention', 'Reprise opératoire'], { forms: ['réopéré', 'réopérée'], acute: true }),
  c('rehospitalisation', 'evolution', ['Réhospitalisation', 'Réadmission', 'Ré-hospitalisation', 'Réadmission à J30'], { acute: true }),
  c('recidive', 'evolution', ['Récidive', 'Rechute', 'Récurrence', 'Progression'], {}),
  c('rea', 'evolution', ['Transfert en réanimation', 'Réanimation', 'Soins intensifs', 'USI', 'USIC', 'Passage en réanimation'], { acute: true }),
  c('mode_sortie', 'evolution', ['Mode de sortie', 'Destination à la sortie', 'Sortie', 'Orientation'], { generic: true }),
  c('perdu_de_vue', 'evolution', ['Perdu de vue', 'Perdue de vue', 'PDV'], {}),
  c('guerison', 'evolution', ['Guérison', 'Rémission', 'Rémission complète', 'RC'], { forms: ['guéri', 'guérie'] }),
  c('sequelles', 'evolution', ['Séquelles', 'Séquelle', 'Handicap résiduel', 'Rankin', 'Score de Rankin modifié', 'mRS'], {}),

  // ───────────────────────────────────────────────────────────── rubriques
  c('antecedents', 'rubrique', ['Antécédents', 'ATCD', 'Antécédents personnels', 'Antécédents médicaux', 'Atcds', 'Antécédents médico-chirurgicaux', 'Passé médical'], { generic: true }),
  c('antecedents_familiaux', 'rubrique', ['Antécédents familiaux', 'ATCD familiaux', 'Histoire familiale'], { generic: true }),
  c('mode_vie', 'rubrique', ['Mode de vie', 'Habitus', 'Conditions de vie'], { generic: true }),
  c('conclusion', 'rubrique', ['Conclusion', 'Synthèse', 'En résumé', 'Résumé'], { generic: true }),
];

/** Mots vides ignorés au rapprochement d'un libellé : « Taux de CRP » et « CRP » visent la même notion. */
const STOPWORDS = new Set([
  'de', 'du', 'des', 'd', 'la', 'le', 'les', 'l', 'a', 'au', 'aux', 'en', 'et', 'ou', 'un', 'une', 'par', 'pour',
  'sur', 'dans', 'avec', 'the', 'of', 'taux', 'valeur', 'niveau', 'resultat', 'presence', 'notion', 'existence',
  'patient', 'patiente', 'oui', 'non', 'connu', 'connue', 'y', 'compris', 'lors', 'mesure', 'mesuree', 'dosage',
]);

/** Mots qui situent une mesure dans le temps ou le dossier, sans désigner de notion à eux seuls. */
const QUALIFIER_TOKENS = new Set(
  ['admission', 'entree', 'arrivee', 'j0', 'initial', 'initiale', 'sortie', 'antecedent', 'atcd', 'admi', 'admise', 'entre', 'le'].map(stemToken),
);

function stemToken(t: string): string {
  return t.length > 3 && /[sx]$/.test(t) && !/(?:ss|us|is)$/.test(t) ? t.slice(0, -1) : t;
}

/** Mots qui situent la mesure à l'arrivée du patient (« CRP à l'admission », « Hb d'entrée »). */
const ADMISSION_WORDS = /\b(?:admission|entree|arrivee|j0|initial|initiale|initiaux|aux urgences|premier bilan|bilan d'entree)\b/;

/** Ramène un mot à une forme comparable : repli, pluriel courant retiré. */
const stem = (token: string): string => stemToken(token);

function tokens(text: string): string[] {
  return fold(text)
    .replace(/[’'`´-]/g, ' ')
    .split(/[^\p{L}\p{N}+]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t))
    .map(stem);
}

/**
 * Libellé nettoyé : unité ou précision entre parenthèses ou crochets retirée (« CRP (mg/L) », « Poids [kg] »), unité
 * finale après une virgule ou « en » (« Poids, kg », « Taille en cm »), ponctuation de fin (« Âge : », « HTA ? »),
 * espaces repliées. Garde la casse et les accents : c'est encore un libellé à afficher et à chercher.
 */
export function cleanLabel(label: string): string {
  return label
    .replace(/[   ]/g, ' ')
    .replace(/\s*[([][^()[\]]{0,40}[)\]]/g, ' ')
    .replace(/\s*(?:,|\ben)\s*(?:mg|g|µg|ng|pg|mmol|µmol|ui|u|kg|cm|mm|m|ml|l|%|°c|mmhg|ans?|jours?|mois|bpm|\/mm3)(?:\s*\/\s*[a-zµ0-9³²]+)?\s*$/iu, '')
    .replace(/[\s:;=?!.*_–—-]+$/u, '')
    .replace(/^[\s:;=?!.*_•–—-]+/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface IndexedTerm {
  concept: Concept;
  key: string;
  size: number;
  length: number;
}

let INDEX: IndexedTerm[] | null = null;
function index(): IndexedTerm[] {
  if (INDEX) return INDEX;
  INDEX = [];
  for (const concept of CONCEPTS) {
    for (const term of [...concept.terms, ...(concept.labelOnly ?? [])]) {
      const toks = [...new Set(tokens(term))].sort();
      if (toks.length === 0) continue;
      INDEX.push({ concept, key: toks.join(' '), size: toks.length, length: fold(term).length });
    }
  }
  return INDEX;
}

/**
 * Notion à laquelle se rattache un libellé libre, ou `null`.
 *
 * Rapprochement par ensemble de mots repliés : l'ordre, la casse, les accents, les mots vides et une unité entre
 * parenthèses n'y font rien (« Protéine C réactive (mg/L) », « réactive, protéine C »). D'abord l'égalité exacte
 * avec l'une des écritures connues ; sinon, l'écriture connue la plus complète entièrement contenue dans le libellé
 * (« Taux d'hémoglobine à l'admission » -> hémoglobine). Une rubrique générique (« Traitement ») ne gagne que par
 * égalité exacte : « Traitement par insuline » est l'insuline, pas la rubrique.
 */
export function findConcept(label: string): Concept | null {
  const toks = [...new Set(tokens(cleanLabel(label)))].sort();
  if (toks.length === 0) return null;
  const key = toks.join(' ');
  const exact = index().find((t) => t.key === key);
  if (exact) return exact.concept;
  const set = new Set(toks);
  let best: IndexedTerm | null = null;
  for (const t of index()) {
    if (t.concept.generic) continue;
    const words = t.key.split(' ');
    if (!words.every((w) => set.has(w))) continue;
    // « Admission le » ne rattache pas « CRP à l'admission » aux dates : un mot qui situe la mesure dans le temps ne
    // désigne pas, seul, la notion.
    if (words.every((w) => QUALIFIER_TOKENS.has(w))) continue;
    // Un sigle d'une lettre ou deux (« T », « P », « K ») ne rattache pas un libellé plus long à sa notion.
    if (t.size === 1 && t.length <= 2 && toks.length > 1) continue;
    if (!best || t.size > best.size || (t.size === best.size && t.length > best.length)) best = t;
  }
  return best?.concept ?? null;
}

/** Le libellé situe-t-il la mesure à l'arrivée (« CRP à l'admission », « Température d'entrée ») ? */
export function mentionsAdmission(label: string): boolean {
  return ADMISSION_WORDS.test(fold(label));
}

function unique(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const k = fold(item).replace(/\s+/g, ' ').trim();
    if (k.length === 0 || seen.has(k)) continue;
    seen.add(k);
    out.push(item.trim());
  }
  return out;
}

/**
 * Écritures d'un libellé libre : le libellé nettoyé lui-même, toujours en tête, puis les synonymes, sigles et formes
 * de sa notion quand le lexique la reconnaît (`findConcept`). Sans notion reconnue, le libellé nettoyé seul.
 */
export function variantsFor(label: string): string[] {
  const cleaned = cleanLabel(label) || label.trim();
  const concept = findConcept(label);
  if (!concept) return [cleaned];
  return unique([cleaned, ...concept.terms, ...(concept.labelOnly ?? []), ...(concept.forms ?? [])]);
}
