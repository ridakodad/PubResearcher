/**
 * Un faux service Supabase, en mémoire, pour tester le site sans compte ni réseau : l'authentification (e-mail,
 * Google, réinitialisation) et les deux tables, avec leurs règles.
 *
 * Il imite le *protocole* — formats de réponse, codes d'erreur, PKCE vérifié pour de bon (le défi est recalculé à
 * partir du vérificateur), jeton obligatoire sur les tables, règles d'accès par ligne — pas le serveur : ce que l'on
 * éprouve ici, c'est la manière dont le site s'en sert. Il ne dispense pas d'un essai sur un vrai projet.
 *
 * Les contraintes des tables (valeurs permises, longueurs) sont lues dans la migration SQL elle-même : si les listes
 * d'options du site et celles de la base divergent, une écriture est refusée ici comme elle le serait en vrai.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const MOCK_URL = 'https://mock.supabase.co';
export const MOCK_KEY = 'sb_publishable_e2e';

const b64url = (input) => Buffer.from(input).toString('base64url');

/** Colonnes, contraintes et droits de `public.profiles` et `public.consents`, lus dans la migration. */
function readConstraints() {
  const dir = path.join(ROOT, 'supabase', 'migrations');
  const sql = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
    .join('\n');
  const oneOf = {};
  for (const m of sql.matchAll(/^\s*(\w+)\s+text[^\n]*?\bin \(([^)]*)\)/gm)) {
    oneOf[m[1]] = [...m[2].matchAll(/'([^']*)'/g)].map((v) => v[1]);
  }
  const lengths = {};
  for (const m of sql.matchAll(/char_length\((\w+)\) between (\d+) and (\d+)/g)) lengths[m[1]] = [Number(m[2]), Number(m[3])];
  for (const m of sql.matchAll(/char_length\((\w+)\) <= (\d+)/g)) lengths[m[1]] = [0, Number(m[2])];
  const notNull = [...sql.matchAll(/^\s*(\w+)\s+(?:text|uuid)\s+not null/gm)].map((m) => m[1]);
  const columns = {};
  for (const m of sql.matchAll(/create table if not exists public\.(\w+) \(([\s\S]*?)\n\);/g)) {
    columns[m[1]] = [...m[2].matchAll(/^\s{2}(\w+)\s+(?:uuid|text|timestamptz)/gm)].map((c) => c[1]);
  }
  // Droits accordés colonne par colonne à l'utilisateur connecté (« grant insert (…) on public.x to authenticated »).
  const granted = { insert: {}, update: {} };
  for (const m of sql.matchAll(/grant (insert|update) \(([^)]*)\)\s+on public\.(\w+) to authenticated;/g)) {
    granted[m[1]][m[3]] = m[2].split(',').map((c) => c.trim());
  }
  return { oneOf, lengths, notNull, columns, granted };
}

export class FakeSupabase {
  constructor({ confirmEmail = true, googleEnabled = true } = {}) {
    this.confirmEmail = confirmEmail;
    this.googleEnabled = googleEnabled; // « Authentication › Sign In / Providers › Google » activé dans le projet
    this.constraints = readConstraints();
    this.users = new Map(); // adresse → utilisateur
    this.codes = new Map(); // code d'échange → { user, challenge, kind }
    this.pending = new Map(); // adresse → { redirectTo, challenge } (inscription à confirmer)
    this.profiles = new Map(); // user_id → ligne
    this.consents = []; // lignes, jamais modifiées
    this.log = []; // chaque requête reçue : { method, path, query, body, headers }
    this.faults = []; // pannes programmées : { match, status, body, times }
  }

  /** Programme une panne : la prochaine requête dont « méthode chemin » contient `match` reçoit cette réponse. */
  fail(match, status, body = {}, times = 1) {
    this.faults.push({ match, status, body, times });
  }

  /** Programme une coupure réseau : la requête n'aboutit pas du tout (serveur injoignable, hors ligne). */
  cut(match, times = 1) {
    this.faults.push({ match, abort: true, times });
  }

  requests(match) {
    return this.log.filter((r) => `${r.method} ${r.path}`.includes(match));
  }

  // ------------------------------------------------------------------------------------------------ jetons ---

  jwt(user) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      iss: `${MOCK_URL}/auth/v1`,
      sub: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      exp: now + 3600,
      iat: now,
      session_id: crypto.randomUUID(),
      app_metadata: { provider: user.provider },
      user_metadata: user.metadata,
    };
    return `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(payload))}.${b64url('signature')}`;
  }

  userJson(user) {
    const now = new Date().toISOString();
    return {
      id: user.id,
      aud: 'authenticated',
      role: 'authenticated',
      email: user.email,
      email_confirmed_at: user.confirmed ? now : null,
      phone: '',
      confirmed_at: user.confirmed ? now : null,
      last_sign_in_at: now,
      app_metadata: { provider: user.provider, providers: [user.provider] },
      user_metadata: user.metadata,
      identities: [{ id: user.id, user_id: user.id, identity_data: user.metadata, provider: user.provider, created_at: now, updated_at: now }],
      created_at: now,
      updated_at: now,
      is_anonymous: false,
    };
  }

  sessionJson(user) {
    return { access_token: this.jwt(user), token_type: 'bearer', expires_in: 3600, refresh_token: `refresh-${crypto.randomUUID()}`, user: this.userJson(user) };
  }

  createUser({ email, password = '', provider = 'email', metadata = {}, confirmed = true }) {
    const user = { id: crypto.randomUUID(), email, password, provider, metadata, confirmed };
    this.users.set(email, user);
    return user;
  }

  /** Les messages d'erreur du service, au format `2024-01-01` (code texte + message). */
  error(status, code, message) {
    return { status, body: { code, message }, headers: { 'x-supabase-api-version': '2024-01-01' } };
  }

  // ----------------------------------------------------------------------------------- aide aux scénarios ---

  /** Le lien reçu par e-mail : l'adresse de retour du site, avec le code d'échange en plus. */
  confirmationLink(email) {
    const pending = this.pending.get(email);
    if (!pending) throw new Error(`aucune inscription en attente pour ${email}`);
    const user = this.users.get(email);
    user.confirmed = true;
    const code = `code-${crypto.randomUUID()}`;
    this.codes.set(code, { user, challenge: pending.challenge, kind: 'signup' });
    return withParam(pending.redirectTo, 'code', code);
  }

  recoveryLink(email) {
    const pending = this.pending.get(`recovery:${email}`);
    if (!pending) throw new Error(`aucune réinitialisation en attente pour ${email}`);
    const code = `code-${crypto.randomUUID()}`;
    this.codes.set(code, { user: this.users.get(email), challenge: null, kind: 'recovery' });
    return withParam(pending.redirectTo, 'code', code);
  }

  // ------------------------------------------------------------------------------------------ traitement ---

  async handle(route, request) {
    const url = new URL(request.url());
    const method = request.method();
    const origin = request.headers()['origin'] ?? '*';
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'access-control-expose-headers': 'x-supabase-api-version, content-range',
      vary: 'origin',
    };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

    let body = null;
    const raw = request.postData();
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }
    const entry = { method, path: url.pathname, query: Object.fromEntries(url.searchParams), body, headers: request.headers() };
    this.log.push(entry);

    const fault = this.faults.find((f) => f.times > 0 && `${method} ${url.pathname}`.includes(f.match));
    let result;
    if (fault) {
      fault.times -= 1;
      if (fault.abort) return route.abort('connectionfailed');
      result = { status: fault.status, body: fault.body };
    } else if (url.pathname !== '/auth/v1/authorize' && request.headers()['apikey'] !== MOCK_KEY) {
      // (« authorize » est une navigation du navigateur : elle ne porte pas d'en-tête personnalisé.)
      result = this.error(401, 'no_authorization', 'No API key found in request');
    } else if (url.pathname.startsWith('/auth/v1/')) {
      result = this.auth(url, method, body, request);
    } else if (url.pathname.startsWith('/rest/v1/')) {
      result = this.rest(url, method, body, request);
    } else {
      result = { status: 404, body: { message: 'not found' } };
    }

    if (result.redirect) {
      return route.fulfill({ status: 302, headers: { ...cors, location: result.redirect } });
    }
    return route.fulfill({
      status: result.status ?? 200,
      headers: { ...cors, 'content-type': 'application/json', ...(result.headers ?? {}) },
      body: result.body === undefined ? '' : JSON.stringify(result.body),
    });
  }

  // ------------------------------------------------------------------------------------------ /auth/v1 ---

  auth(url, method, body, request) {
    const route = url.pathname.replace('/auth/v1', '');

    if (route === '/settings' && method === 'GET') {
      // Réglages publics, sous la forme que renvoie le vrai service (extrait).
      return { body: { external: { email: true, google: this.googleEnabled, github: false }, disable_signup: false, mailer_autoconfirm: !this.confirmEmail } };
    }

    if (route === '/signup' && method === 'POST') {
      const email = String(body.email ?? '').toLowerCase();
      if (!email) return this.error(400, 'validation_failed', 'To signup, please provide your email');
      if (String(body.password ?? '').length < 6) {
        return { status: 422, body: { code: 'weak_password', message: 'Password should be at least 6 characters.', weak_password: { reasons: ['length'] } }, headers: { 'x-supabase-api-version': '2024-01-01' } };
      }
      const existing = this.users.get(email);
      if (existing) {
        // Comme le vrai service : même réponse qu'une inscription réussie, pour ne pas révéler qu'un compte existe.
        return { body: { ...this.userJson({ ...existing, id: crypto.randomUUID() }), identities: [] } };
      }
      const user = this.createUser({ email, password: body.password, metadata: { ...(body.data ?? {}), email, email_verified: false }, confirmed: !this.confirmEmail });
      if (this.confirmEmail) {
        this.pending.set(email, { redirectTo: url.searchParams.get('redirect_to'), challenge: body.code_challenge });
        return { body: this.userJson(user) };
      }
      return { body: this.sessionJson(user) };
    }

    if (route === '/token' && method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const user = this.users.get(String(body.email ?? '').toLowerCase());
        if (!user || user.password !== body.password) return this.error(400, 'invalid_credentials', 'Invalid login credentials');
        if (!user.confirmed) return this.error(400, 'email_not_confirmed', 'Email not confirmed');
        return { body: this.sessionJson(user) };
      }
      if (grant === 'pkce') {
        const entry = this.codes.get(body.auth_code);
        if (!entry) return this.error(400, 'flow_state_not_found', 'invalid flow state, no valid flow state found');
        this.codes.delete(body.auth_code);
        const verifier = String(body.code_verifier ?? '');
        if (entry.challenge) {
          const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
          if (!verifier || challenge !== entry.challenge) return this.error(400, 'bad_code_verifier', 'code challenge does not match previously saved code verifier');
        }
        return { body: this.sessionJson(entry.user) };
      }
      if (grant === 'refresh_token') return this.error(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    }

    if (route === '/authorize' && method === 'GET') {
      const provider = url.searchParams.get('provider');
      if (provider !== 'google' || !this.googleEnabled) return this.error(400, 'validation_failed', 'Unsupported provider: provider is not enabled');
      const redirectTo = url.searchParams.get('redirect_to');
      const email = this.nextOAuthEmail ?? 'dr.google@exemple.org';
      const user =
        this.users.get(email) ??
        this.createUser({
          email,
          provider: 'google',
          metadata: { full_name: 'Dr Google Test', name: 'Dr Google Test', avatar_url: 'https://lh3.googleusercontent.com/a/e2e', email, email_verified: true },
        });
      const code = `code-${crypto.randomUUID()}`;
      this.codes.set(code, { user, challenge: url.searchParams.get('code_challenge'), kind: 'oauth' });
      return { redirect: withParam(redirectTo, 'code', code) };
    }

    if (route === '/recover' && method === 'POST') {
      // Même réponse que l'adresse existe ou non.
      const email = String(body.email ?? '').toLowerCase();
      if (this.users.has(email)) this.pending.set(`recovery:${email}`, { redirectTo: url.searchParams.get('redirect_to') });
      return { body: {} };
    }

    if (route === '/resend' && method === 'POST') {
      const email = String(body.email ?? '').toLowerCase();
      // Le renvoi ouvre un nouveau flux PKCE : nouveau défi, nouvelle adresse de retour (avec son identifiant de flux).
      if (this.pending.has(email)) {
        const previous = this.pending.get(email);
        this.pending.set(email, { redirectTo: url.searchParams.get('redirect_to') ?? previous.redirectTo, challenge: body.code_challenge ?? previous.challenge });
      }
      return { body: {} };
    }

    if (route === '/user' && method === 'PUT') {
      const user = this.userFromAuth(request);
      if (!user) return this.error(401, 'no_authorization', 'This endpoint requires a Bearer token');
      if (body.password) {
        if (body.password === user.password) return this.error(422, 'same_password', 'New password should be different from the old password.');
        user.password = body.password;
      }
      return { body: this.userJson(user) };
    }

    if (route === '/user' && method === 'GET') {
      const user = this.userFromAuth(request);
      return user ? { body: this.userJson(user) } : this.error(401, 'no_authorization', 'This endpoint requires a Bearer token');
    }

    if (route === '/logout' && method === 'POST') return { status: 204 };

    return this.error(404, 'not_found', `${method} ${route}`);
  }

  userFromAuth(request) {
    const token = (request.headers()['authorization'] ?? '').replace(/^Bearer /, '');
    const payload = token.split('.')[1];
    if (!payload) return null;
    try {
      const sub = JSON.parse(Buffer.from(payload, 'base64url').toString()).sub;
      return [...this.users.values()].find((u) => u.id === sub) ?? null;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------- /rest/v1 ---

  rest(url, method, body, request) {
    const user = this.userFromAuth(request);
    // Sans jeton d'utilisateur : le rôle « anon », qui n'a aucun droit sur ces tables (revoke all ... from anon).
    if (!user) return { status: 401, body: { code: '42501', message: 'permission denied for table', details: null, hint: null } };

    const table = url.pathname.replace('/rest/v1/', '');
    if (table !== 'profiles' && table !== 'consents') return { status: 404, body: { code: 'PGRST205', message: `Could not find the table 'public.${table}'` } };
    const rows = table === 'profiles' ? [...this.profiles.values()] : this.consents;

    if (method === 'GET') {
      let selected = rows.filter((row) => row.user_id === user.id); // règle d'accès par ligne
      for (const [column, filter] of url.searchParams) {
        if (['select', 'order', 'limit', 'offset'].includes(column)) continue;
        if (filter.startsWith('eq.')) selected = selected.filter((row) => String(row[column]) === filter.slice(3));
      }
      const order = url.searchParams.get('order');
      if (order) {
        const [column, direction] = order.split('.');
        selected = [...selected].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1) * (direction === 'desc' ? -1 : 1));
      }
      const limit = Number(url.searchParams.get('limit') ?? Infinity);
      return { body: selected.slice(0, limit) };
    }

    if (method === 'POST') {
      const incoming = Array.isArray(body) ? body : [body];
      const upsert = url.searchParams.get('on_conflict') === 'user_id' && table === 'profiles';
      // Même ordre que le vrai service : colonnes connues (PostgREST), droits (base), règle d'accès, contraintes.
      for (const row of incoming) {
        const denied = this.privileges(table, row, upsert);
        if (denied) return denied;
        if (row.user_id !== user.id) return { status: 403, body: { code: '42501', message: `new row violates row-level security policy for table "${table}"` } };
        const violation = this.check(table, row);
        if (violation) return { status: 400, body: { code: '23514', message: `new row for relation "${table}" violates check constraint "${violation}"` } };
      }
      for (const row of incoming) {
        if (table === 'profiles') {
          const existing = this.profiles.get(row.user_id);
          if (existing && !upsert) return { status: 409, body: { code: '23505', message: 'duplicate key value violates unique constraint "profiles_pkey"' } };
          this.profiles.set(row.user_id, { ...(existing ?? { created_at: new Date().toISOString() }), ...row, updated_at: new Date().toISOString() });
        } else {
          this.consents.push({ id: crypto.randomUUID(), accepted_at: new Date().toISOString(), ...row });
        }
      }
      return { status: 201 };
    }

    // PATCH et DELETE : aucune règle ne les autorise sur `consents` ; `profiles` ne se supprime pas.
    return { status: 403, body: { code: '42501', message: `permission denied for table ${table}` } };
  }

  /**
   * Droits colonne par colonne de la migration. Une colonne absente de la table : erreur PostgREST (PGRST204). Une
   * colonne que l'utilisateur n'a pas le droit d'écrire (`accepted_at`, `created_at`…) : refus de la base (42501),
   * comme sur le vrai projet. Un « upsert » exige en plus le droit de mise à jour de chaque colonne envoyée.
   */
  privileges(table, row, upsert) {
    const { columns, granted } = this.constraints;
    for (const key of Object.keys(row)) {
      if (!columns[table].includes(key)) {
        return { status: 400, body: { code: 'PGRST204', details: null, hint: null, message: `Could not find the '${key}' column of '${table}' in the schema cache` } };
      }
      if (!(granted.insert[table] ?? []).includes(key) || (upsert && !(granted.update[table] ?? []).includes(key))) {
        return { status: 403, body: { code: '42501', details: null, hint: null, message: `permission denied for table ${table}` } };
      }
    }
    return null;
  }

  /** Contraintes CHECK de la migration. Renvoie le nom de la contrainte violée, ou `null`. */
  check(table, row) {
    const { oneOf, lengths, notNull, granted } = this.constraints;
    for (const column of granted.insert[table]) {
      const value = row[column];
      if (notNull.includes(column) && (value === undefined || value === null || value === '')) return `${column} not null`;
      if (typeof value === 'string' && oneOf[column] && !oneOf[column].includes(value)) return `${column} in (${oneOf[column].join(', ')})`;
      if (typeof value === 'string' && lengths[column] && (value.length < lengths[column][0] || value.length > lengths[column][1])) return `${column} longueur ${lengths[column].join('..')}`;
    }
    if (table === 'consents' && (!Array.isArray(row.items) || row.items.length < 1 || row.items.length > 20)) return 'items cardinalité 1..20';
    if (table === 'consents' && row.kind !== 'anonymisation') return 'kind in (anonymisation)';
    return null;
  }
}

function withParam(target, key, value) {
  const url = new URL(target);
  url.searchParams.set(key, value);
  return url.toString();
}
