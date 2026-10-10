import { useId } from 'react';

/**
 * Identité visuelle de PubResearcher.
 *
 * La marque est un médaillon indigo cerclé d'or : un « P » blanc, une étincelle
 * dorée à son épaule. Elle est dessinée ici en SVG — aucun fichier à déposer,
 * net à toutes les tailles, identique dans les deux thèmes (le même dessin est
 * servi comme icône d'onglet : `public/favicon.svg`).
 *
 * Le mot-symbole est en deux tons : « Pub » au bleu de la marque, « Researcher »
 * à l'encre du thème.
 */

export const PRODUCT = 'PubResearcher';

export function BrandMark({ size = 40 }: { size?: number }) {
  // Un identifiant par instance : deux médaillons dans la même page ne doivent pas se disputer le même dégradé.
  const gradient = useId();

  return (
    <svg
      className="brand-mark"
      width={size}
      height={size}
      viewBox="0 0 40 40"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradient} x1="6" y1="4" x2="34" y2="38" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#3a2a86" />
          <stop offset="1" stopColor="#130b2e" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="20" r="18.6" fill={`url(#${gradient})`} stroke="#e2c979" strokeWidth="1.6" />
      {/* Le « P » : une hampe et une panse, la contre-forme évidée. */}
      <path
        fill="#ffffff"
        fillRule="evenodd"
        d="M13.5 11h7.2a6.3 6.3 0 0 1 0 12.6H17.5V29h-4Zm4 3.6V20h3a2.7 2.7 0 0 0 0-5.4Z"
      />
      {/* L'étincelle. */}
      <path fill="#e2c979" d="M29.6 6.8l1.1 2.4 2.4 1.1-2.4 1.1-1.1 2.4-1.1-2.4-2.4-1.1 2.4-1.1Z" />
    </svg>
  );
}

export function Brand() {
  return (
    <div className="brand">
      <BrandMark />
      <span className="brand-text">
        <span className="brand-title">
          <span className="brand-pub">Pub</span>
          <span className="brand-researcher">Researcher</span>
        </span>
        <span className="brand-sub">Dossiers · Littérature</span>
      </span>
    </div>
  );
}
