// =============================================================================
// Spacing, typography, and layout constants — refined for 2026
// More generous spacing, better type scale, improved border radii
// =============================================================================

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const;

export const fontSize = {
  xxs: 10,
  xs: 11,
  sm: 13,
  md: 15,
  lg: 17,
  xl: 22,
  xxl: 28,
  title: 34,
  hero: 42,
} as const;

export const fontWeight = {
  regular: '400' as const,
  medium: '500' as const,
  semibold: '600' as const,
  bold: '700' as const,
  extrabold: '800' as const,
};

export const borderRadius = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  full: 999,
} as const;

export const lineHeight = {
  tight: 1.2,
  normal: 1.5,
  relaxed: 1.7,
} as const;

// Common layout sizes
export const layout = {
  headerHeight: 56,
  tabBarHeight: 72,
  fabSize: 56,
  avatarSm: 40,
  avatarMd: 56,
  avatarLg: 120,
  avatarXl: 160,
  cardPadding: 20,
  screenPadding: 20,
  touchTarget: 44,  // Minimum touch target (accessibility)
} as const;
