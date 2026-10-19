import Foundation

/// What one window shows that the bridge keeps live for it.
struct Viewing: Hashable, Sendable {
    var bot: BotID?
    var session: SessionID?
    /// The Sessions list, which a thread's header also reads.
    var sessionsList = false
}

/// One window's claim on what it shows. The window holds it while it is open and returns it when it closes.
struct ViewingLease: Hashable, Sendable {
    let id = UUID()
}

/// Every window's viewing, merged into what is on screen anywhere. A bot or thread stays live while any window shows
/// it, so a thread is unwatched only when its last window leaves it.
struct OnScreen: Equatable, Sendable {
    /// What one call changed on screen, in the order the bridge should hear it.
    struct Change: Equatable, Sendable {
        /// Bots newly on screen, to open, which marks them read.
        var opened: [BotID] = []
        /// Threads no window shows any more.
        var unwatched: [SessionID] = []
        /// Threads newly on screen.
        var watched: [SessionID] = []
        /// The list's watch, when it changed.
        var sessionsList: Bool?

        var isEmpty: Bool { self == Change() }
    }

    private var leases: [ViewingLease: Viewing] = [:]

    private(set) var bots: Set<BotID> = []
    private(set) var sessions: Set<SessionID> = []
    private(set) var sessionsList = false

    /// Sets what a window shows; nil returns its lease.
    mutating func set(_ viewing: Viewing?, for lease: ViewingLease) -> Change {
        let before = self
        leases[lease] = viewing
        bots = Set(leases.values.compactMap(\.bot))
        sessions = Set(leases.values.compactMap(\.session))
        sessionsList = leases.values.contains { $0.sessionsList }
        return Change(
            opened: bots.subtracting(before.bots).sorted { $0.rawValue < $1.rawValue },
            unwatched: before.sessions.subtracting(sessions).sorted { $0.rawValue < $1.rawValue },
            watched: sessions.subtracting(before.sessions).sorted { $0.rawValue < $1.rawValue },
            sessionsList: sessionsList == before.sessionsList ? nil : sessionsList
        )
    }
}
