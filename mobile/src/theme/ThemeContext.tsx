import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { ThemeColors, ThemeVariant, resolveTheme } from '../tokens/themes';

const STORAGE_KEY_THEME = 'tracknotes:theme';
const STORAGE_KEY_AUTO_DARK = 'tracknotes:autoDark';

export interface ThemeContextValue {
  /** Current (effective) theme variant */
  themeVariant: ThemeVariant;
  /** Manually set the theme variant (disables auto dark mode) */
  setThemeVariant: (variant: ThemeVariant) => void;

  /** Whether the theme follows the system light/dark preference */
  autoDarkMode: boolean;
  /** Toggle auto dark mode */
  setAutoDarkMode: (enabled: boolean) => void;

  /** Resolved theme colors for the current variant */
  colors: ThemeColors;

  /** Whether the current theme is dark */
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemColorScheme = useColorScheme();
  const [manualTheme, setManualTheme] = useState<ThemeVariant | null>(null);
  const [autoDarkMode, setAutoDarkModeState] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Load persisted preferences
  useEffect(() => {
    (async () => {
      const [savedTheme, savedAutoDark] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY_THEME),
        AsyncStorage.getItem(STORAGE_KEY_AUTO_DARK),
      ]);
      if (savedAutoDark !== null) {
        setAutoDarkModeState(savedAutoDark === 'true');
      }
      if (savedTheme === 'light' || savedTheme === 'dark') {
        setManualTheme(savedTheme);
      }
      setLoaded(true);
    })();
  }, []);

  const setThemeVariant = useCallback((variant: ThemeVariant) => {
    setManualTheme(variant);
    setAutoDarkModeState(false);
    AsyncStorage.setItem(STORAGE_KEY_THEME, variant);
    AsyncStorage.setItem(STORAGE_KEY_AUTO_DARK, 'false');
  }, []);

  const setAutoDarkMode = useCallback((enabled: boolean) => {
    setAutoDarkModeState(enabled);
    if (enabled) {
      setManualTheme(null);
      AsyncStorage.removeItem(STORAGE_KEY_THEME);
    }
    AsyncStorage.setItem(STORAGE_KEY_AUTO_DARK, String(enabled));
  }, []);

  // Resolve the effective theme variant
  const themeVariant = useMemo((): ThemeVariant => {
    if (manualTheme && !autoDarkMode) return manualTheme;
    // Auto dark mode: follow system
    return systemColorScheme === 'dark' ? 'dark' : 'light';
  }, [manualTheme, autoDarkMode, systemColorScheme]);

  const colors = useMemo(() => resolveTheme(themeVariant), [themeVariant]);
  const isDark = themeVariant === 'dark';

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeVariant,
      setThemeVariant,
      autoDarkMode,
      setAutoDarkMode,
      colors,
      isDark,
    }),
    [themeVariant, setThemeVariant, autoDarkMode, setAutoDarkMode, colors, isDark],
  );

  // Don't render until preferences are loaded to avoid a theme flash
  if (!loaded) return null;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
