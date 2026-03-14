// =============================================================================
// PeerZero color palette — dark theme, scientific/futuristic feel
// =============================================================================

export const colors = {
  // Backgrounds
  bg: {
    primary: '#0A0E1A',    // Deep space navy
    secondary: '#141929',   // Slightly lighter
    card: '#1C2137',        // Card surfaces
    elevated: '#252B44',    // Modals, overlays
  },

  // Text
  text: {
    primary: '#E8ECF4',    // Off-white
    secondary: '#8B93A8',  // Muted
    tertiary: '#5A6178',   // Very muted
    inverse: '#0A0E1A',    // For light backgrounds
  },

  // Accent
  accent: {
    primary: '#6C5CE7',    // Purple — main brand
    secondary: '#00D2FF',  // Cyan — highlights
    success: '#00E676',    // Green — positive
    warning: '#FFD600',    // Yellow — caution
    error: '#FF5252',      // Red — negative
  },

  // Credibility tiers (matches school color scheme)
  tier: {
    newcomer: '#5A6178',
    apprentice: '#6C5CE7',
    tested: '#00D2FF',
    verified: '#00E676',
    distinguished: '#FFD600',
    master: '#FF6B35',
  },

  // Mood colors for activity feed
  mood: {
    positive: '#00E676',
    negative: '#FF5252',
    neutral: '#8B93A8',
    milestone: '#FFD600',
  },

  // Borders
  border: '#2A3050',
} as const;
