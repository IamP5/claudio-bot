import Foundation
import UIKit
import UserNotifications

/// Turns store attention into local notifications and routes taps and approval actions back.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    static let enabledKey = "notificationsEnabled"
    private static let approvalCategory = "APPROVAL"
    private static let allowAction = "ALLOW"
    private static let denyAction = "DENY"

    var onOpenTask: (TaskID) -> Void = { _ in }
    var onDecide: (TaskID, ItemID, Decision) async -> Void = { _, _, _ in }

    private let center = UNUserNotificationCenter.current()

    override init() {
        super.init()
        center.delegate = self
        let allow = UNNotificationAction(identifier: Self.allowAction, title: "Allow", options: [])
        let deny = UNNotificationAction(identifier: Self.denyAction, title: "Deny", options: [.destructive])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: Self.approvalCategory, actions: [allow, deny], intentIdentifiers: []),
        ])
    }

    private var enabled: Bool {
        UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true
    }

    func requestAuthorization() async {
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    func post(_ attention: [Attention], viewing: TaskID?) {
        guard enabled else { return }
        let active = UIApplication.shared.applicationState == .active
        for item in attention where !(active && item.task.id == viewing) {
            center.add(request(for: item))
        }
    }

    func clear(task: TaskID) {
        let id = Self.identifier(task)
        center.removeDeliveredNotifications(withIdentifiers: [id])
        center.removePendingNotificationRequests(withIdentifiers: [id])
    }

    // One notification per task: a newer reason replaces the older one instead of stacking.
    private static func identifier(_ task: TaskID) -> String { "task-\(task.rawValue)" }

    private func request(for attention: Attention) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        let task = attention.task
        content.title = task.title
        content.threadIdentifier = task.id.rawValue
        content.sound = .default
        content.userInfo = ["taskId": task.id.rawValue]
        switch attention.reason {
        case .approval(let a):
            content.body = "Claude needs approval: \(a.tool) \(a.summary)"
            content.categoryIdentifier = Self.approvalCategory
            content.userInfo["itemId"] = a.id.rawValue
        case .question(let q):
            content.body = "Claude has a question: \(q.questions.first?.question ?? "tap to answer")"
        case .needsInput:
            content.body = "Claude is waiting for you."
        case .finished:
            let label = task.statusDisplay.title
            content.body = task.preview.isEmpty ? "\(label)." : "\(label): \(task.preview)"
        case .failed:
            content.body = task.preview.isEmpty ? "The task failed." : "Failed: \(task.preview)"
        }
        return UNNotificationRequest(identifier: Self.identifier(task.id), content: content, trigger: nil)
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
        guard let task = info["taskId"] as? String else { return }
        let item = info["itemId"] as? String
        let action = response.actionIdentifier
        await handle(action: action, task: TaskID(task), item: item.map { ItemID($0) })
    }

    private func handle(action: String, task: TaskID, item: ItemID?) async {
        switch (action, item) {
        case (Self.allowAction, let item?): await onDecide(task, item, .allow)
        case (Self.denyAction, let item?): await onDecide(task, item, .deny)
        default: onOpenTask(task)
        }
    }
}
