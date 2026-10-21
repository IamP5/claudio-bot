import Foundation
import Testing
@testable import ClaudioBot

private let at = Date(timeIntervalSince1970: 1_792_152_000)
private let utc: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    calendar.locale = Locale(identifier: "en_US")
    return calendar
}()

private func machine(
    _ id: String, role: MachineRole = .machine, online: Bool = true, since: Date? = nil,
    access: MachineAccess = MachineAccess(full: false, sandbox: true), connectors: [MachineConnector] = []
) -> Machine {
    Machine(id: MachineID(id), name: id, role: role, online: online, since: since, platform: .darwin, access: access, connectors: connectors)
}

private let home = machine("omarchy", role: .home)
private let mac = machine("mac")

private func project(_ id: String) -> SessionProject {
    SessionProject(id: ProjectID(id), name: id, path: "/p/\(id)", githubRepo: nil, lastAt: nil, canCloud: false)
}

private func row(_ id: String, project: String, on machine: Machine?) -> SessionRow {
    SessionRow(
        id: SessionID(id), projectId: ProjectID(project), parentId: nil, title: id, origin: .terminal, agent: nil, status: .idle,
        holder: .nobody, unread: false, branch: nil, worktree: false, pr: nil, mirror: .notMirrored, hidden: false, url: nil,
        createdAt: at, lastAt: at, machine: machine?.id
    )
}

@Suite struct MachineTextTests {
    @Test(arguments: [
        (true, false, "Full access, no sandbox"), (true, true, "Full access"), (false, true, "Guarded"), (false, false, "Guarded, no sandbox"),
    ])
    func theAccessChipNamesTheModeAndASandboxThatIsOff(full: Bool, sandbox: Bool, text: String) {
        #expect(MachineText.access(MachineAccess(full: full, sandbox: sandbox)) == text)
    }

    @Test func anOfflineMachineSaysSinceWhen() {
        #expect(MachineText.presence(home) == "Online")
        #expect(MachineText.presence(machine("m", online: false)) == "Offline")
        let earlier = machine("m", online: false, since: at - 3600)
        #expect(MachineText.presence(earlier, now: at, calendar: utc) == "Offline since 11:00\u{202F}AM")
        let yesterday = machine("m", online: false, since: at - 86_400)
        #expect(MachineText.presence(yesterday, now: at, calendar: utc) == "Offline since yesterday")
    }

    @Test func onlyABrowserAndComputerUseGetAChipEachOnce() {
        let connectors = [
            MachineConnector(name: "github", kind: .other), MachineConnector(name: "computer-use", kind: .computerUse),
            MachineConnector(name: "chrome-devtools", kind: .chrome), MachineConnector(name: "claude-in-chrome", kind: .chrome),
            MachineConnector(name: "figma", kind: .unknown("design")),
        ]
        #expect(MachineText.connectorChips(connectors) == ["Chrome", "Computer use"])
        #expect(MachineText.connectorChips([]) == [])
    }

    @Test func theEnrollCommandUsesTheFirstAddressTheHomeListed() {
        let code = PairCode(code: "R4TW-9HJC", expiresAt: at, urls: ["http://omarchy.tail1234.ts.net:7878", "http://192.168.1.30:7878"])
        #expect(MachineText.enrollCommand(code) == "claudiobot machine enroll http://omarchy.tail1234.ts.net:7878 R4TW-9HJC")
        #expect(MachineText.enrollCommand(PairCode(code: "X", expiresAt: at, urls: [])) == nil)
    }

    @Test func aPickerMarksAnOfflineMachine() {
        #expect(MachineText.choice(mac) == "mac")
        #expect(MachineText.choice(machine("mac", online: false)) == "mac (offline)")
    }
}

@Suite struct MachineProjectsTests {
    @Test func projectsGoWhereTheirSessionsAreAndTheRestToTheHomeWhichLeads() {
        let projects = [project("both"), project("macOnly"), project("fresh")]
        let rows = [row("s1", project: "both", on: home), row("s2", project: "both", on: mac), row("s3", project: "macOnly", on: mac)]
        let groups = MachineProjects.group(projects, rows: rows, machines: [mac, home])
        #expect(groups.map(\.machine.id) == [home.id, mac.id])
        #expect(groups[0].projects.map(\.name) == ["both", "fresh"])
        #expect(groups[1].projects.map(\.name) == ["both", "macOnly"])
    }

    @Test func aMachineWithNoProjectsIsLeftOut() {
        let groups = MachineProjects.group([project("p")], rows: [], machines: [home, mac])
        #expect(groups.map(\.machine.id) == [home.id])
    }
}

@MainActor
@Suite struct MachineStoreTests {
    private func hello(machines: [Machine]?) -> ServerMessage {
        .hello(Hello(
            features: machines == nil ? [] : [.machines], machine: "omarchy", userName: "Alex", bots: [],
            world: machines == nil ? nil : World(id: WorldID("w1"), name: "Alex's bots"), machines: machines
        ))
    }

    @Test func helloAndEachMachinesFrameSetTheListAndAnOlderBridgeHasNone() {
        let store = AppStore()
        store.apply(hello(machines: [home]))
        #expect(store.machines == [home] && store.world?.id == WorldID("w1"))
        #expect(!store.hasSeveralMachines)
        store.apply(.machines([home, mac]))
        #expect(store.hasSeveralMachines)
        store.apply(hello(machines: nil))
        #expect(store.machines.isEmpty && store.world == nil && !store.has(.machines))
    }

    @Test func chipsNameTheMachineOnlyWhenThereAreSeveralAndNeverForACloudAgent() {
        let store = AppStore()
        store.apply(hello(machines: [home]))
        #expect(store.chipName(home.id) == nil)
        store.apply(.machines([home, mac]))
        #expect(store.chipName(mac.id) == "mac")
        #expect(store.chipName(nil) == nil)
        var agent = Agent(
            id: AgentID("a1"), botId: BotID("b1"), title: "t", where: .mac, projectName: "p", status: .working, url: nil,
            createdAt: at, updatedAt: at, machine: mac.id
        )
        #expect(store.chipName(for: agent) == "mac")
        agent.where = .cloud
        #expect(store.chipName(for: agent) == nil)
    }

    @Test func theEnrollCodeIsKeptUntilDiscardedAndUnpairingForgetsTheMachines() {
        let store = AppStore()
        store.apply(hello(machines: [home, mac]))
        let code = PairCode(code: "R4TW-9HJC", expiresAt: at, urls: ["http://omarchy:7878"])
        store.apply(.machineCode(code))
        #expect(store.machineCode == code)
        store.discardMachineCode()
        #expect(store.machineCode == nil)
        store.setConnection(.unpaired)
        #expect(store.machines.isEmpty && store.world == nil)
    }

    @Test func theAgentsOnPickerSendsTheMachineOrLetsTheBotChoose() throws {
        let bot = BotID("b1")
        let pick = try JSONSerialization.jsonObject(with: Wire.encoder().encode(AgentsOnSection.choose(bot, mac.id))) as! NSDictionary
        #expect((pick["patch"] as? NSDictionary) == ["agentsOn": "mac"])
        let free = try JSONSerialization.jsonObject(with: Wire.encoder().encode(AgentsOnSection.choose(bot, nil))) as! NSDictionary
        #expect((free["patch"] as? NSDictionary) == ["agentsOn": NSNull()])

        var held = Bot(
            id: bot, name: "eng", title: nil, avatar: .standard, pinned: false, hidden: false, status: .idle, unread: 0,
            question: nil, preview: "", lastAt: at, createdAt: at, routines: []
        )
        #expect(AgentsOnSection.label(held, machines: [home, mac]) == "Let the bot choose")
        held.agentsOn = MachineID("mac")
        #expect(AgentsOnSection.label(held, machines: [home, machine("mac", online: false)]) == "mac (offline)")
    }
}
