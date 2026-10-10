# Identité visuelle

La charte graphique de PubResearcher : couleurs, police, formes, composants, thèmes, et ce qui la garde lisible. Tout vit dans `web/src/styles.css` (feuille écrite à la main, sans framework) et quelques composants (`web/src/components/Brand.tsx`, `web/src/components/charts/StatTile.tsx`, `web/src/App.tsx`).

## 1. Le parti pris

Une application de recherche clinique se lit longtemps : l'identité est donc **un habillage, jamais un obstacle**. Elle tient en trois idées :

- **Indigo nuit, poussière d'or, bleu pervenche.** Le fond de page est un blanc légèrement bleuté ; les blocs sont des cartes aux grands rayons à l'ombre diffuse teintée d'indigo ; l'or ne sert qu'aux étiquettes et aux filets, le bleu pervenche à l'action et à l'outil courant.
- **Une pièce maîtresse** : la carte d'en-tête du plan de travail, un dégradé indigo traversé d'un arc d'or poudré, avec les chiffres-clés en pastilles de verre.
- **Une navigation en verre sombre** : un rail vertical sur grand écran ; sur écran étroit, une pastille flottante au bas de l'écran, icône au-dessus du libellé, l'outil courant allumé en bleu pervenche.

Le verre dépoli (`backdrop-filter`) est réservé au *châssis* — barre supérieure, rail, fenêtres modales, notifications, pastilles de la carte d'en-tête. Jamais sous du texte de données ni sous un graphique : la lisibilité passe avant l'effet.

## 2. Couleurs

Toutes les couleurs sont des **jetons** (`--nom`) déclarés une fois en tête de feuille, en trois blocs : `:root` (thème clair, complet), `@media (prefers-color-scheme: dark)` et `:root[data-theme='dark']` (thème sombre, identique dans les deux blocs — un test le vérifie). Un composant ne déclare jamais de couleur en dur, sauf le rail et la carte d'en-tête (voir § 5), qui sont sombres dans les deux thèmes.

### Marque

| Jeton | Clair | Sombre | Rôle |
|---|---|---|---|
| `--brand` | `#3d55c0` | `#8ea6ff` | Liens, focus, série de données, étiquettes de section |
| `--brand-strong` | `#2f4299` | `#aebfff` | Survol |
| `--brand-soft` | `#e8edff` | `#1b2350` | Aplat de fond (sélection, pastille) |
| `--brand-grad` | `#4a66d6 → #3d55c0` | `#a3b6ff → #8ea6ff` | Fond des boutons pleins |
| `--on-brand` | `#ffffff` | `#0b0820` | Texte posé sur un aplat de marque |
| `--accent` | `#7a5a06` | `#e8cf8a` | Or d'encre : texte (valeurs proposées par le modèle, avertissements) |
| `--gold` | `#e2c979` | `#e8cf8a` | Or décoratif (filets, étiquettes sur fond nuit) |
| `--violet` | `#5b3fd0` | `#b9a8ff` | Icône d'outil (extraction) |
| `--night` | `#130b2e` | — | Fond du rail et de la carte d'en-tête |

### Surfaces et encres

| Jeton | Clair | Sombre |
|---|---|---|
| `--plane` (fond de page) | `#f5f7fb` | `#0b0820` |
| `--surface-1` (cartes) | `#ffffff` | `#14102e` |
| `--surface-2` | `#eef0f9` | `#1d1842` |
| `--surface-3` | `#e1e5f3` | `#282257` |
| `--text-primary` | `#0c0a26` | `#f2f0ff` |
| `--text-secondary` | `#3b4160` | `#c3c0e8` |
| `--text-muted` | `#5a6184` | `#a29fce` |
| `--control-border` (champs de saisie) | `#6a7298` | `#8d89c0` |

### États

`--good-text`, `--warning`, `--serious` et `--critical` (avec `--critical-soft`) portent les états. **Le rouge n'encode jamais de donnée** : il ne sert qu'aux états critiques (suppression, erreur). Les graphiques n'ont qu'une série, donc une seule teinte séquentielle (`--series-1`, le bleu de la marque) ; l'or (`--series-2`) distingue ce que propose le modèle. Un couple vert/rouge porteur de sens serait illisible sous déficience de vision des couleurs.

### Contrastes mesurés (WCAG 2.2)

Mesurés sur la feuille de style elle-même, pour chaque encre contre chaque surface (`plane`, `surface-1`, `surface-2`, `surface-3`, `brand-soft`, `accent-soft`) :

| Encre | Clair (pire cas) | Sombre (pire cas) | Exigence |
|---|---:|---:|---|
| `--text-primary` | 15,4:1 | 11,3:1 | 4,5:1 |
| `--text-secondary` | 7,9:1 | 7,3:1 | 4,5:1 |
| `--text-muted` | 4,8:1 | 5,1:1 | 4,5:1 |
| `--brand` | 5,1:1 | 5,5:1 | 4,5:1 (texte), 3:1 (anneau de focus) |
| `--accent` | 5,1:1 | 8,3:1 | 4,5:1 |
| `--critical` | 5,2:1 | 5,9:1 | 4,5:1 |
| `--control-border` | 3,7:1 | 4,4:1 | 3:1 (WCAG 1.4.11) |
| `--on-brand` sur le dégradé des boutons | 5,0:1 | 8,5:1 | 4,5:1 |
| Blanc sur l'outil actif du rail | 4,6:1 | 4,6:1 | 4,5:1 |
| Texte de la carte d'en-tête | 6,9:1 (jeton), 6,7:1 (mesuré en rendu) | idem | 4,5:1 |

Un test (`server/test/web-contrast.test.ts`) recalcule ces rapports à partir de `styles.css` : une couleur modifiée qui passe sous le seuil fait échouer la suite. La mesure *en rendu* de la carte d'en-tête (dégradé, halo violet et poussière d'or sous chaque ligne de texte, de 320 à 1 440 px) a donné **6,7:1 au pire** ; le jeton du test (`--hero-ground`) est le fond le plus clair que l'on tolère sous du texte.

## 3. Typographie

**Poppins**, quatre graisses (400, 500, 600, 700), sous-ensemble latin, au format `woff2`, fournie avec l'application (`web/src/fonts/`, licence SIL OFL 1.1 : `OFL.txt` y est joint, avec un `README.md` de provenance). Elle est servie par l'application elle-même : l'outil démarre hors connexion, et la politique de sécurité du serveur (`font-src 'self'`) n'a pas à s'ouvrir.

- Titres : 700 pour `h1` (1,85 rem, interlettrage resserré), 600 pour `h2` et `h3`.
- Corps : 400, 15 px, interligne 1,55.
- Étiquettes de section et de colonne : capitales espacées (0,12 à 0,18 em), 600 — l'or sur fond nuit, le bleu de la marque sur fond clair.
- Chiffres-clés : 700, grande taille, au-dessus de leur libellé.
- Poppins ne porte ni les chiffres tabulaires ni quelques signes (≥, ≈, →) : la pile de repli est `'Segoe UI', system-ui, -apple-system, 'Helvetica Neue', sans-serif`, et la police du système prend le relais signe par signe.
- Les données (codes de dossier, clés techniques, chaînes de recherche) sont en `ui-monospace`.

## 4. Formes

| | |
|---|---|
| Rayons | 32 px (carte d'en-tête), 26 px (cartes d'outils), 18 px (panneaux, tuiles), 12 px (petits blocs), pastille complète (boutons, onglets, puces, rail) |
| Trame d'espacement | 4 / 8 / 12 / 16 / 24 / 32 px (`--s1` à `--s6`) |
| Ombres | Trois niveaux, larges et diffuses, teintées d'indigo (`--shadow-1` à `--shadow-3`) ; noires et plus denses en thème sombre |
| Mouvement | Court (140 à 320 ms), sortant, jamais décoratif ; tout s'efface sous `prefers-reduced-motion` |
| Cibles tactiles | 44 px pour les entrées du rail, 40 px pour les boutons secondaires sur écran tactile |

## 5. Composants

**Marque.** Un médaillon indigo cerclé d'or, un « P » blanc, une étincelle dorée — dessiné en SVG (`Brand.tsx`), identique dans les deux thèmes ; le même dessin est servi comme icône d'onglet (`web/public/favicon.svg`). Le mot-symbole est en deux tons : « Pub » au bleu de la marque, « Researcher » à l'encre du thème.

**Rail d'outils.** Une pastille de verre sombre, la même dans les deux thèmes (fond `--night`, halo bleu en bas à droite). L'outil courant s'allume en bleu pervenche (dégradé, liseré clair, halo). Les groupes portent une étiquette en capitales dorées ; les compteurs (dossiers, variables, complétude) sont à droite. Sur grand écran, un bouton de la barre supérieure le replie en icônes seules (tout reste nommé pour les lecteurs d'écran).
Sous 1 000 px, le rail devient une **pastille flottante** au bas de l'écran : icône au-dessus d'un libellé court, défilement horizontal, l'outil courant recentré à chaque changement. Chaque libellé court est contenu dans le libellé complet, que les lecteurs d'écran continuent de lire (WCAG 2.5.3). Les zones qui collent au bas de l'écran (barre d'enregistrement, saisie de la rédaction, notifications) se décalent de la hauteur de la pastille (`--dock`).

**Carte d'en-tête** (`.hero`). Dégradé `#130b2e → #2b1d68`, halo violet dans le coin, arc d'or poudré à droite, pastille de contour (mode d'extraction) en haut à droite, chiffres-clés en pastilles de verre. Elle est sombre dans les deux thèmes. L'arc est une image à part (`web/src/assets/hero-dust.svg`), produite par un générateur **déterministe** : `node scripts/make-hero-art.mjs` redonne le même fichier à l'octet près. Sur écran étroit, l'arc passe au bas de la carte pour ne pas traverser le texte.

**Tuiles de chiffres** (`StatTile`, `.stat`). Un chiffre isolé, centré, en gras, son libellé dessous, un complément facultatif ; deux par ligne sur écran étroit.

**Cartes d'outils, panneaux, boutons.** Cartes blanches (`--surface-1`) à grand rayon et ombre diffuse ; bouton plein en dégradé de la marque, bouton à contour, bouton discret (sans cadre jusqu'au survol) ; onglets en pastille, l'actif plein.

## 6. Thèmes

Trois états, comme le veut le navigateur : **système** (par défaut, `prefers-color-scheme`), **clair** et **sombre** choisis depuis la barre supérieure (réglage conservé sur le poste). `web/public/theme-init.js` pose l'attribut `data-theme` avant le premier affichage pour éviter l'éclair du mauvais thème ; il est dans un fichier à part parce que la politique de sécurité interdit les scripts dans la page.

Le thème sombre n'est pas une inversion : les surfaces sont un indigo nuit, le bleu de la marque et l'or sont éclaircis pour tenir le contraste, le rouge est adouci, les ombres sont plus denses. Le rail et la carte d'en-tête, déjà sombres, restent identiques ; une fine bordure les détache du fond.

## 7. Ce qui garde la charte lisible

- `server/test/web-contrast.test.ts` : contrastes de chaque jeton (13 tests), parité des deux blocs sombres.
- Audit d'accessibilité automatisé (axe-core, WCAG 2.2 AA) sur 8 pages × 4 largeurs × 2 thèmes, parcours au clavier, cibles tactiles, mouvement réduit : voir le [rapport de validation](validation.md), § 1.2.
- Aucune information portée par la couleur seule : états doublés d'un libellé ou d'une forme, séries à une teinte.

## 8. Modifier la charte

1. Les couleurs : les trois blocs de jetons en tête de `web/src/styles.css`. Gardez le thème sombre synchrone dans ses deux blocs ; `npm test` dit si un contraste passe sous le seuil.
2. La marque : `web/src/components/Brand.tsx` et `web/public/favicon.svg` (même dessin).
3. L'illustration d'en-tête : `scripts/make-hero-art.mjs` (graine, géométrie de l'arc, nombre de grains), puis `node scripts/make-hero-art.mjs`.
4. La police : remplacez les quatre `woff2` de `web/src/fonts/` et les `@font-face` en tête de feuille ; joignez la licence de la nouvelle police.
5. Compilez (`npm run build`) et regardez les deux thèmes, à 1 440 et 390 px.

La carte de partage du dépôt (`docs/img/social-preview.png`, 1 280 × 640) reprend la carte d'en-tête ; à téléverser dans les réglages du dépôt GitHub (*Social preview*) — elle ne se règle pas depuis le code.
