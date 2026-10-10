// Génère l'illustration de la carte d'en-tête (web/src/assets/hero-dust.svg) : un arc d'or et sa poussière, sur
// fond transparent, posés sur le dégradé indigo de la carte (voir `.hero` dans web/src/styles.css).
//
// Générateur déterministe : la graine est fixe, le fichier produit est identique à chaque exécution.
//   node scripts/make-hero-art.mjs [sortie.svg]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] ?? path.join(root, 'web/src/assets/hero-dust.svg');

const W = 1200, H = 300;
// Cercle dont on ne voit que le limbe inférieur droit : passe par (680,300) et (1045,0), centre en haut à gauche.
const A = { x: 680, y: 300 }, B = { x: 1045, y: 0 };
const R = 1008, C = { x: 239, y: -607 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rnd = mulberry32(20261010);
const angA = Math.atan2(A.y - C.y, A.x - C.x), angB = Math.atan2(B.y - C.y, B.x - C.x);

const dots = [];
const GOLDS = ['#f6e7b4', '#f0d98e', '#e6c46f', '#d9b25a'];
for (let i = 0; i < 260; i++) {
  // position le long de l'arc (un peu au-delà des deux bouts), puis profondeur vers l'intérieur
  const t = -0.08 + rnd() * 1.16;
  const ang = angA + (angB - angA) * t;
  const depth = -Math.log(1 - rnd() * 0.97) * 62; // loi exponentielle : dense contre l'arc, clairsemée au large
  if (depth > 300) continue;
  const rr = R - 2 - depth;
  const x = C.x + Math.cos(ang) * rr, y = C.y + Math.sin(ang) * rr;
  if (x < 0 || x > W || y < -2 || y > H + 2) continue;
  const near = Math.exp(-depth / 120);
  const op = Math.min(0.9, 0.14 + near * 0.7 * (0.35 + rnd() * 0.65));
  const r = 0.45 + rnd() * rnd() * 1.5;
  const colour = rnd() < 0.12 ? '#d9d3ff' : GOLDS[Math.floor(rnd() * GOLDS.length)];
  dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(2)}" fill="${colour}" fill-opacity="${op.toFixed(2)}"/>`);
}
// quelques grains isolés, plus loin dans la nuit
for (let i = 0; i < 26; i++) {
  const x = 420 + rnd() * 560, y = rnd() * H;
  dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(0.5 + rnd() * 0.9).toFixed(2)}" fill="#d9d3ff" fill-opacity="${(0.12 + rnd() * 0.3).toFixed(2)}"/>`);
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
<defs>
<linearGradient id="g" gradientUnits="userSpaceOnUse" x1="${B.x}" y1="${B.y}" x2="${A.x}" y2="${A.y}">
<stop offset="0" stop-color="#f6e7b4" stop-opacity="0.95"/>
<stop offset="0.55" stop-color="#d9bb6c" stop-opacity="0.6"/>
<stop offset="1" stop-color="#b99a52" stop-opacity="0.2"/>
</linearGradient>
<linearGradient id="s" gradientUnits="userSpaceOnUse" x1="560" y1="300" x2="1200" y2="140">
<stop offset="0" stop-color="#ffffff" stop-opacity="0"/>
<stop offset="0.6" stop-color="#c9b8ff" stop-opacity="0.5"/>
<stop offset="1" stop-color="#ffffff" stop-opacity="0"/>
</linearGradient>
<filter id="b" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="5"/></filter>
</defs>
<path d="M 560 306 Q 900 250 1210 140" fill="none" stroke="url(#s)" stroke-width="16" opacity="0.2" filter="url(#b)"/>
<path d="M ${A.x} ${A.y} A ${R} ${R} 0 0 0 ${B.x} ${B.y}" fill="none" stroke="url(#g)" stroke-width="7" opacity="0.28" filter="url(#b)"/>
<path d="M ${A.x} ${A.y} A ${R} ${R} 0 0 0 ${B.x} ${B.y}" fill="none" stroke="url(#g)" stroke-width="1.5"/>
${dots.join('\n')}
</svg>
`;
fs.writeFileSync(out, svg);
console.log(`${path.relative(root, out)} : ${dots.length} grains, ${(svg.length / 1024).toFixed(1)} Ko`);
