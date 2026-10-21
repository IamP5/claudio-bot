import Foundation

/// How a machine reads in Settings, on chips and in pickers.
enum MachineText {
    static func access(_ access: MachineAccess) -> String {
        switch (access.full, access.sandbox) {
        case (true, false): "Full access, no sandbox"
        case (true, true): "Full access"
        case (false, false): "Guarded, no sandbox"
        case (false, true): "Guarded"
        }
    }

    static func platform(_ platform: MachinePlatform) -> String {
        switch platform {
        case .darwin: "macOS"
        case .linux: "Linux"
        case .unknown(let raw): raw
        }
    }

    /// "Online", or "Offline since 11:10 PM", "Offline since yesterday", "Offline since Monday", "Offline since Oct 9".
    static func presence(_ machine: Machine, now: Date = .now, calendar: Calendar = .current) -> String {
        if machine.online { return "Online" }
        guard let since = machine.since else { return "Offline" }
        let when = TimeLabel.home(since, now: now, calendar: calendar)
        return "Offline since \(when == "Yesterday" ? "yesterday" : when)"
    }

    /// The connectors worth a chip, once each: a browser and computer use. Other MCP servers are not named.
    static func connectorChips(_ connectors: [MachineConnector]) -> [String] {
        let kinds = Set(connectors.map(\.kind))
        return [(ConnectorKind.chrome, "Chrome"), (.computerUse, "Computer use")].compactMap { kinds.contains($0.0) ? $0.1 : nil }
    }

    /// A picker row: the name, marked when the machine is away, since an agent placed there waits for it.
    static func choice(_ machine: Machine) -> String {
        machine.online ? machine.name : "\(machine.name) (offline)"
    }

    /// The confirmation before removing a machine, nil for the home, which cannot be removed.
    static func removal(_ machine: Machine) -> (title: String, message: String)? {
        guard machine.role != .home else { return nil }
        return (
            "Remove \(machine.name)?",
            "Its agents stop being reachable from your \(ThisDevice.casualNoun). \(machine.name) keeps its files and transcripts."
        )
    }

    /// What another computer runs to enroll with this code, at the first address the home listed.
    static func enrollCommand(_ code: PairCode) -> String? {
        code.urls?.first.map { "claudiobot machine enroll \($0) \(code.code)" }
    }
}

/// Where a new session can start: a project on a machine. machine nil: the home's own, as a bridge without machines
/// has it.
struct SessionPlace: Hashable, Sendable {
    let machine: MachineID?
    let project: ProjectID
}

/// One machine's projects in the New Session picker.
struct MachineProjects: Identifiable, Equatable {
    let machine: Machine
    let projects: [SessionProject]
    var id: MachineID { machine.id }

    /// Each project under its own machine, or the home's when the bridge names none. Machines with no projects are left
    /// out; the home leads.
    static func group(_ projects: [SessionProject], machines: [Machine]) -> [MachineProjects] {
        let home = machines.first { $0.role == .home }?.id
        let ordered = machines.filter { $0.role == .home } + machines.filter { $0.role != .home }
        return ordered.compactMap { machine in
            let mine = projects.filter { ($0.machine ?? home) == machine.id }
            return mine.isEmpty ? nil : MachineProjects(machine: machine, projects: mine)
        }
    }
}
