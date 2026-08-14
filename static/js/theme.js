// Theme + layout variables applied to the <html> element.

import { S } from './store.js';

export const ACCENTS = ['indigo', 'lantern', 'neon', 'cyan', 'magenta',
  'blue', 'teal', 'green', 'amber', 'rose', 'violet', 'slate'];

/** Every theme, with whether it is dark — used for the `system` mapping. */
export const THEMES = [
  { id: 'dark',     label: 'Lantern',  dark: true,  swatch: '#0e0d11' },
  { id: 'midnight', label: 'Midnight', dark: true,  swatch: '#080b14' },
  { id: 'cyber',    label: 'Cyber',    dark: true,  swatch: '#07070a' },
  { id: 'carbon',   label: 'Carbon',   dark: true,  swatch: '#0d0d0d' },
  { id: 'ember',    label: 'Ember',    dark: true,  swatch: '#141010' },
  { id: 'void',     label: 'Void',     dark: true,  swatch: '#000000' },
  { id: 'light',    label: 'Paper',    dark: false, swatch: '#fdfcfb' },
  { id: 'mist',     label: 'Mist',     dark: false, swatch: '#f7f9fc' },
  { id: 'sepia',    label: 'Sepia',    dark: false, swatch: '#f7f2e8' },
];
export const isDarkTheme = (id) => THEMES.find((t) => t.id === id)?.dark ?? true;

const media = window.matchMedia('(prefers-color-scheme: dark)');

export function resolvedTheme() {
  const pref = S.settings?.theme || 'dark';
  if (pref === 'system') return media.matches ? 'dark' : 'light';
  return THEMES.some((t) => t.id === pref) ? pref : 'dark';
}

export function applyTheme() {
  const root = document.documentElement;
  const settings = S.settings || {};
  const theme = resolvedTheme();
  root.dataset.theme = theme;
  // Light themes need more than a palette: syntax colours, the lens, the modal
  // overlay and a few tag colours all have to flip. Those used to be keyed on
  // [data-theme="light"], so Mist — the *other* light theme — silently inherited
  // dark syntax highlighting on a near-white background. Keyed on lightness now,
  // so any light theme gets them.
  if (isDarkTheme(theme)) delete root.dataset.light;
  else root.dataset.light = 'true';
  root.dataset.accent = ACCENTS.includes(settings.accent) ? settings.accent : 'indigo';
  root.dataset.density = settings.density === 'compact' ? 'compact' : 'comfortable';
  root.dataset.width = settings.bubble_width || 'normal';
  root.style.setProperty('--fs', `${settings.font_size || 15}px`);

  const icon = document.querySelector('#theme-icon');
  if (icon) {
    icon.innerHTML = isDarkTheme(resolvedTheme())
      ? '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>'
      : '<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  }
}

/** Follow the OS when the user picked "system". */
media.addEventListener('change', () => {
  if (S.settings?.theme === 'system') applyTheme();
});
