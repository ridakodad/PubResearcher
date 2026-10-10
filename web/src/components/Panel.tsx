import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { IconChevron } from './icons';

/**
 * Bloc de travail que l'on ouvre et que l'on réduit.
 *
 * Un écran d'étude accumule les sections : corpus, réglages, résultats,
 * justifications. Tout afficher en permanence fatigue et noie l'essentiel ;
 * tout masquer oblige à re-déplier à chaque visite. Le panneau retient donc
 * son état d'une session à l'autre, par clé : chacun compose l'écran dont il a
 * besoin, et le retrouve tel quel.
 *
 * Réduit, il ne laisse que son titre et son résumé — ce qui suffit à décider
 * s'il faut l'ouvrir.
 */

const STORAGE_PREFIX = 'panel:';

function readStored(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? fallback : raw === '1';
  } catch {
    // Stockage indisponible (navigation privée stricte) : on garde le défaut.
    return fallback;
  }
}

/** Signale aux panneaux montés qu'une commande globale a changé le stockage. */
const CHANGED = 'panels:changed';

export function usePanelState(key: string, defaultOpen = true): [boolean, () => void] {
  const [open, setOpen] = useState(() => readStored(key, defaultOpen));

  // Sans cette écoute, un panneau garderait l'état lu à son montage et
  // « Tout réduire » resterait sans effet sur lui.
  useEffect(() => {
    const resync = () => setOpen(readStored(key, defaultOpen));
    window.addEventListener(CHANGED, resync);
    return () => window.removeEventListener(CHANGED, resync);
  }, [key, defaultOpen]);

  const toggle = useCallback(() => {
    setOpen((current) => {
      const next = !current;
      try {
        localStorage.setItem(STORAGE_PREFIX + key, next ? '1' : '0');
      } catch {
        // Sans stockage, l'état vaut pour la session en cours.
      }
      return next;
    });
  }, [key]);

  return [open, toggle];
}

export function Panel({
  id,
  title,
  summary,
  actions,
  children,
  defaultOpen = true,
  padded = true,
}: {
  /** Clé de mémorisation. Stable dans le temps : c'est elle qui retient l'état. */
  id: string;
  title: ReactNode;
  /** Résumé affiché même replié : il doit suffire à décider d'ouvrir. */
  summary?: ReactNode;
  /** Commandes du panneau, masquées quand il est replié. */
  actions?: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  padded?: boolean;
}) {
  const [open, toggle] = usePanelState(id, defaultOpen);
  const bodyId = `panel-${id}`;

  return (
    <section className={open ? 'panel' : 'panel panel-closed'}>
      <div className="panel-head">
        {/* Motif « accordéon » : le bouton est le contenu d'un titre. Sans lui, la page n'a pas de plan pour qui
            la parcourt par ses titres. */}
        <h2 className="panel-heading">
          <button
            className="panel-toggle"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={bodyId}
          >
            <IconChevron size={16} className={open ? 'panel-chevron open' : 'panel-chevron'} />
            <span className="panel-title">{title}</span>
          </button>
        </h2>
        {summary && <span className="panel-summary">{summary}</span>}
        {/* Les commandes d'un panneau replié n'ont pas de contexte : elles
            disparaissent avec lui. */}
        {actions && open && <div className="panel-actions">{actions}</div>}
      </div>

      {open && (
        <div id={bodyId} className={padded ? 'panel-body' : 'panel-body panel-body-flush'}>
          {children}
        </div>
      )}
    </section>
  );
}

/**
 * Réduit ou déploie tous les panneaux d'un écran d'un seul geste.
 *
 * Sur une page longue, c'est la commande qui remet de l'ordre : on replie
 * tout, puis on rouvre la seule section sur laquelle on travaille.
 */
export function PanelGroupControls({ keys }: { keys: string[] }) {
  const setAll = (open: boolean) => {
    try {
      for (const key of keys) localStorage.setItem(STORAGE_PREFIX + key, open ? '1' : '0');
    } catch {
      // Sans stockage, rien à propager.
    }
    window.dispatchEvent(new Event(CHANGED));
  };

  return (
    <div className="row" style={{ gap: 4 }}>
      <button className="btn-sm btn-quiet" onClick={() => setAll(false)}>
        Tout réduire
      </button>
      <button className="btn-sm btn-quiet" onClick={() => setAll(true)}>
        Tout déployer
      </button>
    </div>
  );
}
