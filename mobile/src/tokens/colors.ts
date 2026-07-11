/** Raw color values — all hex constants used throughout the design system */

export const palette = {
  // Neutrals
  white: '#FFFFFF',
  black: '#000000',

  // Grays (iOS system gray scale)
  gray50: '#F2F2F7',
  gray100: '#E5E5EA',
  gray200: '#D1D1D6',
  gray300: '#C7C7CC',
  gray400: '#ABABAB',
  gray500: '#8E8E93',
  gray600: '#666666',
  gray700: '#48484A',
  gray800: '#38383A',
  gray900: '#2C2C2E',
  gray950: '#1C1C1E',

  // Plan mode — Blue
  blue: '#2196F3',
  blueLight: '#64B5F6',
  blueMuted: '#90CAF9',
  blueDark: '#1565C0',
  blueSubtle: '#E3F2FD',

  // Hike mode — Green
  green: '#4CAF50',
  greenLight: '#81C784',
  greenMuted: '#A5D6A7',
  greenDark: '#2E7D32',
  greenSubtle: '#E8F5E9',

  // Contribute mode — Orange
  orange: '#FF9800',
  orangeLight: '#FFB74D',
  orangeMuted: '#FFCC80',
  orangeDark: '#E65100',
  orangeSubtle: '#FFF3E0',

  // Temperature scale (climate cards)
  deepOrange: '#FF5722',
  deepOrangeLight: '#FF8A65',

  // Alert colors — light theme uses WCAG AA compliant (4.5:1 on white) variants
  alertGreenLight: '#188530',
  alertGreenDark: '#30D158',
  alertAmberLight: '#A84B00',
  alertAmberDark: '#FFD60A',
  alertRedLight: '#D32F2F',
  alertRedDark: '#FF453A',

  // Night Red palette
  nightBg: '#1A0000',
  nightSurface: '#2A0A0A',
  nightBorder: '#3A1A1A',
  nightTextPrimary: '#FF6B6B',
  nightTextSecondary: '#CC5555',
  nightAlertGreen: '#FF4444',
  nightAlertAmber: '#FF6B3A',
  nightAlertRed: '#FF2020',

  // Night red-shifted accents (all modes shift toward red at night)
  nightRedAccent: '#FF5252',
  nightRedAccentSubtle: '#3A1515',
  nightRedAccentMuted: '#CC4040',

  // Modal/backdrop scrim (theme-independent translucent black)
  scrim: 'rgba(0, 0, 0, 0.5)',
} as const;

export type PaletteColor = typeof palette[keyof typeof palette];
