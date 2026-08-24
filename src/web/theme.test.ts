import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  applyTheme,
  getPreference,
  nextPreference,
  onThemeChange,
  resolveTheme,
  setPreference,
  themeColor,
} from './theme';

/** jsdom has no matchMedia, so stand one in that reports a fixed OS preference. */
function mockSystemTheme(prefersDark: boolean): void {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: prefersDark && query.includes('dark'),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe('theme', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-pref');
    mockSystemTheme(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('getPreference', () => {
    it('defaults to system when nothing is stored', () => {
      expect(getPreference()).toBe('system');
    });

    it('reads a stored preference', () => {
      localStorage.setItem('trail-maps-theme', 'dark');
      expect(getPreference()).toBe('dark');
    });

    it('ignores a stored value that is not a known preference', () => {
      localStorage.setItem('trail-maps-theme', 'chartreuse');
      expect(getPreference()).toBe('system');
    });
  });

  describe('resolveTheme', () => {
    it('follows the OS when the preference is system', () => {
      mockSystemTheme(true);
      expect(resolveTheme('system')).toBe('dark');
      mockSystemTheme(false);
      expect(resolveTheme('system')).toBe('light');
    });

    it('ignores the OS when the preference is explicit', () => {
      mockSystemTheme(true);
      expect(resolveTheme('light')).toBe('light');
      mockSystemTheme(false);
      expect(resolveTheme('dark')).toBe('dark');
    });
  });

  describe('nextPreference', () => {
    it('cycles system -> light -> dark -> system', () => {
      expect(nextPreference('system')).toBe('light');
      expect(nextPreference('light')).toBe('dark');
      expect(nextPreference('dark')).toBe('system');
    });
  });

  describe('applyTheme', () => {
    it('writes the resolved theme and the preference onto <html>', () => {
      mockSystemTheme(true);
      applyTheme('system');
      expect(document.documentElement.dataset.theme).toBe('dark');
      expect(document.documentElement.dataset.themePref).toBe('system');

      applyTheme('light');
      expect(document.documentElement.dataset.theme).toBe('light');
      expect(document.documentElement.dataset.themePref).toBe('light');
    });

    it('notifies listeners with the resolved theme', () => {
      const seen: string[] = [];
      const unsubscribe = onThemeChange(theme => seen.push(theme));

      applyTheme('dark');
      applyTheme('light');
      unsubscribe();
      applyTheme('dark');

      expect(seen).toEqual(['dark', 'light']);
    });

    it('labels the toggle button with the current preference', () => {
      const button = document.createElement('button');
      button.className = 'theme-toggle';
      document.body.append(button);

      applyTheme('dark');
      expect(button.getAttribute('aria-label')).toBe('Theme: dark');

      button.remove();
    });
  });

  describe('setPreference', () => {
    it('stores an explicit choice', () => {
      setPreference('dark');
      expect(localStorage.getItem('trail-maps-theme')).toBe('dark');
      expect(getPreference()).toBe('dark');
    });

    it('clears the stored choice when going back to system', () => {
      setPreference('light');
      setPreference('system');
      expect(localStorage.getItem('trail-maps-theme')).toBeNull();
      expect(getPreference()).toBe('system');
    });
  });

  describe('themeColor', () => {
    it('falls back when the custom property is not defined', () => {
      expect(themeColor('--not-a-real-token', '#abcdef')).toBe('#abcdef');
    });

    it('returns the value of a defined custom property', () => {
      document.documentElement.style.setProperty('--chart-line', '#123456');
      expect(themeColor('--chart-line', '#000000')).toBe('#123456');
      document.documentElement.style.removeProperty('--chart-line');
    });
  });
});
