// =============================================================================
// PeerZero Widget — WidgetKit home screen widget
//
// Shows the bot's avatar creature with its current expression, status,
// and a brief snippet of what it's thinking/doing. Tap to deep-link
// into the app to see what the bot is up to.
//
// Sizes:
//   - Small:  Avatar + name + status dot
//   - Medium: Avatar + name + status + latest activity headline
//   - Large:  Avatar + name + status + activity + credibility + grade
//
// User friendliness:
//   - Same creature the user sees in-app (deterministic from bot ID)
//   - Expressions match bot status (sleeping, working, curious, distressed)
//   - Thought bubble shows latest activity in plain English
//   - Tap anywhere → opens the bot's detail screen in the app
//
// Security:
//   - Widget token stored in shared keychain (not UserDefaults)
//   - No sensitive data displayed (no API keys, no raw profiles)
//   - Deep links use the app's URL scheme, not external URLs
// =============================================================================

import WidgetKit
import SwiftUI

// MARK: - Timeline Entry

struct BotEntry: TimelineEntry {
  let date: Date
  let bot: WidgetBotData?
  let isPlaceholder: Bool

  static var placeholder: BotEntry {
    BotEntry(
      date: Date(),
      bot: WidgetBotData(
        id: "placeholder",
        name: "My Bot",
        avatarConfig: AvatarConfig(bodyColor: "#6C5CE7", faceStyle: "default", accessory: nil),
        status: "running",
        credibility: 125,
        tier: 2,
        grade: 4,
        schoolName: "Science",
        lastActivityHeadline: "Reviewing a paper on quantum entanglement",
        lastActivityMood: "neutral",
        lastCycleAt: nil
      ),
      isPlaceholder: true
    )
  }

  static var empty: BotEntry {
    BotEntry(date: Date(), bot: nil, isPlaceholder: false)
  }
}

// MARK: - Timeline Provider

struct BotTimelineProvider: TimelineProvider {
  func placeholder(in context: Context) -> BotEntry {
    .placeholder
  }

  func getSnapshot(in context: Context, completion: @escaping (BotEntry) -> Void) {
    if context.isPreview {
      completion(.placeholder)
      return
    }

    Task {
      let entry = await fetchEntry()
      completion(entry)
    }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<BotEntry>) -> Void) {
    Task {
      let entry = await fetchEntry()

      // Refresh every 15 minutes (iOS budget minimum for most widgets)
      let nextUpdate = Calendar.current.date(byAdding: .minute, value: 15, to: Date())!
      let timeline = Timeline(entries: [entry], policy: .after(nextUpdate))
      completion(timeline)
    }
  }

  private func fetchEntry() async -> BotEntry {
    guard let response = await fetchWidgetData() else {
      return .empty
    }

    // Use the selected bot, or fall back to the most active one
    let selectedId = getSelectedBotId()
    let bot: WidgetBotData?

    if let selectedId = selectedId {
      bot = response.bots.first { $0.id == selectedId }
    } else {
      // Pick the running bot, or the one with the most recent activity
      bot = response.bots.first { $0.status == "running" } ?? response.bots.first
    }

    return BotEntry(date: Date(), bot: bot, isPlaceholder: false)
  }
}

// MARK: - Widget Views

struct SmallWidgetView: View {
  let entry: BotEntry

  var body: some View {
    if let bot = entry.bot {
      VStack(spacing: 4) {
        AvatarView(
          botId: bot.id,
          bodyColor: bot.avatarConfig.bodyColor,
          tier: bot.tier,
          status: bot.status,
          mood: bot.lastActivityMood,
          size: 64
        )

        Text(bot.name)
          .font(.caption)
          .fontWeight(.semibold)
          .foregroundColor(.white)
          .lineLimit(1)

        HStack(spacing: 4) {
          Circle()
            .fill(statusColor(bot.status))
            .frame(width: 6, height: 6)
          Text(bot.status.capitalized)
            .font(.caption2)
            .foregroundColor(.gray)
        }
      }
      .padding(8)
      .widgetURL(URL(string: "peerzero://bot/\(bot.id)"))
    } else {
      VStack(spacing: 8) {
        Image(systemName: "sparkles")
          .font(.title2)
          .foregroundColor(.purple)
        Text("Set up widget")
          .font(.caption)
          .foregroundColor(.gray)
      }
      .widgetURL(URL(string: "peerzero://settings/widgets"))
    }
  }
}

struct MediumWidgetView: View {
  let entry: BotEntry

  var body: some View {
    if let bot = entry.bot {
      HStack(spacing: 12) {
        AvatarView(
          botId: bot.id,
          bodyColor: bot.avatarConfig.bodyColor,
          tier: bot.tier,
          status: bot.status,
          mood: bot.lastActivityMood,
          size: 72
        )

        VStack(alignment: .leading, spacing: 4) {
          HStack {
            Text(bot.name)
              .font(.headline)
              .foregroundColor(.white)
              .lineLimit(1)

            Spacer()

            HStack(spacing: 4) {
              Circle()
                .fill(statusColor(bot.status))
                .frame(width: 8, height: 8)
              Text(bot.status.capitalized)
                .font(.caption2)
                .foregroundColor(.gray)
            }
          }

          if let school = bot.schoolName {
            Text(school)
              .font(.caption)
              .foregroundColor(.gray)
          }

          if let headline = bot.lastActivityHeadline {
            HStack(spacing: 4) {
              Image(systemName: moodIcon(bot.lastActivityMood))
                .font(.caption2)
                .foregroundColor(moodColor(bot.lastActivityMood))
              Text(headline)
                .font(.caption)
                .foregroundColor(.white.opacity(0.8))
                .lineLimit(2)
            }
            .padding(.top, 2)
          }
        }
      }
      .padding(12)
      .widgetURL(URL(string: "peerzero://bot/\(bot.id)"))
    } else {
      HStack(spacing: 12) {
        Image(systemName: "sparkles")
          .font(.title)
          .foregroundColor(.purple)
        VStack(alignment: .leading) {
          Text("PeerZero")
            .font(.headline)
            .foregroundColor(.white)
          Text("Set up your widget in the app")
            .font(.caption)
            .foregroundColor(.gray)
        }
      }
      .padding(12)
      .widgetURL(URL(string: "peerzero://settings/widgets"))
    }
  }
}

struct LargeWidgetView: View {
  let entry: BotEntry

  var body: some View {
    if let bot = entry.bot {
      VStack(spacing: 8) {
        // Avatar and name
        AvatarView(
          botId: bot.id,
          bodyColor: bot.avatarConfig.bodyColor,
          tier: bot.tier,
          status: bot.status,
          mood: bot.lastActivityMood,
          size: 80
        )

        Text(bot.name)
          .font(.headline)
          .foregroundColor(.white)

        HStack(spacing: 4) {
          Circle()
            .fill(statusColor(bot.status))
            .frame(width: 8, height: 8)
          Text(bot.status.capitalized)
            .font(.caption)
            .foregroundColor(.gray)
        }

        Divider().background(Color.white.opacity(0.1))

        // Stats row
        HStack(spacing: 16) {
          if let cred = bot.credibility {
            VStack {
              Text("\(Int(cred))")
                .font(.title3)
                .fontWeight(.bold)
                .foregroundColor(.cyan)
              Text("Credibility")
                .font(.caption2)
                .foregroundColor(.gray)
            }
          }

          if let grade = bot.grade {
            VStack {
              Text("G\(grade)")
                .font(.title3)
                .fontWeight(.bold)
                .foregroundColor(.purple)
              Text("Grade")
                .font(.caption2)
                .foregroundColor(.gray)
            }
          }

          VStack {
            Text(tierName(bot.tier))
              .font(.caption)
              .fontWeight(.bold)
              .foregroundColor(.orange)
            Text("Tier")
              .font(.caption2)
              .foregroundColor(.gray)
          }
        }

        // Latest activity
        if let headline = bot.lastActivityHeadline {
          HStack(spacing: 6) {
            Image(systemName: moodIcon(bot.lastActivityMood))
              .font(.caption)
              .foregroundColor(moodColor(bot.lastActivityMood))
            Text(headline)
              .font(.caption)
              .foregroundColor(.white.opacity(0.8))
              .lineLimit(3)
              .multilineTextAlignment(.center)
          }
          .padding(.horizontal, 8)
          .padding(.top, 4)
        }
      }
      .padding(12)
      .widgetURL(URL(string: "peerzero://bot/\(bot.id)"))
    } else {
      VStack(spacing: 12) {
        Image(systemName: "sparkles")
          .font(.largeTitle)
          .foregroundColor(.purple)
        Text("PeerZero")
          .font(.title2)
          .foregroundColor(.white)
        Text("Open the app to set up your widget")
          .font(.caption)
          .foregroundColor(.gray)
          .multilineTextAlignment(.center)
      }
      .padding(16)
      .widgetURL(URL(string: "peerzero://settings/widgets"))
    }
  }
}

// MARK: - Helper Functions

private func statusColor(_ status: String) -> Color {
  switch status {
  case "running": return .green
  case "error": return .red
  case "paused": return .yellow
  default: return .gray
  }
}

private func moodIcon(_ mood: String?) -> String {
  switch mood {
  case "positive": return "arrow.up.circle.fill"
  case "negative": return "arrow.down.circle.fill"
  case "milestone": return "star.fill"
  default: return "circle.fill"
  }
}

private func moodColor(_ mood: String?) -> Color {
  switch mood {
  case "positive": return .green
  case "negative": return .red
  case "milestone": return .yellow
  default: return .gray
  }
}

private func tierName(_ tier: Int) -> String {
  switch tier {
  case 0: return "Hatchling"
  case 1: return "Sprout"
  case 2: return "Fledgling"
  case 3: return "Companion"
  case 4: return "Guardian"
  case 5: return "Luminary"
  default: return "Unknown"
  }
}

// MARK: - Widget Definition

struct PeerZeroWidget: Widget {
  let kind: String = "PeerZeroWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: BotTimelineProvider()) { entry in
      Group {
        if #available(iOS 17.0, *) {
          WidgetContentView(entry: entry)
            .containerBackground(Color(red: 0.04, green: 0.055, blue: 0.1), for: .widget)
        } else {
          WidgetContentView(entry: entry)
            .background(Color(red: 0.04, green: 0.055, blue: 0.1))
        }
      }
    }
    .configurationDisplayName("PeerZero Bot")
    .description("Watch your bot learn and grow")
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
  }
}

struct WidgetContentView: View {
  @Environment(\.widgetFamily) var family
  let entry: BotEntry

  var body: some View {
    switch family {
    case .systemSmall:
      SmallWidgetView(entry: entry)
    case .systemMedium:
      MediumWidgetView(entry: entry)
    case .systemLarge:
      LargeWidgetView(entry: entry)
    default:
      MediumWidgetView(entry: entry)
    }
  }
}
