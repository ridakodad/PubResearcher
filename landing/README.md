# PubResearcher — page d'accueil

Le site public de PubResearcher : il présente l'outil, propose de créer un accès (**Google** ou adresse e-mail), mène l'utilisateur dans un court parcours d'accueil — profil, étude, **engagement d'anonymisation avant d'importer des données de patients** — puis l'oriente vers l'application. Il se déploie seul (Vercel, dossier racine `landing`), ne reçoit aucune donnée de patient et ne protège pas l'application : c'est une porte d'entrée, pas une serrure.

**Mode d'emploi complet** — mise en service pas à pas (Supabase, Google, Vercel), variables, données conservées, charte et versions, limites, dépannage : [docs/page-d-accueil.md](../docs/page-d-accueil.md).

```bash
npm ci
npm run dev          # http://localhost:5174 — « mode aperçu » tant que .env.local ne définit pas VITE_SUPABASE_*
npm run typecheck
npm run build        # dist/, branché sur le projet Supabase de .env.production
npm run preview      # sert dist/ sur http://localhost:4173
```

Projet Supabase : « PubResearcher » (`oyzhlclaniaykyixhsjy`, région eu-west-3), migration appliquée et vérifiée ; son adresse et sa clé **publique** sont dans `.env.production` (rien de secret : elles finissent dans le code publié ; une variable définie dans Vercel l'emporte). Ce qui reste à régler dans les tableaux de bord (adresses de retour, Google, envoi des courriels, Vercel) : [mise en service](../docs/page-d-accueil.md#5-mettre-le-site-en-ligne--pas-à-pas).

Tests : la logique, la migration et la configuration sont vérifiées par `npm test` à la racine du dépôt (`server/test/landing-logic.test.ts`) ; les parcours dans un navigateur, contre un faux Supabase, par `node --test e2e/flows.test.mjs` (Playwright requis : `npm i -D playwright && npx playwright install chromium`).

| Dossier | Contenu |
|---|---|
| `src/lib/` | Logique pure (charte, formulaires, parcours, adresses, retours d'erreur), session Supabase, profil |
| `src/pages/`, `src/components/` | Pages et composants React |
| `supabase/migrations/` | Tables `profiles` et `consents`, contraintes, règles d'accès par ligne, droits par colonne |
| `e2e/` | Serveur statique à la manière de Vercel, faux Supabase, scénarios |
| `public/` | Icône, image de partage, `robots.txt`, script du thème, captures de l'application |
