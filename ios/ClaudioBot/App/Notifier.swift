import Foundation
import UserNotifications

/// Turns store alerts into local notifications and routes taps and answer actions back.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let enabledKey = "notificationsEnabled"
    private static let optionActions = ["OPTION_0", "OPTION_1"]

    var onOpenBot: (BotID) -> Void = { _ in }
    /// The card is the one the alert named, so the thread can say when it no longer waits.
    var onOpenSession: (SessionID, MessageID?) -> Void = { _, _ in }
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

    /// Skips alerts for the chats and threads on screen while the app is active.
    func post(_ alerts: [Alert], onScreen: OnScreen) {
        guard enabled else { return }
        let active = AppActivity.isActive
        for alert in alerts where Self.shows(alert, active: active, onScreen: onScreen) {
            Task { await post(alert) }
        }
    }

    /// Never buzz for what is on screen: the user already sees it.
    static func shows(_ alert: Alert, active: Bool, onScreen: OnScreen) -> Bool {
        guard active else { return true }
        switch alert {
        case .bot(let bot, _): return !onScreen.bots.contains(bot.id)
        case .session(let session): return !onScreen.sessions.contains(session.sessionId)
        }
    }

    /// Removes the bot's message notification and its card notifications, which share its thread.
    func clear(bot: BotID) {
        Task {
            let ids = await center.deliveredNotifications()
                .filter { $0.request.content.threadIdentifier == bot.rawValue }
                .map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    /// Removes the session's notification. Its thread is the session id, as the bridge's pushes for it are.
    func clear(session: SessionID) {
        Task {
            let ids = await center.deliveredNotifications()
                .filter { $0.request.content.threadIdentifier == session.rawValue }
                .map(\.request.identifier)
            center.removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    /// After unpairing, nothing on the lock screen should point at the old Mac.
    func clearAll() {
        center.removeAllDeliveredNotifications()
        center.removeAllPendingNotificationRequests()
    }

    /// Messages share one notification per bot, so a newer one replaces the older instead of stacking.
    /// Each card gets its own, so a later message cannot replace a question or approval still waiting on the user.
    /// A session has one: what it wants now replaces what it wanted before.
    static func identifier(for alert: Alert) -> String {
        switch alert {
        case .bot(let bot, .message): "bot-\(bot.id.rawValue)"
        case .bot(_, .question(let id, _, _)), .bot(_, .permission(let id, _)): "card-\(id.rawValue)"
        case .session(let session): "session-\(session.sessionId.rawValue)"
        }
    }

    /// Notifications group by bot, or by session (P-NOTIFY-4).
    static func thread(of alert: Alert) -> String {
        switch alert {
        case .bot(let bot, _): bot.id.rawValue
        case .session(let session): session.sessionId.rawValue
        }
    }

    /// The session's title, then what it wants. nil for a reason a newer bridge invented, which is not posted.
    static func text(of session: SessionAlert) -> (title: String, body: String)? {
        let title = session.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let body: String
        switch session.reason {
        case .card: body = Self.cards(session.count, session.cardKind)
        case .reminder: body = Self.reminder(session.count, session.cardKind)
        case .finished: body = "Finished"
        case .failed: body = Self.ending("Stopped with an error", session.running)
        case .lost: body = Self.ending("Interrupted by a bridge restart", session.running)
        case .unknown: return nil
        }
        return (title.isEmpty ? "Claude Code session" : title, body)
    }

    /// "Stopped with an error. 2 commands still run on your Mac.", or the bare ending when nothing outlived Claude Code.
    static func ending(_ ending: String, _ running: SessionRunning?) -> String {
        guard let running, let counted = SessionText.running(running) else { return ending }
        return "\(ending). \(counted) still \(running.agents + running.commands == 1 ? "runs" : "run") on your Mac."
    }

    /// Named by what the cards ask for. Mixed kinds, or a bridge that does not say, name none (as the bridge's push does).
    static func cards(_ n: Int, _ kind: SessionCardKind?) -> String {
        switch kind {
        case .permission?: n > 1 ? "Needs \(n) approvals" : "Needs your approval"
        case .ask?: n > 1 ? "Has \(n) questions for you" : "Has a question for you"
        case .plan?: n > 1 ? "Has \(n) plans for you to review" : "Has a plan for you to review"
        case .unknown?, nil: n > 1 ? "Needs you: \(n) requests" : "Needs you"
        }
    }

    static func reminder(_ n: Int, _ kind: SessionCardKind?) -> String {
        switch kind {
        case .permission?: n > 1 ? "Still waiting for \(n) approvals" : "Still waiting for your approval"
        case .ask?: n > 1 ? "Still waiting for \(n) answers" : "Still waiting for your answer"
        case .plan?, .unknown?, nil: "Still waiting for you"
        }
    }

    private func post(_ alert: Alert) async {
        let content = UNMutableNotificationContent()
        content.threadIdentifier = Self.thread(of: alert)
        content.sound = .default
        switch alert {
        case let .bot(bot, reason):
            content.title = bot.name
            content.userInfo = ["botId": bot.id.rawValue]
            switch reason {
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
        case let .session(session):
            guard let text = Self.text(of: session) else { return }
            content.title = text.title
            content.body = text.body
            content.userInfo = ["sessionId": session.sessionId.rawValue]
            if let card = session.cardId { content.userInfo["cardId"] = card.rawValue }
        }
        try? await center.add(UNNotificationRequest(identifier: Self.identifier(for: alert), content: content, trigger: nil))
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
        if let session = info["sessionId"] as? String {
            let card = (info["cardId"] as? String).map { MessageID($0) }
            return await open(session: SessionID(session), card: card)
        }
        guard let bot = info["botId"] as? String else { return }
        let message = info["messageId"] as? String
        let action = response.actionIdentifier
        await handle(action: action, bot: BotID(bot), message: message.map { MessageID($0) })
    }

    private func open(session: SessionID, card: MessageID?) {
        onOpenSession(session, card)
    }

    private func handle(action: String, bot: BotID, message: MessageID?) async {
        if let message, let option = Self.optionActions.firstIndex(of: action) {
            await onAnswer(bot, message, option)
        } else {
            onOpenBot(bot)
        }
    }
}
