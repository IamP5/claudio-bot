import AppKit
import Foundation
import Observation
import os

/// Where to look for the bridge on this Mac before its plist says otherwise: the CLI's label, port, home and log folder.
struct ServiceLocation: Equatable, Sendable {
    static let standardLabel = "com.claudiobot.bridge"

    var label: String
    var port: Int
    var home: URL
    var logDir: URL
    var launchAgents: URL

    var plist: URL { launchAgents.appending(path: "\(label).plist") }

    static func standard(user: URL = FileManager.default.homeDirectoryForCurrentUser) -> ServiceLocation {
        ServiceLocation(
            label: standardLabel, port: 7878, home: user.appending(path: ".claudiobot"),
            logDir: user.appending(path: "Library/Logs/ClaudioBot"), launchAgents: user.appending(path: "Library/LaunchAgents")
        )
    }

    /// The location this app manages. A Debug build takes `-bridgeLabel`, `-bridgePort`, `-bridgeHome` and
    /// `-bridgeLogDir`, so a check drives a throwaway service and never the user's own.
    static var current: ServiceLocation {
        var location = standard()
        #if DEBUG
        let args = UserDefaults.standard
        if let label = args.string(forKey: "bridgeLabel") { location.label = label }
        if let port = args.string(forKey: "bridgePort").flatMap(Int.init) { location.port = port }
        if let home = args.string(forKey: "bridgeHome") { location.home = URL(filePath: home) }
        if let logDir = args.string(forKey: "bridgeLogDir") { location.logDir = URL(filePath: logDir) }
        #endif
        return location
    }
}

/// What an installed LaunchAgent plist says about the bridge it runs.
struct InstalledPlist: Equatable, Sendable {
    var programArguments: [String]
    var workingDirectory: String?
    var environment: [String: String]
    var log: String?

    var port: Int? { environment["CLAUDIOBOT_PORT"].flatMap(Int.init) }
    var home: String? { environment["CLAUDIOBOT_HOME"] }
    /// `claudiobot install` runs <checkout>/bridge/src/main.ts from <checkout>/bridge.
    var checkout: URL? { workingDirectory.map { URL(filePath: $0).deletingLastPathComponent() } }

    /// nil when the data is not a plist dictionary. Fields of the wrong type read as absent.
    init?(data: Data) {
        guard let dict = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any] else { return nil }
        programArguments = dict["ProgramArguments"] as? [String] ?? []
        workingDirectory = dict["WorkingDirectory"] as? String
        environment = (dict["EnvironmentVariables"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String }
        log = dict["StandardOutPath"] as? String
    }

    init(programArguments: [String] = [], workingDirectory: String? = nil, environment: [String: String] = [:], log: String? = nil) {
        self.programArguments = programArguments
        self.workingDirectory = workingDirectory
        self.environment = environment
        self.log = log
    }
}

/// launchd's view of the job: the top-level `pid` and `last exit code` of `launchctl print gui/<uid>/<label>`.
struct LaunchdJob: Equatable, Sendable {
    var pid: Int?
    /// nil when the job never exited.
    var lastExit: Int?

    /// Nested blocks (endpoints, sockets) repeat keys one tab deeper, so only lines with a single leading tab count.
    init(launchctlPrint text: String) {
        func top(_ key: String) -> String? {
            text.split(separator: "\n").lazy.compactMap { line -> String? in
                let prefix = "\t\(key) = "
                return line.hasPrefix(prefix) ? String(line.dropFirst(prefix.count)) : nil
            }.first
        }
        pid = top("pid").flatMap { Int($0) }
        lastExit = top("last exit code").flatMap { Int($0.prefix { $0.isNumber || $0 == "-" }) }
    }

    init(pid: Int?, lastExit: Int?) {
        self.pid = pid
        self.lastExit = lastExit
    }
}

/// One look at the bridge on this Mac.
struct Probe: Equatable, Sendable {
    /// nil when no plist is installed under the label.
    var plist: InstalledPlist?
    /// nil when launchd does not know the label: never bootstrapped, or booted out.
    var job: LaunchdJob?
    /// GET 127.0.0.1:<port>/health answered ok.
    var healthy: Bool
    /// <home>/run/control.sock exists, so the bridge can mint a code for this Mac's app.
    var controlSocket: Bool
    /// The last lines of the service log.
    var logTail: [String]
}

/// What the bridge on this Mac is doing, derived from one Probe and never set piecemeal.
enum ServiceState: Equatable, Sendable {
    case checking
    /// No plist and nothing answers. `checkout`: a claudio-bot folder the Install button can run from.
    case notInstalled(checkout: URL?)
    case stopped
    case starting
    /// `managed`: launchd runs it; otherwise it was started from a terminal and the app leaves it alone.
    /// `selfPairing`: the control socket exists, so this Mac's app can pair itself without a code.
    case running(managed: Bool, selfPairing: Bool)
    case failed(reason: String, logTail: [String])

    /// How long a start may take before it counts as failed.
    static let startGrace: TimeInterval = 15

    /// `startedAt`: when the app last asked launchd to start the job, or first saw it starting.
    static func derive(_ probe: Probe, checkout: URL?, startedAt: Date?, now: Date) -> ServiceState {
        if probe.healthy { return .running(managed: probe.job?.pid != nil, selfPairing: probe.controlSocket) }
        guard probe.plist != nil else { return .notInstalled(checkout: checkout) }
        let withinGrace = startedAt.map { now.timeIntervalSince($0) < startGrace } ?? false
        guard let job = probe.job else { return withinGrace ? .starting : .stopped }
        if withinGrace || (job.pid != nil && startedAt == nil) { return .starting }
        if job.pid != nil {
            return .failed(reason: problem(in: probe.logTail) ?? "The bridge started but did not answer within \(Int(startGrace)) seconds.", logTail: probe.logTail)
        }
        if let code = job.lastExit, code != 0 {
            return .failed(reason: problem(in: probe.logTail) ?? "The bridge exited with code \(code).", logTail: probe.logTail)
        }
        return .stopped
    }

    /// The last line saying why the bridge refused to start or crashed: the lines `claudiobot install` watches for,
    /// or an uncaught error.
    static func problem(in lines: [String]) -> String? {
        let refusals = ["Another ClaudioBot bridge", "Could not take the lock", "ClaudioBot will not start"]
        return lines.last { line in
            refusals.contains { line.hasPrefix($0) } || line.range(of: #"^\s*(\w*Error|error):"#, options: .regularExpression) != nil
        }?.trimmingCharacters(in: .whitespaces)
    }

    var summary: String {
        switch self {
        case .checking: "Looking for the bridge…"
        case .notInstalled: "The bridge is not installed on this Mac."
        case .stopped: "The bridge on this Mac is stopped."
        case .starting: "The bridge is starting…"
        case .running(true, _): "The bridge is running."
        case .running(false, _): "A bridge started from a terminal is running."
        case .failed(let reason, _): reason
        }
    }

    var canStart: Bool {
        switch self {
        case .checking, .stopped, .failed: true
        default: false
        }
    }

    /// Stop also boots out a job launchd keeps restarting.
    var canStop: Bool {
        switch self {
        case .checking, .starting, .failed, .running(managed: true, _): true
        default: false
        }
    }

    var canRestart: Bool {
        switch self {
        case .checking, .failed, .running(managed: true, _): true
        default: false
        }
    }

    var isStarting: Bool { self == .starting }
}

/// Where the paired bridge runs, read off the pairing and never stored: a loopback address is this Mac.
enum BridgePlace: Equatable, Sendable {
    case thisMac, otherMac

    init?(_ pairing: Pairing?) {
        guard let pairing else { return nil }
        self = pairing.url.isLoopback ? .thisMac : .otherMac
    }
}

/// The only place the Mac app starts processes. stdout and stderr share one pipe, read to its end.
enum Shell {
    struct Ran: Sendable {
        var status: Int32
        var output: String
    }

    static func run(_ argv: [String], cwd: URL? = nil, environment: [String: String]? = nil) async -> Ran {
        await Task.detached {
            let process = Process()
            process.executableURL = URL(filePath: argv[0])
            process.arguments = Array(argv.dropFirst())
            process.currentDirectoryURL = cwd
            if let environment { process.environment = environment }
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = pipe
            process.standardInput = FileHandle.nullDevice
            do {
                try process.run()
            } catch {
                return Ran(status: -1, output: error.localizedDescription)
            }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            return Ran(status: process.terminationStatus, output: String(decoding: data, as: UTF8.self))
        }.value
    }

    static func quote(_ word: String) -> String {
        "'" + word.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
    }
}

/// The bridge on this Mac: the LaunchAgent `claudiobot install` writes. The app adopts it and never runs a bridge of
/// its own. It changes the pairing only through `BridgeClient.pair`, and only when the user clicks Use this Mac.
@Observable
@MainActor
final class LocalBridge {
    enum Action: Equatable, Sendable { case pairing, installing, starting, stopping, restarting }

    private(set) var state: ServiceState = .checking
    private(set) var config: ServiceConfig
    /// The action under way, for the buttons.
    private(set) var action: Action?
    /// Why the last action failed.
    private(set) var problem: String?
    /// What the last install printed.
    private(set) var installOutput: String?
    /// The repository this app was built from, when it holds the bridge.
    let builtCheckout: URL?
    /// A demo shows sample bots and leaves this Mac's service alone: it never probes, starts or stops it.
    let isDemo: Bool

    @ObservationIgnored private let location: ServiceLocation
    @ObservationIgnored private var probe: Probe?
    @ObservationIgnored private var startedAt: Date?
    @ObservationIgnored private var demand = 0
    @ObservationIgnored private let log = Logger(subsystem: "dev.claudiobot.mac", category: "local-bridge")

    init(location: ServiceLocation = .current, builtCheckout: URL? = LocalBridge.checkoutFromInfoPlist(), isDemo: Bool = false) {
        self.location = location
        self.isDemo = isDemo
        self.builtCheckout = builtCheckout.flatMap { Self.holdsBridge($0) ? $0 : nil }
        config = ServiceConfig(location: location, plist: nil)
    }

    nonisolated static func checkoutFromInfoPlist() -> URL? {
        guard let path = Bundle.main.object(forInfoDictionaryKey: "ClaudioBotCheckout") as? String, !path.isEmpty else { return nil }
        return URL(filePath: path).standardizedFileURL
    }

    nonisolated static func holdsBridge(_ checkout: URL) -> Bool {
        FileManager.default.fileExists(atPath: checkout.appending(path: "bridge/src/cli.ts").path(percentEncoded: false))
    }

    /// The checkout Install runs from and Settings shows: the installed service's, else the one this app was built from.
    var checkout: URL? { config.installedCheckout ?? builtCheckout }

    /// Probes in the background while the app is paired with this Mac and not connected, or while a start settles.
    /// While a view that shows the state is on screen, `onDemand` probes too.
    func run(localAndDown: @escaping @MainActor () -> Bool) async {
        while !Task.isCancelled {
            if demand > 0 || state.isStarting || localAndDown() { await refresh() }
            try? await Task.sleep(for: state.isStarting ? .seconds(1) : .seconds(5))
        }
    }

    /// Keeps the state fresh for as long as the calling view's task runs.
    func onDemand() async {
        demand += 1
        defer { demand -= 1 }
        await refresh()
        while !Task.isCancelled { try? await Task.sleep(for: .seconds(60)) }
    }

    /// The unit tests run inside this app, which must not look at this Mac's service while they do.
    nonisolated static let hostsTests: Bool = {
        let environment = ProcessInfo.processInfo.environment
        return environment.keys.contains { $0.hasPrefix("XCTest") || $0.hasPrefix("XCInjectBundle") }
            || environment["DYLD_INSERT_LIBRARIES"]?.contains("XCTest") == true
    }()

    func refresh() async {
        guard !Self.hostsTests, !isDemo else { return }
        let plistData = try? Data(contentsOf: location.plist)
        let plist = plistData.flatMap(InstalledPlist.init(data:))
        let config = ServiceConfig(location: location, plist: plist)
        let printed = await Shell.run(["/bin/launchctl", "print", "gui/\(getuid())/\(config.label)"])
        let job = printed.status == 0 ? LaunchdJob(launchctlPrint: printed.output) : nil
        let healthy = await Self.healthy(port: config.port)
        let probe = Probe(
            plist: plistData == nil ? nil : (plist ?? InstalledPlist()), job: job, healthy: healthy,
            controlSocket: FileManager.default.fileExists(atPath: config.controlSocket.path(percentEncoded: false)),
            logTail: Self.tail(of: config.log)
        )
        let now = Date.now
        var next = ServiceState.derive(probe, checkout: builtCheckout, startedAt: startedAt, now: now)
        // A bridge on its way out also has a pid and no /health, so a stop never starts the clock.
        if next == .starting, startedAt == nil, action != .stopping {
            startedAt = now
            next = ServiceState.derive(probe, checkout: builtCheckout, startedAt: startedAt, now: now)
        }
        if case .running = next { startedAt = nil }
        if next == .stopped { startedAt = nil }
        self.config = config
        self.probe = probe
        if next != state { log.notice("bridge \(config.label, privacy: .public): \(String(describing: next), privacy: .public)") }
        state = next
    }

    func start() async {
        await perform(.starting) {
            await refresh()
            if case .running = state { return nil }
            let domain = "gui/\(getuid())"
            let ran = probe?.job == nil
                ? await Shell.run(["/bin/launchctl", "bootstrap", domain, location.plist.path(percentEncoded: false)])
                : await Shell.run(["/bin/launchctl", "kickstart", "\(domain)/\(config.label)"])
            startedAt = .now
            return ran.status == 0 ? nil : "launchctl could not start the bridge: \(ran.output.trimmed)"
        }
    }

    /// Bots and routines stop until the bridge starts again. bootout returns before the job is gone.
    func stop() async {
        await perform(.stopping) {
            await refresh()
            guard probe?.job != nil else { return nil }
            let ran = await Shell.run(["/bin/launchctl", "bootout", "gui/\(getuid())/\(config.label)"])
            startedAt = nil
            for _ in 0..<40 {
                await refresh()
                if probe?.job == nil { break }
                try? await Task.sleep(for: .milliseconds(250))
            }
            return probe?.job == nil ? nil : "launchctl could not stop the bridge: \(ran.output.trimmed)"
        }
    }

    /// Also how a bridge updated in its checkout starts serving the control socket.
    func restart() async {
        await refresh()
        guard probe?.job != nil else { return await start() }
        await perform(.restarting) {
            let ran = await Shell.run(["/bin/launchctl", "kickstart", "-k", "gui/\(getuid())/\(config.label)"])
            startedAt = .now
            return ran.status == 0 ? nil : "launchctl could not restart the bridge: \(ran.output.trimmed)"
        }
    }

    /// Runs the README's install in the user's login shell, so `claudiobot install` pins their PATH, bun and claude.
    func install(from checkout: URL) async {
        await perform(.installing) {
            guard Self.holdsBridge(checkout) else { return "\(checkout.path(percentEncoded: false)) is not a claudio-bot checkout." }
            let shell = ProcessInfo.processInfo.environment["SHELL"] ?? "/bin/zsh"
            var environment = ProcessInfo.processInfo.environment
            environment.merge(Self.installEnvironment(location)) { $1 }
            let ran = await Shell.run(
                [shell, "-l", "-c", Self.installScript(location)], cwd: checkout.appending(path: "bridge"), environment: environment
            )
            installOutput = ran.output
            startedAt = .now
            return ran.status == 0 ? nil : "The install stopped with code \(ran.status). Its output is below."
        }
    }

    nonisolated static func installScript(_ location: ServiceLocation) -> String {
        let standard = ServiceLocation.standard()
        var flags = ""
        if location.label != standard.label { flags += " --label \(Shell.quote(location.label))" }
        if location.logDir != standard.logDir { flags += " --log-dir \(Shell.quote(location.logDir.path(percentEncoded: false)))" }
        return "bun install --frozen-lockfile && bun run claudiobot install\(flags)"
    }

    /// The service keeps the CLAUDIOBOT_* variables of the shell that installs it.
    nonisolated static func installEnvironment(_ location: ServiceLocation) -> [String: String] {
        let standard = ServiceLocation.standard()
        var environment: [String: String] = [:]
        if location.home != standard.home { environment["CLAUDIOBOT_HOME"] = location.home.path(percentEncoded: false) }
        if location.port != standard.port { environment["CLAUDIOBOT_PORT"] = String(location.port) }
        return environment
    }

    /// The log holds pairing codes, so it opens on this Mac only.
    func showLog() {
        NSWorkspace.shared.open(config.log)
    }

    /// Mints a code over the control socket and redeems it at the loopback address through the one pairing path. The
    /// click is the confirmation: the address is this Mac and the token never leaves it. Never called on its own,
    /// so after a phone revokes this Mac it stays unpaired until the user clicks again.
    func useThisMac(_ client: BridgeClient) async -> Bool {
        var paired = false
        await perform(.pairing) {
            await refresh()
            guard case .running(_, let selfPairing) = state else { return "The bridge on this Mac is not running." }
            guard selfPairing else { return "Restart the bridge so this Mac can pair itself." }
            let ran = await Shell.run([
                "/usr/bin/curl", "-sS", "--max-time", "5", "--unix-socket", config.controlSocket.path(percentEncoded: false),
                "-X", "POST", "http://localhost/pair-code",
            ])
            guard ran.status == 0, let offer = try? Wire.decoder().decode(PairCode.self, from: Data(ran.output.utf8)) else {
                return "The bridge did not give this Mac a pairing code: \(ran.output.trimmed)"
            }
            do {
                try await client.pair(PairInvite(url: config.socketURL, code: offer.code))
                paired = true
                return nil
            } catch {
                return error.localizedDescription
            }
        }
        return paired
    }

    private func perform(_ action: Action, _ body: () async -> String?) async {
        guard self.action == nil, !isDemo else { return }
        self.action = action
        problem = nil
        problem = await body()
        self.action = nil
        await refresh()
    }

    private static func healthy(port: Int) async -> Bool {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
        request.timeoutInterval = 2
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return false }
        struct Health: Decodable { let ok: Bool }
        return (try? JSONDecoder().decode(Health.self, from: data))?.ok == true
    }

    private static func tail(of log: URL, lines: Int = 40) -> [String] {
        guard let handle = try? FileHandle(forReadingFrom: log) else { return [] }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        try? handle.seek(toOffset: size > 16_384 ? size - 16_384 : 0)
        let text = String(decoding: handle.readDataToEndOfFile(), as: UTF8.self)
        return text.split(separator: "\n", omittingEmptySubsequences: true).suffix(lines).map(String.init)
    }
}

/// The service as its plist describes it, over the location's defaults.
struct ServiceConfig: Equatable, Sendable {
    var label: String
    var port: Int
    var home: URL
    var log: URL
    var installedCheckout: URL?

    init(location: ServiceLocation, plist: InstalledPlist?) {
        label = location.label
        port = plist?.port ?? location.port
        home = plist?.home.map { URL(filePath: $0) } ?? location.home
        log = plist?.log.map { URL(filePath: $0) } ?? location.logDir.appending(path: "bridge.log")
        installedCheckout = plist?.checkout
    }

    var controlSocket: URL { home.appending(path: "run/control.sock") }
    /// Where this app pairs and connects. Loopback only, so the token never leaves the Mac.
    var socketURL: URL { URL(string: "ws://127.0.0.1:\(port)/ws")! }
}

private extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
