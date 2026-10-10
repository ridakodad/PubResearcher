import type { Server } from 'node:http';

/**
 * Délais du serveur HTTP. Node coupe par défaut toute requête qui dure plus de cinq minutes : un envoi de 200 Mo
 * sur un disque réseau ou une liaison lente y arrive. Trente minutes couvrent les envois réalistes ; l'attente des
 * en-têtes, elle, reste courte (60 s) — c'est elle qui protège des connexions qui n'envoient jamais rien.
 */
export const HTTP_TIMEOUTS = {
  requestTimeout: 30 * 60 * 1000,
  headersTimeout: 60 * 1000,
  keepAliveTimeout: 65 * 1000,
} as const;

export function applyHttpTimeouts(server: Server): void {
  server.requestTimeout = HTTP_TIMEOUTS.requestTimeout;
  server.headersTimeout = HTTP_TIMEOUTS.headersTimeout;
  server.keepAliveTimeout = HTTP_TIMEOUTS.keepAliveTimeout;
}
