import express, { type Express } from 'express';
import cors from 'cors';
import fs from 'node:fs';
import path from 'node:path';
import { appPassword, corsOrigins, extraAllowedHosts, extraAllowedOrigins, host, webDistDir } from './config.js';
import { db, schemaVersion } from './db/index.js';
import { errorMiddleware } from './lib/http.js';
import { accessControl, isLoopback, requestGuard, securityHeaders } from './lib/security.js';
import { appVersion } from './version.js';
import { patientsRouter } from './routes/patients.js';
import { documentsRouter } from './routes/documents.js';
import { templatesRouter } from './routes/templates.js';
import { recordsRouter } from './routes/records.js';
import { analyticsRouter } from './routes/analytics.js';
import { exportRouter } from './routes/export.js';
import { redactionRouter } from './routes/redaction.js';
import { biblioRouter } from './routes/biblio.js';

export interface AppOptions {
  /** Mot de passe d'accès ; par défaut `APP_PASSWORD`. `null` supprime tout contrôle d'accès. */
  password?: string | null;
  /** Noms d'hôte acceptés ; par défaut ceux du poste (si l'outil n'écoute que dessus) plus `ALLOWED_HOSTS`. `null` : tous. */
  allowedHosts?: string[] | null;
}

const startedAt = Date.now();

/** Construit l'application Express. Séparé du démarrage pour les tests. */
export function createApp(options: AppOptions = {}): Express {
  const app = express();
  app.disable('x-powered-by');
  // Derrière un proxy (TLS, nom de domaine), l'adresse du client est celle que le proxy annonce.
  // Sans cela, le comptage des essais de mot de passe verrouillerait tout le monde à la fois.
  if (process.env.TRUST_PROXY) {
    const hops = Number(process.env.TRUST_PROXY);
    app.set('trust proxy', Number.isInteger(hops) ? hops : process.env.TRUST_PROXY);
  }

  app.use(securityHeaders());
  app.use(
    requestGuard({
      allowedHosts:
        options.allowedHosts !== undefined
          ? options.allowedHosts
          : isLoopback(host)
            ? ['localhost', '127.0.0.1', '[::1]', '::1', ...extraAllowedHosts]
            : extraAllowedHosts.length > 0
              ? extraAllowedHosts
              : null,
      allowedOrigins: [...corsOrigins, ...extraAllowedOrigins],
      trustForwardedHost: Boolean(process.env.TRUST_PROXY),
    }),
  );
  app.use(cors({ origin: corsOrigins, credentials: true }));
  app.use(accessControl(options.password === undefined ? appPassword : options.password));
  // Les fiches et leurs règles peuvent être volumineuses ; les fichiers passent
  // par multer et ne sont pas concernés par cette limite.
  app.use(express.json({ limit: '5mb' }));

  /*
   * Sonde de disponibilité. Elle interroge la base : un serveur qui répond mais ne peut plus lire
   * ses données n'est pas « en bonne santé ». Aucune donnée de patient ni chemin n'y figure.
   */
  app.get('/api/health', (_req, res) => {
    try {
      db.prepare('SELECT 1').get();
      res.json({
        status: 'ok',
        version: appVersion,
        schemaVersion: schemaVersion(),
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        time: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({ status: 'degraded', version: appVersion, error: 'Base de données inaccessible.' });
    }
  });

  app.use('/api/patients', patientsRouter);
  app.use('/api', documentsRouter);
  app.use('/api/templates', templatesRouter);
  app.use('/api/records', recordsRouter);
  app.use('/api/analytics', analyticsRouter);
  app.use('/api/export', exportRouter);
  app.use('/api/biblio', biblioRouter);
  app.use('/api', redactionRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Route inconnue.' });
  });

  // En production, le serveur sert aussi le front compilé : un seul processus,
  // une seule origine, pas de configuration CORS à gérer au déploiement.
  if (fs.existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(webDistDir, 'index.html'));
    });
  }

  app.use(errorMiddleware);
  return app;
}
