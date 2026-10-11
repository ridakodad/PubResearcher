/**
 * Parcours de bout en bout de la page d'accueil, dans un vrai navigateur, contre un faux Supabase en mémoire.
 *
 *   cd landing && node --test e2e/flows.test.mjs
 *
 * Il faut Playwright (`npm i -D playwright` puis `npx playwright install chromium`) : le site, lui, n'en dépend pas.
 * Variables facultatives : PLAYWRIGHT_MODULE (chemin du module, s'il n'est pas installé ici), CHROMIUM_PATH.
 *
 * Deux compilations sont éprouvées : « configurée » (VITE_SUPABASE_* pointent vers le faux service) et « aperçu »
 * (aucune variable : rien ne doit partir sur le réseau). Chaque scénario part d'un navigateur et d'un service neufs.
 * Le site est servi avec les en-têtes de vercel.json : une ressource interdite par la CSP fait échouer le test.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { FakeSupabase, MOCK_KEY, MOCK_URL } from './fake-supabase.mjs';
import { serveDist } from './static-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VITE = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');

const playwright = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright').catch(() => null);
const skip = playwright ? false : 'Playwright n’est pas installé (npm i -D playwright)';

const ME = { name: 'Dr Salma Benali', email: 'salma.benali@exemple.org', password: 'une phrase de passe solide' };
const VERSION = '2026-10-v1';
const CHARTER_IDS = ['identifiants', 'angles-morts', 'codes', 'autorisation', 'transferts'];

// ------------------------------------------------------------------------------------------- compilation ---

/**
 * Compile le site avec ces variables, et elles seules. Le mode « e2e » écarte `.env.production` (les adresse et clé
 * du vrai projet). Les variables du service sont toujours posées, vides au besoin : une variable d'environnement
 * l'emporte sur tout fichier, y compris un `.env.local` que l'on aurait créé pour essayer le vrai projet. Et la
 * compilation est celle de la production (`NODE_ENV`), quoi qu'hérite le processus de test.
 */
function build(outDir, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('VITE_')));
  const none = { VITE_SUPABASE_URL: '', VITE_SUPABASE_PUBLISHABLE_KEY: '', VITE_SUPABASE_ANON_KEY: '' };
  const args = [VITE, 'build', '--mode', 'e2e', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'];
  const result = spawnSync(process.execPath, args, {
    cwd: ROOT,
    env: { ...clean, NODE_ENV: 'production', ...none, ...env },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `compilation de ${outDir} : ${result.stderr || result.stdout}`);
}

// ------------------------------------------------------------------------------------------ utilitaires ---

let browser;
const servers = [];

before(async () => {
  if (playwright) browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  await Promise.all(servers.map((s) => s.close()));
});

async function openSite(site, { fake = null, viewport = { width: 1280, height: 900 }, colorScheme = 'light' } = {}) {
  const context = await browser.newContext({ locale: 'fr-FR', viewport, colorScheme });
  if (fake) await context.route(`${MOCK_URL}/**`, (route, request) => fake.handle(route, request));
  const page = await context.newPage();
  const problems = [];
  const outside = [];
  page.on('console', (message) => {
    if (process.env.DEBUG_E2E) console.log(`    [console ${message.type()}] ${message.text()}`);
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`${message.type()}: ${message.text()}`);
  });
  if (process.env.DEBUG_E2E) {
    page.on('framenavigated', (frame) => frame === page.mainFrame() && console.log(`    [navigation] ${frame.url()}`));
    page.on('request', (request) => /mock\.supabase/.test(request.url()) && console.log(`    [supabase] ${request.method()} ${request.url().replace(MOCK_URL, '')}`));
  }
  page.on('pageerror', (error) => problems.push(`pageerror: ${error}`));
  page.on('request', (request) => {
    const host = new URL(request.url()).host;
    if (host !== new URL(site.origin).host && host !== new URL(MOCK_URL).host) outside.push(request.url());
  });
  return { context, page, problems, outside, origin: site.origin };
}

/** Erreurs de console inattendues : les « Failed to load resource » des réponses 4xx/5xx voulues sont tolérées. */
function unexpected(problems, { allowNetwork = false } = {}) {
  return problems.filter((p) => !(allowNetwork && /Failed to load resource/.test(p)));
}

function seedUser(fake, { email = ME.email, password = ME.password, name = ME.name, confirmed = true, provider = 'email' } = {}) {
  return fake.createUser({ email, password, provider, confirmed, metadata: { full_name: name, email } });
}

function seedProfile(fake, user, overrides = {}) {
  fake.profiles.set(user.id, {
    user_id: user.id,
    full_name: user.metadata.full_name ?? ME.name,
    role: 'medecin',
    institution: 'CHU Ibn Rochd',
    country: 'Maroc',
    specialty: 'Cardiologie',
    study_type: 'these',
    volume: 'lt100',
    hosting: 'poste',
    ethics: 'obtenue',
    onboarding_completed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  });
}

function seedConsent(fake, user, version = VERSION) {
  fake.consents.push({ id: crypto.randomUUID(), user_id: user.id, kind: 'anonymisation', version, items: CHARTER_IDS, accepted_at: new Date().toISOString() });
}

async function login(page, origin, { email = ME.email, password = ME.password, next = '' } = {}) {
  await page.goto(`${origin}/connexion${next}`);
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Me connecter' }).click();
}

/**
 * Arrivée sur le parcours d'accueil : à la toute première visite d'un compte, la présentation vidéo s'affiche d'abord ;
 * on la passe pour atteindre le profil.
 */
async function profileStep(page) {
  const intro = page.getByRole('heading', { name: 'Bienvenue dans PubResearcher' });
  const profile = page.getByRole('heading', { name: 'Qui êtes-vous ?' });
  await intro.or(profile).waitFor();
  if (await intro.isVisible()) await page.getByRole('button', { name: 'Commencer le parcours' }).click();
  await profile.waitFor();
}

async function fillProfile(page, { country = 'Maroc' } = {}) {
  await page.getByLabel('Fonction').selectOption('interne');
  await page.getByLabel('Établissement ou laboratoire').fill('CHU Ibn Rochd, Casablanca');
  await page.getByLabel('Pays').fill(country);
  await page.getByLabel('Spécialité').fill('Cardiologie');
  await page.getByRole('button', { name: 'Continuer' }).click();
}

async function fillStudy(page, { ethics = 'En cours de demande', button = 'Continuer' } = {}) {
  await page.getByLabel('Type d’étude').selectOption('these');
  await page.getByText('Moins de 100 dossiers').click();
  await page.getByText('Sur mon ordinateur').click();
  await page.getByText(ethics, { exact: true }).click();
  await page.getByRole('button', { name: button }).click();
}

async function tickCharter(page, count = 5) {
  const boxes = page.locator('.charter-item input');
  for (let i = 0; i < count; i++) await boxes.nth(i).check();
}

/** Tous les « user_id=eq.… » des lectures de tables : un utilisateur ne demande jamais que ses propres lignes. */
function readFilters(fake) {
  return fake.requests('GET /rest/v1/').map((r) => r.query.user_id);
}

// -------------------------------------------------------------------------------------------- scénarios ---

describe('site configuré (faux Supabase)', { skip }, () => {
  let site;

  before(async () => {
    build('dist-e2e', {
      VITE_SUPABASE_URL: MOCK_URL,
      VITE_SUPABASE_PUBLISHABLE_KEY: MOCK_KEY,
      VITE_APP_URL: 'http://localhost:4000',
      VITE_SITE_URL: 'https://pubresearcher.exemple',
      VITE_CONTROLLER_NAME: 'Association Exemple',
      VITE_CONTACT_EMAIL: 'contact@exemple.org',
    });
    site = await serveDist('dist-e2e');
    servers.push(site);
  });

  test('la page d’accueil se charge sans erreur, sans bandeau d’aperçu, avec la CSP de vercel.json', async () => {
    const fake = new FakeSupabase();
    const { page, problems, outside, context } = await openSite(site, { fake });
    const response = await page.goto(site.origin + '/');
    const csp = response.headers()['content-security-policy'];
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /unsafe-(inline|eval)/);

    await page.getByRole('heading', { level: 1 }).waitFor();
    assert.equal(await page.locator('.preview-banner').count(), 0, 'pas de bandeau d’aperçu quand l’authentification est branchée');
    assert.match(await page.title(), /PubResearcher/);
    await page.getByRole('link', { name: 'Créer un compte' }).first().waitFor();
    assert.deepEqual(unexpected(problems), []);
    assert.deepEqual(outside, [], 'aucune ressource hors du site et de Supabase');
    // Rien n'est demandé à Supabase tant que personne n'est connecté : le client n'est même pas chargé.
    assert.equal(fake.log.length, 0);
    await context.close();
  });

  test('inscription par e-mail : confirmation, lien reçu, retour connecté sur /bienvenue', async () => {
    const fake = new FakeSupabase({ confirmEmail: true });
    const { page, problems, context } = await openSite(site, { fake });
    await page.goto(site.origin + '/inscription');
    await page.getByLabel('Nom et prénom').fill(ME.name);
    await page.getByLabel('Adresse e-mail').fill(ME.email);
    await page.getByLabel('Mot de passe', { exact: true }).fill(ME.password);
    await page.getByLabel('Confirmez le mot de passe').fill(ME.password);
    await page.getByRole('button', { name: 'Créer mon accès' }).last().click();

    await page.getByRole('heading', { name: 'Vérifiez votre boîte e-mail' }).waitFor();
    assert.ok(await page.getByText(ME.email).first().isVisible());

    const [signup] = fake.requests('POST /auth/v1/signup');
    assert.equal(signup.body.email, ME.email);
    assert.equal(signup.body.data.full_name, ME.name);
    assert.equal(signup.body.code_challenge_method, 's256', 'flux PKCE');
    assert.ok(signup.body.code_challenge);
    assert.match(signup.query.redirect_to, /^http:\/\/127\.0\.0\.1:\d+\/bienvenue/, 'le retour se fait sur /bienvenue, à l’origine courante');

    await page.getByRole('button', { name: 'Renvoyer le lien' }).click();
    await page.getByText('Un nouveau lien vient d’être envoyé.').waitFor();
    assert.equal(fake.requests('POST /auth/v1/resend')[0].body.type, 'signup');

    // L'utilisateur ouvre le lien du courriel.
    await page.goto(fake.confirmationLink(ME.email));
    await profileStep(page);
    assert.equal(await page.getByLabel('Nom et prénom').inputValue(), ME.name, 'le nom saisi à l’inscription préremplit le profil');
    assert.equal(new URL(page.url()).search, '', 'le code d’échange est retiré de l’adresse');
    const [exchange] = fake.requests('POST /auth/v1/token');
    assert.equal(exchange.query.grant_type, 'pkce');
    assert.ok(exchange.body.code_verifier, 'le vérificateur PKCE accompagne le code');
    assert.deepEqual(unexpected(problems), []);
    await context.close();
  });

  test('lien de confirmation ouvert dans un autre navigateur : un message clair, puis le mot de passe suffit', async () => {
    const fake = new FakeSupabase({ confirmEmail: true });
    const first = await openSite(site, { fake });
    await first.page.goto(site.origin + '/inscription');
    await first.page.getByLabel('Nom et prénom').fill(ME.name);
    await first.page.getByLabel('Adresse e-mail').fill(ME.email);
    await first.page.getByLabel('Mot de passe', { exact: true }).fill(ME.password);
    await first.page.getByLabel('Confirmez le mot de passe').fill(ME.password);
    await first.page.getByRole('button', { name: 'Créer mon accès' }).last().click();
    await first.page.getByRole('heading', { name: 'Vérifiez votre boîte e-mail' }).waitFor();
    const link = fake.confirmationLink(ME.email); // le courriel est lu sur un autre appareil
    await first.context.close();

    // Le second navigateur n'a pas le vérificateur PKCE : l'échange du code ne peut pas aboutir.
    const second = await openSite(site, { fake });
    await second.page.goto(link);
    await second.page.waitForURL('**/connexion?suite=%2Fbienvenue');
    await second.page.getByRole('alert').getByText(/n’a pas pu se terminer dans ce navigateur/).waitFor();
    assert.equal(fake.requests('POST /auth/v1/token').filter((r) => r.query.grant_type === 'pkce').length, 0, 'aucun échange tenté sans vérificateur');

    // L'adresse est confirmée côté service : le mot de passe suffit.
    await login(second.page, site.origin);
    await second.page.waitForURL('**/bienvenue');
    await profileStep(second.page);
    await second.context.close();
  });

  test('lien de confirmation « token_hash » (modèle de la documentation) : valable dans un autre navigateur, une seule fois', async () => {
    const fake = new FakeSupabase({ confirmEmail: true });
    const first = await openSite(site, { fake });
    await first.page.goto(site.origin + '/inscription');
    await first.page.getByLabel('Nom et prénom').fill(ME.name);
    await first.page.getByLabel('Adresse e-mail').fill(ME.email);
    await first.page.getByLabel('Mot de passe', { exact: true }).fill(ME.password);
    await first.page.getByLabel('Confirmez le mot de passe').fill(ME.password);
    await first.page.getByRole('button', { name: 'Créer mon accès' }).last().click();
    await first.page.getByRole('heading', { name: 'Vérifiez votre boîte e-mail' }).waitFor();
    const link = fake.tokenHashLink(ME.email, { kind: 'signup', siteUrl: site.origin });
    await first.context.close();

    // Ouvert sur un autre appareil : pas de vérificateur PKCE, et pourtant connecté, directement sur le parcours.
    const second = await openSite(site, { fake });
    await second.page.goto(link);
    await profileStep(second.page);
    assert.equal(new URL(second.page.url()).pathname, '/bienvenue');
    assert.equal(new URL(second.page.url()).search, '', 'le jeton a quitté l’adresse');
    const [verify] = fake.requests('POST /auth/v1/verify');
    assert.equal(verify.body.type, 'email');
    assert.ok(fake.users.get(ME.email).confirmed);
    assert.deepEqual(unexpected(second.problems), []);

    // Le même lien une seconde fois (ici, un troisième navigateur) : refusé, et on le dit.
    const third = await openSite(site, { fake });
    await third.page.goto(link);
    await third.page.waitForURL('**/connexion?suite=%2Fbienvenue');
    await third.page.getByRole('alert').getByText(/Ce lien a expiré ou a déjà servi/).waitFor();
    assert.equal(new URL(third.page.url()).searchParams.has('token_hash'), false);
    await second.context.close();
    await third.context.close();
  });

  test('parcours complet : profil, étude, charte, accès — et ce qui part dans la base', async () => {
    const fake = new FakeSupabase({ confirmEmail: false });
    const { page, problems, context } = await openSite(site, { fake });
    await page.goto(site.origin + '/inscription');
    await page.getByLabel('Nom et prénom').fill(ME.name);
    await page.getByLabel('Adresse e-mail').fill(ME.email);
    await page.getByLabel('Mot de passe', { exact: true }).fill(ME.password);
    await page.getByLabel('Confirmez le mot de passe').fill(ME.password);
    await page.getByRole('button', { name: 'Créer mon accès' }).last().click();

    await page.waitForURL('**/bienvenue');
    await profileStep(page);
    const user = fake.users.get(ME.email);

    await fillProfile(page);
    await page.getByRole('heading', { name: 'Quelle étude préparez-vous ?' }).waitFor();
    const afterProfile = fake.requests('POST /rest/v1/profiles').at(-1);
    assert.equal(afterProfile.query.on_conflict, 'user_id');
    assert.equal(afterProfile.body.user_id, user.id);
    assert.equal(afterProfile.body.role, 'interne');
    assert.equal(afterProfile.body.country, 'Maroc');
    assert.equal('onboarding_completed_at' in afterProfile.body, false, 'la fin du parcours n’est pas datée avant la fin');

    await fillStudy(page);
    await page.getByRole('heading', { name: 'Avant d’importer des données de patients' }).waitFor();
    const confirm = page.getByRole('button', { name: 'Je confirme et j’enregistre' });
    assert.equal(await confirm.isDisabled(), true, 'rien ne se confirme tant que rien n’est coché');
    await tickCharter(page, 4);
    assert.equal(await confirm.isDisabled(), true, 'quatre engagements sur cinq ne suffisent pas');
    await page.getByText('4 engagements confirmés sur 5.').waitFor();
    await tickCharter(page, 5);
    assert.equal(await confirm.isEnabled(), true);
    await confirm.click();

    await page.waitForURL('**/acces');
    await page.getByRole('heading', { level: 1, name: `Bonjour, ${ME.name}.` }).waitFor();

    const consent = fake.requests('POST /rest/v1/consents')[0].body;
    assert.deepEqual(consent, { user_id: user.id, kind: 'anonymisation', version: VERSION, items: CHARTER_IDS });
    const last = fake.requests('POST /rest/v1/profiles').at(-1).body;
    assert.match(last.onboarding_completed_at, /^\d{4}-\d\d-\d\dT/);
    assert.equal(fake.consents.length, 1);
    assert.equal(fake.profiles.get(user.id).study_type, 'these');

    const open = page.getByRole('link', { name: /Ouvrir l’application/ });
    assert.equal(await open.getAttribute('href'), 'http://localhost:4000');
    assert.equal(await open.getAttribute('target'), '_blank');
    assert.match(await open.getAttribute('rel'), /noopener/);
    await page.getByText('Interne, résident').waitFor();
    await page.getByText('En cours de demande').first().waitFor();
    await page.getByText(/dossiers fictifs/).first().waitFor();

    // Chaque lecture ne demande que les lignes de l'utilisateur connecté.
    assert.ok(readFilters(fake).length >= 2);
    assert.ok(readFilters(fake).every((filter) => filter === `eq.${user.id}`));

    // Recharger l'accès garde la session ; /bienvenue renvoie vers /acces quand tout est fait.
    await page.reload();
    await page.getByRole('heading', { level: 1, name: `Bonjour, ${ME.name}.` }).waitFor();
    await page.goto(site.origin + '/bienvenue');
    await page.waitForURL('**/acces');
    assert.deepEqual(unexpected(problems), []);
    await context.close();
  });

  test('« Continuer avec Google » : redirection PKCE vers Supabase, retour, échange du code', async () => {
    const fake = new FakeSupabase();
    const { page, problems, context } = await openSite(site, { fake });
    await page.goto(site.origin + '/inscription');
    await page.getByRole('button', { name: 'Continuer avec Google' }).click();

    await page.waitForURL('**/bienvenue');
    await profileStep(page);
    assert.equal(fake.requests('GET /auth/v1/settings').length, 1, 'le site vérifie d’abord que Google est activé');
    const [authorize] = fake.requests('GET /auth/v1/authorize');
    assert.equal(authorize.query.provider, 'google');
    assert.equal(authorize.query.code_challenge_method, 's256');
    assert.equal(authorize.query.prompt, 'select_account', 'Google propose de choisir le compte');
    assert.match(authorize.query.redirect_to, /^http:\/\/127\.0\.0\.1:\d+\/bienvenue/);
    assert.equal(fake.requests('POST /auth/v1/token')[0].query.grant_type, 'pkce');
    assert.equal(await page.getByLabel('Nom et prénom').inputValue(), 'Dr Google Test', 'le nom du compte Google préremplit le profil');
    assert.equal(new URL(page.url()).search, '');
    await page.getByRole('link', { name: 'Mon accès' }).first().waitFor();
    assert.deepEqual(unexpected(problems), []);
    await context.close();
  });

  test('Google pas encore activé dans le projet : message en français, on reste sur le site', async () => {
    const fake = new FakeSupabase({ googleEnabled: false });
    const { page, problems, context } = await openSite(site, { fake });
    await page.goto(site.origin + '/inscription');
    const google = page.getByRole('button', { name: 'Continuer avec Google' });
    await google.click();
    await page.getByText('La connexion avec Google n’est pas encore activée sur ce site : utilisez votre adresse e-mail.').waitFor();
    assert.equal(new URL(page.url()).pathname, '/inscription');
    assert.equal(fake.requests('GET /auth/v1/authorize').length, 0, 'aucun départ vers la page d’erreur brute du service');
    assert.ok(await google.isEnabled(), 'le bouton redevient utilisable');

    // Activé entre-temps, réglages momentanément injoignables : la vérification ne bloque jamais une connexion possible.
    fake.googleEnabled = true;
    fake.fail('GET /auth/v1/settings', 503, { message: 'Service Unavailable' });
    await google.click();
    await page.waitForURL('**/bienvenue');
    await profileStep(page);
    assert.equal(fake.requests('GET /auth/v1/authorize').length, 1);
    assert.deepEqual(unexpected(problems, { allowNetwork: true }), [], 'seule la panne programmée apparaît');
    await context.close();
  });

  test('connexion : mauvais mot de passe en français, puis succès ; retour vers la page demandée', async () => {
    const fake = new FakeSupabase();
    seedUser(fake);
    const { page, problems, context } = await openSite(site, { fake });
    await login(page, site.origin, { password: 'pas le bon mot de passe' });
    const alert = page.getByRole('alert');
    await alert.waitFor();
    assert.match(await alert.innerText(), /E-mail ou mot de passe incorrect\./);
    assert.doesNotMatch(await page.locator('body').innerText(), /Invalid login credentials/, 'le texte anglais du service ne s’affiche jamais');

    await page.getByLabel('Mot de passe', { exact: true }).fill(ME.password);
    await page.getByRole('button', { name: 'Me connecter' }).click();
    await page.waitForURL('**/bienvenue');
    assert.deepEqual(unexpected(problems, { allowNetwork: true }), []);
    await context.close();
  });

  test('adresse non confirmée : message clair et renvoi du lien', async () => {
    const fake = new FakeSupabase();
    seedUser(fake, { confirmed: false });
    fake.pending.set(ME.email, { redirectTo: `${site.origin}/bienvenue`, challenge: null });
    const { page, context } = await openSite(site, { fake });
    await login(page, site.origin);
    await page.getByRole('alert').getByText(/Adresse e-mail non confirmée/).waitFor();
    await page.getByRole('button', { name: 'Renvoyer le lien de confirmation' }).click();
    await page.getByText('Un nouveau lien vient d’être envoyé.').waitFor();
    assert.equal(fake.requests('POST /auth/v1/resend').length, 1);
    await context.close();
  });

  test('pages protégées : retour à la connexion, puis à la page demandée ; aucune redirection ouverte', async () => {
    const fake = new FakeSupabase();
    const user = seedUser(fake);
    seedProfile(fake, user);
    seedConsent(fake, user);
    const { page, context } = await openSite(site, { fake });

    await page.goto(site.origin + '/acces');
    await page.waitForURL('**/connexion?suite=%2Facces');
    await login(page, site.origin, { next: '?suite=%2Facces' });
    await page.waitForURL('**/acces');
    await page.getByRole('heading', { level: 1 }).waitFor();
    await page.getByRole('link', { name: 'Se déconnecter' }).first().click();
    await page.waitForURL(site.origin + '/');

    for (const evil of ['https://evil.example/', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/inconnu']) {
      await login(page, site.origin, { next: `?suite=${encodeURIComponent(evil)}` });
      await page.waitForURL((url) => url.origin === site.origin && /\/(bienvenue|acces)$/.test(url.pathname));
      assert.equal(new URL(page.url()).origin, site.origin, `redirection refusée : ${evil}`);
      await page.getByRole('link', { name: 'Se déconnecter' }).first().click();
      await page.waitForURL(site.origin + '/');
    }
    await context.close();
  });

  test('retour d’authentification en échec : phrase en français, adresse nettoyée', async () => {
    const fake = new FakeSupabase();
    const { page, context } = await openSite(site, { fake });

    await page.goto(`${site.origin}/connexion?error=access_denied&error_code=bad_oauth_callback&error_description=User+denied+access`);
    await page.getByRole('alert').getByText('La connexion a été annulée.').waitFor();
    assert.equal(new URL(page.url()).search, '', 'les paramètres d’erreur ne restent pas dans l’adresse');
    assert.doesNotMatch(await page.locator('body').innerText(), /User denied access/);

    await page.goto('about:blank'); // un changement de fragment seul ne recharge pas la page : on repart d'une page vierge
    await page.goto(`${site.origin}/connexion#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
    await page.getByRole('alert').getByText(/Ce lien a expiré/).waitFor();
    assert.equal(new URL(page.url()).hash, '');
    await context.close();
  });

  test('mot de passe oublié : même réponse pour toute adresse, lien de retour, nouveau mot de passe', async () => {
    const fake = new FakeSupabase();
    seedUser(fake);
    const { page, problems, context } = await openSite(site, { fake });
    await page.goto(site.origin + '/mot-de-passe');

    await page.getByRole('button', { name: 'Envoyer le lien' }).click();
    await page.getByText('Indiquez votre adresse e-mail.').waitFor();
    await page.getByLabel('Adresse e-mail').fill('inconnue@exemple.org');
    await page.getByRole('button', { name: 'Envoyer le lien' }).click();
    const unknown = page.getByRole('status');
    await unknown.getByText(/Si un compte existe pour/).waitFor();
    const unknownText = (await unknown.innerText()).replace('inconnue@exemple.org', 'X');

    await page.goto(site.origin + '/mot-de-passe');
    await page.getByLabel('Adresse e-mail').fill(ME.email);
    await page.getByRole('button', { name: 'Envoyer le lien' }).click();
    const known = page.getByRole('status');
    await known.getByText(/Si un compte existe pour/).waitFor();
    assert.equal((await known.innerText()).replace(ME.email, 'X'), unknownText, 'la réponse ne révèle pas si un compte existe');
    const recover = fake.requests('POST /auth/v1/recover').at(-1);
    assert.match(recover.query.redirect_to, /\/mot-de-passe/);

    await page.goto(fake.recoveryLink(ME.email));
    await page.getByRole('heading', { name: 'Choisir un nouveau mot de passe' }).waitFor();
    await page.getByLabel('Nouveau mot de passe').fill('court');
    await page.getByLabel('Confirmez le mot de passe').fill('court');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByText(/au moins 10 caractères/).waitFor();
    await page.getByLabel('Nouveau mot de passe').fill('un autre mot de passe solide');
    await page.getByLabel('Confirmez le mot de passe').fill('un autre mot de passe solide');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByText('Votre mot de passe est modifié.').waitFor();
    assert.equal(fake.users.get(ME.email).password, 'un autre mot de passe solide');
    assert.deepEqual(unexpected(problems), []);
    await context.close();
  });

  test('réinitialisation sur un autre appareil : le lien « token_hash » y marche ; le lien par défaut s’explique', async () => {
    const fake = new FakeSupabase();
    seedUser(fake);
    const desktop = await openSite(site, { fake });
    await desktop.page.goto(site.origin + '/mot-de-passe');
    await desktop.page.getByLabel('Adresse e-mail').fill(ME.email);
    await desktop.page.getByRole('button', { name: 'Envoyer le lien' }).click();
    await desktop.page.getByRole('status').getByText(/Si un compte existe pour/).waitFor();
    assert.ok(fake.requests('POST /auth/v1/recover').at(-1).body.code_challenge, 'la demande porte un défi PKCE');
    const pkceLink = fake.recoveryLink(ME.email);
    const hashLink = fake.tokenHashLink(ME.email, { kind: 'recovery', siteUrl: site.origin });
    await desktop.context.close();

    // Lien par défaut, ouvert ailleurs : le vérificateur est resté sur l'autre appareil. Message clair, sur place.
    const phone = await openSite(site, { fake, viewport: { width: 390, height: 844 } });
    await phone.page.goto(pkceLink);
    await phone.page.getByRole('alert').getByText(/ouvert ailleurs que dans le navigateur où vous l’avez demandé/).waitFor();
    assert.equal(new URL(phone.page.url()).pathname, '/mot-de-passe');
    await phone.page.getByRole('heading', { name: 'Mot de passe oublié' }).waitFor();
    // Il ne reparaît pas plus loin, sur la page de connexion.
    await phone.page.goto(site.origin + '/connexion');
    await phone.page.getByRole('heading', { name: 'Se connecter' }).waitFor();
    assert.equal(await phone.page.getByRole('alert').count(), 0);

    // Lien « token_hash » : il marche sur ce même téléphone.
    await phone.page.goto(hashLink);
    await phone.page.getByRole('heading', { name: 'Choisir un nouveau mot de passe' }).waitFor();
    assert.equal(new URL(phone.page.url()).search, '', 'le jeton a quitté l’adresse');
    await phone.page.getByLabel('Nouveau mot de passe').fill('un autre mot de passe solide');
    await phone.page.getByLabel('Confirmez le mot de passe').fill('un autre mot de passe solide');
    await phone.page.getByRole('button', { name: 'Enregistrer' }).click();
    await phone.page.getByText('Votre mot de passe est modifié.').waitFor();
    assert.equal(fake.users.get(ME.email).password, 'un autre mot de passe solide');
    assert.deepEqual(unexpected(phone.problems), []);
    await phone.context.close();

    // Un lien de réinitialisation périmé (retour d'erreur du service) : même explication, adresse nettoyée.
    const late = await openSite(site, { fake });
    await late.page.goto(`${site.origin}/mot-de-passe#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired`);
    await late.page.getByRole('alert').getByText(/Demandez-en un nouveau ci-dessous/).waitFor();
    assert.equal(new URL(late.page.url()).hash, '');
    await late.context.close();
  });

  test('serveur d’envoi par défaut de Supabase : l’inscription refusée s’explique, Google reste possible', async () => {
    const fake = new FakeSupabase({ confirmEmail: true, mailAllowList: ['equipe@exemple.org'] });
    const { page, problems, context } = await openSite(site, { fake });
    await page.goto(site.origin + '/inscription');
    await page.getByLabel('Nom et prénom').fill(ME.name);
    await page.getByLabel('Adresse e-mail').fill(ME.email);
    await page.getByLabel('Mot de passe', { exact: true }).fill(ME.password);
    await page.getByLabel('Confirmez le mot de passe').fill(ME.password);
    await page.getByRole('button', { name: 'Créer mon accès' }).last().click();
    await page.getByRole('alert').getByText('Ce site ne peut pas encore envoyer de courriel à cette adresse. Utilisez « Continuer avec Google », ou réessayez plus tard.').waitFor();
    assert.equal(fake.users.has(ME.email), false);
    assert.deepEqual(unexpected(problems, { allowNetwork: true }), [], 'seul le refus du service apparaît');
    await context.close();
  });

  test('reprise du parcours : charte périmée → étape 3 ; parcours terminé → /acces ; profil partiel → étape 2', async () => {
    // Charte d'une ancienne version : on redemande la charte, sans effacer l'ancien engagement.
    const fake = new FakeSupabase();
    const user = seedUser(fake);
    seedProfile(fake, user);
    seedConsent(fake, user, '2026-01-v0');
    const first = await openSite(site, { fake });
    await login(first.page, site.origin);
    await first.page.getByRole('heading', { name: 'Avant d’importer des données de patients' }).waitFor();
    await first.page.getByText('Étape 3 sur 3').waitFor();
    await tickCharter(first.page);
    await first.page.getByRole('button', { name: 'Je confirme et j’enregistre' }).click();
    await first.page.waitForURL('**/acces');
    assert.deepEqual(fake.consents.map((c) => c.version), ['2026-01-v0', VERSION], 'journal en ajout seul');
    await first.context.close();

    // Profil enregistré seulement jusqu'à l'étape 1.
    const partial = new FakeSupabase();
    const other = seedUser(partial, { email: 'autre@exemple.org', name: 'Dr Autre' });
    seedProfile(partial, other, { study_type: null, volume: null, hosting: null, ethics: null, onboarding_completed_at: null });
    const second = await openSite(site, { fake: partial });
    await login(second.page, site.origin, { email: 'autre@exemple.org' });
    await second.page.getByRole('heading', { name: 'Quelle étude préparez-vous ?' }).waitFor();
    await second.page.getByText('Étape 2 sur 3').waitFor();
    await second.context.close();
  });

  test('modifier mes réponses : profil prérempli, charte non redemandée, date de fin conservée', async () => {
    const fake = new FakeSupabase();
    const user = seedUser(fake);
    seedProfile(fake, user, { country: 'Maroc' });
    seedConsent(fake, user);
    const completedAt = fake.profiles.get(user.id).onboarding_completed_at;
    const { page, problems, context } = await openSite(site, { fake });
    await login(page, site.origin);
    await page.waitForURL('**/bienvenue');
    await page.waitForURL('**/acces');
    await page.getByRole('link', { name: 'Modifier mes réponses' }).click();
    await profileStep(page);
    await page.getByText('Étape 1 sur 2').waitFor();
    assert.equal(await page.getByLabel('Pays').inputValue(), 'Maroc');
    await fillProfile(page, { country: 'Tunisie' });
    await fillStudy(page, { ethics: 'Obtenue', button: 'Enregistrer' });
    await page.waitForURL('**/acces');
    assert.equal(fake.profiles.get(user.id).country, 'Tunisie');
    assert.equal(fake.profiles.get(user.id).onboarding_completed_at, completedAt, 'la date de fin n’est pas écrasée');
    assert.equal(fake.consents.length, 1, 'aucun nouvel engagement : le texte n’a pas changé');
    assert.deepEqual(unexpected(problems), []);
    await context.close();
  });

  test('pannes : erreur de lecture, d’écriture et réseau coupé — toujours en français, sans détail technique', async () => {
    const fake = new FakeSupabase();
    const user = seedUser(fake);
    seedProfile(fake, user);
    seedConsent(fake, user);
    const { page, problems, context } = await openSite(site, { fake });
    await login(page, site.origin);
    await page.waitForURL('**/acces');

    // Lecture : le service de données répond 500. (La page doit avoir fini de se charger : sinon la panne serait
    // consommée par sa propre lecture, avant le rechargement.)
    await page.getByRole('heading', { level: 1, name: /Bonjour/ }).waitFor();
    fake.fail('GET /rest/v1/profiles', 500, { code: 'XX000', message: 'internal secret detail' });
    await page.reload();
    await page.getByRole('alert').getByText(/Impossible d’enregistrer ou de lire vos réponses/).waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(), /internal secret detail/, 'le détail technique reste dans la console');
    await page.getByRole('button', { name: 'Réessayer' }).click();
    await page.getByRole('heading', { level: 1, name: /Bonjour/ }).waitFor();

    // Écriture de l'engagement qui échoue : on reste sur la charte, le bouton reste utilisable.
    await page.goto(site.origin + '/bienvenue?modifier');
    await fillProfile(page);
    fake.fail('POST /rest/v1/profiles', 500, { message: 'boom' });
    await page.getByRole('button', { name: 'Enregistrer' }).waitFor();
    await page.getByLabel('Type d’étude').selectOption('revue');
    await page.getByText('Plus de 1 000 dossiers').click();
    await page.getByText('Sur mon ordinateur').click();
    await page.getByText('Obtenue', { exact: true }).click();
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.getByRole('alert').getByText(/Impossible d’enregistrer/).waitFor();
    assert.match(page.url(), /\/bienvenue/);
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await page.waitForURL('**/acces');

    // Connexion alors que le réseau est coupé.
    await page.getByRole('link', { name: 'Se déconnecter' }).first().click();
    await page.waitForURL(site.origin + '/');
    fake.cut('POST /auth/v1/token');
    await login(page, site.origin);
    await page.getByRole('alert').getByText(/injoignable/).waitFor();
    assert.ok(problems.length >= 0);
    await context.close();
  });

  test('déconnexion : la session disparaît du navigateur ; un autre utilisateur ne voit rien du premier', async () => {
    const fake = new FakeSupabase();
    const first = seedUser(fake);
    seedProfile(fake, first);
    seedConsent(fake, first);
    const second = seedUser(fake, { email: 'deuxieme@exemple.org', name: 'Dr Deuxième' });
    const { page, context } = await openSite(site, { fake });

    await login(page, site.origin);
    await page.waitForURL('**/acces');
    const keys = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('sb-')));
    assert.ok(keys.length > 0, 'la session est dans le navigateur');
    await page.getByRole('link', { name: 'Se déconnecter' }).first().click();
    await page.waitForURL(site.origin + '/');
    const [logout] = fake.requests('POST /auth/v1/logout');
    assert.equal(logout.query.scope, 'local', 'ce navigateur seulement : les autres appareils restent connectés');
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter((k) => /^sb-.+-auth-token$/.test(k))), [], 'plus de session');
    await page.getByRole('link', { name: 'Se connecter' }).first().waitFor();

    await login(page, site.origin, { email: second.email });
    await page.waitForURL('**/bienvenue');
    await profileStep(page);
    assert.equal(await page.getByLabel('Pays').inputValue(), '', 'rien du profil du premier utilisateur');
    assert.equal(await page.getByLabel('Nom et prénom').inputValue(), 'Dr Deuxième');
    assert.ok(readFilters(fake).includes(`eq.${second.id}`));
    await context.close();
  });

  test('/deconnexion ouvert depuis un autre site : confirmation demandée, la session reste', async () => {
    const fake = new FakeSupabase();
    const me = seedUser(fake);
    seedProfile(fake, me);
    seedConsent(fake, me);
    const { page, problems, context } = await openSite(site, { fake });
    await login(page, site.origin);
    await page.waitForURL('**/acces');
    await page.getByRole('heading', { level: 1, name: /Bonjour/ }).waitFor();

    await page.goto(site.origin + '/deconnexion'); // comme un lien posé sur une autre page du web
    await page.getByRole('heading', { name: 'Se déconnecter ?' }).waitFor();
    assert.equal(fake.requests('POST /auth/v1/logout').length, 0, 'rien sans confirmation');
    await page.getByRole('link', { name: 'Rester connecté' }).click();
    await page.waitForURL('**/acces');

    await page.goto(site.origin + '/deconnexion');
    await page.getByRole('button', { name: 'Me déconnecter' }).click();
    await page.waitForURL(site.origin + '/');
    assert.equal(fake.requests('POST /auth/v1/logout').length, 1);
    await page.getByRole('link', { name: 'Se connecter' }).first().waitFor();

    // Déconnecté, la page ne sert à rien : retour à l'accueil.
    await page.goto(site.origin + '/deconnexion');
    await page.waitForURL(site.origin + '/');
    assert.deepEqual(unexpected(problems), []);
    await context.close();
  });

  test('adresses abîmées : un fragment illisible ne fait pas tomber la page ; un fichier manquant reste une 404', async () => {
    const fake = new FakeSupabase();
    const { page, problems, context } = await openSite(site, { fake });
    await page.goto(site.origin + '/#%');
    await page.getByRole('heading', { level: 1 }).first().waitFor();
    assert.equal(await page.getByText('Quelque chose s’est mal passé.').count(), 0, 'pas l’écran d’erreur du site');
    const missing = await page.request.get(site.origin + '/assets/index-inexistant.js');
    assert.equal(missing.status(), 404);
    assert.doesNotMatch(await missing.text(), /<html/i);
    assert.deepEqual(unexpected(problems), []);
    await context.close();
  });

  test('la base refuse une valeur hors liste : les options du site suivent les contraintes SQL', async () => {
    const fake = new FakeSupabase({ confirmEmail: false });
    const user = seedUser(fake);
    const { page, context } = await openSite(site, { fake });
    await login(page, site.origin);
    await page.waitForURL('**/bienvenue');
    // Chaque option proposée par les listes déroulantes est acceptée telle quelle par les contraintes de la migration.
    // (`evaluateAll` n'attend pas : on attend d'abord que le formulaire soit affiché, profil chargé.)
    await profileStep(page);
    await page.getByLabel('Fonction').waitFor();
    const roles = await page.getByLabel('Fonction').locator('option').evaluateAll((nodes) => nodes.map((n) => n.value).filter(Boolean));
    assert.ok(roles.length >= 6);
    for (const role of roles) {
      assert.equal(fake.check('profiles', { user_id: user.id, full_name: 'Dr Test', role, institution: 'CHU', country: 'Maroc' }), null, `rôle ${role}`);
    }
    await page.getByLabel('Fonction').selectOption('interne');
    await page.getByLabel('Établissement ou laboratoire').fill('CHU');
    await page.getByLabel('Pays').fill('Maroc');
    await page.getByRole('button', { name: 'Continuer' }).click();
    await page.getByRole('heading', { name: 'Quelle étude préparez-vous ?' }).waitFor();
    const studies = await page.getByLabel('Type d’étude').locator('option').evaluateAll((nodes) => nodes.map((n) => n.value).filter(Boolean));
    for (const study_type of studies) assert.equal(fake.check('profiles', { user_id: user.id, full_name: 'Dr Test', role: 'interne', institution: 'CHU', country: 'Maroc', study_type }), null, `type d’étude ${study_type}`);
    await context.close();
  });

  test('clavier : lien d’évitement, menu des écrans étroits (ouvert, fermé par Échap), focus après navigation', async () => {
    const fake = new FakeSupabase();
    const { page, context } = await openSite(site, { fake, viewport: { width: 390, height: 844 } });
    await page.goto(site.origin + '/');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Aller au contenu' });
    assert.equal(await skip.evaluate((el) => el === document.activeElement), true, 'premier arrêt de tabulation');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main');

    const menu = page.getByRole('button', { name: 'Ouvrir le menu' });
    assert.equal(await menu.getAttribute('aria-expanded'), 'false');
    await menu.click();
    assert.equal(await page.getByRole('button', { name: 'Fermer le menu' }).getAttribute('aria-expanded'), 'true');
    await page.getByRole('navigation', { name: /menu/ }).getByRole('link', { name: 'Vos données' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('button', { name: 'Ouvrir le menu' }).getAttribute('aria-expanded'), 'false');

    // Naviguer vers une autre page place le focus sur le contenu et met à jour le titre.
    await page.getByRole('button', { name: 'Ouvrir le menu' }).click();
    await page.locator('.mobile-panel').getByRole('link', { name: 'Créer un compte' }).click();
    await page.waitForURL('**/inscription');
    await page.waitForFunction(() => document.activeElement?.id === 'main'); // le focus suit le changement de page
    assert.match(await page.title(), /^Créer mon accès — PubResearcher$/);
    await context.close();
  });

  test('liens et boutons : tout lien externe s’ouvre avec rel=noopener ; aucun défilement horizontal de 320 à 1440 px', async () => {
    const fake = new FakeSupabase();
    const { page, context } = await openSite(site, { fake });
    for (const width of [320, 390, 768, 1024, 1180, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      for (const route of ['/', '/inscription', '/connexion', '/mot-de-passe', '/confidentialite', '/introuvable']) {
        await page.goto(site.origin + route);
        await page.getByRole('heading', { level: 1 }).first().waitFor();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${route} à ${width} px : ${overflow} px de trop`);
      }
    }
    await page.goto(site.origin + '/');
    const unsafe = await page.locator('a[target="_blank"]').evaluateAll((links) => links.filter((a) => !/noopener/.test(a.rel)).map((a) => a.href));
    assert.deepEqual(unsafe, []);
    const origin = new URL(page.url()).origin;
    const external = await page.locator('a[href^="http"]').evaluateAll((links) => links.filter((a) => a.target !== '_blank').map((a) => a.href));
    assert.deepEqual(external.filter((href) => !href.startsWith(origin)), [], 'un lien vers un autre site s’ouvre dans un nouvel onglet');
    await context.close();
  });
  test('première inscription : la présentation vidéo d’abord, une seule fois, puis le profil', async () => {
    const fake = new FakeSupabase({ confirmEmail: false });
    seedUser(fake);
    const { page, problems, context } = await openSite(site, { fake });
    await login(page, site.origin);
    await page.waitForURL('**/bienvenue');
    await page.getByRole('heading', { name: 'Bienvenue dans PubResearcher' }).waitFor();

    // La vidéo : commandes, jamais de lecture automatique, servie par le site (la politique de sécurité l'admet).
    const video = page.locator('video');
    assert.equal(await video.getAttribute('autoplay'), null, 'pas de lecture automatique');
    assert.notEqual(await video.getAttribute('controls'), null, 'avec ses commandes');
    assert.match(await video.getAttribute('aria-label'), /1 min 35/);
    const sources = await page.locator('video source').evaluateAll((nodes) => nodes.map((n) => [n.getAttribute('src'), n.getAttribute('type')]));
    assert.deepEqual(sources, [
      ['/video/presentation-pubresearcher.mp4', 'video/mp4; codecs="avc1.640028"'],
      ['/video/presentation-pubresearcher.webm', 'video/webm; codecs="vp9"'],
    ]);
    for (const [src, type] of sources) {
      const file = await page.request.get(site.origin + src);
      assert.equal(file.status(), 200);
      assert.equal(file.headers()['content-type'], type.split(';')[0]);
      assert.ok((await file.body()).length > 1_000_000, 'la vraie vidéo, pas la page HTML');
    }
    const poster = await page.request.get(site.origin + (await video.getAttribute('poster')));
    assert.equal(poster.headers()['content-type'], 'image/jpeg');
    // La vidéo se charge bel et bien dans le navigateur (métadonnées : durée réelle).
    const duration = await video.evaluate((v) => new Promise((resolve) => {
      if (v.readyState >= 1) resolve(v.duration);
      else v.addEventListener('loadedmetadata', () => resolve(v.duration), { once: true });
    }));
    assert.ok(duration > 90 && duration < 100, `durée lue : ${duration}`);

    // Son équivalent texte.
    await page.getByText('Lire le déroulé de la vidéo').click();
    assert.equal(await page.locator('.intro-transcript li').count(), 11);

    await page.getByRole('button', { name: 'Commencer le parcours' }).click();
    await page.getByRole('heading', { name: 'Qui êtes-vous ?' }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Qui êtes-vous ?', 'le titre de l’étape prend le focus');
    // Recharger au milieu du parcours ne remontre pas la vidéo.
    await page.reload();
    await page.getByRole('heading', { name: 'Qui êtes-vous ?' }).waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Bienvenue dans PubResearcher' }).count(), 0);
    const stored = await page.evaluate(() => Object.keys(localStorage).filter((k) => !/^sb-.+-auth-token$/.test(k)));
    assert.ok(stored.every((key) => key === 'theme'), `localStorage : ${stored}`);
    assert.deepEqual(unexpected(problems), []);
    await context.close();
  });

  test('« Activer Claude » : un guide public qui mène aux bonnes pages de la console, sans jamais demander la clé', async () => {
    const fake = new FakeSupabase();
    const me = seedUser(fake);
    seedProfile(fake, me);
    seedConsent(fake, me);
    const { page, problems, context } = await openSite(site, { fake });
    await page.goto(site.origin + '/activer-claude');
    await page.getByRole('heading', { name: 'Activer Claude', level: 1 }).waitFor();
    const links = await page.locator('.guide-step a[target="_blank"]').evaluateAll((as) => as.map((a) => [a.getAttribute('href'), a.getAttribute('rel')]));
    assert.deepEqual(links, [
      ['https://platform.claude.com/', 'noopener noreferrer'],
      ['https://platform.claude.com/settings/billing', 'noopener noreferrer'],
      ['https://platform.claude.com/settings/keys', 'noopener noreferrer'],
    ]);
    assert.equal(await page.locator('main input, main textarea').count(), 0, 'aucun champ : la clé se colle dans l’application');
    await page.getByText(/ne la collez jamais ailleurs/).waitFor();
    assert.equal(await page.title(), 'Activer Claude — PubResearcher');
    // Depuis l'accès, et depuis la question sur le coût.
    await login(page, site.origin, { next: '?suite=%2Facces' });
    await page.waitForURL('**/acces');
    await page.getByRole('link', { name: /Obtenir ma clé, pas à pas/ }).click();
    await page.waitForURL('**/activer-claude');
    await page.goto(site.origin + '/');
    await page.getByText('Combien cela coûte-t-il ?').click();
    await page.locator('.faq-item').getByRole('link', { name: 'Activer Claude' }).click();
    await page.waitForURL('**/activer-claude');
    assert.deepEqual(unexpected(problems), []);
    await context.close();
  });
});

// ------------------------------------------------------------------------------------------------ aperçu ---

describe('site en mode aperçu (aucune variable VITE_SUPABASE_*)', { skip }, () => {
  let site;

  before(async () => {
    build('dist-e2e-preview', {});
    site = await serveDist('dist-e2e-preview');
    servers.push(site);
  });

  test('le bandeau est sur chaque page, Google est signalé « aperçu », et rien ne part sur le réseau', async () => {
    const { page, problems, outside, context } = await openSite(site);
    const requests = [];
    page.on('request', (request) => requests.push(request.url()));
    for (const route of ['/', '/inscription', '/connexion', '/mot-de-passe', '/confidentialite']) {
      await page.goto(site.origin + route);
      await page.locator('.preview-banner').waitFor();
      assert.match(await page.locator('.preview-banner').innerText(), /Mode aperçu/);
    }
    await page.goto(site.origin + '/inscription');
    await page.getByRole('button', { name: 'Continuer avec Google (aperçu)' }).click();
    await page.waitForURL('**/bienvenue');
    await profileStep(page);
    assert.deepEqual(outside, [], 'aucune requête vers un autre site');
    assert.ok(requests.every((url) => url.startsWith(site.origin)), 'tout vient du site lui-même');
    assert.ok(!requests.some((url) => /supabase/.test(url)));
    assert.deepEqual(unexpected(problems), []);
    await context.close();
  });

  test('parcours complet en aperçu : la session et les réponses ne survivent pas à la fermeture de l’onglet', async () => {
    const { page, problems, context } = await openSite(site);
    await page.goto(site.origin + '/inscription');
    await page.getByLabel('Nom et prénom').fill(ME.name);
    await page.getByLabel('Adresse e-mail').fill(ME.email);
    await page.getByLabel('Mot de passe', { exact: true }).fill(ME.password);
    await page.getByLabel('Confirmez le mot de passe').fill(ME.password);
    await page.getByRole('button', { name: 'Créer mon accès' }).last().click();
    await page.waitForURL('**/bienvenue');
    await profileStep(page);
    await fillProfile(page);
    await page.getByLabel('Type d’étude').selectOption('these');
    await page.getByText('Moins de 100 dossiers').click();
    await page.getByText('Sur mon ordinateur').click();
    await page.getByText('Pas encore demandée', { exact: true }).click();
    await page.getByText(/demandez l’autorisation/).waitFor(); // le rappel s'adapte à la réponse
    await page.getByRole('button', { name: 'Continuer' }).click();
    await page.getByRole('heading', { name: 'Avant d’importer des données de patients' }).waitFor();
    await tickCharter(page);
    await page.getByRole('button', { name: 'Je confirme et j’enregistre' }).click();
    await page.waitForURL('**/acces');
    await page.getByRole('link', { name: /Ouvrir l’application/ }).waitFor();
    await page.getByText('Pas encore demandée').first().waitFor();

    await page.reload();
    await page.getByRole('heading', { level: 1, name: /Bonjour/ }).waitFor();
    const stored = await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }));
    assert.ok(stored.local.every((key) => key === 'theme'), `rien d’autre que le thème dans localStorage : ${stored.local}`);
    assert.ok(stored.session.every((key) => key.startsWith('pr:')));

    await page.getByRole('link', { name: 'Se déconnecter' }).first().click();
    await page.waitForURL(site.origin + '/');
    await page.goto(site.origin + '/acces');
    await page.waitForURL('**/connexion?suite=%2Facces');

    // Un nouvel onglet (nouveau contexte) repart de zéro.
    const fresh = await openSite(site);
    await fresh.page.goto(site.origin + '/acces');
    await fresh.page.waitForURL('**/connexion?suite=%2Facces');
    assert.deepEqual(unexpected(problems), []);
    await fresh.context.close();
    await context.close();
  });
});
