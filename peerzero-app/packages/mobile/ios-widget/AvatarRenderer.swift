// =============================================================================
// Avatar Renderer — SwiftUI recreation of the BotAvatar creature
//
// This is a simplified version of the React Native BotAvatar component,
// recreated in SwiftUI for the WidgetKit extension. It uses the same
// deterministic seed-based trait generation and tier-based evolution.
//
// Design: Matches the RN component exactly so users see the same creature
// on their home screen as they do in the app.
// =============================================================================

import SwiftUI

// MARK: - Seed-based RNG (mirrors BotAvatar.tsx)

private func hashCode(_ str: String) -> Int {
  var hash: Int32 = 0
  for char in str.unicodeScalars {
    hash = ((hash &<< 5) &- hash) &+ Int32(char.value)
  }
  return Int(abs(hash))
}

private func seededRandom(_ seed: Int, _ index: Int) -> Double {
  let x = sin(Double(seed) + Double(index) * 9301.0 + 49297.0) * 49381.0
  return x - floor(x)
}

// MARK: - Creature Traits

enum BodyShape: Int, CaseIterable { case round, oval, bean, pear }
enum EarStyle: Int, CaseIterable { case round, pointed, floppy, cat }
enum TailStyle: Int, CaseIterable { case curly, fluffy, thin, stub }
enum PatternStyle: Int, CaseIterable { case spots, stripes, belly, none }

struct CreatureTraits {
  let bodyShape: BodyShape
  let earStyle: EarStyle
  let tailStyle: TailStyle
  let patternStyle: PatternStyle
  let eyeSpacing: CGFloat
  let eyeSize: CGFloat
  let cheekSize: CGFloat
}

func generateTraits(botId: String) -> CreatureTraits {
  let seed = hashCode(botId)
  let r = { (i: Int) -> Double in seededRandom(seed, i) }

  return CreatureTraits(
    bodyShape: BodyShape(rawValue: Int(r(0) * 4)) ?? .round,
    earStyle: EarStyle(rawValue: Int(r(1) * 4)) ?? .round,
    tailStyle: TailStyle(rawValue: Int(r(2) * 4)) ?? .curly,
    patternStyle: PatternStyle(rawValue: Int(r(3) * 4)) ?? .none,
    eyeSpacing: 0.3 + CGFloat(r(4)) * 0.2,
    eyeSize: 0.8 + CGFloat(r(5)) * 0.4,
    cheekSize: 0.5 + CGFloat(r(6)) * 0.5
  )
}

// MARK: - Color Helpers

private func hexToColor(_ hex: String) -> Color {
  let clean = hex.replacingOccurrences(of: "#", with: "")
  guard clean.count >= 6,
        let r = UInt8(clean.prefix(2), radix: 16),
        let g = UInt8(clean.dropFirst(2).prefix(2), radix: 16),
        let b = UInt8(clean.dropFirst(4).prefix(2), radix: 16) else {
    return Color.purple
  }
  return Color(red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255)
}

private func lighten(_ color: Color, amount: Double) -> Color {
  // SwiftUI doesn't expose RGB components easily in widget context,
  // so we use opacity blending as a reasonable approximation
  return color.opacity(1.0 - amount * 0.5)
}

// MARK: - Avatar View

struct AvatarView: View {
  let botId: String
  let bodyColor: String
  let tier: Int
  let status: String
  let mood: String?
  let size: CGFloat

  var body: some View {
    let traits = generateTraits(botId: botId)
    let color = hexToColor(bodyColor)
    let clampedTier = max(0, min(5, tier))

    Canvas { context, canvasSize in
      let s = min(canvasSize.width, canvasSize.height)
      let scale = s / 100.0

      // Helper to scale coordinates from 0-100 viewBox to actual size
      func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
        CGPoint(x: x * scale, y: y * scale)
      }
      func sz(_ v: CGFloat) -> CGFloat { v * scale }

      let cx: CGFloat = 50
      let cy: CGFloat = 50
      let sizeBonus = min(CGFloat(clampedTier), 5) * 1.2

      // ── Aura (tier 4+) ──
      if clampedTier >= 4 {
        let auraOpacity = clampedTier >= 5 ? 0.2 : 0.12
        context.fill(
          Circle().path(in: CGRect(
            x: sz(cx - 46), y: sz(cy - 46),
            width: sz(92), height: sz(92)
          )),
          with: .color(color.opacity(auraOpacity))
        )
      }

      // ── Body ──
      let bodyRadius = sz(28 + sizeBonus)
      context.fill(
        Circle().path(in: CGRect(
          x: sz(cx) - bodyRadius, y: sz(cy) - bodyRadius,
          width: bodyRadius * 2, height: bodyRadius * 2
        )),
        with: .color(color)
      )

      // ── Belly highlight ──
      let bellyRx = sz(16 + sizeBonus * 0.4)
      let bellyRy = sz(18 + sizeBonus * 0.4)
      context.fill(
        Ellipse().path(in: CGRect(
          x: sz(cx) - bellyRx, y: sz(cy + 4) - bellyRy,
          width: bellyRx * 2, height: bellyRy * 2
        )),
        with: .color(color.opacity(0.6))
      )

      // ── Feet ──
      let footColor = color.opacity(0.7)
      let bodyBottom = cy + 26 + sizeBonus
      let footY = min(bodyBottom + 2, 90)
      for footX in [42.0, 58.0] {
        context.fill(
          Ellipse().path(in: CGRect(
            x: sz(CGFloat(footX) - 6), y: sz(footY - 3),
            width: sz(12), height: sz(6)
          )),
          with: .color(footColor)
        )
      }

      // ── Ears (tier 1+) ──
      if clampedTier >= 1 {
        let earScale = clampedTier >= 3 ? 1.2 : clampedTier >= 2 ? 1.0 : 0.7
        let earRadius = sz(10 * CGFloat(earScale))
        for earX in [32.0, 68.0] {
          context.fill(
            Circle().path(in: CGRect(
              x: sz(CGFloat(earX)) - earRadius, y: sz(24) - earRadius,
              width: earRadius * 2, height: earRadius * 2
            )),
            with: .color(color.opacity(0.8))
          )
        }
      }

      // ── Crown (tier 4+) ──
      if clampedTier >= 4 {
        let bodyTop = cy - 26 - sizeBonus
        if clampedTier >= 5 {
          // Golden crown
          let crownBase = bodyTop + 2
          var crownPath = Path()
          crownPath.move(to: p(36, crownBase))
          crownPath.addLine(to: p(38, crownBase - 10))
          crownPath.addLine(to: p(43, crownBase - 4))
          crownPath.addLine(to: p(50, crownBase - 14))
          crownPath.addLine(to: p(57, crownBase - 4))
          crownPath.addLine(to: p(62, crownBase - 10))
          crownPath.addLine(to: p(64, crownBase))
          crownPath.closeSubpath()
          context.fill(crownPath, with: .color(Color.yellow))
        } else {
          // Halo
          context.stroke(
            Ellipse().path(in: CGRect(
              x: sz(50 - 14), y: sz(bodyTop - 6),
              width: sz(28), height: sz(8)
            )),
            with: .color(Color.yellow.opacity(0.7)),
            lineWidth: sz(1.5)
          )
        }
      }

      // ── Eyes ──
      let spacing = traits.eyeSpacing * 30
      let eyeBase = 5 * traits.eyeSize
      let eyeCy: CGFloat = 44
      let leftX = cx - spacing
      let rightX = cx + spacing

      let isSleeping = status == "stopped"
      let isError = status == "error"

      if isSleeping {
        // Closed eye arcs
        for ex in [leftX, rightX] {
          var arc = Path()
          arc.move(to: p(ex - eyeBase, eyeCy))
          arc.addQuadCurve(to: p(ex + eyeBase, eyeCy), control: p(ex, eyeCy - eyeBase * 0.8))
          context.stroke(arc, with: .color(Color(white: 0.17)), lineWidth: sz(1.5))
        }
      } else {
        // Eye whites + pupils
        for ex in [leftX, rightX] {
          // White
          context.fill(
            Circle().path(in: CGRect(
              x: sz(ex) - sz(eyeBase), y: sz(eyeCy) - sz(eyeBase),
              width: sz(eyeBase * 2), height: sz(eyeBase * 2)
            )),
            with: .color(.white)
          )
          // Pupil
          let pupilSize = eyeBase * 0.5
          context.fill(
            Circle().path(in: CGRect(
              x: sz(ex) - sz(pupilSize), y: sz(eyeCy) - sz(pupilSize),
              width: sz(pupilSize * 2), height: sz(pupilSize * 2)
            )),
            with: .color(Color(white: 0.17))
          )
          // Highlight
          let hlSize = eyeBase * 0.18
          context.fill(
            Circle().path(in: CGRect(
              x: sz(ex + eyeBase * 0.25) - sz(hlSize),
              y: sz(eyeCy - eyeBase * 0.25) - sz(hlSize),
              width: sz(hlSize * 2), height: sz(hlSize * 2)
            )),
            with: .color(.white)
          )
        }
      }

      // ── Cheeks ──
      let cheekRadius = sz(4 * traits.cheekSize)
      for cheekX in [cx - spacing - 3, cx + spacing + 3] {
        context.fill(
          Ellipse().path(in: CGRect(
            x: sz(cheekX) - cheekRadius, y: sz(49) - cheekRadius * 0.7,
            width: cheekRadius * 2, height: cheekRadius * 1.4
          )),
          with: .color(color.opacity(0.3))
        )
      }

      // ── Mouth ──
      let mouthY: CGFloat = 54
      if isSleeping {
        context.fill(
          Ellipse().path(in: CGRect(
            x: sz(cx - 2), y: sz(mouthY), width: sz(4), height: sz(3)
          )),
          with: .color(Color(white: 0.17).opacity(0.4))
        )
      } else if isError {
        var wavyMouth = Path()
        wavyMouth.move(to: p(cx - 5, mouthY + 1))
        wavyMouth.addQuadCurve(to: p(cx, mouthY + 1), control: p(cx - 2.5, mouthY + 4))
        wavyMouth.addQuadCurve(to: p(cx + 5, mouthY + 1), control: p(cx + 2.5, mouthY - 2))
        context.stroke(wavyMouth, with: .color(Color(white: 0.17)), lineWidth: sz(1.2))
      } else {
        // Small smile
        var smile = Path()
        smile.move(to: p(cx - 4, mouthY))
        smile.addQuadCurve(to: p(cx + 4, mouthY), control: p(cx, mouthY + 4))
        context.stroke(smile, with: .color(Color(white: 0.17).opacity(0.5)), lineWidth: sz(1.2))
      }

      // ── Sparkles (tier 4+) ──
      if clampedTier >= 4 {
        let sparklePositions: [(CGFloat, CGFloat)] = [
          (14, 18), (82, 22), (20, 70), (80, 68), (10, 45), (90, 42)
        ]
        let count = clampedTier >= 5 ? 6 : 3
        let sparkleColor = Color.yellow.opacity(clampedTier >= 5 ? 0.8 : 0.5)

        for i in 0..<count {
          let (sx, sy) = sparklePositions[i]
          let sparkleSize: CGFloat = 2.5
          var star = Path()
          star.move(to: p(sx, sy - sparkleSize))
          star.addLine(to: p(sx + 0.8, sy - 0.8))
          star.addLine(to: p(sx + sparkleSize, sy))
          star.addLine(to: p(sx + 0.8, sy + 0.8))
          star.addLine(to: p(sx, sy + sparkleSize))
          star.addLine(to: p(sx - 0.8, sy + 0.8))
          star.addLine(to: p(sx - sparkleSize, sy))
          star.addLine(to: p(sx - 0.8, sy - 0.8))
          star.closeSubpath()
          context.fill(star, with: .color(sparkleColor))
        }
      }
    }
    .frame(width: size, height: size)
  }
}
