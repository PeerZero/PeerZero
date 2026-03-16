// =============================================================================
// Widget Data Provider — fetches bot data for the iOS widget timeline
//
// Security:
//   - Widget token stored in App Group keychain (never in UserDefaults)
//   - Token scoped read-only to widget data endpoint
//   - All network calls use URLSession with TLS
//   - No API keys or sensitive data in widget storage
//
// Scalability:
//   - Timeline refresh every 15 min (iOS minimum for budget widgets)
//   - ETag support for conditional fetching — avoids redundant transfers
//   - Compact JSON response (~200-500 bytes per bot)
// =============================================================================

import WidgetKit
import Foundation
import Security

// MARK: - Data Models

struct WidgetBotData: Codable {
  let id: String
  let name: String
  let avatarConfig: AvatarConfig
  let status: String
  let credibility: Double?
  let tier: Int
  let grade: Int?
  let schoolName: String?
  let lastActivityHeadline: String?
  let lastActivityMood: String?
  let lastCycleAt: String?

  enum CodingKeys: String, CodingKey {
    case id, name, status, credibility, tier, grade
    case avatarConfig = "avatar_config"
    case schoolName = "school_name"
    case lastActivityHeadline = "last_activity_headline"
    case lastActivityMood = "last_activity_mood"
    case lastCycleAt = "last_cycle_at"
  }
}

struct AvatarConfig: Codable {
  let bodyColor: String
  let faceStyle: String?
  let accessory: String?

  enum CodingKeys: String, CodingKey {
    case bodyColor = "body_color"
    case faceStyle = "face_style"
    case accessory
  }
}

struct WidgetDataResponse: Codable {
  let bots: [WidgetBotData]
  let updatedAt: String

  enum CodingKeys: String, CodingKey {
    case bots
    case updatedAt = "updated_at"
  }
}

// MARK: - Keychain Helpers (App Group shared keychain)

private let appGroupId = "group.com.peerzero.app"
private let tokenKeychainKey = "com.peerzero.widget-token"
private let apiBaseKeychainKey = "com.peerzero.api-base-url"

func getWidgetToken() -> String? {
  let query: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrAccount as String: tokenKeychainKey,
    kSecAttrAccessGroup as String: appGroupId,
    kSecReturnData as String: true,
    kSecMatchLimit as String: kSecMatchLimitOne,
  ]

  var result: AnyObject?
  let status = SecItemCopyMatching(query as CFDictionary, &result)
  guard status == errSecSuccess, let data = result as? Data else { return nil }
  return String(data: data, encoding: .utf8)
}

func getApiBaseUrl() -> String {
  let defaults = UserDefaults(suiteName: appGroupId)
  return defaults?.string(forKey: "apiBaseUrl") ?? "https://api.peerzero.app"
}

func getSelectedBotId() -> String? {
  let defaults = UserDefaults(suiteName: appGroupId)
  return defaults?.string(forKey: "widgetBotId")
}

// MARK: - Data Fetcher

func fetchWidgetData() async -> WidgetDataResponse? {
  guard let token = getWidgetToken() else { return nil }

  let baseUrl = getApiBaseUrl()
  guard let url = URL(string: "\(baseUrl)/api/widgets/data") else { return nil }

  var request = URLRequest(url: url)
  request.setValue(token, forHTTPHeaderField: "X-Widget-Token")
  request.timeoutInterval = 15

  // ETag for conditional fetching
  let defaults = UserDefaults(suiteName: appGroupId)
  if let etag = defaults?.string(forKey: "widgetDataETag") {
    request.setValue(etag, forHTTPHeaderField: "If-None-Match")
  }

  do {
    let (data, response) = try await URLSession.shared.data(for: request)
    guard let httpResponse = response as? HTTPURLResponse else { return nil }

    if httpResponse.statusCode == 304 {
      // Not modified — return cached data
      if let cachedData = defaults?.data(forKey: "widgetDataCache"),
         let cached = try? JSONDecoder().decode(WidgetDataResponse.self, from: cachedData) {
        return cached
      }
      return nil
    }

    guard httpResponse.statusCode == 200 else { return nil }

    // Store ETag and cache
    if let etag = httpResponse.value(forHTTPHeaderField: "ETag") {
      defaults?.set(etag, forKey: "widgetDataETag")
    }
    defaults?.set(data, forKey: "widgetDataCache")

    return try JSONDecoder().decode(WidgetDataResponse.self, from: data)
  } catch {
    // Network error — return cached data if available
    if let cachedData = defaults?.data(forKey: "widgetDataCache"),
       let cached = try? JSONDecoder().decode(WidgetDataResponse.self, from: cachedData) {
      return cached
    }
    return nil
  }
}
