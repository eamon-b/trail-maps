import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppMode, ThemeColors, ThemeVariant, resolveTheme } from '../tokens/themes';

const STORAGE_KEY_THEME = 'trail-companion:theme';
const STORAGE_KEY_MODE = 'trail-companion:mode';
const STORAGE_KEY_AUTO_DARK = 'trail-companion:autoDark';
const STORAGE_KEY_NIGHT_RED = 'trail-companion:nightRed';
const STORAGE_KEY_HIGH_CONTRAST = 'trail-companion:highContrast';

export interface ThemeContextValue {
  /** Current application mode */
  mode: AppMode;
  /** Set the application mode */
  setMode: (mode: AppMode) => void;

  /** Current theme variant */
  themeVariant: ThemeVariant;
  /** Manually set theme variant (disables auto dark mode) */
  setThemeVariant: (variant: ThemeVariant) => void;

  /** Whether dark mode follows system preference */
  autoDarkMode: boolean;
  /** Toggle auto dark mode */
  setAutoDarkMode: (enabled: boolean) => void;

  /** Whether night red mode is active (independent of dark mode) */
  nightRedEnabled: boolean;
  /** Toggle night red mode */
  setNightRedEnabled: (enabled: boolean) => void;

  /** Resolved theme colors for the current mode + theme combination */
  colors: ThemeColors;

  /** Whether the current theme is dark (dark, oled, or nightRed) */
  isDark: boolean;

  /** Whether high contrast mode is active (thicker borders, solid backgrounds) */
  highContrast: boolean;
  /** Toggle high contrast mode */
  setHighContrast: (enabled: boolean) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const systemColorScheme = useColorScheme();
  const [mode, setModeState] = useState<AppMode>('plan');
  const [manualTheme, setManualTheme] = useState<ThemeVariant | null>(null);
  const [autoDarkMode, setAutoDarkModeState] = useState(true);
  const [nightRedEnabled, setNightRedEnabledState] = useState(false);
  const [highContrast, setHighContrastState] = useState(false);
  const [loaded, setLoaded] = useState(false);

  // Load persisted preferences
  useEffect(() => {
    (async () => {
      const [savedTheme, savedMode, savedAutoDark, savedNightRed, savedHighContrast] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEY_THEME),
        AsyncStorage.getItem(STORAGE_KEY_MODE),
        AsyncStorage.getItem(STORAGE_KEY_AUTO_DARK),
        AsyncStorage.getItem(STORAGE_KEY_NIGHT_RED),
        AsyncStorage.getItem(STORAGE_KEY_HIGH_CONTRAST),
      ]);
      if (savedMode && ['plan', 'hike', 'contribute'].includes(savedMode)) {
        setModeState(savedMode as AppMode);
      }
      if (savedAutoDark !== null) {
        setAutoDarkModeState(savedAutoDark === 'true');
      }
      if (savedNightRed === 'true') {
        setNightRedEnabledState(true);
      }
      if (savedHighContrast === 'true') {
        setHighContrastState(true);
      }
      if (savedTheme && ['light', 'dark', 'oled', 'nightRed'].includes(savedTheme)) {
        setManualTheme(savedTheme as ThemeVariant);
      }
      setLoaded(true);
    })();
  }, []);

  const setMode = useCallback((newMode: AppMode) => {
    setModeState(newMode);
    AsyncStorage.setItem(STORAGE_KEY_MODE, newMode);
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

  const setNightRedEnabled = useCallback((enabled: boolean) => {
    setNightRedEnabledState(enabled);
    AsyncStorage.setItem(STORAGE_KEY_NIGHT_RED, String(enabled));
  }, []);

  const setHighContrast = useCallback((enabled: boolean) => {
    setHighContrastState(enabled);
    AsyncStorage.setItem(STORAGE_KEY_HIGH_CONTRAST, String(enabled));
  }, []);

  // Resolve the effective theme variant
  const themeVariant = useMemo((): ThemeVariant => {
    if (nightRedEnabled) return 'nightRed';
    if (manualTheme && !autoDarkMode) return manualTheme;
    // Auto dark mode: follow system
    return systemColorScheme === 'dark' ? 'dark' : 'light';
  }, [nightRedEnabled, manualTheme, autoDarkMode, systemColorScheme]);

  const colors = useMemo(() => resolveTheme(themeVariant, mode), [themeVariant, mode]);

  const isDark = themeVariant !== 'light';

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      setMode,
      themeVariant,
      setThemeVariant,
      autoDarkMode,
      setAutoDarkMode,
      nightRedEnabled,
      setNightRedEnabled,
      colors,
      isDark,
      highContrast,
      setHighContrast,
    }),
    [mode, setMode, themeVariant, setThemeVariant, autoDarkMode, setAutoDarkMode, nightRedEnabled, setNightRedEnabled, colors, isDark, highContrast, setHighContrast],
  );

  // Don't render until preferences are loaded to avoid flash
  if (!loaded) return null;

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
