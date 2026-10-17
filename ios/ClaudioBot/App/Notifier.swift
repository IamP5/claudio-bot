import Foundation
import UIKit
import UserNotifications

/// Turns store alerts into local notifications and routes taps and answer actions back.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let enabledKey = "notificationsEnabled"
    private static let optionActions = ["OPTION_0", "OPTION_1"]

    var onOpenBot: (BotID) -> Void = { _ in }
    var onAnswer: (BotID, MessageID, Int) async -> Void = { _, _, _ in }

    private let center = UNUserNotificationCenter.current()

    override init() {
        super.init()
        center.delegate = self
    }

    private var enabled: Bool {
        UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true
    }

    func requestAuthorization() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    func post(_ alerts: [Alert], viewing: BotID?) {
        guard enabled else { return }
        let active = UIApplication.shared.applicationState == .active
        for alert in alerts where !(active && alert.bot.id == viewing) {
            Task { await post(alert) }
        }
    }

    func clear(bot: BotID) {
        let id = Self.identifier(bot)
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.removePendingNotificationRequests(withIdentifiers: [id])
    }

    // One notification per bot: a newer message replaces the older one instead of stacking.
    private static func identifier(_ bot: BotID) -> String { "bot-\(bot.rawValue)" }

    private func post(_ alert: Alert) async {
        let content = UNMutableNotificationContent()
        content.title = alert.bot.name
        content.threadIdentifier = alert.bot.id.rawValue
        content.sound = .default
        content.userInfo = ["botId": alert.bot.id.rawValue]
        switch alert.reason {
        case .message(let text):
            content.body = text
        case let .question(id, question, options):
            content.body = question
            content.userInfo["messageId"] = id.rawValue
            content.categoryIdentifier = await registerCategory(for: id, options: options)
        case .permission(_, let label):
            // No approve action here: the user decides with the exact command in front of them.
            content.body = "Needs your approval: \(label)"
        }
        try? await center.add(UNNotificationRequest(identifier: Self.identifier(alert.bot.id), content: content, trigger: nil))
    }

    /// Action titles are fixed per category, so each question gets its own category with its first two options.
    private func registerCategory(for id: MessageID, options: [String]) async -> String {
        let name = "QUESTION-\(id.rawValue)"
        let actions = zip(Self.optionActions, options).map { action, title in
            UNNotificationAction(identifier: action, title: title, options: [])
        }
        let category = UNNotificationCategory(identifier: name, actions: actions, intentIdentifiers: [])
        let existing = await center.notificationCategories().filter { $0.identifier != name }
        // Keep the set from growing without bound across many questions.
        center.setNotificationCategories(Set(existing.suffix(30)).union([category]))
        return name
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let info = response.notification.request.content.userInfo
        guard let bot = info["botId"] as? String else { return }
        let message = info["messageId"] as? String
        let action = response.actionIdentifier
        await handle(action: action, bot: BotID(bot), message: message.map { MessageID($0) })
    }

    private func handle(action: String, bot: BotID, message: MessageID?) async {
        if let message, let option = Self.optionActions.firstIndex(of: action) {
            await onAnswer(bot, message, option)
        } else {
            onOpenBot(bot)
        }
    }
}
