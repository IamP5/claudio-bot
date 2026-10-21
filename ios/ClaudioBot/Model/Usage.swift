import Foundation

enum UsageText {
    /// "37% used". Below the limit it never rounds up to 100%, and at the limit it never reads less.
    static func used(_ utilization: Double) -> String {
        "\(percent(utilization))% used"
    }

    static func percent(_ utilization: Double) -> Int {
        let rounded = Int((max(0, utilization) * 100).rounded())
        return utilization < 1 ? min(rounded, 99) : max(rounded, 100)
    }

    static func resets(_ at: Date?, now: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String? {
        guard let at else { return nil }
        let left = at.timeIntervalSince(now)
        if left < 60 { return "Resets in under a minute" }
        if left < 24 * 3600 { return "Resets in \(duration(left, spoken: false))" }
        return "Resets \(day(at, left: left, wide: false, locale: locale, timeZone: timeZone))"
    }

    static func spoken(_ window: UsageWindow, now: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        let name = window.label.replacingOccurrences(of: " · ", with: ", ")
        let used = "\(percent(window.utilization)) percent used"
        guard let at = window.resetsAt else { return "\(name), \(used)" }
        let left = at.timeIntervalSince(now)
        let reset = left < 60 ? "resets in under a minute"
            : left < 24 * 3600 ? "resets in \(duration(left, spoken: true))"
            : "resets \(day(at, left: left, wide: true, locale: locale, timeZone: timeZone))"
        return "\(name), \(used), \(reset)"
    }

    static func updated(_ at: Date, now: Date) -> String {
        let ago = max(0, now.timeIntervalSince(at))
        if ago < 60 { return "Updated just now" }
        if ago < 3600 { return "Updated \(Int(ago / 60)) min ago" }
        if ago < 24 * 3600 { return "Updated \(Int(ago / 3600)) h ago" }
        return "Updated \(Int(ago / 86400)) d ago"
    }

    static func status(_ usage: PlanUsage, now: Date) -> String {
        if case .ok(_, let at, true, _) = usage { return "Couldn't refresh. \(updated(at, now: now))." }
        return updated(usage.fetchedAt, now: now)
    }

    static func plan(_ raw: String?) -> String? {
        guard let raw = raw?.trimmingCharacters(in: .whitespaces), !raw.isEmpty else { return nil }
        return "Claude \(raw.prefix(1).uppercased())\(raw.dropFirst())"
    }

    /// computer: where Claude Code is logged in, the bridge's.
    static func unavailable(_ reason: UsageUnavailable, on computer: String) -> String {
        switch reason {
        case .loggedOut: "Log in to Claude Code on \(computer) with your Claude subscription."
        case .apiKey: "Claude Code on \(computer) uses an API key, which has no plan limits. Log in with your Claude subscription to see them."
        case .thirdParty: "Claude Code on \(computer) uses Bedrock, Vertex or another provider, which has no plan limits."
        case .noScope: "Claude Code's login on \(computer) can't read usage. Run /login in Claude Code there to log in again."
        case .failed, .unknown: "The bridge on \(computer) couldn't read usage from Claude Code. Pull down to try again."
        }
    }

    private static func duration(_ seconds: TimeInterval, spoken: Bool) -> String {
        let minutes = Int((seconds / 60).rounded(.up))
        let (h, m) = (minutes / 60, minutes % 60)
        let hours = spoken ? "\(h) hour\(h == 1 ? "" : "s")" : "\(h) h"
        let mins = spoken ? "\(m) minute\(m == 1 ? "" : "s")" : "\(m) min"
        if h == 0 { return mins }
        return m == 0 ? hours : "\(hours) \(mins)"
    }

    private static func day(_ at: Date, left: TimeInterval, wide: Bool, locale: Locale, timeZone: TimeZone) -> String {
        var style = Date.FormatStyle(locale: locale, timeZone: timeZone).hour().minute()
        style = left < 6 * 24 * 3600 ? style.weekday(wide ? .wide : .abbreviated) : style.month(wide ? .wide : .abbreviated).day()
        return at.formatted(style)
    }
}

extension PlanUsage {
    /// The 5-hour window, which the bot list shows.
    var session: UsageWindow? {
        if case .ok(_, _, _, let windows) = self { windows.first { $0.kind == .session } } else { nil }
    }
}
