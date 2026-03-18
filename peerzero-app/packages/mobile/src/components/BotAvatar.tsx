// =============================================================================
// BotAvatar — Procedurally generated SVG creatures that evolve with the bot
//
// Each bot gets a unique creature based on its ID (deterministic seed).
// The creature evolves through 6 stages tied to credibility tiers:
//   Stage 0 (Newcomer)      — tiny, round, vulnerable. Big eyes, no features.
//   Stage 1 (Apprentice)    — small ears appear, blush marks.
//   Stage 2 (Tested)        — antenna/horn nubs, slightly larger body.
//   Stage 3 (Verified)      — full ears, tail, body pattern markings.
//   Stage 4 (Distinguished) — crown/halo, glowing aura, expressive face.
//   Stage 5 (Master)        — final form with wings, complex patterns, sparkles.
//
// Expressions react to the bot's current mood/status:
//   running  → happy, eyes open, slight bounce
//   stopped  → sleeping, closed eyes, zzz
//   paused   → curious, tilted head
//   error    → distressed, wavy mouth, sweat drop
//
// Body color comes from avatar_config.body_color (user-chosen at creation).
// Shape/species is deterministic from bot ID, so every bot is unique but stable.
// =============================================================================

import React, { useEffect, useRef } from 'react';
import { Animated, View, StyleSheet } from 'react-native';
import Svg, {
  Circle, Ellipse, Path, G, Defs, RadialGradient, Stop,
  LinearGradient, Rect,
} from 'react-native-svg';

// ── Types ──

export interface AvatarProps {
  botId: string;
  bodyColor: string;
  tier: number;        // 0-5 (maps to evolution stage)
  status: 'running' | 'stopped' | 'paused' | 'error';
  mood?: 'positive' | 'negative' | 'neutral' | 'milestone';
  hunger?: 'satisfied' | 'curious' | 'yearning' | 'starving';
  size?: number;       // render size in px (default 120)
  animate?: boolean;   // enable idle animations (default true)
  speciesSeed?: string; // override botId for trait generation (species_seed from avatar_config)
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

function lighten(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount);
}

function darken(hex: string, amount: number): string {
  const { r, g, b } = hexToRgb(hex);
  return rgbToHex(r * (1 - amount), g * (1 - amount), b * (1 - amount));
}

// ── Creature trait generation ──

interface CreatureTraits {
  bodyShape: 'round' | 'oval' | 'bean' | 'pear';
  earStyle: 'round' | 'pointed' | 'floppy' | 'cat';
  tailStyle: 'curly' | 'fluffy' | 'thin' | 'stub';
  patternStyle: 'spots' | 'stripes' | 'belly' | 'none';
  eyeSpacing: number;  // 0.3 - 0.5
  eyeSize: number;     // 0.8 - 1.2 multiplier
  cheekSize: number;   // 0.5 - 1.0 multiplier
}

function generateTraits(botId: string): CreatureTraits {
  const seed = hashCode(botId);
  const r = (i: number) => seededRandom(seed, i);

  const bodyShapes: CreatureTraits['bodyShape'][] = ['round', 'oval', 'bean', 'pear'];
  const earStyles: CreatureTraits['earStyle'][] = ['round', 'pointed', 'floppy', 'cat'];
  const tailStyles: CreatureTraits['tailStyle'][] = ['curly', 'fluffy', 'thin', 'stub'];
  const patternStyles: CreatureTraits['patternStyle'][] = ['spots', 'stripes', 'belly', 'none'];

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

// ── SVG Creature Parts ──

function renderBody(
  traits: CreatureTraits,
  color: string,
  tier: number,
): React.ReactElement {
  const lightColor = lighten(color, 0.3);
  // Body gets slightly larger with tier, but capped to stay within viewBox
  // At tier 5 (max), sizeBonus = 6. This keeps all shapes within the safe zone
  // (roughly x: 12-88, y: 18-84) leaving room for ears, crown, feet.
  const sizeBonus = Math.min(tier, 5) * 1.2;

  const cx = 50;
  const cy = 50;

  switch (traits.bodyShape) {
    case 'round':
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.4" cy="0.35" r="0.6">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Circle cx={cx} cy={cy} r={28 + sizeBonus} fill="url(#bodyGrad)" />
          {/* Belly highlight */}
          <Ellipse cx={cx} cy={cy + 4} rx={16 + sizeBonus * 0.4} ry={18 + sizeBonus * 0.4} fill={lightColor} opacity={0.4} />
        </G>
      );
    case 'oval':
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.4" cy="0.35" r="0.6">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Ellipse cx={cx} cy={cy + 2} rx={22 + sizeBonus} ry={26 + sizeBonus} fill="url(#bodyGrad)" />
          <Ellipse cx={cx} cy={cy + 6} rx={13 + sizeBonus * 0.3} ry={15 + sizeBonus * 0.3} fill={lightColor} opacity={0.4} />
        </G>
      );
    case 'bean': {
      // Bean shape: wider at bottom, narrower at top, with a slight indent on left
      const w = 24 + sizeBonus;
      const h = 28 + sizeBonus;
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.4" cy="0.35" r="0.6">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Path
            d={`M ${cx} ${cy - h}
                C ${cx + w * 0.9} ${cy - h}, ${cx + w} ${cy - h * 0.4}, ${cx + w} ${cy}
                C ${cx + w} ${cy + h * 0.5}, ${cx + w * 0.6} ${cy + h}, ${cx} ${cy + h}
                C ${cx - w * 0.6} ${cy + h}, ${cx - w} ${cy + h * 0.5}, ${cx - w} ${cy + 2}
                C ${cx - w} ${cy - h * 0.3}, ${cx - w * 0.7} ${cy - h}, ${cx} ${cy - h}
                Z`}
            fill="url(#bodyGrad)"
          />
          <Ellipse cx={cx + 1} cy={cy + 4} rx={13 + sizeBonus * 0.3} ry={15 + sizeBonus * 0.3} fill={lightColor} opacity={0.35} />
        </G>
      );
    }
    case 'pear':
    default: {
      // Pear: narrow top, wide bottom. Cute bottom-heavy shape.
      const pw = 24 + sizeBonus;
      const ph = 26 + sizeBonus;
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.4" cy="0.35" r="0.6">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Path
            d={`M ${cx} ${cy - ph}
                C ${cx + pw * 0.6} ${cy - ph}, ${cx + pw * 0.7} ${cy - ph * 0.3}, ${cx + pw * 0.8} ${cy}
                C ${cx + pw} ${cy + ph * 0.4}, ${cx + pw * 0.5} ${cy + ph}, ${cx} ${cy + ph}
                C ${cx - pw * 0.5} ${cy + ph}, ${cx - pw} ${cy + ph * 0.4}, ${cx - pw * 0.8} ${cy}
                C ${cx - pw * 0.7} ${cy - ph * 0.3}, ${cx - pw * 0.6} ${cy - ph}, ${cx} ${cy - ph}
                Z`}
            fill="url(#bodyGrad)"
          />
          <Ellipse cx={cx} cy={cy + 6} rx={14 + sizeBonus * 0.3} ry={14 + sizeBonus * 0.3} fill={lightColor} opacity={0.35} />
        </G>
      );
    }
  }
}

function renderEars(
  traits: CreatureTraits,
  color: string,
  tier: number,
): React.ReactElement | null {
  if (tier < 1) return null; // No ears at stage 0 — tiny vulnerable baby

  const earColor = darken(color, 0.1);
  const innerColor = lighten(color, 0.4);
  const earScale = tier >= 3 ? 1.2 : tier >= 2 ? 1.0 : 0.7; // Ears grow with tier

  switch (traits.earStyle) {
    case 'round':
      return (
        <G>
          <Circle cx={32} cy={24} r={10 * earScale} fill={earColor} />
          <Circle cx={32} cy={24} r={6 * earScale} fill={innerColor} opacity={0.6} />
          <Circle cx={68} cy={24} r={10 * earScale} fill={earColor} />
          <Circle cx={68} cy={24} r={6 * earScale} fill={innerColor} opacity={0.6} />
        </G>
      );
    case 'pointed':
      return (
        <G>
          <Path d={`M 28 ${32 - 2 * earScale} L ${26 - 4 * earScale} ${14 - 6 * earScale} L ${38 + 2 * earScale} ${28 - 2 * earScale} Z`} fill={earColor} />
          <Path d={`M 30 ${30 - 2 * earScale} L ${28 - 2 * earScale} ${18 - 4 * earScale} L ${36 + earScale} ${28 - earScale} Z`} fill={innerColor} opacity={0.5} />
          <Path d={`M 72 ${32 - 2 * earScale} L ${74 + 4 * earScale} ${14 - 6 * earScale} L ${62 - 2 * earScale} ${28 - 2 * earScale} Z`} fill={earColor} />
          <Path d={`M 70 ${30 - 2 * earScale} L ${72 + 2 * earScale} ${18 - 4 * earScale} L ${64 - earScale} ${28 - earScale} Z`} fill={innerColor} opacity={0.5} />
        </G>
      );
    case 'floppy': {
      // Floppy ears droop down from head level — like a bunny/puppy
      const dropY = 30 + 8 * earScale; // How far down the ear tip goes
      const earW = 8 * earScale;
      return (
        <G>
          {/* Left floppy ear */}
          <Path
            d={`M 34 26 Q ${26 - earW} 24, ${22 - earW} ${dropY} Q ${20 - earW} ${dropY + 6}, ${24 - earW + 4} ${dropY + 2} Q 30 ${dropY - 4}, 36 30`}
            fill={earColor}
          />
          {/* Right floppy ear */}
          <Path
            d={`M 66 26 Q ${74 + earW} 24, ${78 + earW} ${dropY} Q ${80 + earW} ${dropY + 6}, ${76 + earW - 4} ${dropY + 2} Q 70 ${dropY - 4}, 64 30`}
            fill={earColor}
          />
        </G>
      );
    }
    case 'cat':
    default:
      return (
        <G>
          <Path d={`M 30 30 L ${24 - 4 * earScale} ${12 - 6 * earScale} L 40 ${26 - 2 * earScale} Z`} fill={earColor} />
          <Path d={`M 32 28 L ${27 - 2 * earScale} ${16 - 4 * earScale} L 38 ${26 - earScale} Z`} fill={innerColor} opacity={0.5} />
          <Path d={`M 70 30 L ${76 + 4 * earScale} ${12 - 6 * earScale} L 60 ${26 - 2 * earScale} Z`} fill={earColor} />
          <Path d={`M 68 28 L ${73 + 2 * earScale} ${16 - 4 * earScale} L 62 ${26 - earScale} Z`} fill={innerColor} opacity={0.5} />
        </G>
      );
  }
}

function renderEyes(
  traits: CreatureTraits,
  status: 'running' | 'stopped' | 'paused' | 'error',
  mood: string,
  _tier: number,
): React.ReactElement {
  const spacing = traits.eyeSpacing * 30;
  const baseSize = 5 * traits.eyeSize;
  const cx = 50;
  const cy = 44; // Eyes sit in the upper third of the body (center at 50)
  const leftX = cx - spacing;
  const rightX = cx + spacing;

  // Sleeping (stopped)
  if (status === 'stopped') {
    return (
      <G>
        {/* Closed eyes — cute arcs */}
        <Path d={`M ${leftX - baseSize} ${cy} Q ${leftX} ${cy - baseSize * 0.8} ${leftX + baseSize} ${cy}`} stroke="#2D1B4E" strokeWidth={1.5} fill="none" strokeLinecap="round" />
        <Path d={`M ${rightX - baseSize} ${cy} Q ${rightX} ${cy - baseSize * 0.8} ${rightX + baseSize} ${cy}`} stroke="#2D1B4E" strokeWidth={1.5} fill="none" strokeLinecap="round" />
        {/* Zzz */}
        <Path d={`M 72 32 L 78 32 L 72 38 L 78 38`} stroke="#8B93A8" strokeWidth={1} fill="none" opacity={0.6} />
        <Path d={`M 80 26 L 84 26 L 80 30 L 84 30`} stroke="#8B93A8" strokeWidth={0.8} fill="none" opacity={0.4} />
      </G>
    );
  }

  // Error (distressed)
  if (status === 'error') {
    return (
      <G>
        {/* Worried eyes — X shapes or spirals */}
        <Circle cx={leftX} cy={cy} r={baseSize} fill="white" />
        <Circle cx={rightX} cy={cy} r={baseSize} fill="white" />
        <Circle cx={leftX} cy={cy - 1} r={baseSize * 0.45} fill="#2D1B4E" />
        <Circle cx={rightX} cy={cy - 1} r={baseSize * 0.45} fill="#2D1B4E" />
        {/* Tiny pupils — looking up nervously */}
        <Circle cx={leftX} cy={cy - 2} r={baseSize * 0.2} fill="white" />
        <Circle cx={rightX} cy={cy - 2} r={baseSize * 0.2} fill="white" />
        {/* Sweat drop */}
        <Path d={`M 74 36 Q 76 32 78 36 Q 76 40 74 36`} fill="#00D2FF" opacity={0.6} />
      </G>
    );
  }

  // Paused (curious — one eye slightly bigger, head tilt implied)
  if (status === 'paused') {
    return (
      <G>
        <Circle cx={leftX} cy={cy} r={baseSize * 1.1} fill="white" />
        <Circle cx={rightX} cy={cy} r={baseSize * 0.9} fill="white" />
        <Circle cx={leftX + 0.5} cy={cy} r={baseSize * 0.5} fill="#2D1B4E" />
        <Circle cx={rightX + 0.5} cy={cy} r={baseSize * 0.4} fill="#2D1B4E" />
        <Circle cx={leftX + 1} cy={cy - 1} r={baseSize * 0.2} fill="white" />
        <Circle cx={rightX + 1} cy={cy - 1} r={baseSize * 0.15} fill="white" />
        {/* Question mark */}
        <Path d={`M 72 28 Q 76 24 76 28 Q 76 31 73 32`} stroke="#8B93A8" strokeWidth={1} fill="none" opacity={0.5} />
        <Circle cx={73} cy={35} r={0.8} fill="#8B93A8" opacity={0.5} />
      </G>
    );
  }

  // Running (happy — default alive state)
  const isHappy = mood === 'positive' || mood === 'milestone';
  const isSad = mood === 'negative';

  return (
    <G>
      {/* Eye whites */}
      <Circle cx={leftX} cy={cy} r={baseSize} fill="white" />
      <Circle cx={rightX} cy={cy} r={baseSize} fill="white" />
      {/* Pupils */}
      <Circle cx={leftX + (isHappy ? 0.5 : 0)} cy={cy + (isSad ? 1 : 0)} r={baseSize * 0.5} fill="#2D1B4E" />
      <Circle cx={rightX + (isHappy ? 0.5 : 0)} cy={cy + (isSad ? 1 : 0)} r={baseSize * 0.5} fill="#2D1B4E" />
      {/* Sparkle/light reflection */}
      <Circle cx={leftX + baseSize * 0.25} cy={cy - baseSize * 0.25} r={baseSize * 0.18} fill="white" />
      <Circle cx={rightX + baseSize * 0.25} cy={cy - baseSize * 0.25} r={baseSize * 0.18} fill="white" />
      {/* Happy eyes: upward arc smile-eyes instead of round eyes */}
      {isHappy && (
        <G>
          {/* Draw happy arc lines over the pupils to create ^ ^ effect */}
          <Path
            d={`M ${leftX - baseSize * 0.7} ${cy + baseSize * 0.1} Q ${leftX} ${cy - baseSize * 0.6} ${leftX + baseSize * 0.7} ${cy + baseSize * 0.1}`}
            stroke="#2D1B4E" strokeWidth={1.5} fill="none" strokeLinecap="round"
          />
          <Path
            d={`M ${rightX - baseSize * 0.7} ${cy + baseSize * 0.1} Q ${rightX} ${cy - baseSize * 0.6} ${rightX + baseSize * 0.7} ${cy + baseSize * 0.1}`}
            stroke="#2D1B4E" strokeWidth={1.5} fill="none" strokeLinecap="round"
          />
        </G>
      )}
    </G>
  );
}

function renderMouth(
  status: 'running' | 'stopped' | 'paused' | 'error',
  mood: string,
): React.ReactElement {
  const cx = 50;
  const cy = 54; // Below eyes (at 44), centered in lower face area

  if (status === 'stopped') {
    // Tiny sleeping mouth — small oval
    return <Ellipse cx={cx} cy={cy + 1} rx={2} ry={1.5} fill="#2D1B4E" opacity={0.4} />;
  }

  if (status === 'error') {
    // Wavy distressed mouth
    return (
      <Path
        d={`M ${cx - 5} ${cy + 1} Q ${cx - 2.5} ${cy + 4} ${cx} ${cy + 1} Q ${cx + 2.5} ${cy - 2} ${cx + 5} ${cy + 1}`}
        stroke="#2D1B4E"
        strokeWidth={1.2}
        fill="none"
        strokeLinecap="round"
      />
    );
  }

  if (status === 'paused') {
    // Small "o" mouth
    return <Ellipse cx={cx} cy={cy + 1} rx={2.5} ry={3} fill="#2D1B4E" opacity={0.5} />;
  }

  // Running — mood-based mouth
  const isHappy = mood === 'positive' || mood === 'milestone';
  const isSad = mood === 'negative';

  if (isHappy) {
    // Big smile with open mouth
    return (
      <G>
        <Path
          d={`M ${cx - 6} ${cy} Q ${cx} ${cy + 8} ${cx + 6} ${cy}`}
          fill="#2D1B4E"
          opacity={0.6}
        />
        {/* Tongue */}
        <Path
          d={`M ${cx - 2} ${cy + 4} Q ${cx} ${cy + 6.5} ${cx + 2} ${cy + 4}`}
          fill="#FF8A8A"
          opacity={0.7}
        />
      </G>
    );
  }

  if (isSad) {
    // Slight frown
    return (
      <Path
        d={`M ${cx - 4} ${cy + 2} Q ${cx} ${cy - 1} ${cx + 4} ${cy + 2}`}
        stroke="#2D1B4E"
        strokeWidth={1.2}
        fill="none"
        strokeLinecap="round"
        opacity={0.5}
      />
    );
  }

  // Neutral — small smile
  return (
    <Path
      d={`M ${cx - 4} ${cy} Q ${cx} ${cy + 4} ${cx + 4} ${cy}`}
      stroke="#2D1B4E"
      strokeWidth={1.2}
      fill="none"
      strokeLinecap="round"
      opacity={0.5}
    />
  );
}

function renderCheeks(traits: CreatureTraits, color: string): React.ReactElement {
  const cheekColor = lighten(color, 0.2);
  const size = 4 * traits.cheekSize;
  // Cheeks sit just below and outside the eyes
  const cheekY = 49;
  return (
    <G>
      <Ellipse cx={50 - traits.eyeSpacing * 30 - 3} cy={cheekY} rx={size} ry={size * 0.7} fill={cheekColor} opacity={0.35} />
      <Ellipse cx={50 + traits.eyeSpacing * 30 + 3} cy={cheekY} rx={size} ry={size * 0.7} fill={cheekColor} opacity={0.35} />
    </G>
  );
}

function renderTail(
  traits: CreatureTraits,
  color: string,
  tier: number,
): React.ReactElement | null {
  if (tier < 3) return null; // No tail until Verified

  const tailColor = darken(color, 0.15);

  switch (traits.tailStyle) {
    case 'curly':
      return (
        <Path
          d="M 22 58 Q 10 55 12 45 Q 14 38 18 42"
          stroke={tailColor}
          strokeWidth={3}
          fill="none"
          strokeLinecap="round"
        />
      );
    case 'fluffy':
      return (
        <G>
          <Circle cx={16} cy={52} r={6} fill={tailColor} />
          <Circle cx={13} cy={48} r={4.5} fill={tailColor} />
          <Circle cx={12} cy={44} r={3.5} fill={tailColor} />
        </G>
      );
    case 'thin':
      return (
        <Path
          d="M 22 58 Q 8 52 10 42"
          stroke={tailColor}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
        />
      );
    case 'stub':
    default:
      return (
        <Ellipse cx={20} cy={56} rx={5} ry={3.5} fill={tailColor} />
      );
  }
}

function renderPatterns(
  traits: CreatureTraits,
  color: string,
  tier: number,
): React.ReactElement | null {
  if (tier < 3) return null; // Patterns appear at Verified

  const patternColor = lighten(color, 0.15);

  switch (traits.patternStyle) {
    case 'spots':
      return (
        <G opacity={0.3}>
          <Circle cx={38} cy={40} r={2.5} fill={patternColor} />
          <Circle cx={62} cy={42} r={2} fill={patternColor} />
          <Circle cx={44} cy={62} r={2.2} fill={patternColor} />
          <Circle cx={58} cy={60} r={1.8} fill={patternColor} />
        </G>
      );
    case 'stripes':
      return (
        <G opacity={0.2}>
          <Path d="M 38 36 Q 50 34 62 36" stroke={patternColor} strokeWidth={2} fill="none" strokeLinecap="round" />
          <Path d="M 36 44 Q 50 42 64 44" stroke={patternColor} strokeWidth={2} fill="none" strokeLinecap="round" />
          <Path d="M 38 52 Q 50 50 62 52" stroke={patternColor} strokeWidth={2} fill="none" strokeLinecap="round" />
        </G>
      );
    case 'belly':
      return (
        <Ellipse cx={50} cy={56} rx={12} ry={10} fill={patternColor} opacity={0.25} />
      );
    default:
      return null;
  }
}

function renderCrown(tier: number): React.ReactElement | null {
  if (tier < 4) return null; // Crown at Distinguished+

  // Body top is approximately at y = 50 - 26 - tier*1.2 = ~18 at tier 5
  const bodyTop = 50 - 26 - Math.min(tier, 5) * 1.2;
  const crownBase = bodyTop + 2;

  if (tier >= 5) {
    // Master — golden crown with gems
    return (
      <G>
        <Defs>
          <LinearGradient id="crownGrad" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#FFD700" />
            <Stop offset="1" stopColor="#FFA500" />
          </LinearGradient>
        </Defs>
        <Path
          d={`M 36 ${crownBase} L 38 ${crownBase - 10} L 43 ${crownBase - 4} L 50 ${crownBase - 14} L 57 ${crownBase - 4} L 62 ${crownBase - 10} L 64 ${crownBase} Z`}
          fill="url(#crownGrad)"
        />
        {/* Gems */}
        <Circle cx={43} cy={crownBase - 4} r={1.5} fill="#FF5252" />
        <Circle cx={50} cy={crownBase - 9} r={2} fill="#00D2FF" />
        <Circle cx={57} cy={crownBase - 4} r={1.5} fill="#00E676" />
      </G>
    );
  }

  // Distinguished — simple halo
  return (
    <Ellipse
      cx={50}
      cy={bodyTop - 2}
      rx={14}
      ry={4}
      fill="none"
      stroke="#FFD600"
      strokeWidth={1.5}
      opacity={0.7}
    />
  );
}

function renderWings(color: string, tier: number): React.ReactElement | null {
  if (tier < 5) return null; // Wings only for Master

  const wingColor = lighten(color, 0.35);
  return (
    <G opacity={0.5}>
      {/* Left wing */}
      <Path
        d={`M 26 44 Q 8 32 14 20 Q 22 28 26 38`}
        fill={wingColor}
      />
      <Path
        d={`M 26 44 Q 4 44 8 30 Q 18 36 26 42`}
        fill={wingColor}
        opacity={0.7}
      />
      {/* Right wing */}
      <Path
        d={`M 74 44 Q 92 32 86 20 Q 78 28 74 38`}
        fill={wingColor}
      />
      <Path
        d={`M 74 44 Q 96 44 92 30 Q 82 36 74 42`}
        fill={wingColor}
        opacity={0.7}
      />
    </G>
  );
}

function renderSparkles(tier: number): React.ReactElement | null {
  if (tier < 4) return null;

  const sparkleColor = tier >= 5 ? '#FFD700' : '#FFD600';
  const opacity = tier >= 5 ? 0.8 : 0.5;
  const count = tier >= 5 ? 6 : 3;

  // Fixed positions for sparkles so they don't jump around
  const positions = [
    { x: 14, y: 18 }, { x: 82, y: 22 }, { x: 20, y: 70 },
    { x: 80, y: 68 }, { x: 10, y: 45 }, { x: 90, y: 42 },
  ];

  return (
    <G opacity={opacity}>
      {positions.slice(0, count).map((pos, i) => (
        <G key={i}>
          {/* 4-pointed star sparkle */}
          <Path
            d={`M ${pos.x} ${pos.y - 2.5} L ${pos.x + 0.8} ${pos.y - 0.8} L ${pos.x + 2.5} ${pos.y} L ${pos.x + 0.8} ${pos.y + 0.8} L ${pos.x} ${pos.y + 2.5} L ${pos.x - 0.8} ${pos.y + 0.8} L ${pos.x - 2.5} ${pos.y} L ${pos.x - 0.8} ${pos.y - 0.8} Z`}
            fill={sparkleColor}
          />
        </G>
      ))}
    </G>
  );
}

function renderHungerIndicator(
  hunger: 'satisfied' | 'curious' | 'yearning' | 'starving',
): React.ReactElement | null {
  if (hunger === 'satisfied') return null;

  // Thought bubble positioned top-right
  const bubbleOpacity = hunger === 'starving' ? 0.85 : hunger === 'yearning' ? 0.7 : 0.5;

  return (
    <G opacity={bubbleOpacity}>
      {/* Thought bubble trail */}
      <Circle cx={72} cy={26} r={1.5} fill="white" opacity={0.6} />
      <Circle cx={76} cy={20} r={2.2} fill="white" opacity={0.7} />
      {/* Main thought bubble */}
      <Ellipse cx={84} cy={12} rx={10} ry={8} fill="white" opacity={0.9} />
      {hunger === 'starving' ? (
        // Starving: sparkle/star icon — "I want to grow!"
        <G>
          <Path
            d="M 84 8 L 85.2 10.4 L 87.8 10.8 L 85.9 12.6 L 86.4 15.2 L 84 14 L 81.6 15.2 L 82.1 12.6 L 80.2 10.8 L 82.8 10.4 Z"
            fill="#FFD600"
          />
        </G>
      ) : hunger === 'yearning' ? (
        // Yearning: book icon — "I want to learn!"
        <G>
          <Rect x={80} y={9} width={8} height={6} rx={0.5} fill="#6C5CE7" opacity={0.8} />
          <Path d="M 84 9 L 84 15" stroke="white" strokeWidth={0.5} />
          <Path d="M 81 10 L 83 10" stroke="white" strokeWidth={0.4} />
          <Path d="M 85 10 L 87 10" stroke="white" strokeWidth={0.4} />
        </G>
      ) : (
        // Curious: question mark — "What's new?"
        <G>
          <Path d="M 82.5 9 Q 85.5 7 86 10 Q 86.5 12 84 13" stroke="#8B93A8" strokeWidth={1.2} fill="none" strokeLinecap="round" />
          <Circle cx={84} cy={15} r={0.8} fill="#8B93A8" />
        </G>
      )}
    </G>
  );
}

function renderAura(color: string, tier: number): React.ReactElement | null {
  if (tier < 4) return null;

  const auraColor = lighten(color, 0.4);
  const auraOpacity = tier >= 5 ? 0.2 : 0.12;

  return (
    <Circle cx={50} cy={50} r={46} fill={auraColor} opacity={auraOpacity} />
  );
}

function renderFeet(color: string, tier: number): React.ReactElement {
  const footColor = darken(color, 0.2);
  // Position feet just below the body. Body center is at y=50, body extends
  // roughly 26 + tier*1.2 below center. Feet sit 2px below body bottom.
  const bodyBottom = 50 + 26 + Math.min(tier, 5) * 1.2;
  const cy = Math.min(bodyBottom + 2, 90); // Clamp to stay in viewBox
  return (
    <G>
      <Ellipse cx={42} cy={cy} rx={6} ry={3} fill={footColor} />
      <Ellipse cx={58} cy={cy} rx={6} ry={3} fill={footColor} />
    </G>
  );
}

// ── Main Component ──

export default function BotAvatar({
  botId,
  bodyColor,
  tier = 0,
  status = 'stopped',
  mood = 'neutral',
  hunger = 'satisfied',
  size = 120,
  animate = true,
  speciesSeed,
}: AvatarProps) {
  const traits = generateTraits(speciesSeed || botId);
  const color = bodyColor || '#6C5CE7';
  const clampedTier = Math.max(0, Math.min(5, tier));

  // Idle breathing animation
  const breathAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!animate || status === 'stopped') {
      breathAnim.setValue(1);
      return;
    }

    const breathing = Animated.loop(
      Animated.sequence([
        Animated.timing(breathAnim, {
          toValue: 1.03,
          duration: status === 'error' ? 600 : 1800,
          useNativeDriver: true,
        }),
        Animated.timing(breathAnim, {
          toValue: 1,
          duration: status === 'error' ? 600 : 1800,
          useNativeDriver: true,
        }),
      ]),
    );
    breathing.start();
    return () => breathing.stop();
  }, [animate, status, breathAnim]);

  // Gentle bounce for running status
  const bounceAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animate || status !== 'running') {
      bounceAnim.setValue(0);
      return;
    }

    const bounce = Animated.loop(
      Animated.sequence([
        Animated.timing(bounceAnim, {
          toValue: -2,
          duration: 1200,
          useNativeDriver: true,
        }),
        Animated.timing(bounceAnim, {
          toValue: 0,
          duration: 1200,
          useNativeDriver: true,
        }),
      ]),
    );
    bounce.start();
    return () => bounce.stop();
  }, [animate, status, bounceAnim]);

  return (
    <View style={[styles.container, { width: size, height: size }]}>
      <Animated.View
        style={{
          transform: [
            { scale: breathAnim },
            { translateY: bounceAnim },
          ],
        }}
      >
        <Svg width={size} height={size} viewBox="0 0 100 100">
          {/* Background aura (tier 4+) */}
          {renderAura(color, clampedTier)}

          {/* Wings (tier 5) */}
          {renderWings(color, clampedTier)}

          {/* Tail (tier 3+) */}
          {renderTail(traits, color, clampedTier)}

          {/* Ears (tier 1+) */}
          {renderEars(traits, color, clampedTier)}

          {/* Body */}
          {renderBody(traits, color, clampedTier)}

          {/* Body patterns (tier 3+) */}
          {renderPatterns(traits, color, clampedTier)}

          {/* Feet */}
          {renderFeet(color, clampedTier)}

          {/* Eyes */}
          {renderEyes(traits, status, mood, clampedTier)}

          {/* Cheeks */}
          {renderCheeks(traits, color)}

          {/* Mouth */}
          {renderMouth(status, mood)}

          {/* Crown/halo (tier 4+) */}
          {renderCrown(clampedTier)}

          {/* Sparkles (tier 4+) */}
          {renderSparkles(clampedTier)}

          {/* Knowledge hunger indicator */}
          {renderHungerIndicator(hunger)}
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
