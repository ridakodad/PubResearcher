/**
 * Plafonds de l'analyse de fichiers.
 *
 * Un dossier patient est écrit par des logiciels hospitaliers, des scanners et des mains
 * pressées : on y trouve des PDF de trente mille pages, des Word décompressés à plusieurs
 * gigaoctets, des images de cent mégapixels. Sans plafond, l'un de ces fichiers suffit à
 * occuper le serveur plusieurs minutes ou à épuiser sa mémoire — pour tous ceux qui
 * l'utilisent. Chaque plafond se règle par une variable d'environnement, lue à chaque
 * fichier : se heurter à un plafond doit toujours produire un message qui dit lequel et
 * comment le relever, jamais un silence.
 */

import os from 'node:os';

const MB = 1024 * 1024;

function envNumber(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
}

export const limits = {
  /** Texte conservé par document, en caractères (≈ 8 Mo). Au-delà, le texte est coupé et le document le signale. */
  maxTextChars: () => envNumber('MAX_TEXT_CHARS', 8_000_000),
  /** Pages lues par PDF. Les suivantes sont ignorées et comptées dans `pagesTruncated`. */
  maxPdfPages: () => envNumber('PDF_MAX_PAGES', 1500),
  /** Temps accordé à la lecture d'un PDF avant de rendre ce qui a été lu. */
  pdfTimeoutMs: () => envNumber('PDF_PARSE_TIMEOUT_MS', 120_000, 1000),
  /** Taille décompressée des parties XML d'un fichier Word (le texte structuré, pas les images). */
  maxDocxXmlBytes: () => envNumber('DOCX_MAX_XML_MB', 32) * MB,
  /** Taille décompressée de l'ensemble d'une archive Word. */
  maxDocxTotalBytes: () => envNumber('DOCX_MAX_TOTAL_MB', 512) * MB,
  /** Image acceptée par la reconnaissance optique, en pixels. */
  maxImagePixels: () => envNumber('IMAGE_MAX_MEGAPIXELS', 100) * 1_000_000,
  /** Fichiers analysés en même temps, tous envois confondus (et nombre de fils d'analyse). */
  parseConcurrency: () => envNumber('PARSE_CONCURRENCY', 2),
  /**
   * Délai ferme d'une analyse dans son fil, au-delà duquel le fil est arrêté. Le délai du PDF ci-dessus est
   * « poli » (la lecture rend ce qu'elle a lu entre deux pages) ; celui-ci attrape ce qui ne rend jamais la main.
   */
  parseHardTimeoutMs: () => envNumber('PARSE_HARD_TIMEOUT_MS', envNumber('PDF_PARSE_TIMEOUT_MS', 120_000, 1000) + 60_000, 1000),
  /**
   * Mémoire du tas d'un fil d'analyse, en Mo. Node ne borne pas la mémoire hors tas (tampons binaires : un flux
   * compressé qui se gonfle de mille fois sa taille y loge), et abandonne ce réglage si le processus a reçu
   * `--max-old-space-size` : voir `parseMaxGrowthMb`, qui couvre ces deux cas.
   */
  parseWorkerMb: () => envNumber('PARSE_WORKER_MB', 2048, 128),
  /**
   * Croissance de la mémoire du serveur, en Mo, pendant une analyse, au-delà de laquelle l'analyse la plus
   * ancienne est arrêtée. Par défaut 3 Go, ou 40 % de la mémoire de la machine si elle est plus petite.
   */
  parseMaxGrowthMb: () => envNumber('PARSE_MAX_GROWTH_MB', Math.min(3072, Math.floor((os.totalmem() / MB) * 0.4)), 64),
  /** Tableau de cohorte : lignes lues par feuille (un patient par ligne). */
  tableMaxRows: () => envNumber('TABLE_MAX_ROWS', 50_000),
  /** Tableau de cohorte : colonnes lues par feuille. */
  tableMaxColumns: () => envNumber('TABLE_MAX_COLUMNS', 2_000),
  /** Tableau de cohorte : cellules non vides lues dans tout le classeur. */
  tableMaxCells: () => envNumber('TABLE_MAX_CELLS', 2_000_000),
  /** Classeur : taille décompressée d'une partie XML (une feuille, la table des chaînes). */
  tableMaxXmlBytes: () => envNumber('TABLE_MAX_XML_MB', 64) * MB,
  /** Classeur : taille décompressée de l'ensemble de l'archive. */
  tableMaxTotalBytes: () => envNumber('TABLE_MAX_TOTAL_MB', 256) * MB,
  /** `PARSE_ISOLATION=0` : les fichiers sont lus dans le fil principal, sans isolation (diagnostic). */
  parseIsolation: () => process.env.PARSE_ISOLATION !== '0',
};

