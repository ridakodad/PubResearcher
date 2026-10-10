// Fabrique les PDF de test de l'OCR. Hors suite : le résultat est versionné, ce script
// documente seulement l'origine des fichiers (aucune donnée réelle, texte inventé).
//
//   PLAYWRIGHT=/chemin/vers/playwright/index.mjs CHROMIUM=/chemin/vers/chrome node make-fixtures.mjs
//
// scan.pdf   — une page, uniquement une image : aucune couche texte, comme un scanner.
// mixte.pdf  — page 1 scannée, page 2 avec couche texte (« Poids : 71 kg »).
// double.pdf — deux pages scannées, pour éprouver le plafond de pages OCR.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const compteRendu = `
<div style="font:22px/1.5 'DejaVu Serif', serif; padding:60px 70px; width:1050px; height:1450px; background:#fff; color:#111">
<h2 style="font-size:28px">COMPTE RENDU D'HOSPITALISATION</h2>
<p>N° dossier : 24-0153<br>Âge : 54 ans<br>Sexe : Féminin<br>Date d'admission : 12/03/2024</p>
<p>Motif d'hospitalisation : douleurs abdominales aiguës</p>
<p>Antécédents : diabète type 2, pas d'HTA, tabagisme sevré.</p>
<p>Hémoglobine : 11,2 g/dL<br>CRP : 142 mg/L<br>Température : 38,5 °C</p>
<p>Traitement : chirurgical. Évolution : favorable.<br>Durée d'hospitalisation : 12 jours</p>
</div>`;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1190, height: 1560 } });
await page.setContent(`<body style="margin:0;background:#fff">${compteRendu}</body>`);
const png = await page.screenshot({ clip: { x: 0, y: 0, width: 1190, height: 1560 } });
const b64 = png.toString('base64');
const img = (extra = '') => `<img src="data:image/png;base64,${b64}" style="width:210mm;display:block;${extra}">`;
const opts = { width: '210mm', height: '297mm', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } };

const build = async (name, html) => {
  await page.setContent(`<body style="margin:0">${html}</body>`);
  await page.pdf({ path: path.join(here, name), ...opts });
  console.log(name, fs.statSync(path.join(here, name)).size, 'octets');
};

await build('scan.pdf', img());
await build('mixte.pdf', `${img('page-break-after:always')}<div style="padding:30px;font:16px sans-serif">Page deux avec couche texte : Poids : 71 kg</div>`);
await build('double.pdf', `${img('page-break-after:always')}${img()}`);
await browser.close();
