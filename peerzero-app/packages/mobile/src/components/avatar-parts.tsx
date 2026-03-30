// =============================================================================
// Avatar SVG Parts — all creature rendering functions
//
// Extracted from BotAvatar.tsx for file size management.
// Each function renders a specific part of the creature SVG.
// =============================================================================

import React from 'react';
import {
  Circle, Ellipse, Path, G, Defs, RadialGradient, Stop,
  LinearGradient, Rect,
} from 'react-native-svg';
import { type CreatureTraits, lighten, darken } from './avatar-utils';

// ── SVG Creature Parts ──

export function renderBody(
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
    case 'pear': {
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
    case 'squish': {
      // Squish: very wide and flat, like a happy pancake. Maximum cute chubby vibe.
      const sw = 32 + sizeBonus;
      const sh = 20 + sizeBonus * 0.6;
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.4" cy="0.35" r="0.6">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Ellipse cx={cx} cy={cy + 4} rx={sw} ry={sh} fill="url(#bodyGrad)" />
          <Ellipse cx={cx} cy={cy + 8} rx={sw * 0.6} ry={sh * 0.5} fill={lightColor} opacity={0.4} />
        </G>
      );
    }
    case 'tall': {
      // Tall: elongated upright body like a standing marshmallow. Dignified.
      const tw = 18 + sizeBonus * 0.7;
      const th = 32 + sizeBonus;
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.4" cy="0.3" r="0.6">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Path
            d={`M ${cx} ${cy - th}
                C ${cx + tw} ${cy - th}, ${cx + tw * 1.1} ${cy - th * 0.3}, ${cx + tw * 1.1} ${cy}
                C ${cx + tw * 1.1} ${cy + th * 0.5}, ${cx + tw * 0.8} ${cy + th}, ${cx} ${cy + th}
                C ${cx - tw * 0.8} ${cy + th}, ${cx - tw * 1.1} ${cy + th * 0.5}, ${cx - tw * 1.1} ${cy}
                C ${cx - tw * 1.1} ${cy - th * 0.3}, ${cx - tw} ${cy - th}, ${cx} ${cy - th}
                Z`}
            fill="url(#bodyGrad)"
          />
          <Ellipse cx={cx} cy={cy + 6} rx={tw * 0.55} ry={th * 0.35} fill={lightColor} opacity={0.35} />
        </G>
      );
    }
    case 'chonk': {
      // Chonk: massive round body, basically a big cuddly sphere with extra girth.
      const cr = 34 + sizeBonus;
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.35" cy="0.35" r="0.65">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Circle cx={cx} cy={cy + 2} r={cr} fill="url(#bodyGrad)" />
          <Ellipse cx={cx} cy={cy + 8} rx={cr * 0.55} ry={cr * 0.45} fill={lightColor} opacity={0.4} />
        </G>
      );
    }
    case 'teardrop': {
      // Teardrop: narrow top flaring wide at the bottom, like a little ghost/droplet.
      const dw = 26 + sizeBonus;
      const dh = 28 + sizeBonus;
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.4" cy="0.3" r="0.6">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Path
            d={`M ${cx} ${cy - dh}
                C ${cx + dw * 0.3} ${cy - dh}, ${cx + dw * 0.4} ${cy - dh * 0.6}, ${cx + dw * 0.5} ${cy - dh * 0.2}
                C ${cx + dw * 0.8} ${cy + dh * 0.1}, ${cx + dw} ${cy + dh * 0.5}, ${cx + dw * 0.6} ${cy + dh}
                Q ${cx} ${cy + dh * 1.1}, ${cx - dw * 0.6} ${cy + dh}
                C ${cx - dw} ${cy + dh * 0.5}, ${cx - dw * 0.8} ${cy + dh * 0.1}, ${cx - dw * 0.5} ${cy - dh * 0.2}
                C ${cx - dw * 0.4} ${cy - dh * 0.6}, ${cx - dw * 0.3} ${cy - dh}, ${cx} ${cy - dh}
                Z`}
            fill="url(#bodyGrad)"
          />
          <Ellipse cx={cx} cy={cy + 6} rx={dw * 0.4} ry={dh * 0.35} fill={lightColor} opacity={0.35} />
        </G>
      );
    }
    case 'blob': {
      // Blob: melted puddle shape, like it's too lazy to hold a form. Flat and oozy.
      const bw = 36 + sizeBonus;
      const bh = 16 + sizeBonus * 0.4;
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.4" cy="0.3" r="0.7">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Path
            d={`M ${cx - bw} ${cy + bh * 0.3}
                Q ${cx - bw * 0.8} ${cy - bh}, ${cx - bw * 0.3} ${cy - bh * 0.8}
                Q ${cx} ${cy - bh * 1.2}, ${cx + bw * 0.3} ${cy - bh * 0.8}
                Q ${cx + bw * 0.8} ${cy - bh}, ${cx + bw} ${cy + bh * 0.3}
                Q ${cx + bw * 0.9} ${cy + bh * 1.1}, ${cx} ${cy + bh}
                Q ${cx - bw * 0.9} ${cy + bh * 1.1}, ${cx - bw} ${cy + bh * 0.3}
                Z`}
            fill="url(#bodyGrad)"
          />
          <Ellipse cx={cx} cy={cy + 2} rx={bw * 0.5} ry={bh * 0.5} fill={lightColor} opacity={0.35} />
        </G>
      );
    }
    case 'loaf': {
      // Loaf: bread loaf shape. Rectangular with rounded ends. Peak comedy.
      const lw = 30 + sizeBonus;
      const lh = 22 + sizeBonus * 0.7;
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.4" cy="0.3" r="0.6">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Rect x={cx - lw} y={cy - lh * 0.6} rx={lh * 0.6} ry={lh * 0.6} width={lw * 2} height={lh * 1.4} fill="url(#bodyGrad)" />
          {/* Loaf top dome */}
          <Ellipse cx={cx} cy={cy - lh * 0.55} rx={lw * 0.85} ry={lh * 0.5} fill={lightColor} opacity={0.3} />
          {/* Belly shine */}
          <Ellipse cx={cx} cy={cy + 4} rx={lw * 0.5} ry={lh * 0.3} fill={lightColor} opacity={0.25} />
        </G>
      );
    }
    case 'nuggie':
    default: {
      // Nuggie: lumpy chicken nugget shape. Irregular and hilarious.
      const nw = 26 + sizeBonus;
      const nh = 24 + sizeBonus;
      return (
        <G>
          <Defs>
            <RadialGradient id="bodyGrad" cx="0.4" cy="0.35" r="0.6">
              <Stop offset="0" stopColor={lightColor} />
              <Stop offset="1" stopColor={color} />
            </RadialGradient>
          </Defs>
          <Path
            d={`M ${cx - nw * 0.2} ${cy - nh}
                C ${cx + nw * 0.5} ${cy - nh * 1.05}, ${cx + nw * 1.1} ${cy - nh * 0.5}, ${cx + nw * 0.9} ${cy - nh * 0.1}
                C ${cx + nw * 1.1} ${cy + nh * 0.3}, ${cx + nw * 0.8} ${cy + nh * 0.9}, ${cx + nw * 0.3} ${cy + nh}
                C ${cx - nw * 0.2} ${cy + nh * 1.05}, ${cx - nw * 0.9} ${cy + nh * 0.7}, ${cx - nw} ${cy + nh * 0.2}
                C ${cx - nw * 1.05} ${cy - nh * 0.3}, ${cx - nw * 0.7} ${cy - nh * 0.9}, ${cx - nw * 0.2} ${cy - nh}
                Z`}
            fill="url(#bodyGrad)"
          />
          <Ellipse cx={cx + 2} cy={cy + 3} rx={nw * 0.4} ry={nh * 0.35} fill={lightColor} opacity={0.3} />
        </G>
      );
    }
  }
}

export function renderEars(
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
      return (
        <G>
          <Path d={`M 30 30 L ${24 - 4 * earScale} ${12 - 6 * earScale} L 40 ${26 - 2 * earScale} Z`} fill={earColor} />
          <Path d={`M 32 28 L ${27 - 2 * earScale} ${16 - 4 * earScale} L 38 ${26 - earScale} Z`} fill={innerColor} opacity={0.5} />
          <Path d={`M 70 30 L ${76 + 4 * earScale} ${12 - 6 * earScale} L 60 ${26 - 2 * earScale} Z`} fill={earColor} />
          <Path d={`M 68 28 L ${73 + 2 * earScale} ${16 - 4 * earScale} L 62 ${26 - earScale} Z`} fill={innerColor} opacity={0.5} />
        </G>
      );
    case 'bunny': {
      // Tall floppy bunny ears — one slightly droopy for personality
      const earH = 18 * earScale;
      const earW = 6 * earScale;
      return (
        <G>
          {/* Left bunny ear — stands up */}
          <Path
            d={`M 36 26 Q ${36 - earW} ${26 - earH * 0.5} ${34 - earW * 0.5} ${26 - earH}
                Q ${34} ${26 - earH * 0.9} ${36 + earW * 0.5} ${26 - earH * 0.3}
                Q ${38} ${26 - earH * 0.1} 38 28`}
            fill={earColor}
          />
          <Path
            d={`M 36 26 Q ${36 - earW * 0.5} ${26 - earH * 0.4} ${35 - earW * 0.2} ${26 - earH * 0.7}
                Q 35 ${26 - earH * 0.6} ${36 + earW * 0.2} ${26 - earH * 0.3}`}
            fill={innerColor} opacity={0.5}
          />
          {/* Right bunny ear — slightly droopy for charm */}
          <Path
            d={`M 64 26 Q ${64 + earW} ${26 - earH * 0.4} ${66 + earW * 0.5} ${26 - earH * 0.8}
                Q ${68 + earW * 0.3} ${26 - earH * 0.3} ${66} ${24}
                Q 64 25 62 28`}
            fill={earColor}
          />
          <Path
            d={`M 64 26 Q ${64 + earW * 0.5} ${26 - earH * 0.3} ${65 + earW * 0.3} ${26 - earH * 0.55}`}
            stroke={innerColor} strokeWidth={earW * 0.3} fill="none" opacity={0.4} strokeLinecap="round"
          />
        </G>
      );
    }
    case 'bear': {
      // Small round bear ears — sitting on top of the head
      const bearR = 7 * earScale;
      return (
        <G>
          <Circle cx={34} cy={22} r={bearR} fill={earColor} />
          <Circle cx={34} cy={22} r={bearR * 0.55} fill={innerColor} opacity={0.5} />
          <Circle cx={66} cy={22} r={bearR} fill={earColor} />
          <Circle cx={66} cy={22} r={bearR * 0.55} fill={innerColor} opacity={0.5} />
        </G>
      );
    }
    case 'antennae': {
      // Bug-like antennae with little bobbles on top — quirky and adorable
      const antH = 14 * earScale;
      const bobR = 3 * earScale;
      return (
        <G>
          <Path d={`M 42 28 Q 38 ${28 - antH * 0.5} ${36 - bobR} ${28 - antH}`} stroke={earColor} strokeWidth={1.5} fill="none" strokeLinecap="round" />
          <Circle cx={36 - bobR} cy={28 - antH} r={bobR} fill={earColor} />
          <Circle cx={36 - bobR} cy={28 - antH} r={bobR * 0.5} fill={innerColor} opacity={0.6} />
          <Path d={`M 58 28 Q 62 ${28 - antH * 0.5} ${64 + bobR} ${28 - antH}`} stroke={earColor} strokeWidth={1.5} fill="none" strokeLinecap="round" />
          <Circle cx={64 + bobR} cy={28 - antH} r={bobR} fill={earColor} />
          <Circle cx={64 + bobR} cy={28 - antH} r={bobR * 0.5} fill={innerColor} opacity={0.6} />
        </G>
      );
    }
    case 'horns': {
      // Small curved horns — gives a devilish-cute vibe
      const hornH = 10 * earScale;
      return (
        <G>
          <Path
            d={`M 36 26 Q 30 ${26 - hornH * 0.4} ${28 - hornH * 0.2} ${26 - hornH}`}
            stroke={earColor} strokeWidth={3.5 * earScale} fill="none" strokeLinecap="round"
          />
          <Path
            d={`M 64 26 Q 70 ${26 - hornH * 0.4} ${72 + hornH * 0.2} ${26 - hornH}`}
            stroke={earColor} strokeWidth={3.5 * earScale} fill="none" strokeLinecap="round"
          />
          {/* Horn tips slightly lighter */}
          <Circle cx={28 - hornH * 0.2} cy={26 - hornH} r={1.5 * earScale} fill={innerColor} opacity={0.6} />
          <Circle cx={72 + hornH * 0.2} cy={26 - hornH} r={1.5 * earScale} fill={innerColor} opacity={0.6} />
        </G>
      );
    }
    case 'tiny': {
      // Comically tiny ears — barely visible on the head. Like, why even bother.
      const tinyR = 3 * earScale;
      return (
        <G>
          <Circle cx={36} cy={24} r={tinyR} fill={earColor} />
          <Circle cx={36} cy={24} r={tinyR * 0.5} fill={innerColor} opacity={0.5} />
          <Circle cx={64} cy={24} r={tinyR} fill={earColor} />
          <Circle cx={64} cy={24} r={tinyR * 0.5} fill={innerColor} opacity={0.5} />
        </G>
      );
    }
    case 'huge': {
      // Absurdly oversized floppy ears — droop past the body. All ear, no plan.
      const hugeDrop = 46 + 10 * earScale;
      const hugeW = 14 * earScale;
      return (
        <G>
          {/* Left massive floppy ear */}
          <Path
            d={`M 34 24 Q ${20 - hugeW} 20, ${14 - hugeW} ${hugeDrop}
                Q ${12 - hugeW} ${hugeDrop + 8}, ${18 - hugeW + 6} ${hugeDrop + 4}
                Q 28 ${hugeDrop - 8}, 38 28`}
            fill={earColor}
          />
          <Path
            d={`M 35 26 Q ${24 - hugeW * 0.6} 24, ${18 - hugeW * 0.6} ${hugeDrop - 6}`}
            stroke={innerColor} strokeWidth={hugeW * 0.25} fill="none" opacity={0.3} strokeLinecap="round"
          />
          {/* Right massive floppy ear */}
          <Path
            d={`M 66 24 Q ${80 + hugeW} 20, ${86 + hugeW} ${hugeDrop}
                Q ${88 + hugeW} ${hugeDrop + 8}, ${82 + hugeW - 6} ${hugeDrop + 4}
                Q 72 ${hugeDrop - 8}, 62 28`}
            fill={earColor}
          />
          <Path
            d={`M 65 26 Q ${76 + hugeW * 0.6} 24, ${82 + hugeW * 0.6} ${hugeDrop - 6}`}
            stroke={innerColor} strokeWidth={hugeW * 0.25} fill="none" opacity={0.3} strokeLinecap="round"
          />
        </G>
      );
    }
    case 'one':
    default: {
      // Just one ear. The other one? Who knows. Lost it in an experiment maybe.
      const oneR = 10 * earScale;
      return (
        <G>
          {/* Only the left ear exists */}
          <Circle cx={32} cy={22} r={oneR} fill={earColor} />
          <Circle cx={32} cy={22} r={oneR * 0.6} fill={innerColor} opacity={0.5} />
          {/* Right side: tiny bandage where ear should be */}
          <Path d={`M 64 22 L 72 22`} stroke={innerColor} strokeWidth={2} opacity={0.3} strokeLinecap="round" />
          <Path d={`M 68 19 L 68 25`} stroke={innerColor} strokeWidth={2} opacity={0.3} strokeLinecap="round" />
        </G>
      );
    }
  }
}

export function renderEyes(
  traits: CreatureTraits,
  status: 'running' | 'stopped' | 'paused' | 'error',
  mood: string,
  _tier: number,
  color: string,
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

  // Running — mood-based eyes

  // Proud: confident closed eyes with slight upward tilt, like savoring a win
  if (mood === 'proud') {
    return (
      <G>
        {/* Confident closed eyes — slightly smug ^ ^ with longer curves */}
        <Path d={`M ${leftX - baseSize * 0.8} ${cy + baseSize * 0.15} Q ${leftX} ${cy - baseSize * 0.7} ${leftX + baseSize * 0.8} ${cy + baseSize * 0.15}`} stroke="#2D1B4E" strokeWidth={1.8} fill="none" strokeLinecap="round" />
        <Path d={`M ${rightX - baseSize * 0.8} ${cy + baseSize * 0.15} Q ${rightX} ${cy - baseSize * 0.7} ${rightX + baseSize * 0.8} ${cy + baseSize * 0.15}`} stroke="#2D1B4E" strokeWidth={1.8} fill="none" strokeLinecap="round" />
        {/* Tiny sparkle by left eye — proud twinkle */}
        <Path d={`M ${leftX - baseSize * 1.2} ${cy - baseSize * 0.6} L ${leftX - baseSize * 1.0} ${cy - baseSize * 0.3} M ${leftX - baseSize * 1.4} ${cy - baseSize * 0.45} L ${leftX - baseSize * 0.8} ${cy - baseSize * 0.45}`} stroke="#FFD600" strokeWidth={0.8} strokeLinecap="round" />
      </G>
    );
  }

  // Focused: determined squinty eyes with tiny brow lines
  if (mood === 'focused') {
    return (
      <G>
        <Circle cx={leftX} cy={cy} r={baseSize * 0.85} fill="white" />
        <Circle cx={rightX} cy={cy} r={baseSize * 0.85} fill="white" />
        <Circle cx={leftX} cy={cy} r={baseSize * 0.45} fill="#2D1B4E" />
        <Circle cx={rightX} cy={cy} r={baseSize * 0.45} fill="#2D1B4E" />
        <Circle cx={leftX + baseSize * 0.15} cy={cy - baseSize * 0.15} r={baseSize * 0.12} fill="white" />
        <Circle cx={rightX + baseSize * 0.15} cy={cy - baseSize * 0.15} r={baseSize * 0.12} fill="white" />
        {/* Determined brow lines */}
        <Path d={`M ${leftX - baseSize * 0.8} ${cy - baseSize * 1.2} L ${leftX + baseSize * 0.5} ${cy - baseSize * 1.0}`} stroke="#2D1B4E" strokeWidth={1.2} fill="none" strokeLinecap="round" opacity={0.6} />
        <Path d={`M ${rightX + baseSize * 0.8} ${cy - baseSize * 1.2} L ${rightX - baseSize * 0.5} ${cy - baseSize * 1.0}`} stroke="#2D1B4E" strokeWidth={1.2} fill="none" strokeLinecap="round" opacity={0.6} />
      </G>
    );
  }

  // Excited: huge sparkling eyes, star reflections
  if (mood === 'excited') {
    return (
      <G>
        {/* Big wide eyes */}
        <Circle cx={leftX} cy={cy} r={baseSize * 1.2} fill="white" />
        <Circle cx={rightX} cy={cy} r={baseSize * 1.2} fill="white" />
        <Circle cx={leftX} cy={cy} r={baseSize * 0.55} fill="#2D1B4E" />
        <Circle cx={rightX} cy={cy} r={baseSize * 0.55} fill="#2D1B4E" />
        {/* Star sparkle reflections instead of round dots */}
        <Path d={`M ${leftX + baseSize * 0.2} ${cy - baseSize * 0.5} L ${leftX + baseSize * 0.3} ${cy - baseSize * 0.3} M ${leftX + baseSize * 0.05} ${cy - baseSize * 0.4} L ${leftX + baseSize * 0.45} ${cy - baseSize * 0.4}`} stroke="white" strokeWidth={1} strokeLinecap="round" />
        <Path d={`M ${rightX + baseSize * 0.2} ${cy - baseSize * 0.5} L ${rightX + baseSize * 0.3} ${cy - baseSize * 0.3} M ${rightX + baseSize * 0.05} ${cy - baseSize * 0.4} L ${rightX + baseSize * 0.45} ${cy - baseSize * 0.4}`} stroke="white" strokeWidth={1} strokeLinecap="round" />
        {/* Exclamation marks */}
        <Path d={`M 75 30 L 75 34`} stroke="#FFD600" strokeWidth={1.2} strokeLinecap="round" opacity={0.7} />
        <Circle cx={75} cy={36.5} r={0.7} fill="#FFD600" opacity={0.7} />
      </G>
    );
  }

  // Shy: pupils looking away, extra blush implied by smaller eyes
  if (mood === 'shy') {
    return (
      <G>
        <Circle cx={leftX} cy={cy} r={baseSize * 0.9} fill="white" />
        <Circle cx={rightX} cy={cy} r={baseSize * 0.9} fill="white" />
        {/* Pupils offset to one side — looking away */}
        <Circle cx={leftX - baseSize * 0.3} cy={cy + baseSize * 0.15} r={baseSize * 0.4} fill="#2D1B4E" />
        <Circle cx={rightX - baseSize * 0.3} cy={cy + baseSize * 0.15} r={baseSize * 0.4} fill="#2D1B4E" />
        <Circle cx={leftX - baseSize * 0.15} cy={cy - baseSize * 0.1} r={baseSize * 0.12} fill="white" />
        <Circle cx={rightX - baseSize * 0.15} cy={cy - baseSize * 0.1} r={baseSize * 0.12} fill="white" />
        {/* Extra blush lines under eyes */}
        <Path d={`M ${leftX - baseSize * 0.6} ${cy + baseSize * 0.7} L ${leftX - baseSize * 0.3} ${cy + baseSize * 0.65}`} stroke="#FF8A8A" strokeWidth={0.6} strokeLinecap="round" opacity={0.5} />
        <Path d={`M ${leftX} ${cy + baseSize * 0.7} L ${leftX + baseSize * 0.3} ${cy + baseSize * 0.65}`} stroke="#FF8A8A" strokeWidth={0.6} strokeLinecap="round" opacity={0.5} />
      </G>
    );
  }

  // Tired: half-lidded droopy eyes
  if (mood === 'tired') {
    return (
      <G>
        <Circle cx={leftX} cy={cy} r={baseSize} fill="white" />
        <Circle cx={rightX} cy={cy} r={baseSize} fill="white" />
        {/* Droopy pupils — slightly lower */}
        <Circle cx={leftX} cy={cy + baseSize * 0.2} r={baseSize * 0.45} fill="#2D1B4E" />
        <Circle cx={rightX} cy={cy + baseSize * 0.2} r={baseSize * 0.45} fill="#2D1B4E" />
        <Circle cx={leftX + baseSize * 0.15} cy={cy} r={baseSize * 0.12} fill="white" />
        <Circle cx={rightX + baseSize * 0.15} cy={cy} r={baseSize * 0.12} fill="white" />
        {/* Half-lid lines cutting across top of eyes */}
        <Path d={`M ${leftX - baseSize * 1.1} ${cy - baseSize * 0.3} Q ${leftX} ${cy + baseSize * 0.1} ${leftX + baseSize * 1.1} ${cy - baseSize * 0.3}`} fill={color} />
        <Path d={`M ${rightX - baseSize * 1.1} ${cy - baseSize * 0.3} Q ${rightX} ${cy + baseSize * 0.1} ${rightX + baseSize * 1.1} ${cy - baseSize * 0.3}`} fill={color} />
      </G>
    );
  }

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

export function renderMouth(
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

  // Proud: wide confident grin, slightly asymmetric
  if (mood === 'proud') {
    return (
      <G>
        <Path
          d={`M ${cx - 6} ${cy - 0.5} Q ${cx} ${cy + 6} ${cx + 7} ${cy - 1}`}
          stroke="#2D1B4E" strokeWidth={1.4} fill="none" strokeLinecap="round" opacity={0.6}
        />
      </G>
    );
  }

  // Focused: small straight determined line
  if (mood === 'focused') {
    return (
      <Path
        d={`M ${cx - 3} ${cy + 0.5} L ${cx + 3} ${cy + 0.5}`}
        stroke="#2D1B4E" strokeWidth={1.3} fill="none" strokeLinecap="round" opacity={0.5}
      />
    );
  }

  // Excited: big wide open mouth "O!"
  if (mood === 'excited') {
    return (
      <G>
        <Ellipse cx={cx} cy={cy + 2} rx={4.5} ry={5} fill="#2D1B4E" opacity={0.6} />
        {/* Tongue peeking out */}
        <Path
          d={`M ${cx - 2.5} ${cy + 5} Q ${cx} ${cy + 8} ${cx + 2.5} ${cy + 5}`}
          fill="#FF8A8A" opacity={0.7}
        />
      </G>
    );
  }

  // Shy: tiny wobbly smile, slightly off-center
  if (mood === 'shy') {
    return (
      <Path
        d={`M ${cx - 3} ${cy + 1} Q ${cx - 1} ${cy + 3} ${cx + 2} ${cy + 0.5}`}
        stroke="#2D1B4E" strokeWidth={1} fill="none" strokeLinecap="round" opacity={0.4}
      />
    );
  }

  // Tired: yawn — open oval mouth
  if (mood === 'tired') {
    return (
      <G>
        <Ellipse cx={cx} cy={cy + 1.5} rx={3} ry={4} fill="#2D1B4E" opacity={0.45} />
        {/* Tiny "..." above — sleepy thought */}
        <Circle cx={cx - 4} cy={cy - 3} r={0.6} fill="#8B93A8" opacity={0.4} />
        <Circle cx={cx} cy={cy - 3.5} r={0.6} fill="#8B93A8" opacity={0.4} />
        <Circle cx={cx + 4} cy={cy - 3} r={0.6} fill="#8B93A8" opacity={0.4} />
      </G>
    );
  }

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

export function renderCheeks(traits: CreatureTraits, color: string): React.ReactElement {
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

export function renderTail(
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
      return (
        <Ellipse cx={20} cy={56} rx={5} ry={3.5} fill={tailColor} />
      );
    case 'pom':
      // Fluffy pom-pom — like a bunny tail
      return (
        <G>
          <Circle cx={18} cy={54} r={5} fill={tailColor} />
          <Circle cx={16} cy={52} r={3.5} fill={lighten(tailColor, 0.15)} opacity={0.7} />
          <Circle cx={20} cy={52} r={3} fill={lighten(tailColor, 0.15)} opacity={0.5} />
          <Circle cx={17} cy={56} r={3} fill={lighten(tailColor, 0.1)} opacity={0.6} />
        </G>
      );
    case 'spike':
      // Spiky tail pointing up — a little rebellious
      return (
        <G>
          <Path d={`M 22 58 L 14 48 L 20 52 L 12 42 L 22 50`} fill={tailColor} />
        </G>
      );
    case 'spring':
      // Coiled spring tail — boing boing boing
      return (
        <G>
          <Path
            d={`M 22 58 Q 14 56 18 52 Q 22 48 14 46 Q 8 44 12 40 Q 16 36 10 34`}
            stroke={tailColor} strokeWidth={2.5} fill="none" strokeLinecap="round"
          />
          <Circle cx={10} cy={33} r={2.5} fill={tailColor} />
        </G>
      );
    case 'fan':
    default:
      // Peacock-style fan tail — way too fancy for a blob
      return (
        <G opacity={0.8}>
          <Path d={`M 22 56 Q 6 48 4 36`} stroke={tailColor} strokeWidth={2} fill="none" strokeLinecap="round" />
          <Path d={`M 22 54 Q 8 42 10 30`} stroke={tailColor} strokeWidth={2} fill="none" strokeLinecap="round" />
          <Path d={`M 22 52 Q 12 38 16 28`} stroke={tailColor} strokeWidth={2} fill="none" strokeLinecap="round" />
          <Circle cx={4} cy={35} r={3} fill={lighten(tailColor, 0.2)} />
          <Circle cx={10} cy={29} r={3} fill={lighten(tailColor, 0.15)} />
          <Circle cx={16} cy={27} r={3} fill={lighten(tailColor, 0.1)} />
        </G>
      );
  }
}

export function renderPatterns(
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
    case 'freckles':
      // Cute little freckle dots clustered on the cheeks
      return (
        <G opacity={0.3}>
          <Circle cx={36} cy={48} r={1.2} fill={patternColor} />
          <Circle cx={38} cy={50} r={1} fill={patternColor} />
          <Circle cx={34} cy={50} r={1.1} fill={patternColor} />
          <Circle cx={64} cy={48} r={1.2} fill={patternColor} />
          <Circle cx={62} cy={50} r={1} fill={patternColor} />
          <Circle cx={66} cy={50} r={1.1} fill={patternColor} />
        </G>
      );
    case 'heart':
      // A small heart marking on the chest
      return (
        <G opacity={0.3}>
          <Path
            d={`M 50 55
                C 50 52 46 50 44 52
                C 42 54 42 57 50 62
                C 58 57 58 54 56 52
                C 54 50 50 52 50 55 Z`}
            fill={patternColor}
          />
        </G>
      );
    case 'mustache':
      // A distinguished little mustache below the mouth. Very scholarly.
      return (
        <G opacity={0.35}>
          <Path
            d={`M 43 58 Q 45 56 47 57 Q 49 58.5 50 58 Q 51 58.5 53 57 Q 55 56 57 58`}
            stroke={darken(patternColor, 0.3)} strokeWidth={1.5} fill="none" strokeLinecap="round"
          />
        </G>
      );
    case 'bandaid':
      // A little X-shaped bandaid on the body. Battle scars from peer review.
      return (
        <G opacity={0.35}>
          <Rect x={56} y={38} width={8} height={5} rx={1.5} fill={patternColor} />
          <Path d={`M 58 39.5 L 60 42 M 60 39.5 L 58 42`} stroke={darken(patternColor, 0.2)} strokeWidth={0.8} strokeLinecap="round" />
        </G>
      );
    default:
      return null;
  }
}

export function renderCrown(tier: number): React.ReactElement | null {
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

export function renderWings(color: string, tier: number): React.ReactElement | null {
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

export function renderSparkles(tier: number): React.ReactElement | null {
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

export function renderHungerIndicator(
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

export function renderTierRibbon(color: string, tier: number): React.ReactElement | null {
  // Tier 2 (Fledgling) gets a small ribbon/bow to mark their first visible milestone.
  // Tier 3+ have ears/tail/patterns; tier 4+ have crowns. Tier 2 needs this.
  if (tier !== 2) return null;

  const ribbonColor = darken(color, 0.1);
  const ribbonLight = lighten(color, 0.2);
  // Position at the right side of the body, like a little scarf knot
  return (
    <G>
      {/* Bow loops */}
      <Ellipse cx={72} cy={52} rx={4} ry={2.5} fill={ribbonColor} opacity={0.8} transform="rotate(-20, 72, 52)" />
      <Ellipse cx={72} cy={57} rx={4} ry={2.5} fill={ribbonColor} opacity={0.8} transform="rotate(20, 72, 57)" />
      {/* Center knot */}
      <Circle cx={72} cy={54.5} r={1.8} fill={ribbonLight} />
      {/* Trailing ribbon */}
      <Path d="M 72 56.5 Q 74 62 71 66" stroke={ribbonColor} strokeWidth={1.5} fill="none" strokeLinecap="round" opacity={0.6} />
      <Path d="M 72 56.5 Q 76 61 75 65" stroke={ribbonColor} strokeWidth={1.5} fill="none" strokeLinecap="round" opacity={0.6} />
    </G>
  );
}


export function renderAura(color: string, tier: number): React.ReactElement | null {
  if (tier < 4) return null;

  const auraColor = lighten(color, 0.4);
  const auraOpacity = tier >= 5 ? 0.2 : 0.12;

  return (
    <Circle cx={50} cy={50} r={46} fill={auraColor} opacity={auraOpacity} />
  );
}

export function renderFeet(color: string, tier: number): React.ReactElement {
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
