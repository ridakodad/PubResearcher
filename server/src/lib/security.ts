import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

/**
 * En-têtes de sécurité et contrôle d'accès.
 *
 * Cet outil manipule des comptes rendus de patients. Il tourne le plus souvent sur le poste d'un
 * chercheur, mais rien n'empêche de le poser sur un serveur du service : les protections ci-dessous
 * sont donc actives par défaut, et le contrôle d'accès s'allume d'une variable d'environnement.
 */

/** En-têtes posés sur toutes les réponses. */
export function securityHeaders(): RequestHandler {
  // Le front compilé n'appelle aucun service extérieur : ni police, ni script, ni statistique.
  // `style-src 'unsafe-inline'` est requis par les styles en ligne de React ; les scripts, eux, restent
  // limités aux fichiers de l'application.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'self'",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  return (req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.path.startsWith('/api/')) {
      // Des données de patients ne doivent séjourner ni dans le cache du navigateur ni dans celui d'un
      // intermédiaire. (Les fichiers du dossier fixent leur propre politique, plus stricte encore.)
      res.setHeader('Cache-Control', 'no-store');
    } else {
      res.setHeader('Content-Security-Policy', csp);
    }
    next();
  };
}

/** Compare deux secrets sans révéler, par le temps de réponse, combien de caractères coïncident. */
export function sameSecret(given: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

interface Attempts {
  failures: number;
  firstAt: number;
  blockedUntil: number;
}

const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 10;

/**
 * Mot de passe d'accès (HTTP Basic).
 *
 * Le navigateur affiche sa propre fenêtre de saisie puis joint les identifiants à chaque requête, y
 * compris les appels de l'interface : aucune page de connexion à maintenir. Le nom d'utilisateur est
 * ignoré — il n'y a qu'un mot de passe, partagé par l'équipe de l'étude. Les essais ratés d'une même
 * adresse sont comptés : dix en cinq minutes ferment la porte pour cinq minutes.
 *
 * Sans HTTPS, ce mot de passe circule en clair sur le réseau : à placer derrière un proxy TLS dès que
 * l'outil quitte le poste.
 */
export function accessControl(password: string | null): RequestHandler {
  if (!password) return (_req, _res, next) => next();

  const attempts = new Map<string, Attempts>();

  return (req: Request, res: Response, next: NextFunction): void => {
    // La supervision (orchestrateur, sonde de disponibilité) doit pouvoir demander l'état sans identifiants.
    if (req.path === '/api/health') return next();

    const now = Date.now();
    const who = req.ip ?? 'inconnu';
    const record = attempts.get(who);
    if (record && record.blockedUntil > now) {
      res.setHeader('Retry-After', String(Math.ceil((record.blockedUntil - now) / 1000)));
      res.status(429).json({ error: 'Trop d’essais. Patientez quelques minutes avant de réessayer.' });
      return;
    }

    const header = req.headers.authorization ?? '';
    if (header.toLowerCase().startsWith('basic ')) {
      const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      const given = separator < 0 ? decoded : decoded.slice(separator + 1);
      if (sameSecret(given, password)) {
        attempts.delete(who);
        next();
        return;
      }
      // Un essai raté compte ; une requête sans identifiants (premier appel du navigateur) non.
      const fresh = !record || now - record.firstAt > WINDOW_MS;
      const failures = (fresh ? 0 : record.failures) + 1;
      attempts.set(who, {
        failures,
        firstAt: fresh ? now : record.firstAt,
        blockedUntil: failures >= MAX_FAILURES ? now + WINDOW_MS : 0,
      });
    }

    res.setHeader('WWW-Authenticate', 'Basic realm="PubResearcher", charset="UTF-8"');
    res.status(401).json({ error: 'Authentification requise.' });
  };
}

/** Une adresse d'écoute n'est-elle accessible que depuis ce poste ? */
export function isLoopback(host: string): boolean {
  return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host);
}

export interface GuardOptions {
  /** Noms d'hôte acceptés dans l'en-tête `Host`. `null` : pas de contrôle (écoute sur le réseau, noms inconnus d'avance). */
  allowedHosts: string[] | null;
  /** Origines autorisées à écrire en plus de l'origine de l'outil lui-même (le front de développement). */
  allowedOrigins: string[];
  /** Derrière un proxy de confiance : l'hôte demandé par le visiteur est celui que le proxy annonce (`X-Forwarded-Host`). */
  trustForwardedHost?: boolean;
}

/** `localhost:4000` -> `localhost` ; `[::1]:4000` -> `[::1]`. */
function hostnameOf(hostHeader: string): string {
  const h = hostHeader.trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.replace(/:\d+$/, '');
}

/**
 * Deux protections contre un site tiers ouvert dans le même navigateur que l'outil.
 *
 * 1. Les noms d'hôte. Un site malveillant peut faire pointer son propre nom vers 127.0.0.1 : le navigateur
 *    le tient alors pour « même origine » que l'API, et sa page peut la lire. Tant que l'outil n'écoute que
 *    sur le poste, il n'accepte donc que `localhost`, `127.0.0.1` et `[::1]` (plus `ALLOWED_HOSTS`).
 * 2. Les écritures venues d'ailleurs. Une page quelconque peut envoyer, sans autorisation préalable du navigateur,
 *    un formulaire multipart ou un POST sans corps — déposer un fichier dans un dossier, changer la fiche active,
 *    relancer une extraction. Toute requête qui modifie quelque chose et dont l'en-tête `Origin` désigne un autre
 *    site est refusée. Les requêtes sans `Origin` (scripts, curl) ne sont pas des navigateurs : elles passent.
 */
export function requestGuard(options: GuardOptions): RequestHandler {
  const hosts = options.allowedHosts ? new Set(options.allowedHosts.map((h) => h.toLowerCase())) : null;
  const origins = new Set(options.allowedOrigins.map((o) => o.replace(/\/+$/, '').toLowerCase()));

  return (req: Request, res: Response, next: NextFunction): void => {
    const hostHeader = req.headers.host ?? '';
    if (hosts && !hosts.has(hostnameOf(hostHeader))) {
      res.status(403).json({
        error: `Nom d'hôte non autorisé (${hostnameOf(hostHeader) || 'absent'}). Pour y accéder sous ce nom, ajoutez-le à ALLOWED_HOSTS.`,
      });
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();

    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== 'null') {
      const normalized = origin.replace(/\/+$/, '').toLowerCase();
      let sameSite = false;
      try {
        const originHost = new URL(normalized).host;
        const forwarded = options.trustForwardedHost ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0]!.trim().toLowerCase() : '';
        sameSite = originHost === hostHeader.toLowerCase() || (forwarded !== '' && originHost === forwarded);
      } catch {
        /* origine illisible : refusée plus bas */
      }
      if (!sameSite && !origins.has(normalized)) {
        res.status(403).json({ error: 'Requête refusée : elle provient d’un autre site que l’outil.' });
        return;
      }
    } else if (origin === 'null') {
      // Document sandboxé, fichier local, redirection entre sites : jamais l'interface de l'outil.
      res.status(403).json({ error: 'Requête refusée : origine opaque.' });
      return;
    }
    next();
  };
}
