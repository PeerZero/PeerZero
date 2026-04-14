// =============================================================================
// PeerZero color palette — refined dark theme, scientific/futuristic feel
// Updated 2026 — better contrast, refined accents, glass-morphism ready
// =============================================================================

export const colors = {
  // Backgrounds — deeper, richer darks with better layering
  bg: {
    primary: '#080C18',      // Deep space navy (darker for contrast)
    secondary: '#0E1424',    // Card backgrounds, secondary surfaces
    card: '#141C30',         // Card surfaces — slightly warmer
    elevated: '#1C2640',     // Modals, overlays, popovers
    glass: 'rgba(14, 20, 36, 0.85)', // Glass-morphism base
  },

  // Text — improved contrast ratios (WCAG AA compliant)
  text: {
    primary: '#EAF0FA',     // Near-white with slight blue tone
    secondary: '#8B95B0',   // Muted — readable on dark bg
    tertiary: '#6B7A9A',    // Subtle labels, timestamps (WCAG AA 4.5:1 on #080C18)
    inverse: '#080C18',     // For use on light/accent backgrounds
    accent: '#38F5B5',      // For text that needs to pop (sparingly)
  },

  // Accent — refined, less neon, more sophisticated
  accent: {
    primary: '#7C6CF0',     // Rich purple — main brand (slightly warmer)
    secondary: '#38CFFF',   // Bright cyan — highlights, links
    success: '#34D399',     // Emerald green — success states
    warning: '#FBBF24',     // Amber — warnings, caution
    error: '#F87171',       // Soft red — errors, destructive
    glow: '#7C6CF020',      // Subtle brand glow for shadows
  },

  // Credibility tiers — progression feels natural
  tier: {
    newcomer: '#4D5A78',    // Gray — just started
    apprentice: '#7C6CF0',  // Purple — brand color
    tested: '#38CFFF',      // Cyan — proving themselves
    verified: '#34D399',    // Green — established credibility
    distinguished: '#FBBF24', // Gold — high achiever
    master: '#F97316',      // Orange — graduated master
  },

  // Mood colors for activity feed — clearer emotional coding
  mood: {
    positive: '#34D399',
    negative: '#F87171',
    neutral: '#8B95B0',
    milestone: '#FBBF24',
    proud: '#F97316',
    focused: '#38CFFF',
    excited: '#7C6CF0',
    shy: '#4D5A78',
    tired: '#4D5A78',
  },

  // Borders — subtle, layered
  border: '#1E2A44',        // Primary border
  borderLight: '#2A3858',   // Elevated border (cards, inputs on focus)

  // Gradients (as string pairs for LinearGradient)
  gradient: {
    brand: ['#7C6CF0', '#38CFFF'] as [string, string],
    success: ['#34D399', '#38CFFF'] as [string, string],
    warm: ['#F97316', '#FBBF24'] as [string, string],
    card: ['rgba(124, 108, 240, 0.06)', 'rgba(56, 207, 255, 0.03)'] as [string, string],
  },

  // Shadows
  shadow: {
    card: '#00000040',
    glow: '#7C6CF030',
    success: '#34D39930',
    error: '#F8717130',
  },
} as const;
