// =============================================================================
// Avatar Utilities — types, RNG, color helpers, trait generation
//
// Extracted from BotAvatar.tsx for file size management.
// Pure functions with no React dependencies.
// =============================================================================

// ── Types ──

export interface AvatarProps {
  botId: string;
  bodyColor: string;
  tier: number;        // 0-5 (maps to evolution stage)
  status: 'running' | 'stopped' | 'paused' | 'error';
  mood?: 'positive' | 'negative' | 'neutral' | 'milestone' | 'proud' | 'focused' | 'excited' | 'shy' | 'tired';
  hunger?: 'satisfied' | 'curious' | 'yearning' | 'starving';
  size?: number;       // render size in px (default 120)
  animate?: boolean;   // enable idle animations (default true)
  speciesSeed?: string; // override botId for trait generation (species_seed from avatar_config)
}

export interface CreatureTraits {
  bodyShape: 'round' | 'oval' | 'bean' | 'pear' | 'squish' | 'tall' | 'chonk' | 'teardrop' | 'blob' | 'loaf' | 'nuggie';
  earStyle: 'round' | 'pointed' | 'floppy' | 'cat' | 'bunny' | 'bear' | 'antennae' | 'horns' | 'tiny' | 'huge' | 'one';
  tailStyle: 'curly' | 'fluffy' | 'thin' | 'stub' | 'pom' | 'spike' | 'spring' | 'fan';
  patternStyle: 'spots' | 'stripes' | 'belly' | 'none' | 'freckles' | 'heart' | 'mustache' | 'bandaid';
  eyeSpacing: number;  // 0.3 - 0.5
  eyeSize: number;     // 0.8 - 1.2 multiplier
  cheekSize: number;   // 0.5 - 1.0 multiplier
}

// ── Seed-based deterministic RNG from bot ID ──

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash);
}

function seededRandom(seed: number, index: number): number {
  const x = Math.sin(seed + index * 9301 + 49297) * 49381;
  return x - Math.floor(x);
}

// ── Color helpers ──

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  return {
    r: parseInt(clean.substring(0, 2), 16) || 100,
    g: parseInt(clean.substring(2, 4), 16) || 100,
    b: parseInt(clean.substring(4, 6), 16) || 200,
  };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${clamp(r).toString(16).padStart(2, '0')}${clamp(g).toString(16).padStart(2, '0')}${clamp(b).toString(16).padStart(2, '0')}`;
}

export function lighten(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

export function darken(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

// ── Creature trait generation ──

export function generateTraits(botId: string): CreatureTraits {
  const seed = hashCode(botId);
  const r = (i: number) => seededRandom(seed, i);

  const bodyShapes: CreatureTraits['bodyShape'][] = ['round', 'oval', 'bean', 'pear', 'squish', 'tall', 'chonk', 'teardrop', 'blob', 'loaf', 'nuggie'];
  const earStyles: CreatureTraits['earStyle'][] = ['round', 'pointed', 'floppy', 'cat', 'bunny', 'bear', 'antennae', 'horns', 'tiny', 'huge', 'one'];
  const tailStyles: CreatureTraits['tailStyle'][] = ['curly', 'fluffy', 'thin', 'stub', 'pom', 'spike', 'spring', 'fan'];
  const patternStyles: CreatureTraits['patternStyle'][] = ['spots', 'stripes', 'belly', 'none', 'freckles', 'heart', 'mustache', 'bandaid'];

  return {
    bodyShape: bodyShapes[Math.floor(r(0) * bodyShapes.length)],
    earStyle: earStyles[Math.floor(r(1) * earStyles.length)],
    tailStyle: tailStyles[Math.floor(r(2) * tailStyles.length)],
    patternStyle: patternStyles[Math.floor(r(3) * patternStyles.length)],
    eyeSpacing: 0.3 + r(4) * 0.2,
    eyeSize: 0.8 + r(5) * 0.4,
    cheekSize: 0.5 + r(6) * 0.5,
  };
}
