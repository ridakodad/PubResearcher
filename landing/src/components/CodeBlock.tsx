import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconCopy } from './icons';

/**
 * Des commandes à recopier : une barre (nom du bloc, bouton « Copier ») au-dessus du code, que l'on peut parcourir au
 * clavier. Le bouton est dans la barre et non sur le texte : une longue ligne ne passe jamais dessous.
 */
export function CodeBlock({ lines, label, title = 'Terminal' }: { lines: readonly string[]; label: string; title?: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // Presse-papiers refusé : le texte reste sélectionnable à la main.
    }
  }

  return (
    <div className="code-block" role="group" aria-label={label}>
      <div className="code-bar">
        <span>{title}</span>
        <button type="button" className="btn btn-sm code-copy" onClick={copy}>
          {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
          <span>{copied ? 'Copié' : 'Copier'}</span>
        </button>
      </div>
      <pre>
        <code>{lines.join('\n')}</code>
      </pre>
      <span className="sr-only" role="status">
        {copied ? 'Commandes copiées dans le presse-papiers.' : ''}
      </span>
    </div>
  );
}
