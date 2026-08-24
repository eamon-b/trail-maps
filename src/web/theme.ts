/**
 * Site-wide theme (light / dark / follow-system).
 *
 * The resolved theme lives on `<html data-theme="light|dark">` and the user's
 * stored choice on `<html data-theme-pref="system|light|dark">`. A small inline
 * script in each page's `<head>` sets both before first paint so there is no
 * flash of the wrong theme; this module keeps them in sync afterwards and
 * renders the toggle button into any `[data-theme-toggle]` slot.
 *
 * Canvas/Chart renderers cannot use CSS variables directly, so they read colors
 * with `themeColor()` and redraw when `onThemeChange()` fires.
 */

export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'trail-maps-theme';
const THEME_CHANGE_EVENT = 'trail-maps:themechange';
const PREFERENCES: ThemePreference[] = ['system', 'light', 'dark'];

const LABELS: Record<ThemePreference, string> = {
  system: 'Theme: system',
  light: 'Theme: light',
  dark: 'Theme: dark',
};

/** Reads the stored preference, falling back to 'system' (also when storage is unavailable). */
export function getPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && (PREFERENCES as string[]).includes(stored)) {
      return stored as ThemePreference;
    }
  } catch {
    // Private browsing / storage disabled — fall through to the default.
  }
  return 'system';
}

function systemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** The theme actually shown for a given preference. */
export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === 'system' ? systemTheme() : preference;
}

/** The next preference in the System → Light → Dark → System cycle. */
export function nextPreference(preference: ThemePreference): ThemePreference {
  const index = PREFERENCES.indexOf(preference);
  return PREFERENCES[(index + 1) % PREFERENCES.length];
}

/** Applies a preference to `<html>` and notifies listeners. Does not persist it. */
export function applyTheme(preference: ThemePreference): ResolvedTheme {
  const theme = resolveTheme(preference);
  const root = document.documentElement;
  root.dataset.themePref = preference;
  root.dataset.theme = theme;

  for (const button of document.querySelectorAll<HTMLElement>('.theme-toggle')) {
    button.setAttribute('aria-label', LABELS[preference]);
    button.setAttribute('title', `${LABELS[preference]} — click to change`);
  }

  window.dispatchEvent(new CustomEvent<ResolvedTheme>(THEME_CHANGE_EVENT, { detail: theme }));
  return theme;
}

/** Applies a preference and stores it for future visits. */
export function setPreference(preference: ThemePreference): ResolvedTheme {
  try {
    if (preference === 'system') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, preference);
    }
  } catch {
    // Storage is best-effort; the theme still applies for this page view.
  }
  return applyTheme(preference);
}

/** Subscribes to theme changes. Returns an unsubscribe function. */
export function onThemeChange(listener: (theme: ResolvedTheme) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<ResolvedTheme>).detail);
  window.addEventListener(THEME_CHANGE_EVENT, handler);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, handler);
}

/**
 * Resolves a CSS custom property from `<html>` — the bridge between the CSS
 * theme tokens and canvas drawing code.
 */
export function themeColor(name: string, fallback = '#000000'): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const ICONS: Record<ThemePreference, string> = {
  // Monitor
  system: '<path d="M3 5.5A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 14.5v-9Z"/><path d="M8.5 20h7M12 16v4"/>',
  // Sun
  light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M19.1 4.9l-1.8 1.8M6.7 17.3l-1.8 1.8"/>',
  // Moon
  dark: '<path d="M20 13.3A8.2 8.2 0 0 1 10.7 4a8.2 8.2 0 1 0 9.3 9.3Z"/>',
};

function createToggle(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'theme-toggle';
  button.innerHTML = PREFERENCES.map(
    pref =>
      `<svg class="theme-icon theme-icon-${pref}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[pref]}</svg>`,
  ).join('');
  button.addEventListener('click', () => setPreference(nextPreference(getPreference())));
  return button;
}

let initialized = false;

/** Renders the toggle(s) and keeps the page in sync with the stored preference. */
export function initTheme(): void {
  if (initialized) return;
  initialized = true;

  for (const slot of document.querySelectorAll<HTMLElement>('[data-theme-toggle]')) {
    slot.replaceChildren(createToggle());
  }

  applyTheme(getPreference());

  // Follow the OS while the preference is 'system'.
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getPreference() === 'system') applyTheme('system');
    });
  }

  // Keep other tabs of the site in sync.
  window.addEventListener('storage', event => {
    if (event.key === STORAGE_KEY || event.key === null) applyTheme(getPreference());
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTheme, { once: true });
  } else {
    initTheme();
  }
}
