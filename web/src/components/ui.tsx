import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { IconAlert, IconAuto, IconClose, IconMoon, IconSun } from './icons';
import { readSetting, writeSetting } from '../lib/storage';

// ------------------------------------------------------------------- toasts

type ToastKind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: ToastKind; message: string }

interface ToastApi {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback((kind: ToastKind, message: string) => {
    const id = nextId.current++;
    setToasts((current) => [...current, { id, kind, message }]);
    // Les messages d'erreur restent affichés plus longtemps : ils demandent
    // souvent une action de l'utilisateur.
    window.setTimeout(() => {
      setToasts((current) => current.filter((t) => t.id !== id));
    }, kind === 'error' ? 8000 : 4000);
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      error: (m) => push('error', m),
      info: (m) => push('info', m),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast doit être utilisé dans un ToastProvider.');
  return ctx;
}

// -------------------------------------------------------------------- modal

/** Éléments que le clavier peut atteindre, dans l'ordre du document. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const visible = (el: HTMLElement): boolean => el.getClientRects().length > 0;

/**
 * Fenêtre modale.
 *
 * Tant qu'elle est ouverte, le reste de la page est inerte : le clavier et les lecteurs d'écran ne peuvent
 * plus l'atteindre, et Tab tourne dans la fenêtre. Le focus entre dans la fenêtre à l'ouverture et revient à
 * l'élément qui l'avait ouverte à la fermeture — sans quoi un utilisateur au clavier se retrouve en tête de
 * page, à l'autre bout de l'écran.
 */
export function Modal({
  title,
  children,
  onClose,
  footer,
  width,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  footer?: ReactNode;
  width?: number;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Le dernier `onClose` reçu : le raccourci Échap ne se ré-installe pas à chaque rendu du parent.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Seule la fenêtre du dessus répond à Échap.
        const backdrops = document.querySelectorAll('.modal-backdrop');
        if (backdrops[backdrops.length - 1] === backdropRef.current) closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const items = [...dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
      if (items.length === 0) {
        e.preventDefault();
        dialogRef.current.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    // Empêche le défilement de la page derrière la fenêtre modale.
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, []);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = document.getElementById('root');
    // Tout ce qui est derrière devient inerte : la page, et les fenêtres déjà ouvertes sous celle-ci.
    const behind: HTMLElement[] = [
      ...(root ? [root] : []),
      ...[...document.querySelectorAll<HTMLElement>('.modal-backdrop')].filter((el) => el !== backdropRef.current),
    ];
    const wasInert = behind.map((el) => el.inert);
    behind.forEach((el) => {
      el.inert = true;
    });

    // Le focus entre dans la fenêtre : premier champ de saisie, sinon premier contrôle du corps, sinon la fenêtre.
    const body = bodyRef.current;
    const target =
      body?.querySelector<HTMLElement>('input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled])') ??
      body?.querySelector<HTMLElement>('button:not([disabled]), a[href]') ??
      dialogRef.current;
    target?.focus({ preventScroll: true });

    return () => {
      behind.forEach((el, i) => {
        el.inert = wasInert[i] ?? false;
      });
      // Retour à l'élément d'origine, ou à défaut au contenu de la page.
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      else document.getElementById('plan-de-travail')?.focus({ preventScroll: true });
    };
  }, []);

  // Une fenêtre s'ouvre toujours à son premier champ. Le navigateur peut
  // l'avoir fait défiler en amenant le champ initial dans la vue : cet effet
  // s'exécute après, et rétablit le haut.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, []);

  /*
   * Rendue directement sous `body`, hors de l'arbre de la page.
   *
   * Une fenêtre modale se positionne par rapport à l'écran. Il suffit qu'un
   * ancêtre porte un `transform`, un `filter` ou un `backdrop-filter` — même
   * neutre — pour qu'il devienne le référentiel du positionnement fixe : la
   * fenêtre se centre alors dans la page et déborde de l'écran. Le portail
   * rend l'affichage indépendant de ce que la page fait de ses styles.
   */
  return createPortal(
    <div
      className="modal-backdrop"
      ref={backdropRef}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={dialogRef}
        style={width ? { width: `min(${width}px, 100%)` } : undefined}
      >
        <div className="modal-head">
          <h2>{title}</h2>
          <div className="spacer" />
          <button className="btn-icon" onClick={onClose} aria-label="Fermer">
            <IconClose size={18} />
          </button>
        </div>
        <div className="modal-body" ref={bodyRef}>{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

// ------------------------------------------------------------------- onglets

/**
 * Clavier d'une barre d'onglets (motif ARIA « tabs ») : ← → passent à l'onglet voisin en l'activant, Début et Fin
 * vont aux extrémités. À poser sur chaque onglet, avec `tabIndex={sélectionné ? 0 : -1}` : un seul onglet figure
 * dans l'ordre de tabulation, les autres s'atteignent aux flèches — sans cela, une barre de huit onglets coûte
 * huit appuis sur Tab avant d'atteindre le contenu.
 */
export function onTabKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const list = event.currentTarget.closest('[role="tablist"]');
  if (!list) return;
  const tabs = [...list.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])')];
  const index = tabs.indexOf(event.currentTarget);
  if (index < 0) return;
  let next: number;
  switch (event.key) {
    case 'ArrowRight':
      next = (index + 1) % tabs.length;
      break;
    case 'ArrowLeft':
      next = (index - 1 + tabs.length) % tabs.length;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = tabs.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  const target = tabs[next];
  target?.focus();
  target?.click();
}

// ----------------------------------------------------------------- pagination

/** Page courante ramenée dans les bornes : un filtre qui réduit la liste ne laisse jamais sur une page qui n'existe plus. */
export function clampPage(page: number, total: number, pageSize: number): number {
  return Math.min(Math.max(0, page), Math.max(1, Math.ceil(total / pageSize)) - 1);
}

/** Navigation entre pages d'une longue liste. Rien ne s'affiche tant que tout tient sur une page. */
export function Pager({
  total,
  pageSize,
  page,
  onPage,
  label,
  noun = 'Lignes',
}: {
  total: number;
  pageSize: number;
  page: number;
  onPage: (page: number) => void;
  label: string;
  noun?: string;
}) {
  if (total <= pageSize) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = clampPage(page, total, pageSize);
  return (
    <nav className="row pager" aria-label={label}>
      <button className="btn-sm" onClick={() => onPage(current - 1)} disabled={current === 0}>
        ← Précédentes
      </button>
      <span className="small secondary" aria-live="polite">
        {noun} {current * pageSize + 1}–{Math.min((current + 1) * pageSize, total)} sur {total.toLocaleString('fr-FR')} · page{' '}
        {current + 1} sur {pages}
      </span>
      <button className="btn-sm" onClick={() => onPage(current + 1)} disabled={current >= pages - 1}>
        Suivantes →
      </button>
    </nav>
  );
}

// ------------------------------------------------------------------- divers

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row" style={{ gap: 8 }}>
      <span className="spinner" aria-hidden="true" />
      {label && <span className="small secondary">{label}</span>}
    </span>
  );
}

export function LoadingPanel({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="card">
      <div className="card-body">
        <Spinner label={label} />
      </div>
    </div>
  );
}

export function ErrorPanel({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="notice notice-error">
      <IconAlert size={18} />
      <div style={{ flex: 1 }}>
        <div>{message}</div>
        {onRetry && (
          <button className="btn-sm" style={{ marginTop: 8 }} onClick={onRetry}>
            Réessayer
          </button>
        )}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/** Délai en deçà duquel un second clic n'est pas une confirmation (un double-clic dure rarement plus de 500 ms). */
const CONFIRM_GRACE_MS = 700;

/** Demande une confirmation avant une action destructive. */
export function ConfirmButton({
  onConfirm,
  label,
  confirmLabel = 'Confirmer ?',
  className = 'btn-sm btn-danger',
  title,
  subject,
}: {
  onConfirm: () => void;
  label: ReactNode;
  confirmLabel?: string;
  className?: string;
  title?: string;
  /** Ce sur quoi porte le geste (« le dossier PAT-001 ») : vingt-quatre boutons « Supprimer » ne se distinguent pas sans lui. */
  subject?: string;
}) {
  const [armed, setArmed] = useState(false);
  const armedAt = useRef(0);

  useEffect(() => {
    if (!armed) return;
    // La confirmation retombe d'elle-même : pas de bouton dangereux laissé armé.
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const visible = armed ? confirmLabel : label;
  // Le nom accessible commence par le texte visible (WCAG 2.5.3) puis nomme l'objet.
  const accessibleName = subject && typeof visible === 'string' ? `${visible} ${subject}` : undefined;

  return (
    <>
      <button
        className={className}
        title={title}
        aria-label={accessibleName}
        onClick={(event) => {
          if (!armed) {
            armedAt.current = Date.now();
            setArmed(true);
            return;
          }
          // Un double-clic arme puis confirme dans le même geste : la confirmation
          // n'aurait alors rien confirmé. On ignore le second clic d'un double-clic
          // et tout clic trop proche de l'armement pour être une décision.
          if (event.detail > 1 || Date.now() - armedAt.current < CONFIRM_GRACE_MS) return;
          onConfirm();
          setArmed(false);
        }}
      >
        {visible}
      </button>
      {/* Le changement de libellé d'un bouton n'est pas annoncé : on dit à voix haute que le geste attend sa confirmation. */}
      <span role="status" className="sr-only">
        {armed ? `${subject ? `${subject} : ` : ''}cliquez de nouveau pour confirmer.` : ''}
      </span>
    </>
  );
}

/** Éditeur de liste de chaînes (options, libellés, mots-clés). */
export function StringListEditor({
  values,
  onChange,
  placeholder,
  ariaLabel,
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState('');

  const add = () => {
    const value = draft.trim();
    if (value.length === 0 || values.includes(value)) {
      setDraft('');
      return;
    }
    onChange([...values, value]);
    setDraft('');
  };

  return (
    <div>
      <div className="row" style={{ gap: 6, marginBottom: values.length > 0 ? 8 : 0 }}>
        {values.map((value, i) => (
          <span key={`${value}-${i}`} className="badge">
            {value}
            <button
              className="btn-icon"
              style={{ border: 'none', background: 'none', padding: '0 0 0 2px' }}
              onClick={() => onChange(values.filter((_, index) => index !== i))}
              aria-label={`Retirer ${value}`}
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
        <input
          type="text"
          value={draft}
          aria-label={ariaLabel ?? 'Nouvelle valeur'}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button className="btn-sm" onClick={add} disabled={draft.trim().length === 0}>
          Ajouter
        </button>
      </div>
    </div>
  );
}

/** Bascule clair / sombre, mémorisée d'une session à l'autre. */
export function ThemeToggle() {
  const [theme, setTheme] = useState<'light' | 'dark' | 'auto'>(() => {
    const saved = readSetting('theme');
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  });

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    writeSetting('theme', theme);
  }, [theme]);

  const next = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
  const Icon = theme === 'auto' ? IconAuto : theme === 'light' ? IconSun : IconMoon;
  const labels = { auto: 'Thème système', light: 'Thème clair', dark: 'Thème sombre' };

  return (
    <button
      className="btn-icon"
      onClick={() => setTheme(next)}
      title={labels[theme]}
      aria-label={labels[theme]}
    >
      <Icon size={18} />
    </button>
  );
}
