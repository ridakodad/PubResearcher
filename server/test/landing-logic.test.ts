/**
 * Page d'accueil (landing/) : la logique pure, les textes partagés avec l'application, la migration SQL et la
 * configuration de déploiement. Les parcours dans un navigateur sont dans landing/e2e (contre un faux Supabase).
 *
 * Ce que ce fichier garde, surtout : les endroits où le site et l'application (ou la base) doivent dire la même chose
 * sans pouvoir s'importer — la charte d'anonymisation, les jetons de couleur, les listes d'options et leurs contraintes
 * SQL. Dans chaque cas, une divergence fait échouer un test plutôt que de se découvrir en production.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as app from '../../web/src/lib/anonymisation.js';
import * as landing from '../../landing/src/lib/charter.js';
import {
  EMAIL_LINK_FAILED,
  hasImplicitTokens,
  LINK_NOT_COMPLETED,
  parseAuthReturn,
  parseEmailLink,
  RECOVERY_LINK_FAILED,
  stripAuthReturn,
  stripEmailLink,
} from '../../landing/src/lib/authReturn.js';
import {
  authErrorCode,
  frenchAuthError,
  PASSWORD_MAX,
  PASSWORD_MIN,
  validateEmail,
  validateLogin,
  validateNewPassword,
  validatePassword,
  validateSignup,
} from '../../landing/src/lib/forms.js';
import {
  EMPTY_PROFILE,
  ETHICS,
  ethicsAdvice,
  fromRow,
  HOSTINGS,
  isProfileComplete,
  labelOf,
  nextStep,
  normalizeDraft,
  ROLES,
  STUDY_TYPES,
  toRow,
  validateProfileStep,
  VOLUMES,
  type Option,
  type ProfileDraft,
} from '../../landing/src/lib/onboarding.js';
import { httpUrl, pageUrl, safeNext } from '../../landing/src/lib/urls.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const read = (relative: string): string => fs.readFileSync(path.join(REPO, relative), 'utf8');

/** Liste récursive des fichiers d'un dossier, sans les dossiers générés. */
function walk(dir: string): string[] {
  return fs.readdirSync(path.join(REPO, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) return ['node_modules', 'dist', 'dist-e2e', 'dist-e2e-preview'].includes(entry.name) ? [] : walk(relative);
    return [relative];
  });
}

const MIGRATION_DIR = 'landing/supabase/migrations';
const migrationSql = fs
  .readdirSync(path.join(REPO, MIGRATION_DIR))
  .filter((name) => name.endsWith('.sql'))
  .sort()
  .map((name) => read(path.join(MIGRATION_DIR, name)))
  .join('\n');

/** Valeurs permises d'une colonne par `check (… in ('a', 'b'))`, lues dans la migration. */
function sqlChoices(column: string): string[] {
  const line = migrationSql.split('\n').find((l) => new RegExp(`^\\s*${column}\\s+text\\b.*\\bin \\(`).test(l));
  assert.ok(line, `contrainte « in (…) » de ${column} introuvable dans la migration`);
  return [...line.matchAll(/'([^']*)'/g)].map((m) => m[1]!);
}

/** Noms des colonnes d'une table, lus dans son `create table`. */
function sqlColumns(table: string): string[] {
  const match = migrationSql.match(new RegExp(`create table if not exists public\\.${table} \\(([\\s\\S]*?)\\n\\);`));
  assert.ok(match, `table ${table} introuvable dans la migration`);
  return match[1]!
    .split('\n')
    .map((line) => line.match(/^\s{2}(\w+)\s+(?:uuid|text|timestamptz)/)?.[1])
    .filter((name): name is string => Boolean(name));
}

/** Droits accordés sur toute la table à l'utilisateur connecté (« grant select on public.x to authenticated »). */
function tableGrants(table: string): string[] {
  return [...migrationSql.matchAll(new RegExp(`grant ([a-z, ]+) on public\\.${table} to authenticated;`, 'g'))]
    .flatMap((m) => m[1]!.split(',').map((p) => p.trim()))
    .sort();
}

/** Colonnes accordées pour une action (« grant insert (a, b) on public.x to authenticated »), ou `null`. */
function columnGrants(action: 'insert' | 'update', table: string): string[] | null {
  const match = migrationSql.match(new RegExp(`grant ${action} \\(([^)]*)\\)\\s+on public\\.${table} to authenticated;`));
  return match ? match[1]!.split(',').map((c) => c.trim()) : null;
}

// ------------------------------------------------------------------------------------------------ charte ---

describe('charte d’anonymisation : le texte confirmé sur le site est celui que l’application redemande', () => {
  test('même version, même titre, même chapeau, même avertissement', () => {
    assert.equal(landing.ANONYMISATION_VERSION, app.ANONYMISATION_VERSION);
    assert.equal(landing.CHARTER_TITLE, app.CHARTER_TITLE);
    assert.equal(landing.CHARTER_LEAD, app.CHARTER_LEAD);
    assert.equal(landing.CHARTER_DISCLAIMER, app.CHARTER_DISCLAIMER);
  });

  test('mêmes engagements, dans le même ordre, mot pour mot', () => {
    assert.deepEqual(landing.CHARTER_ITEMS, app.CHARTER_ITEMS);
    assert.equal(landing.CHARTER_ITEMS.length, 5);
    assert.equal(new Set(landing.CHARTER_ITEMS.map((item) => item.id)).size, 5, 'identifiants uniques');
  });

  test('« tout confirmé » exige les cinq engagements, et seulement eux', () => {
    const all = new Set(landing.CHARTER_ITEMS.map((item) => item.id));
    assert.equal(landing.allConfirmed(all), true);
    assert.equal(landing.allConfirmed(new Set()), false);
    for (const id of all) {
      const missing = new Set(all);
      missing.delete(id);
      assert.equal(landing.allConfirmed(missing), false, `sans « ${id} »`);
    }
    assert.equal(landing.allConfirmed(new Set([...all, 'inconnu'])), true, 'un identifiant en trop ne gêne pas');
    assert.equal(landing.allConfirmed(new Set(['a', 'b', 'c', 'd', 'e'])), false, 'cinq cases ne sont pas les cinq engagements');
  });
});

// ------------------------------------------------------------------------------------------- identité visuelle ---

describe('identité visuelle : le site reprend celle de l’application, octet pour octet', () => {
  const css = (relative: string) => read(relative);
  /** Contenu du bloc `{ … }` qui suit `opening` (accolades équilibrées). */
  function blockAfter(source: string, opening: string): string {
    const start = source.indexOf(opening);
    assert.ok(start >= 0, `bloc introuvable : ${opening}`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) return source.slice(open + 1, i);
    }
    throw new Error(`bloc non refermé : ${opening}`);
  }
  const tokens = (block: string): Record<string, string> =>
    Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));

  const webCss = css('web/src/styles.css');
  const landingCss = css('landing/src/styles.css');

  for (const opening of [':root {', "@media (prefers-color-scheme: dark) {", ":root[data-theme='dark'] {"]) {
    test(`jetons « ${opening.replace(/ \{$/, '')} » identiques`, () => {
      const [a, b] = [tokens(blockAfter(webCss, opening)), tokens(blockAfter(landingCss, opening))];
      assert.ok(Object.keys(a).length > 25, 'le bloc de l’application doit porter ses jetons');
      assert.deepEqual(b, a);
    });
  }

  test('mêmes polices, mêmes @font-face, même arc d’or', () => {
    const faces = (source: string) => source.match(/@font-face \{[^}]*\}/g);
    assert.deepEqual(faces(landingCss), faces(webCss));
    for (const name of fs.readdirSync(path.join(REPO, 'web/src/fonts')).filter((n) => n.endsWith('.woff2'))) {
      assert.deepEqual(fs.readFileSync(path.join(REPO, 'landing/src/fonts', name)), fs.readFileSync(path.join(REPO, 'web/src/fonts', name)), name);
    }
    assert.deepEqual(fs.readFileSync(path.join(REPO, 'landing/src/assets/hero-dust.svg')), fs.readFileSync(path.join(REPO, 'web/src/assets/hero-dust.svg')));
  });

  test('la feuille du site n’appelle aucune ressource distante ni style en ligne', () => {
    assert.doesNotMatch(landingCss, /url\(\s*['"]?https?:/);
    assert.doesNotMatch(landingCss, /@import/);
    for (const file of walk('landing/src').filter((f) => f.endsWith('.tsx'))) {
      assert.doesNotMatch(read(file), /\bstyle=\{\{/, `${file} : pas de style en ligne (la CSP n'autorise que la feuille)`);
    }
  });
});

// ---------------------------------------------------------------------------------------------- formulaires ---

describe('formulaires : adresse e-mail et mot de passe', () => {
  test('adresse e-mail : vide, sans @, sans domaine, trop longue', () => {
    assert.match(validateEmail('')!, /Indiquez/);
    assert.match(validateEmail('   ')!, /Indiquez/);
    for (const bad of ['salma', 'salma@', '@exemple.org', 'salma@exemple', 'salma@exemple.o', 'sa lma@exemple.org', 'a@b@c.org', `${'a'.repeat(250)}@x.org`]) {
      assert.match(validateEmail(bad)!, /ne semble pas valide/, bad);
    }
    for (const good of ['salma@exemple.org', '  salma.benali+etude@chu-casa.ma  ', 'a@b.co']) assert.equal(validateEmail(good), null, good);
  });

  test('mot de passe : longueur minimale et maximale (en octets), chiffres seuls, partie locale de l’adresse', () => {
    assert.equal(validatePassword('a'.repeat(PASSWORD_MIN - 1), 'x@y.org')?.includes(String(PASSWORD_MIN)), true);
    assert.equal(validatePassword('a'.repeat(PASSWORD_MIN), 'x@y.org'), null);
    assert.equal(validatePassword('é'.repeat(PASSWORD_MAX / 2), 'x@y.org'), null, '72 octets au plus : trente-six « é » tiennent');
    assert.match(validatePassword('é'.repeat(PASSWORD_MAX / 2 + 1), 'x@y.org')!, /trop long/);
    assert.match(validatePassword('1234567890123', 'x@y.org')!, /chiffres/);
    assert.match(validatePassword('Mon-salma.benali-2026', 'salma.benali@exemple.org')!, /adresse e-mail/);
    assert.equal(validatePassword('une phrase de passe', 'ab@exemple.org'), null, 'une partie locale de moins de 4 caractères n’est pas comparée');
  });

  test('inscription : chaque champ nomme son erreur ; la confirmation n’est comparée que si le mot de passe est valide', () => {
    assert.deepEqual(Object.keys(validateSignup({ fullName: '', email: '', password: '', confirm: '' })).sort(), ['email', 'fullName', 'password']);
    const ok = { fullName: 'Dr Salma Benali', email: 'salma@exemple.org', password: 'une phrase de passe', confirm: 'une phrase de passe' };
    assert.deepEqual(validateSignup(ok), {});
    assert.deepEqual(Object.keys(validateSignup({ ...ok, confirm: 'une autre phrase' })), ['confirm']);
    assert.match(validateSignup({ ...ok, fullName: 'x'.repeat(121) }).fullName!, /trop long/);
    assert.deepEqual(Object.keys(validateSignup({ ...ok, password: 'court', confirm: 'différent' })), ['password']);
  });

  test('connexion et nouveau mot de passe', () => {
    assert.deepEqual(Object.keys(validateLogin({ email: 'oups', password: '' })).sort(), ['email', 'password']);
    assert.deepEqual(validateLogin({ email: 'a@b.org', password: 'x' }), {});
    assert.deepEqual(validateNewPassword({ password: 'une phrase de passe', confirm: 'une phrase de passe' }), {});
    assert.deepEqual(Object.keys(validateNewPassword({ password: 'une phrase de passe', confirm: 'autre' })), ['confirm']);
    assert.deepEqual(Object.keys(validateNewPassword({ password: 'court', confirm: 'court' })), ['password']);
  });
});

describe('erreurs du service d’authentification : toujours une phrase en français', () => {
  const cases: [unknown, RegExp][] = [
    [{ code: 'invalid_credentials', message: 'Invalid login credentials' }, /incorrect/],
    [{ code: 'email_not_confirmed' }, /non confirmée/],
    [{ code: 'user_already_exists' }, /existe déjà/],
    [{ code: 'email_exists' }, /existe déjà/],
    [{ code: 'weak_password' }, /trop faible/],
    [{ code: 'signup_disabled' }, /fermées/],
    [{ code: 'provider_disabled' }, /Google n’est pas encore activée sur ce site : utilisez votre adresse e-mail/],
    [{ code: 'over_email_send_rate_limit' }, /patientez/],
    [{ code: 'same_password' }, /différer/],
    [{ code: 'session_expired' }, /expiré/],
    [{ status: 429, message: 'whatever' }, /patientez/],
    // Serveur d'envoi par défaut de Supabase (projet tel que livré) : l'adresse n'est pas celle d'un membre de l'équipe.
    [{ code: 'email_address_not_authorized', message: 'Email address "a@b.org" cannot be used as it is not authorized' }, /ne peut pas encore envoyer de courriel.*Continuer avec Google/],
    [{ message: 'Email address "a@b.org" cannot be used as it is not authorized' }, /ne peut pas encore envoyer de courriel/],
    [{ code: 'email_address_invalid', message: 'Email address "a@example.com" is invalid' }, /n’est pas acceptée/],
    [{ name: 'AuthSessionMissingError', message: 'Auth session missing!' }, /session a expiré/],
    [{ message: 'Email not confirmed' }, /non confirmée/],
    [{ message: 'Invalid login credentials' }, /incorrect/],
    [{ message: 'User already registered' }, /existe déjà/],
    [{ message: 'Unsupported provider: provider is not enabled' }, /Google n’est pas encore activée sur ce site : utilisez votre adresse e-mail/],
    [{ message: 'Failed to fetch' }, /injoignable/],
    [{ name: 'AuthRetryableFetchError', message: '' }, /injoignable/],
    [{ message: 'load failed' }, /injoignable/],
  ];
  for (const [error, expected] of cases) {
    test(JSON.stringify(error), () => assert.match(frenchAuthError(error), expected));
  }

  test('une erreur inconnue, vide ou mal formée ne laisse jamais passer le texte brut', () => {
    for (const raw of [new Error('ECONNRESET: socket hang up'), { message: 'JWT expired at 2026' }, 'chaîne', null, undefined, 42, {}]) {
      assert.equal(frenchAuthError(raw), 'Une erreur est survenue. Réessayez dans un instant.');
    }
  });

  test('le code d’une erreur', () => {
    assert.equal(authErrorCode({ code: 'email_not_confirmed' }), 'email_not_confirmed');
    // Ancien format de réponse, sans code : « adresse non confirmée » se reconnaît encore (le bouton de renvoi en dépend).
    assert.equal(authErrorCode({ message: 'Email not confirmed' }), 'email_not_confirmed');
    for (const raw of [null, undefined, 'x', {}, { code: 400 }, { message: 'Invalid login credentials' }]) assert.equal(authErrorCode(raw), '');
  });
});

// -------------------------------------------------------------------------------------------- parcours d’accueil ---

const COMPLETE: ProfileDraft = {
  fullName: 'Dr Salma Benali',
  role: 'medecin',
  institution: 'CHU Ibn Rochd',
  country: 'Maroc',
  specialty: 'Cardiologie',
  studyType: 'these',
  volume: 'lt100',
  hosting: 'poste',
  ethics: 'obtenue',
};

describe('parcours d’accueil : profil, étude, reprise', () => {
  test('les listes d’options sont celles des contraintes SQL, valeur pour valeur', () => {
    const pairs: [string, readonly Option[]][] = [['role', ROLES], ['study_type', STUDY_TYPES], ['volume', VOLUMES], ['hosting', HOSTINGS], ['ethics', ETHICS]];
    for (const [column, options] of pairs) {
      assert.deepEqual(options.map((o) => o.value).sort(), sqlChoices(column).sort(), column);
      assert.equal(new Set(options.map((o) => o.value)).size, options.length, `${column} : valeurs uniques`);
      assert.ok(options.every((o) => o.label.trim().length > 3), `${column} : libellés renseignés`);
    }
  });

  test('étape 1 : nom, fonction, établissement, pays ; la spécialité est facultative mais bornée', () => {
    assert.deepEqual(Object.keys(validateProfileStep(1, EMPTY_PROFILE)).sort(), ['country', 'fullName', 'institution', 'role']);
    assert.deepEqual(validateProfileStep(1, COMPLETE), {});
    assert.deepEqual(validateProfileStep(1, { ...COMPLETE, specialty: '' }), {});
    assert.deepEqual(Object.keys(validateProfileStep(1, { ...COMPLETE, specialty: 'x'.repeat(121) })), ['specialty']);
    assert.deepEqual(Object.keys(validateProfileStep(1, { ...COMPLETE, role: 'chef' })), ['role'], 'une fonction hors liste est refusée');
    assert.match(validateProfileStep(1, { ...COMPLETE, institution: 'x'.repeat(161) }).institution!, /trop long/);
    assert.match(validateProfileStep(1, { ...COMPLETE, country: ' ' }).country!, /Indiquez/);
  });

  test('étape 2 : les quatre réponses sont obligatoires et prises dans les listes', () => {
    assert.deepEqual(Object.keys(validateProfileStep(2, EMPTY_PROFILE)).sort(), ['ethics', 'hosting', 'studyType', 'volume']);
    assert.deepEqual(validateProfileStep(2, COMPLETE), {});
    assert.deepEqual(Object.keys(validateProfileStep(2, { ...COMPLETE, ethics: 'peut-être' })), ['ethics']);
  });

  test('les espaces de bord et les doubles espaces ne comptent pas', () => {
    assert.equal(normalizeDraft({ ...COMPLETE, fullName: '  Dr   Salma \t Benali ' }).fullName, 'Dr Salma Benali');
    assert.deepEqual(validateProfileStep(1, { ...COMPLETE, fullName: ' ', institution: '\n' }).fullName, 'Indiquez votre nom.');
    assert.equal(isProfileComplete(COMPLETE), true);
    assert.equal(isProfileComplete({ ...COMPLETE, hosting: '' }), false);
  });

  test('reprise : où l’on renvoie quelqu’un selon ce que l’on sait de lui', () => {
    const current = landing.ANONYMISATION_VERSION;
    assert.equal(nextStep({ profile: null, consentedVersion: null }), 'profile');
    assert.equal(nextStep({ profile: EMPTY_PROFILE, consentedVersion: current }), 'profile');
    assert.equal(nextStep({ profile: { ...COMPLETE, ethics: '' }, consentedVersion: current }), 'profile', 'profil incomplet : le profil d’abord');
    assert.equal(nextStep({ profile: COMPLETE, consentedVersion: null }), 'charter');
    assert.equal(nextStep({ profile: COMPLETE, consentedVersion: '2026-01-v0' }), 'charter', 'texte périmé : la charte est redemandée');
    assert.equal(nextStep({ profile: COMPLETE, consentedVersion: current }), 'done');
    assert.equal(nextStep({ profile: COMPLETE, consentedVersion: '2026-01-v0' }, '2026-01-v0'), 'done', 'la version attendue est un paramètre');
  });

  test('ligne de la table : espaces nettoyés, vides → null, date de fin seulement quand elle est donnée', () => {
    const row = toRow('u-1', { ...COMPLETE, fullName: ' Dr  Salma Benali ', specialty: '' });
    assert.equal(row.full_name, 'Dr Salma Benali');
    assert.equal(row.specialty, null);
    assert.equal('onboarding_completed_at' in row, false, 'sans date : la clé est absente, l’écriture « fusionne » sans effacer une date déjà posée');
    assert.equal(toRow('u-1', COMPLETE, new Date('2026-10-10T12:00:00Z')).onboarding_completed_at, '2026-10-10T12:00:00.000Z');
    assert.equal(toRow('u-1', EMPTY_PROFILE).study_type, null);
  });

  test('lecture puis écriture : la ligne reconstitue le brouillon', () => {
    assert.deepEqual(fromRow(toRow('u-1', COMPLETE)), normalizeDraft(COMPLETE));
    assert.equal(fromRow(null), null);
    assert.equal(fromRow(undefined), null);
    assert.equal(fromRow({ role: 'medecin' }), null, 'sans nom : pas de profil');
    assert.deepEqual(fromRow({ full_name: 'Dr X' }), { ...EMPTY_PROFILE, fullName: 'Dr X' });
  });

  test('le rappel sur l’autorisation s’adapte à la réponse ; seule une réponse défavorable met en garde', () => {
    assert.equal(ethicsAdvice('obtenue').tone, 'ok');
    assert.equal(ethicsAdvice('sans-objet').tone, 'ok');
    for (const value of ['en-cours', 'pas-encore']) {
      const advice = ethicsAdvice(value);
      assert.equal(advice.tone, 'attention', value);
      assert.match(advice.text, /npm run demo/, 'on propose les dossiers fictifs en attendant');
    }
    assert.equal(ethicsAdvice('').tone, 'ok');
  });

  test('libellé d’une valeur', () => {
    assert.equal(labelOf(ROLES, 'interne'), 'Interne, résident');
    assert.equal(labelOf(ROLES, 'inconnu'), '');
  });
});

// ------------------------------------------------------------------------------------------------- adresses ---

describe('adresses : configuration, retours, redirections', () => {
  test('une adresse de configuration n’est acceptée qu’en http(s), sans identifiants', () => {
    assert.equal(httpUrl('https://abc.supabase.co/'), 'https://abc.supabase.co');
    assert.equal(httpUrl(' http://localhost:4000 '), 'http://localhost:4000');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://exemple.org', 'https://user:pass@exemple.org', 'pas une adresse', '', '   ', null, undefined, '//exemple.org', 'file:///etc/passwd']) {
      assert.equal(httpUrl(bad as string | null | undefined), null, String(bad));
    }
  });

  test('adresse d’une page du site, sur l’origine courante', () => {
    assert.equal(pageUrl('https://site.exemple/', '/bienvenue'), 'https://site.exemple/bienvenue');
    assert.equal(pageUrl('https://site.exemple', 'acces'), 'https://site.exemple/acces');
  });

  test('retour après connexion : seules deux pages du site, jamais de redirection ouverte', () => {
    assert.equal(safeNext('/acces'), '/acces');
    assert.equal(safeNext('/bienvenue'), '/bienvenue');
    for (const bad of [null, undefined, '', '/', 'https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/acces/../../x', '/acces?x=1', '/acces#x', '/ACCES', ' /acces', '/inconnu', '/connexion', '%2Facces', 'acces']) {
      assert.equal(safeNext(bad), null, String(bad));
    }
  });
});

describe('retour d’une authentification en échec', () => {
  test('refus, lien périmé, autre erreur : une phrase, jamais le texte du service', () => {
    assert.equal(parseAuthReturn('', ''), null);
    assert.equal(parseAuthReturn('?suite=/acces', ''), null);
    assert.match(parseAuthReturn('?error=access_denied&error_description=User+denied+access', '')!, /annulée/);
    assert.match(parseAuthReturn('', '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid')!, /expiré/);
    assert.match(parseAuthReturn('?error=server_error&error_description=Unable+to+exchange+external+code', '')!, /n’a pas abouti/);
    for (const [search, hash] of [['?error=access_denied&error_description=User+denied+access', ''], ['', '#error=x&error_description=Boom']] as const) {
      assert.doesNotMatch(parseAuthReturn(search, hash)!, /denied|Boom|exchange/);
    }
  });

  test('un lien ouvert ailleurs que là où l’on s’est inscrit : on dit quoi faire', () => {
    assert.match(LINK_NOT_COMPLETED, /autre|ailleurs/);
    assert.match(LINK_NOT_COMPLETED, /mot de passe/);
    assert.doesNotMatch(LINK_NOT_COMPLETED, /PKCE|verifier|vérificateur/i, 'pas de jargon');
  });

  test('l’adresse nettoyée perd les paramètres d’erreur et garde le reste', () => {
    assert.equal(stripAuthReturn('https://s.exemple/connexion?error=access_denied&error_code=x&error_description=y'), '/connexion');
    assert.equal(stripAuthReturn('https://s.exemple/connexion?suite=%2Facces&error=access_denied'), '/connexion?suite=%2Facces');
    assert.equal(stripAuthReturn('https://s.exemple/connexion#error=access_denied&error_code=otp_expired&error_description=z'), '/connexion');
    assert.equal(stripAuthReturn('https://s.exemple/connexion#type=signup&error=x'), '/connexion#type=signup');
  });

  test('sur la page « mot de passe », un échec parle de réinitialisation : on ne peut pas « se connecter avec son mot de passe »', () => {
    for (const [search, hash] of [
      ['', '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'],
      ['?error=server_error&error_description=x', ''],
    ] as const) {
      assert.equal(parseAuthReturn(search, hash, 'recovery'), RECOVERY_LINK_FAILED);
    }
    assert.match(RECOVERY_LINK_FAILED, /Demandez-en un nouveau/);
    assert.doesNotMatch(RECOVERY_LINK_FAILED, /connectez-vous avec votre mot de passe/i);
    assert.equal(parseAuthReturn('', '', 'recovery'), null);
    assert.equal(parseAuthReturn('', '#error=access_denied&error_code=otp_expired'), EMAIL_LINK_FAILED);
  });
});

describe('liens reçus par e-mail au format « token_hash » : valables sur tout appareil', () => {
  const HASH = 'pkce_7a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a7b8c9d0e1f';

  test('le lien est reconnu, avec son type', () => {
    assert.deepEqual(parseEmailLink(`?token_hash=${HASH}&type=email`), { tokenHash: HASH, type: 'email' });
    assert.deepEqual(parseEmailLink(`?type=recovery&token_hash=${HASH}`), { tokenHash: HASH, type: 'recovery' });
    // `signup` : ancien nom de la confirmation d'inscription.
    assert.deepEqual(parseEmailLink(`?token_hash=${HASH}&type=signup`), { tokenHash: HASH, type: 'email' });
  });

  test('rien d’autre n’est échangé : type inconnu, jeton absent, vide ou suspect', () => {
    for (const search of [
      '',
      '?code=abc',
      `?token_hash=${HASH}`,
      `?token_hash=${HASH}&type=magiclink`,
      `?token_hash=${HASH}&type=invite`,
      '?token_hash=&type=email',
      '?token_hash=court&type=email',
      `?token_hash=${encodeURIComponent('<script>')}&type=email`,
      `?token_hash=${'a'.repeat(300)}&type=email`,
    ]) {
      assert.equal(parseEmailLink(search), null, search);
    }
  });

  test('le jeton quitte l’adresse ; le reste demeure', () => {
    assert.equal(stripEmailLink(`https://s.exemple/bienvenue?token_hash=${HASH}&type=email`), '/bienvenue');
    assert.equal(stripEmailLink(`https://s.exemple/bienvenue?modifier&token_hash=${HASH}&type=email`), '/bienvenue?modifier=');
    assert.equal(stripEmailLink('https://s.exemple/connexion?suite=%2Facces'), '/connexion?suite=%2Facces');
    // `type` n'est retiré de la requête que s'il accompagne un jeton.
    assert.equal(stripEmailLink('https://s.exemple/x?type=a'), '/x?type=a');
  });

  test('jetons de session dans le fragment (ancien format, refusé par le flux PKCE) : détectés, puis retirés', () => {
    const implicit = '#access_token=eyJ.a.b&expires_at=1&expires_in=3600&refresh_token=r&token_type=bearer&type=signup';
    assert.equal(hasImplicitTokens(implicit), true);
    assert.equal(hasImplicitTokens('#apercu'), false);
    assert.equal(hasImplicitTokens(''), false);
    assert.equal(stripEmailLink(`https://s.exemple/bienvenue${implicit}`), '/bienvenue');
    assert.equal(stripEmailLink('https://s.exemple/#vos-donnees'), '/#vos-donnees');
  });

  test('les modèles de courriels de la documentation mènent au site, aux bonnes pages, avec ces paramètres', () => {
    const doc = read('docs/page-d-accueil.md');
    const links = [...doc.matchAll(/href="\{\{ \.SiteURL \}\}(\/[^?"]*)\?token_hash=\{\{ \.TokenHash \}\}&type=(\w+)"/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(links, [
      ['/bienvenue', 'email'],
      ['/mot-de-passe', 'recovery'],
    ]);
    const templates = [...doc.matchAll(/```html\n([\s\S]*?)```/g)].map((m) => m[1]!).join('\n');
    assert.doesNotMatch(templates, /\{\{ \.ConfirmationURL \}\}/, 'plus de lien par défaut dans les modèles proposés');
  });
});

// ---------------------------------------------------------------------------------------------------- base ---

describe('migration SQL : qui peut lire et écrire quoi', () => {
  const policies = [...migrationSql.matchAll(/create policy "([^"]+)"\s+on public\.(\w+) for (\w+) to (\w+)([\s\S]*?);/g)].map((m) => ({
    name: m[1]!,
    table: m[2]!,
    command: m[3]!,
    role: m[4]!,
    body: m[5]!,
  }));

  test('chaque table active les règles d’accès par ligne', () => {
    for (const table of ['profiles', 'consents']) {
      assert.match(migrationSql, new RegExp(`alter table public\\.${table} enable row level security;`), table);
    }
  });

  test('profil : lecture, création et mise à jour par son titulaire, rien d’autre', () => {
    const own = policies.filter((p) => p.table === 'profiles');
    assert.deepEqual(own.map((p) => p.command).sort(), ['insert', 'select', 'update']);
    assert.ok(!policies.some((p) => p.command === 'delete' || p.command === 'all'), 'aucune règle de suppression ni « all »');
  });

  test('engagement : lecture et création seulement — ni modification ni suppression', () => {
    assert.deepEqual(policies.filter((p) => p.table === 'consents').map((p) => p.command).sort(), ['insert', 'select']);
    assert.deepEqual(tableGrants('consents'), ['select']);
    assert.equal(columnGrants('update', 'consents'), null, 'aucun droit de modification, même sur une colonne');
  });

  test('toute règle vise les utilisateurs connectés et compare à leur propre identifiant', () => {
    assert.equal(policies.length, 5);
    for (const policy of policies) {
      assert.equal(policy.role, 'authenticated', policy.name);
      assert.match(policy.body, /\(select auth\.uid\(\)\) = user_id/, `${policy.name} : « (select auth.uid()) = user_id »`);
      assert.doesNotMatch(policy.body, /using \(\s*true\s*\)|with check \(\s*true\s*\)/, policy.name);
    }
  });

  test('droits : tout est retiré, puis seul le nécessaire est rendu à l’utilisateur connecté', () => {
    for (const table of ['profiles', 'consents']) {
      const revoke = migrationSql.indexOf(`revoke all on public.${table} from anon, authenticated;`);
      assert.ok(revoke > 0, `revoke all … ${table}`);
      const firstGrant = migrationSql.search(new RegExp(`grant [^;]*\\bon public\\.${table}\\b`));
      assert.ok(firstGrant > revoke, `${table} : le retrait doit précéder les droits accordés, sinon il les annule`);
    }
    // Un visiteur non connecté n'a rien ; personne n'efface son profil ni ne vide une table.
    assert.doesNotMatch(migrationSql, /grant\s+[^;]*\bto\s+(?:anon|public)\b/i);
    assert.doesNotMatch(migrationSql, /grant\s+(?:all|delete|truncate|references|trigger)\b/i);
    assert.deepEqual(tableGrants('profiles'), ['select']);
  });

  test('les dates et l’identifiant d’un engagement sont posés par la base : impossible d’antidater', () => {
    for (const managed of ['id', 'created_at', 'updated_at', 'accepted_at']) {
      for (const [action, table] of [['insert', 'profiles'], ['update', 'profiles'], ['insert', 'consents']] as const) {
        assert.ok(!columnGrants(action, table)!.includes(managed), `${action} ${table} : ${managed}`);
      }
    }
  });

  test('le site n’écrit que des colonnes qu’il a le droit d’écrire (création comme mise à jour)', () => {
    const profile = Object.keys(toRow('u', COMPLETE, new Date()));
    for (const column of profile) {
      assert.ok(columnGrants('insert', 'profiles')!.includes(column), `insert profiles (${column})`);
      // L'enregistrement est un « upsert » : PostgREST réécrit chaque colonne envoyée en cas de conflit.
      assert.ok(columnGrants('update', 'profiles')!.includes(column), `update profiles (${column})`);
    }
    assert.deepEqual([...columnGrants('insert', 'consents')!].sort(), ['items', 'kind', 'user_id', 'version']);
    assert.match(read('landing/src/lib/profile.ts'), /from\('consents'\)\.insert\(\{\s*user_id: user\.id,\s*kind: 'anonymisation',\s*version: ANONYMISATION_VERSION,\s*items: [^}]*\}\)/);
  });

  test('les lignes disparaissent avec le compte ; la fonction du déclencheur fixe son chemin de recherche', () => {
    assert.equal((migrationSql.match(/references auth\.users \(id\) on delete cascade/g) ?? []).length, 2);
    assert.match(migrationSql, /create or replace function public\.touch_updated_at\(\)[\s\S]*?set search_path = ''/);
  });

  test('aucune colonne ne peut recevoir une donnée de patient : seulement le profil professionnel et l’engagement', () => {
    const names = [...sqlColumns('profiles'), ...sqlColumns('consents')];
    for (const forbidden of ['patient', 'dossier', 'diagnostic', 'birth', 'naissance', 'ipp', 'cin', 'document']) {
      assert.ok(!names.some((n) => n.toLowerCase().includes(forbidden)), `colonne « ${forbidden} » interdite`);
    }
    assert.match(migrationSql, /Aucune donnée de patient/);
  });

  test('le site écrit exactement les colonnes du profil (hors colonnes gérées par la base)', () => {
    const written = Object.keys(toRow('u', COMPLETE, new Date())).sort();
    const managed = ['created_at', 'updated_at'];
    assert.deepEqual(written, sqlColumns('profiles').filter((c) => !managed.includes(c)).sort());
    for (const required of ['user_id', 'full_name', 'role', 'institution', 'country']) assert.ok(written.includes(required), required);
  });

  test('l’engagement écrit seulement des colonnes qui existent, et la version de la charte tient dans la colonne', () => {
    const columns = sqlColumns('consents');
    for (const written of ['user_id', 'kind', 'version', 'items']) assert.ok(columns.includes(written), written);
    assert.ok(landing.ANONYMISATION_VERSION.length <= 40);
    assert.ok(landing.CHARTER_ITEMS.length >= 1 && landing.CHARTER_ITEMS.length <= 20);
    assert.deepEqual(sqlChoices('kind'), ['anonymisation']);
  });
});

// ------------------------------------------------------------------------------------------------ déploiement ---

describe('déploiement (Vercel) : politique de sécurité, en-têtes, page HTML', () => {
  const vercel = JSON.parse(read('landing/vercel.json')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
    rewrites: { source: string; destination: string }[];
    framework: string;
    outputDirectory: string;
  };
  const global = Object.fromEntries(vercel.headers.find((h) => h.source === '/(.*)')!.headers.map((h) => [h.key, h.value]));
  const csp = Object.fromEntries(
    global['Content-Security-Policy']!.split(';').map((d) => {
      const [name, ...values] = d.trim().split(/\s+/);
      return [name!, values];
    }),
  ) as Record<string, string[]>;

  test('politique de sécurité du contenu : tout vient du site, hors l’authentification', () => {
    assert.deepEqual(csp['default-src'], ["'self'"]);
    assert.deepEqual(csp['script-src'], ["'self'"]);
    assert.deepEqual(csp['style-src'], ["'self'"]);
    assert.deepEqual(csp['font-src'], ["'self'"]);
    assert.deepEqual(csp['connect-src'], ["'self'", 'https://*.supabase.co']);
    assert.deepEqual(csp['object-src'], ["'none'"]);
    assert.deepEqual(csp['frame-ancestors'], ["'none'"]);
    assert.deepEqual(csp['base-uri'], ["'self'"]);
    assert.deepEqual(csp['form-action'], ["'self'"]);
    assert.ok(csp['img-src']!.every((v) => ["'self'", 'data:', 'https://*.googleusercontent.com'].includes(v)), 'images : le site, des données intégrées et les photos de compte Google');
    assert.doesNotMatch(global['Content-Security-Policy']!, /unsafe-(inline|eval)|\*\s*[;']|http:/);
  });

  test('autres en-têtes, réécriture vers la page unique, cache des fichiers à empreinte', () => {
    assert.equal(global['X-Content-Type-Options'], 'nosniff');
    assert.match(global['Referrer-Policy']!, /strict-origin/);
    assert.match(global['Permissions-Policy']!, /camera=\(\)/);
    assert.match(global['Cross-Origin-Opener-Policy']!, /same-origin/);
    // Toute adresse inconnue sert la page (routes du site)… sauf /assets/ : un fichier manquant y reste une erreur 404,
    // au lieu d'une page HTML servie sous le nom d'un script, avec le cache d'un an des fichiers à empreinte.
    assert.deepEqual(vercel.rewrites, [{ source: '/((?!assets/).*)', destination: '/index.html' }]);
    assert.equal(vercel.framework, 'vite');
    assert.equal(vercel.outputDirectory, 'dist');
    const assets = vercel.headers.find((h) => h.source === '/assets/(.*)')!.headers[0]!;
    assert.match(assets.value, /immutable/);
  });

  test('page HTML : français, adaptative, sans script en ligne, une seule place pour les balises de partage', () => {
    const html = read('landing/index.html');
    assert.match(html, /<html lang="fr">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1\.0" \/>/);
    assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, 'aucun <script> sans src');
    assert.doesNotMatch(html, /\son\w+=/i, 'aucun gestionnaire d’événement en ligne');
    assert.doesNotMatch(html, /<style/i);
    assert.equal(html.match(/<!--social-tags-->/g)?.length, 1);
    assert.match(html, /<title>[^<]{10,}<\/title>/);
    assert.match(html, /<noscript>/);
  });

  test('le script du thème est un fichier à part, qui ne lit que le réglage du thème', () => {
    const script = read('landing/public/theme-init.js');
    assert.ok(script.length < 800);
    assert.match(script, /localStorage\.getItem\('theme'\)/);
    assert.doesNotMatch(script, /fetch|XMLHttpRequest|document\.cookie/);
  });

  test('les pages qui ne servent à rien dans un moteur de recherche lui sont interdites', () => {
    const robots = read('landing/public/robots.txt');
    for (const route of ['/bienvenue', '/acces', '/mot-de-passe', '/deconnexion']) assert.match(robots, new RegExp(`Disallow: ${route}\\b`), route);
  });
});

describe('code du site : autonome, sans secret, sans surface d’injection', () => {
  const files = walk('landing/src').filter((f) => /\.(ts|tsx)$/.test(f));
  const sources = files.map((file) => ({ file, text: read(file) }));

  test('aucune importation du code de l’application ou du serveur : le site se déploie seul', () => {
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
        const specifier = m[1]!;
        if (!specifier.startsWith('.')) continue;
        const resolved = path.normalize(path.join(path.dirname(file), specifier));
        assert.ok(resolved.startsWith(path.join('landing', '')), `${file} importe ${specifier}, hors de landing/`);
      }
    }
  });

  test('dépendances : l’indispensable, rien qui trace ni qui mesure l’audience', () => {
    const pkg = JSON.parse(read('landing/package.json')) as { dependencies: Record<string, string>; version: string };
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@supabase/supabase-js', 'react', 'react-dom', 'react-router-dom']);
    const root = JSON.parse(read('package.json')) as { version: string };
    assert.equal(pkg.version, root.version, 'une seule version pour l’outil et sa page d’accueil');
  });

  test('le site se compile seul (Vercel n’installe que landing/) : les types qu’il utilise sont déclarés chez lui', () => {
    const pkg = JSON.parse(read('landing/package.json')) as { devDependencies: Record<string, string> };
    // vite.config.ts lit `process.env` : sans @types/node dans landing/, `tsc -b` échoue hors du dépôt complet.
    assert.match(read('landing/vite.config.ts'), /process\./);
    assert.ok(pkg.devDependencies['@types/node'], '@types/node dans landing/package.json');
    for (const name of ['typescript', 'vite', '@vitejs/plugin-react', '@types/react', '@types/react-dom']) assert.ok(pkg.devDependencies[name], name);
    assert.match(read('landing/package.json'), /"build": "tsc -b && vite build"/);
  });

  test('aucune API d’injection de HTML ni d’évaluation de code', () => {
    for (const { file, text } of sources) {
      assert.doesNotMatch(text, /dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(/, file);
    }
  });

  test('aucun secret ni jeton dans le code, les exemples de configuration ou la migration', () => {
    const suspects = [/service_role/i, /sb_secret_/, /-----BEGIN [A-Z ]*PRIVATE KEY/, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./, /sk-ant-/, /AIza[0-9A-Za-z_-]{30,}/];
    for (const file of [...files, 'landing/.env.example', 'landing/.env.production', 'landing/index.html', 'landing/vercel.json', ...fs.readdirSync(path.join(REPO, MIGRATION_DIR)).map((n) => path.join(MIGRATION_DIR, n))]) {
      const text = read(file);
      for (const re of suspects) assert.doesNotMatch(text, re, `${file} : ${re}`);
    }
  });

  test('exemple de configuration : seulement des variables VITE_, sans valeur réelle', () => {
    const env = read('landing/.env.example');
    const assignments = env.split('\n').filter((l) => /^[A-Z_]+=/.test(l));
    assert.ok(assignments.length >= 5);
    for (const line of assignments) {
      assert.match(line, /^VITE_[A-Z_]+=/, line);
      const value = line.split('=')[1] ?? '';
      if (/x{6,}/.test(value)) continue; // un gabarit (« sb_publishable_xxxx… »), pas une clé
      assert.doesNotMatch(value, /^[A-Za-z0-9_-]{30,}$/, `${line} : une valeur qui ressemble à une vraie clé`);
    }
    assert.match(env, /sb_publishable_x+/);
    assert.ok(!/SERVICE|SECRET/i.test(assignments.join('\n')));
  });

  test('configuration de production : l’adresse du projet et sa clé publique, rien d’autre', () => {
    const assignments = Object.fromEntries(
      read('landing/.env.production')
        .split('\n')
        .filter((l) => /^[A-Z_]+=/.test(l))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    assert.deepEqual(Object.keys(assignments).sort(), ['VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_URL']);
    assert.match(assignments.VITE_SUPABASE_URL!, /^https:\/\/[a-z]{20}\.supabase\.co$/);
    // Une clé « publishable », jamais l'ancienne clé JWT ni une clé secrète.
    assert.match(assignments.VITE_SUPABASE_PUBLISHABLE_KEY!, /^sb_publishable_[A-Za-z0-9_-]{20,}$/);
    // Les compilations des tests de bout en bout ne doivent pas lire ce fichier (mode « e2e »).
    assert.match(read('landing/e2e/flows.test.mjs'), /'--mode', 'e2e'/);
  });

  test('la console ne reçoit que des erreurs préfixées, jamais de jeton ni de réponse du service', () => {
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/console\.(\w+)\(([^)]*)/g)) {
        assert.equal(m[1], 'error', `${file} : console.${m[1]}`);
        assert.match(m[2]!, /\[pubresearcher\]/, `${file} : message sans préfixe`);
        assert.doesNotMatch(m[2]!, /token|session|password|motdepasse/i, `${file} : ${m[2]}`);
      }
    }
  });

  test('chaque lien interne mène à une page qui existe', () => {
    const routes = new Set([...read('landing/src/App.tsx').matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]!));
    assert.ok(routes.size >= 8, [...routes].join(' '));
    for (const { file, text } of sources) {
      for (const m of text.matchAll(/\bto=(?:"([^"]+)"|\{\{\s*pathname:\s*'([^']+)')/g)) {
        const target = (m[1] ?? m[2])!.split(/[?#]/)[0]!;
        assert.ok(routes.has(target), `${file} : lien vers ${target}, qui n’est pas une route`);
      }
      for (const m of text.matchAll(/navigate\('([^']+)'/g)) {
        assert.ok(routes.has(m[1]!.split(/[?#]/)[0]!), `${file} : navigate('${m[1]}')`);
      }
    }
  });

  test('typographie : pas d’apostrophe droite dans les textes français affichés', () => {
    for (const { file, text } of sources.filter((s) => s.file.endsWith('.tsx') || s.file.includes('lib'))) {
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, '').replace(/^\s*\{\/\*.*\*\/\}\s*$/, ''))
        .join('\n');
      const hits = [...code.matchAll(/[A-Za-zÀ-ÿ]'[A-Za-zÀ-ÿ]/g)].map((m) => code.slice(Math.max(0, m.index! - 15), m.index! + 15).replace(/\n/g, ' '));
      assert.deepEqual(hits, [], `${file} : apostrophes droites dans du texte`);
    }
  });
});
