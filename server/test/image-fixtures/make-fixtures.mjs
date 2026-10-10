// Fabrique l'image de test de l'OCR. Hors suite : le résultat est versionné, ce script documente seulement l'origine
// du fichier (aucune donnée réelle, texte inventé).
//
//   PLAYWRIGHT=/chemin/vers/playwright/index.mjs CHROMIUM=/chemin/vers/chrome node make-fixtures.mjs
//
// scan-texte.png — une image de 820 × 380 pixels : quatre lignes de texte noir sur fond blanc, comme une photo de
// compte rendu. Les tests en tirent un JPEG (avec une date EXIF) et un TIFF, sans rien versionner de plus.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright');

const compteRendu = `
<div style="font:24px/1.5 'DejaVu Serif', serif; padding:24px 30px; width:760px; height:330px; background:#fff; color:#111">
<h3 style="font-size:26px;margin:0 0 8px">COMPTE RENDU</h3>
<p style="margin:0">Âge : 54 ans<br>Sexe : Féminin<br>CRP : 142 mg/L<br>Température : 38,5 °C</p>
</div>`;

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 820, height: 380 } });
await page.setContent(`<body style="margin:0;background:#fff">${compteRendu}</body>`);
const png = await page.screenshot({ clip: { x: 0, y: 0, width: 820, height: 380 } });
fs.writeFileSync(path.join(here, 'scan-texte.png'), png);
console.log('scan-texte.png', png.length, 'octets');
await browser.close();
