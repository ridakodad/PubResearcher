import { useEffect, useState } from 'react';
import { readSetting, writeSetting } from '../lib/storage';
import { IconAuto, IconMoon, IconSun } from './icons';

type Theme = 'light' | 'dark' | 'auto';

const LABELS: Record<Theme, string> = { auto: 'Thème du système', light: 'Thème clair', dark: 'Thème sombre' };

/** Bascule système / clair / sombre, mémorisée d'une visite à l'autre (même réglage que l'application). */
export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = readSetting('theme');
    return saved === 'light' || saved === 'dark' ? saved : 'auto';
  });

  useEffect(() => {
    if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    writeSetting('theme', theme);
  }, [theme]);

  const next: Theme = theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto';
  const Icon = theme === 'auto' ? IconAuto : theme === 'light' ? IconSun : IconMoon;

  return (
    <button type="button" className="btn-icon" onClick={() => setTheme(next)} title={LABELS[theme]} aria-label={LABELS[theme]}>
      <Icon size={18} />
    </button>
  );
}
