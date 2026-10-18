import Foundation
import Testing
@testable import ClaudioBot

private let now = Date(timeIntervalSince1970: 1_792_152_000)
private let checkout = URL(filePath: "/Users/alex/Dev/claudio-bot")
private let installed = InstalledPlist(workingDirectory: "/Users/alex/Dev/claudio-bot/bridge")

private func probe(
    plist: InstalledPlist? = installed, job: LaunchdJob? = nil, healthy: Bool = false, socket: Bool = false, log: [String] = []
) -> Probe {
    Probe(plist: plist, job: job, healthy: healthy, controlSocket: socket, logTail: log)
}

private let refused = "Another ClaudioBot bridge (pid 41) is using /Users/alex/.claudiobot. Stop it first."

@Suite struct ServiceStateTests {
    @Test(arguments: [
        // Something answers /health: running, managed only when launchd holds a pid.
        (probe(job: LaunchdJob(pid: 41, lastExit: nil), healthy: true, socket: true), nil, ServiceState.running(managed: true, selfPairing: true)),
        (probe(job: LaunchdJob(pid: 41, lastExit: nil), healthy: true), nil, .running(managed: true, selfPairing: false)),
        (probe(plist: nil, healthy: true, socket: true), nil, .running(managed: false, selfPairing: true)),
        // A refusal in an old log does not fail a bridge that answers.
        (probe(job: LaunchdJob(pid: 41, lastExit: 1), healthy: true, log: [refused]), nil, .running(managed: true, selfPairing: false)),
        // No plist and nothing answers.
        (probe(plist: nil), nil, .notInstalled(checkout: checkout)),
        (probe(plist: nil, job: LaunchdJob(pid: nil, lastExit: 0)), nil, .notInstalled(checkout: checkout)),
        // Installed, launchd does not know it: booted out, unless the app just bootstrapped it.
        (probe(), nil, .stopped),
        (probe(), 3, .starting),
        (probe(), 20, .stopped),
        // A pid without /health yet: starting, until the grace runs out.
        (probe(job: LaunchdJob(pid: 41, lastExit: nil)), nil, .starting),
        (probe(job: LaunchdJob(pid: 41, lastExit: nil)), 14, .starting),
        (probe(job: LaunchdJob(pid: 41, lastExit: nil)), 16, .failed(reason: "The bridge started but did not answer within 15 seconds.", logTail: [])),
        // Loaded with no pid: a clean exit is stopped, a crash is failed, with the line that says why.
        (probe(job: LaunchdJob(pid: nil, lastExit: 0)), nil, .stopped),
        (probe(job: LaunchdJob(pid: nil, lastExit: nil)), nil, .stopped),
        (probe(job: LaunchdJob(pid: nil, lastExit: 1), log: ["claudiobot bridge on Mac", refused]), nil, .failed(reason: refused, logTail: ["claudiobot bridge on Mac", refused])),
        (probe(job: LaunchdJob(pid: nil, lastExit: 78)), nil, .failed(reason: "The bridge exited with code 78.", logTail: [])),
        // ... but launchd's throttle between restarts right after a start still reads as starting.
        (probe(job: LaunchdJob(pid: nil, lastExit: 1)), 5, .starting),
    ] as [(Probe, Double?, ServiceState)])
    func eachProbeDerivesOneState(probe: Probe, startedSecondsAgo: Double?, expected: ServiceState) {
        let startedAt = startedSecondsAgo.map { now - $0 }
        #expect(ServiceState.derive(probe, checkout: checkout, startedAt: startedAt, now: now) == expected)
    }

    @Test func theProblemIsTheLastRefusalOrUncaughtError() {
        #expect(ServiceState.problem(in: ["claudiobot bridge on Mac", "access: guarded, sandbox on"]) == nil)
        #expect(ServiceState.problem(in: ["Could not take the lock /x.lock", "pair: claudiobot://pair?…"]) == "Could not take the lock /x.lock")
        #expect(ServiceState.problem(in: [refused, "error: Failed to start server. Is port 7878 in use?", "  at serve (main.ts:1)"])
            == "error: Failed to start server. Is port 7878 in use?")
        #expect(ServiceState.problem(in: ["ClaudioBot will not start: state.json is version 9", "TypeError: x is undefined"]) == "TypeError: x is undefined")
    }

    @Test func theControlsFollowTheState() {
        let terminal = ServiceState.running(managed: false, selfPairing: true)
        #expect(!terminal.canStart && !terminal.canStop && !terminal.canRestart)
        let managed = ServiceState.running(managed: true, selfPairing: false)
        #expect(!managed.canStart && managed.canStop && managed.canRestart)
        #expect(ServiceState.stopped.canStart && !ServiceState.stopped.canStop)
        #expect(!ServiceState.notInstalled(checkout: nil).canStart)
        #expect(terminal.selfPairs && !managed.selfPairs)
    }
}

@Suite struct ServiceConfigTests {
    @Test func launchctlPrintIsReadFromTheServicesOwnTopLevelKeys() {
        let running = "gui/501/com.claudiobot.test = {\n\tactive count = 1\n\tstate = running\n\tpid = 4242\n\tlast exit code = (never exited)\n\tendpoints = {\n\t\tpid = 9\n\t}\n}\n"
        #expect(LaunchdJob(launchctlPrint: running) == LaunchdJob(pid: 4242, lastExit: nil))
        let crashed = "gui/501/com.claudiobot.test = {\n\tstate = not running\n\tlast exit code = 1: Operation not permitted\n}\n"
        #expect(LaunchdJob(launchctlPrint: crashed) == LaunchdJob(pid: nil, lastExit: 1))
    }

    @Test func theInstalledPlistOverridesTheDefaults() throws {
        let xml = """
        <?xml version="1.0" encoding="UTF-8"?>
        <plist version="1.0"><dict>
        <key>Label</key><string>com.claudiobot.test</string>
        <key>ProgramArguments</key><array><string>/opt/homebrew/bin/bun</string><string>/Users/alex/Dev/claudio-bot/bridge/src/main.ts</string></array>
        <key>WorkingDirectory</key><string>/Users/alex/Dev/claudio-bot/bridge</string>
        <key>EnvironmentVariables</key><dict><key>CLAUDIOBOT_HOME</key><string>/tmp/cbm-home</string><key>CLAUDIOBOT_PORT</key><string>17999</string></dict>
        <key>StandardOutPath</key><string>/tmp/cbm-logs/bridge.log</string>
        </dict></plist>
        """
        let plist = try #require(InstalledPlist(data: Data(xml.utf8)))
        let location = ServiceLocation.standard(user: URL(filePath: "/Users/alex"))
        let config = ServiceConfig(location: location, plist: plist)
        #expect(config.port == 17999)
        #expect(config.home == URL(filePath: "/tmp/cbm-home"))
        #expect(config.controlSocket.path(percentEncoded: false) == "/tmp/cbm-home/run/control.sock")
        #expect(config.socketURL == URL(string: "ws://127.0.0.1:17999/ws"))
        #expect(config.log == URL(filePath: "/tmp/cbm-logs/bridge.log"))
        #expect(config.installedCheckout?.path(percentEncoded: false) == "/Users/alex/Dev/claudio-bot/")
        #expect(InstalledPlist(data: Data("not a plist".utf8)) == nil)

        let defaults = ServiceConfig(location: location, plist: nil)
        #expect(defaults.port == 7878)
        #expect(defaults.home == URL(filePath: "/Users/alex/.claudiobot"))
        #expect(defaults.log == URL(filePath: "/Users/alex/Library/Logs/ClaudioBot/bridge.log"))
        #expect(location.plist == URL(filePath: "/Users/alex/Library/LaunchAgents/com.claudiobot.bridge.plist"))
    }

    @Test func installPassesOnlyWhatDiffersFromTheCLIsDefaults() {
        let standard = ServiceLocation.standard()
        #expect(LocalBridge.installScript(standard) == "bun install --frozen-lockfile && bun run claudiobot install")
        #expect(LocalBridge.installEnvironment(standard).isEmpty)
        var throwaway = standard
        throwaway.label = "com.claudiobot.test"
        throwaway.logDir = URL(filePath: "/tmp/it's logs")
        throwaway.home = URL(filePath: "/tmp/cbm-home")
        throwaway.port = 17999
        #expect(LocalBridge.installScript(throwaway)
            == #"bun install --frozen-lockfile && bun run claudiobot install --label 'com.claudiobot.test' --log-dir '/tmp/it'\''s logs'"#)
        #expect(LocalBridge.installEnvironment(throwaway) == ["CLAUDIOBOT_HOME": "/tmp/cbm-home", "CLAUDIOBOT_PORT": "17999"])
    }

    @Test func aLoopbackPairingIsThisMac() {
        func place(_ url: String) -> BridgePlace? {
            BridgePlace(Pairing(url: URL(string: url)!, credential: .device(DeviceID("d1"), token: "t")))
        }
        #expect(place("ws://127.0.0.1:7878/ws") == .thisMac)
        #expect(place("ws://[::1]:7878/ws") == .thisMac)
        #expect(place("ws://localhost:7878/ws") == .thisMac)
        #expect(place("ws://mac.tail1.ts.net:7878/ws") == .otherMac)
        #expect(BridgePlace(nil) == nil)
    }

    @Test func theAppHostingTheseTestsNeverProbesThisMacsService() {
        #expect(LocalBridge.hostsTests)
    }

    @Test func theBuildsOwnCheckoutHoldsTheBridge() throws {
        let checkout = try #require(LocalBridge.checkoutFromInfoPlist())
        #expect(LocalBridge.holdsBridge(checkout))
    }
}
