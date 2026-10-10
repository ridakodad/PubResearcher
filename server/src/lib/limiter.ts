/**
 * Limite le nombre de tâches asynchrones menées de front. Les suivantes attendent leur tour,
 * dans l'ordre d'arrivée. La limite est relue à chaque tâche : elle se règle sans redémarrage.
 */
export function createLimiter(limit: () => number) {
  let active = 0;
  const waiting: (() => void)[] = [];

  const release = (): void => {
    active--;
    waiting.shift()?.();
  };

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    while (active >= Math.max(1, limit())) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      release();
    }
  };
}
