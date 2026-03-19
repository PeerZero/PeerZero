// =============================================================================
// PeerZero Logo — cute eye ("peer") integrated with P0 branding
//
// The "0" in P0 is a stylized eye — the "peer" pun. It's cute and rounded
// to appeal to casual users, but clean enough for the science crowd.
// The eye has a subtle iris gradient in brand purple with a cyan highlight.
// =============================================================================

import React from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, {
  Circle, Ellipse, Path, G, Defs, RadialGradient, Stop,
  LinearGradient, Text as SvgText,
} from 'react-native-svg';
import { colors } from '../theme/colors';

interface PeerZeroLogoProps {
  size?: number; // overall height of the logo mark (default 80)
  showWordmark?: boolean; // show "PeerZero" text below (default false)
}

export default function PeerZeroLogo({ size = 80, showWordmark = false }: PeerZeroLogoProps) {
  // Scale everything relative to the base 80px size
  const s = size / 80;
  const svgWidth = 120 * s;
  const svgHeight = showWordmark ? 110 * s : 80 * s;

  return (
    <View style={styles.container}>
      <Svg width={svgWidth} height={svgHeight} viewBox={`0 0 ${120} ${showWordmark ? 110 : 80}`}>
        <Defs>
          {/* Iris gradient — purple center to deeper purple edge */}
          <RadialGradient id="iris" cx="50%" cy="45%" r="50%">
            <Stop offset="0%" stopColor="#9B8FFF" />
            <Stop offset="60%" stopColor={colors.accent.primary} />
            <Stop offset="100%" stopColor="#4A3DB8" />
          </RadialGradient>
          {/* Outer glow */}
          <RadialGradient id="glow" cx="50%" cy="50%" r="50%">
            <Stop offset="0%" stopColor={colors.accent.primary} stopOpacity="0.15" />
            <Stop offset="100%" stopColor={colors.accent.primary} stopOpacity="0" />
          </RadialGradient>
          {/* Shine gradient for the eye highlight */}
          <LinearGradient id="shine" x1="0%" y1="0%" x2="100%" y2="100%">
            <Stop offset="0%" stopColor="#fff" stopOpacity="0.9" />
            <Stop offset="100%" stopColor="#fff" stopOpacity="0.1" />
          </LinearGradient>
        </Defs>

        {/* Subtle glow behind the logo */}
        <Circle cx="60" cy="40" r="50" fill="url(#glow)" />

        {/* ── "P" letter ── */}
        <G>
          {/* P stem */}
          <Path
            d="M 18 18 L 18 62"
            stroke={colors.text.primary}
            strokeWidth="7"
            strokeLinecap="round"
            fill="none"
          />
          {/* P bowl — connects to the eye */}
          <Path
            d="M 18 18 L 38 18 Q 56 18 56 30 Q 56 40 42 40 L 18 40"
            stroke={colors.text.primary}
            strokeWidth="7"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </G>

        {/* ── "0" as a cute eye ── */}
        <G>
          {/* Eye white (sclera) — slightly oval, cute proportions */}
          <Ellipse
            cx="82" cy="40"
            rx="24" ry="21"
            fill="#F0F0F8"
            stroke={colors.text.primary}
            strokeWidth="4"
          />

          {/* Iris */}
          <Circle cx="82" cy="40" r="13" fill="url(#iris)" />

          {/* Pupil */}
          <Circle cx="82" cy="40" r="6" fill="#1A1030" />

          {/* Main catchlight — top-left, gives life to the eye */}
          <Ellipse cx="76" cy="34" rx="4" ry="3.5" fill="url(#shine)" />

          {/* Small secondary catchlight — bottom-right */}
          <Circle cx="88" cy="46" r="2" fill="#fff" opacity="0.4" />

          {/* Subtle cyan accent ring inside iris — the "tech" feel */}
          <Circle
            cx="82" cy="40" r="10"
            fill="none"
            stroke={colors.accent.secondary}
            strokeWidth="0.8"
            opacity="0.5"
          />

          {/* Top eyelid curve — gives it a friendly, slightly curious look */}
          <Path
            d="M 56 36 Q 70 22 82 22 Q 94 22 108 36"
            fill={colors.bg.primary}
            stroke={colors.text.primary}
            strokeWidth="4"
            strokeLinecap="round"
          />

          {/* Tiny eyelashes — just two cute ones on top */}
          <Path
            d="M 68 27 L 65 21"
            stroke={colors.text.primary}
            strokeWidth="2.5"
            strokeLinecap="round"
          />
          <Path
            d="M 96 27 L 99 21"
            stroke={colors.text.primary}
            strokeWidth="2.5"
            strokeLinecap="round"
          />

          {/* Bottom eyelid — subtle, just a gentle curve */}
          <Path
            d="M 59 46 Q 70 56 82 56 Q 94 56 105 46"
            fill="none"
            stroke={colors.text.primary}
            strokeWidth="2"
            strokeLinecap="round"
            opacity="0.3"
          />
        </G>

        {/* Wordmark below */}
        {showWordmark && (
          <SvgText
            x="60"
            y="100"
            textAnchor="middle"
            fill={colors.text.primary}
            fontSize="16"
            fontWeight="700"
            letterSpacing="1"
          >
            PeerZero
          </SvgText>
        )}
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
