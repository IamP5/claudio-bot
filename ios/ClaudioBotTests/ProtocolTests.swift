import Foundation
import Testing
@testable import ClaudioBot

private final class BundleToken {}

/// fixtures/protocol.json split into raw JSON entries, so each can be decoded and compared on its own.
/// Nothing here counts the entries: a fixture added on the bridge side is covered the next time the tests run.
private enum Fixture {
    static func entries(_ side: String) -> [Data] {
        let url = Bundle(for: BundleToken.self).url(forResource: "protocol", withExtension: "json")!
        let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: [Any]]
        return root[side]!.map { try! JSONSerialization.data(withJSONObject: $0) }
    }

    static func server() throws -> [ServerFrame] {
        try entries("server").map { try Wire.decoder().decode(ServerFrame.self, from: $0) }
    }

    static func messages() throws -> [Message] {
        try server().flatMap { frame -> [Message] in
            switch frame.message {
            case .message(_, let message): [message]
            case .conversation(_, let messages): messages
            default: []
            }
        }
    }

    static func bots() throws -> [Bot] {
        try server().flatMap { frame -> [Bot] in
            switch frame.message {
            case .hello(let hello): hello.bots
            case .bot(let bot): [bot]
            default: []
            }
        }
    }
}

private func jsonObject(_ data: Data) throws -> NSDictionary {
    try JSONSerialization.jsonObject(with: data) as! NSDictionary
}

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try Wire.decoder().decode(type, from: Data(json.utf8))
}

private let at = Date(timeIntervalSince1970: 1_792_152_000)

/// Every value in a decoded frame that fell back to `.unknown`, so a fixture the app does not model fails loudly.
private func unknowns(in message: ServerMessage) -> [String] {
    func inRoutine(_ routine: Routine) -> [String] {
        var found: [String] = []
        if case .unknown(let raw) = routine.trigger { found.append("trigger \(raw)") }
        for run in routine.runs { if case .unknown(let raw) = run.status { found.append("run status \(raw)") } }
        return found
    }
    func inBot(_ bot: Bot) -> [String] {
        var found: [String] = []
        if case .unknown(let raw) = bot.status { found.append("bot status \(raw)") }
        if case .unknown(let raw) = bot.avatar.shape { found.append("shape \(raw)") }
        if case .unknown(let raw) = bot.avatar.color { found.append("color \(raw)") }
        return found + bot.routines.flatMap(inRoutine)
    }
    func inAgent(_ agent: Agent) -> [String] {
        if case .unknown(let raw) = agent.status { return ["agent status \(raw)"] }
        return []
    }
    func inMessage(_ message: Message) -> [String] {
        switch message {
        case .unknown(_, _, let kind): ["message kind \(kind)"]
        case .permission(_, _, let card): if case .closed(let raw) = card.answer { ["permission answer \(raw)"] } else { [] }
        default: []
        }
    }
    switch message {
    case .unknown(let type): return ["type \(type)"]
    case .hello(let hello): return hello.bots.flatMap(inBot)
    case .bot(let b): return inBot(b)
    case .conversation(_, let messages): return messages.flatMap(inMessage)
    case .message(_, let m): return inMessage(m)
    case .details(_, _, _, let agents, let routines): return agents.flatMap(inAgent) + routines.flatMap(inRoutine)
    case .agent(let a, _): return inAgent(a)
    default: return []
    }
}

@Suite struct ProtocolTests {
    @Test func everyServerFixtureDecodesToKnownValuesAndEncodesBackToTheSameJSON() throws {
        let entries = Fixture.entries("server")
        #expect(!entries.isEmpty)
        for data in entries {
            let frame = try Wire.decoder().decode(ServerFrame.self, from: data)
            #expect(unknowns(in: frame.message) == [], "\(String(decoding: data, as: UTF8.self))")
            #expect(try jsonObject(Wire.encoder().encode(frame)) == jsonObject(data))
        }
    }

    @Test func everyClientFixtureDecodesAndEncodesBackToTheSameJSON() throws {
        let entries = Fixture.entries("client")
        #expect(!entries.isEmpty)
        for data in entries {
            let msg = try Wire.decoder().decode(ClientMessage.self, from: data)
            #expect(try jsonObject(Wire.encoder().encode(msg)) == jsonObject(data))
        }
    }

    @Test func helloCarriesTheProtocolTheStreamPositionAndTypedBots() throws {
        guard case .hello(let hello) = try Fixture.server()[0].message else { Issue.record("not hello"); return }
        #expect(hello.protocol == 3)
        #expect(hello.position == StreamPosition(epoch: "e_7f3a", seq: 41, resumed: false))
        #expect(hello.machine == "MacBook")
        #expect(hello.userName == "Alex")
        let bot = try #require(hello.bots.first)
        #expect(bot.avatar == Avatar(shape: .hexagon, color: .orange))
        #expect(bot.title == nil)
        #expect(bot.dailyCapUsd == nil)
        #expect(bot.lastAt == at)
    }

    @Test func aProtocol2HelloReadsAsProtocol2WithNoReplayRing() throws {
        let msg = try decode(ServerMessage.self, #"{"type":"hello","machine":"Mac","userName":"Alex","bots":[]}"#)
        guard case .hello(let hello) = msg else { Issue.record("not hello"); return }
        #expect(hello.protocol == 2)
        #expect(hello.position == StreamPosition(epoch: "", seq: 0, resumed: false))
    }

    @Test func broadcastsCarryTheirSeqAndRepliesDoNot() throws {
        let seqs = try Fixture.server().map { frame -> String in
            switch frame.message {
            case .bot: "bot:\(frame.seq.map(String.init) ?? "-")"
            case .botRemoved: "bot_removed:\(frame.seq.map(String.init) ?? "-")"
            default: ""
            }
        }.filter { !$0.isEmpty }
        #expect(seqs == ["bot:42", "bot_removed:-", "bot:48", "bot:49"])
    }

    @Test func routinesCarryTheirTriggerNextRunAndRuns() throws {
        let routine = try #require(try Fixture.bots().first?.routines.first)
        #expect(routine.trigger == .cron)
        #expect(routine.nextRunAt == Date(timeIntervalSince1970: 1_792_238_220))
        #expect(routine.runs.map(\.status) == [.ok, .quiet, .failed, .skipped])
        #expect(routine.runs.map(\.late) == [false, true, false, false])
        #expect(routine.runs.map(\.manual) == [true, false, false, false])
        #expect(routine.runs.map(\.note) == [nil, nil, "Overloaded", "Missed while the Mac was asleep"])
    }

    @Test func aProtocol2RoutineDecodesWithNoRuns() throws {
        let routine = try decode(Routine.self, #"{"id":"r1","name":"n","schedule":"0 9 * * *","describe":"Daily at 9:00 AM","prompt":"p","enabled":true,"lastRunAt":null}"#)
        #expect(routine.trigger == .cron)
        #expect(routine.nextRunAt == nil)
        #expect(routine.runs.isEmpty)
    }

    @Test func detailsCarryEveryKeptRunAndAProtocol2DetailsHasNoRoutines() throws {
        let routines = try Fixture.server().flatMap { frame -> [Routine] in
            if case .details(_, _, _, _, let routines) = frame.message { routines } else { [] }
        }
        #expect(routines.map(\.id) == [RoutineID("r1")])
        #expect(routines.first?.runs.map(\.id) == ["run4", "run3", "run2", "run1"].map { RunID($0) })

        let old = try decode(ServerMessage.self, #"{"type":"details","botId":"b1","library":[],"links":[],"agents":[]}"#)
        guard case .details(_, _, _, _, let none) = old else { Issue.record("not details"); return }
        #expect(none.isEmpty)
    }

    @Test func botsAndAgentsCarryTheNewStatusesAndTheDailyCap() throws {
        #expect(try Fixture.bots().map(\.status) == [.idle, .working, .awaitingApproval, .parked])
        #expect(try Fixture.bots().map(\.dailyCapUsd) == [nil, 5, nil, nil])
        let agentStatuses = try Fixture.server().compactMap { frame -> AgentStatus? in
            if case .agent(let agent, _) = frame.message { agent.status } else { nil }
        }
        #expect(agentStatuses == [.waiting, .awaitingApproval])
    }

    @Test func permissionCardsDecodeOpenOrDecidedWithTheExactCall() throws {
        let cards = try Fixture.messages().compactMap { message -> PermissionCard? in
            if case .permission(_, _, let card) = message { card } else { nil }
        }
        #expect(cards == [
            PermissionCard(
                from: nil, tool: "Bash", label: "Push to the default branch", detail: "git push origin main",
                always: "git push to main or master from engineer", answer: nil,
                expiresAt: Date(timeIntervalSince1970: 1_792_166_400)
            ),
            PermissionCard(
                from: .agent(id: AgentID("a1"), title: "Set up verification skill"), tool: "mcp__github__merge_pull_request",
                label: "Merge a pull request", detail: #"mcp__github__merge_pull_request {"repo":"acme/web","number":142}"#,
                always: "merging pull requests from engineer", answer: .chose(.once),
                expiresAt: Date(timeIntervalSince1970: 1_792_166_400)
            ),
        ])
    }

    @Test func questionAnswersDecodeAsOpenChosenDismissedOrExpired() throws {
        let answers = try Fixture.messages().compactMap { message -> String? in
            guard case .question(let id, _, let card) = message else { return nil }
            return "\(id):\(card.answer.map { "\($0)" } ?? "open")"
        }
        #expect(answers == ["m6:open", "m6:option(1)", "m7:dismissed", "m10:expired"])
    }

    @Test func questionsFromBeforeProtocol3NeverExpire() throws {
        let expiries = try Fixture.messages().compactMap { message -> Date?? in
            if case .question(_, _, let card) = message { .some(card.expiresAt) } else { nil }
        }
        #expect(expiries == [Date(timeIntervalSince1970: 1_792_238_400), Date(timeIntervalSince1970: 1_792_238_400), nil, Date(timeIntervalSince1970: 1_792_238_400)])
    }

    @Test func devicesAndPairCodeDecode() throws {
        let frames = try Fixture.server()
        let devices = frames.compactMap { if case .devices(let d) = $0.message { d } else { nil } }.first
        #expect(devices?.map(\.id) == [DeviceID("d1"), DeviceID("d0")])
        #expect(devices?.map(\.current) == [true, false])
        #expect(devices?.map(\.legacy) == [false, true])
        #expect(devices?.last?.lastSeenAt == nil)
        let code = frames.compactMap { if case .pairCode(let c) = $0.message { c } else { nil } }.first
        #expect(code == PairCode(code: "K7QD-M2XP", expiresAt: Date(timeIntervalSince1970: 1_792_152_600)))
    }

    @Test func anUnknownPermissionAnswerStillClosesTheCard() throws {
        let json = #"{"kind":"permission","id":"m1","at":"2026-10-16T12:00:00.000Z","from":null,"tool":"Bash","label":"l","detail":"d","always":"a","answer":"withdrawn","expiresAt":"2026-10-16T13:00:00.000Z"}"#
        guard case .permission(_, _, let card) = try decode(Message.self, json) else { Issue.record("not permission"); return }
        #expect(card.answer == .closed("withdrawn"))
    }

    @Test func unknownMessageTypeDecodesInsteadOfThrowing() throws {
        let msg = try decode(ServerMessage.self, #"{"type":"usage","tokens":12}"#)
        guard case .unknown(let type) = msg else { Issue.record("expected unknown"); return }
        #expect(type == "usage")
    }

    @Test func unknownMessageKindKeepsItsIdAndTime() throws {
        let msg = try decode(ServerMessage.self, #"{"type":"message","botId":"b1","message":{"kind":"poll","id":"m9","at":"2026-10-16T12:00:00.000Z"}}"#)
        guard case let .message(_, message) = msg else { Issue.record("expected message"); return }
        #expect(message == .unknown(id: MessageID("m9"), at: at, kind: "poll"))
    }

    @Test func unknownShapeColorStatusAndPeerDecodeAndKeepTheirWireStrings() throws {
        #expect(try decode(Avatar.self, #"{"shape":"heart","color":"gold"}"#) == Avatar(shape: .unknown("heart"), color: .unknown("gold")))
        #expect(try decode(BotStatus.self, #""sleeping""#) == .unknown("sleeping"))
        #expect(try decode(AgentStatus.self, #""queued""#) == .unknown("queued"))
        #expect(try decode(AgentPlace.self, #""ssh""#) == .unknown("ssh"))
        #expect(try decode(RunStatus.self, #""retrying""#) == .unknown("retrying"))
        #expect(try decode(TriggerKind.self, #""webhook""#) == .unknown("webhook"))
        #expect(try decode(Peer.self, #"{"kind":"group","id":"g1"}"#) == .unknown(kind: "group"))
        #expect(try Wire.encoder().encode(AvatarShape.unknown("heart")) == Data(#""heart""#.utf8))
    }

    @Test func everyShapeColorAndStatusMatchesTheBridgeLists() {
        #expect(AvatarShape.allCases.map(\.rawValue) == [
            "circle", "cloud", "diamond", "star4", "flower", "blob", "scallop",
            "drop", "pill", "triangle", "pentagon", "star6", "hexagon",
        ])
        #expect(AvatarColor.allCases.map(\.rawValue) == [
            "white", "brown", "red", "orange", "amber", "green", "teal", "blue", "purple", "pink", "gray",
        ])
        #expect(BotStatus.allCases.map(\.rawValue) == ["idle", "working", "awaiting_approval", "parked"])
        #expect(AgentStatus.allCases.map(\.rawValue) == ["working", "waiting", "failed", "in_cloud", "awaiting_approval", "parked"])
        #expect(RunStatus.allCases.map(\.rawValue) == ["running", "ok", "quiet", "failed", "skipped"])
        #expect(PermissionChoice.allCases.map(\.rawValue) == ["once", "always", "deny", "never"])
    }

    @Test func patchSendsOnlyTheFieldsThatAreSet() throws {
        let rename = try jsonObject(Wire.encoder().encode(ClientMessage.updateBot(botId: BotID("b1"), patch: BotPatch(name: "eng"))))
        #expect(rename == ["type": "update_bot", "botId": "b1", "patch": ["name": "eng"]] as NSDictionary)
        let clear = try Wire.encoder().encode(BotPatch(title: .some(nil)))
        #expect(String(decoding: clear, as: UTF8.self) == #"{"title":null}"#)
        let defaultCap = try Wire.encoder().encode(BotPatch(dailyCapUsd: .some(nil)))
        #expect(String(decoding: defaultCap, as: UTF8.self) == #"{"dailyCapUsd":null}"#)
    }

    @Test func protocolMismatchNamesTheSideToUpdate() {
        #expect(ProtocolMismatch(bridge: 2) == .updateBridge)
        #expect(ProtocolMismatch(bridge: 3) == nil)
        #expect(ProtocolMismatch(bridge: 4) == .updateApp)
    }
}

@Suite struct PairingTests {
    private let socket = URL(string: "ws://10.0.0.20:7878/ws")!

    @Test func pairLinkParsesTheAddressAndCode() {
        let link = URL(string: "claudiobot://pair?url=ws%3A%2F%2F10.0.0.20%3A7878%2Fws&code=k7qd-m2xp")!
        #expect(PairInvite(link: link) == PairInvite(url: socket, code: "K7QD-M2XP"))
    }

    @Test func linksThatAreNotCodePairingsAreRejected() {
        #expect(PairInvite(link: URL(string: "claudiobot://pair?url=http%3A%2F%2Fevil.com&code=x")!) == nil)
        #expect(PairInvite(link: URL(string: "claudiobot://pair?url=ws%3A%2F%2Fhost%3A7878%2Fws")!) == nil)
        #expect(PairInvite(link: URL(string: "claudiobot://pair?url=ws%3A%2F%2Fhost%3A7878%2Fws&token=abc")!) == nil)
        #expect(PairInvite(link: URL(string: "https://pair?url=ws%3A%2F%2Fhost%3A7878%2Fws&code=x")!) == nil)
    }

    @Test func theInviteLinkRoundTrips() {
        let invite = PairInvite(url: socket, code: "K7QD-M2XP")
        #expect(PairInvite(link: invite.link) == invite)
    }

    @Test func redeemingPostsTheCodeAndNameToThePairEndpoint() throws {
        let request = PairInvite(url: socket, code: "K7QD-M2XP").request(deviceName: "Alex's iPhone")
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "http://10.0.0.20:7878/pair")
        #expect(request.value(forHTTPHeaderField: "Origin") == nil)
        let body = try JSONSerialization.jsonObject(with: try #require(request.httpBody)) as? NSDictionary
        #expect(body == ["code": "K7QD-M2XP", "name": "Alex's iPhone"] as NSDictionary)
        let secure = PairInvite(url: URL(string: "wss://mac.tail1.ts.net/ws")!, code: "X").request(deviceName: "p")
        #expect(secure.url?.absoluteString == "https://mac.tail1.ts.net/pair")
    }

    @Test func pairingHappensBesideTheSocketPathBehindAPrefix() throws {
        let invite = try PairInvite(urlString: "wss://example.com/claudio/ws", code: "x")
        #expect(invite.request(deviceName: "p").url?.absoluteString == "https://example.com/claudio/pair")
    }

    @Test(arguments: [
        ("ws://10.0.0.20:7878", "ws://10.0.0.20:7878/ws"),
        ("ws://10.0.0.20:7878/", "ws://10.0.0.20:7878/ws"),
        (" WS://10.0.0.20:7878/ws ", "ws://10.0.0.20:7878/ws"),
        ("wss://mac.tail1.ts.net/ws/", "wss://mac.tail1.ts.net/ws"),
        ("wss://example.com/claudio/ws?token=abc#x", "wss://example.com/claudio/ws"),
    ])
    func aTypedAddressGetsTheSocketPath(typed: String, normalized: String) throws {
        #expect(try PairInvite(urlString: typed, code: "k7qd").url.absoluteString == normalized)
    }

    @Test func aTypedAddressWithAnotherPathOrSchemeIsRefused() {
        #expect(throws: PairInvite.Invalid.path) { try PairInvite(urlString: "ws://10.0.0.20:7878/socket", code: "X") }
        #expect(throws: PairInvite.Invalid.url) { try PairInvite(urlString: "http://10.0.0.20:7878/ws", code: "X") }
        #expect(throws: PairInvite.Invalid.url) { try PairInvite(urlString: "10.0.0.20:7878", code: "X") }
        #expect(throws: PairInvite.Invalid.code) { try PairInvite(urlString: "ws://10.0.0.20:7878/ws", code: "  ") }
    }

    @Test func theConfirmationNamesTheBridgeAndThePairingItReplaces() {
        let invite = PairInvite(url: socket, code: "K7QD-M2XP")
        #expect(invite.confirmation(replacing: nil) == PairingConfirmation(title: "Pair with 10.0.0.20:7878?", detail: nil))
        let home = Pairing(url: URL(string: "wss://mac.tail1.ts.net/ws")!, credential: .device(DeviceID("d1"), token: "abc"))
        #expect(invite.confirmation(replacing: home).detail == "This replaces your pairing with mac.tail1.ts.net.")
        let v6 = PairInvite(url: URL(string: "ws://[fd7a::1]:7878/ws")!, code: "X")
        #expect(v6.confirmation(replacing: nil).title == "Pair with [fd7a::1]:7878?")
    }

    @Test func theBridgesAnswerBecomesADevicePairingOrItsRefusal() throws {
        let invite = PairInvite(url: socket, code: "K7QD-M2XP")
        let paired = try Pairing.pairing(for: invite, status: 200, body: Data(#"{"deviceId":"d1","token":"abc"}"#.utf8))
        #expect(paired == Pairing(url: socket, credential: .device(DeviceID("d1"), token: "abc")))
        do {
            _ = try Pairing.pairing(for: invite, status: 401, body: Data(#"{"error":"That code expired."}"#.utf8))
            Issue.record("a refused code paired")
        } catch {
            #expect(error.localizedDescription == "That code expired.")
        }
        do {
            _ = try Pairing.pairing(for: invite, status: 200, body: Data("<html>".utf8))
            Issue.record("a page that is not the bridge paired")
        } catch {
            #expect(error.localizedDescription == Pairing.Failure.notABridge.localizedDescription)
        }
    }

    @Test func aDeviceConnectsWithABearerTokenAndNeverPutsItInTheURL() {
        let request = Pairing(url: socket, credential: .device(DeviceID("d1"), token: "abc")).socketRequest()
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer abc")
        #expect(request.url?.absoluteString == "ws://10.0.0.20:7878/ws?protocol=3")
    }

    @Test func aLegacyPairingKeepsTheQueryToken() {
        let request = Pairing(url: socket, credential: .legacy(token: "abc")).socketRequest()
        #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
        #expect(request.url?.absoluteString == "ws://10.0.0.20:7878/ws?protocol=3&token=abc")
    }

    @Test func aReconnectAsksToResumeAfterTheLastSeqSeen() throws {
        var cursor = StreamCursor()
        _ = cursor.observe(ServerFrame(message: .hello(Hello(machine: "Mac", userName: "A", bots: [], position: StreamPosition(epoch: "e1", seq: 41, resumed: false)))))
        _ = cursor.observe(ServerFrame(seq: 42, message: .botRemoved(BotID("b2"))))
        let request = Pairing(url: socket, credential: .device(DeviceID("d1"), token: "abc")).socketRequest(resumingFrom: cursor)
        #expect(request.url?.absoluteString == "ws://10.0.0.20:7878/ws?protocol=3&epoch=e1&after=42")
    }

    @Test func aPairingSavedByAnOlderBuildLoadsAsLegacy() throws {
        let old = try JSONDecoder().decode(Pairing.self, from: Data(#"{"url":"ws://10.0.0.20:7878/ws","token":"abc"}"#.utf8))
        #expect(old == Pairing(url: socket, credential: .legacy(token: "abc")))
        let device = Pairing(url: socket, credential: .device(DeviceID("d1"), token: "abc"))
        #expect(try JSONDecoder().decode(Pairing.self, from: JSONEncoder().encode(device)) == device)
    }

    @Test func onlyTheRevokedCloseUnpairsAndA401OnlyAsksTheUser() {
        #expect(BridgeClient.ending(greeted: true, closeCode: 4001, upgradeStatus: 101) == .revoked)
        #expect(BridgeClient.ending(greeted: false, closeCode: 0, upgradeStatus: 401) == .unrecognized)
        #expect(BridgeClient.ending(greeted: true, closeCode: 1006, upgradeStatus: 101) == .greeted)
        #expect(BridgeClient.ending(greeted: false, closeCode: 0, upgradeStatus: 503) == .failed)
        #expect(BridgeClient.ending(greeted: false, closeCode: 0, upgradeStatus: nil) == .failed)
    }

    @Test func backoffDoublesAndCapsAtThirtySeconds() {
        #expect((0..<8).map { Backoff.delay(afterFailures: $0) } == [1, 2, 4, 8, 16, 30, 30, 30])
    }
}

@Suite struct StreamCursorTests {
    private func hello(epoch: String, seq: Int, resumed: Bool) -> ServerFrame {
        ServerFrame(message: .hello(Hello(machine: "Mac", userName: "A", bots: [], position: StreamPosition(epoch: epoch, seq: seq, resumed: resumed))))
    }

    private func broadcast(_ seq: Int) -> ServerFrame {
        ServerFrame(seq: seq, message: .botRemoved(BotID("b1")))
    }

    private func cursor(at seq: Int) -> StreamCursor {
        var cursor = StreamCursor()
        _ = cursor.observe(hello(epoch: "e1", seq: seq, resumed: false))
        return cursor
    }

    @Test func aFreshHelloStartsTheCursorAtItsPosition() {
        let cursor = cursor(at: 41)
        #expect(cursor.resumeQuery == [URLQueryItem(name: "epoch", value: "e1"), URLQueryItem(name: "after", value: "41")])
    }

    @Test func eachNextSeqAdvancesTheCursor() {
        var cursor = cursor(at: 41)
        #expect(cursor.observe(broadcast(42)) == .inOrder)
        #expect(cursor.observe(broadcast(43)) == .inOrder)
        #expect(cursor.resumeQuery.last == URLQueryItem(name: "after", value: "43"))
    }

    /// After 42: a skip, a repeat, and a step back.
    @Test(arguments: [44, 42, 40])
    func aSkippedOrRepeatedSeqBreaksTheStreamAndDropsTheResume(seq: Int) {
        var cursor = cursor(at: 41)
        #expect(cursor.observe(broadcast(42)) == .inOrder)
        #expect(cursor.observe(broadcast(seq)) == .broken)
        #expect(cursor.resumeQuery.isEmpty)
    }

    @Test func repliesWithoutASeqLeaveTheCursorAlone() {
        var cursor = cursor(at: 41)
        #expect(cursor.observe(ServerFrame(message: .error(message: "Unknown bot"))) == .inOrder)
        #expect(cursor.seq == 41)
    }

    @Test func aResumedHelloKeepsOurSeqUntilTheReplayAdvancesIt() {
        var cursor = cursor(at: 41)
        #expect(cursor.observe(hello(epoch: "e1", seq: 50, resumed: true)) == .inOrder)
        #expect(cursor.seq == 41)
        #expect(cursor.observe(broadcast(42)) == .inOrder)
        #expect(cursor.seq == 42)
    }

    @Test func aReplayThatStartsPastOurSeqIsAGap() {
        var cursor = cursor(at: 41)
        _ = cursor.observe(hello(epoch: "e1", seq: 50, resumed: true))
        #expect(cursor.observe(broadcast(43)) == .broken)
        #expect(cursor.resumeQuery.isEmpty)
    }

    @Test func aNewEpochStartsOver() {
        var cursor = cursor(at: 41)
        _ = cursor.observe(hello(epoch: "e2", seq: 3, resumed: false))
        #expect(cursor.epoch == "e2")
        #expect(cursor.seq == 3)
        #expect(cursor.observe(broadcast(4)) == .inOrder)
    }

    @Test func anUndecodableFrameWithASeqIsAGap() {
        var cursor = cursor(at: 41)
        #expect(cursor.skipped(seq: nil) == .inOrder)
        #expect(cursor.resumeQuery.isEmpty == false)
        #expect(cursor.skipped(seq: 42) == .broken)
        #expect(cursor.resumeQuery.isEmpty)
    }

    @Test func theSeqOfAnUndecodableFrameIsReadFromItsJSON() {
        #expect(BridgeClient.seq(in: Data(#"{"type":"message","seq":42,"botId":"b1","message":{"kind":"bot"}}"#.utf8)) == 42)
        #expect(BridgeClient.seq(in: Data(#"{"type":"error","message":7}"#.utf8)) == nil)
        #expect(BridgeClient.seq(in: Data("not json".utf8)) == nil)
    }

    @Test func aBridgeWithoutAReplayRingIsNeverAskedToResumeOrHeldToSeqs() {
        var cursor = StreamCursor()
        _ = cursor.observe(hello(epoch: "", seq: 0, resumed: false))
        #expect(cursor.observe(broadcast(7)) == .inOrder)
        #expect(cursor.skipped(seq: 8) == .inOrder)
        #expect(cursor.resumeQuery.isEmpty)
    }
}

@Suite struct DeepLinkTests {
    @Test func aBotLinkOpensTheBotAtTheMessage() {
        #expect(DeepLink(url: URL(string: "claudiobot://bot/b1?message=m8")!) == .bot(BotID("b1"), message: MessageID("m8")))
        #expect(DeepLink(url: URL(string: "claudiobot://bot/b1")!) == .bot(BotID("b1"), message: nil))
    }

    @Test func aPairLinkCarriesTheInvite() {
        let url = URL(string: "claudiobot://pair?url=ws%3A%2F%2F10.0.0.20%3A7878%2Fws&code=K7QD-M2XP")!
        #expect(DeepLink(url: url) == .pair(PairInvite(url: URL(string: "ws://10.0.0.20:7878/ws")!, code: "K7QD-M2XP")))
    }

    @Test func aProtocol2LinkAsksForABridgeUpdateInsteadOfPairing() {
        let url = URL(string: "claudiobot://pair?url=ws%3A%2F%2F10.0.0.20%3A7878%2Fws&token=0123abcd")!
        #expect(DeepLink(url: url) == .outdatedBridge)
        #expect(DeepLink(url: URL(string: "claudiobot://pair?url=ws%3A%2F%2F10.0.0.20%3A7878%2Fws")!) == nil)
    }

    @Test func otherLinksAreIgnored() {
        #expect(DeepLink(url: URL(string: "claudiobot://bot/")!) == nil)
        #expect(DeepLink(url: URL(string: "claudiobot://settings")!) == nil)
        #expect(DeepLink(url: URL(string: "https://bot/b1")!) == nil)
    }
}

@Suite struct PairingFlowTests {
    private let invite = PairInvite(url: URL(string: "ws://10.0.0.20:7878/ws")!, code: "K7QD-M2XP")
    private let other = PairInvite(url: URL(string: "ws://10.0.0.99:7878/ws")!, code: "AAAA-BBBB")

    @Test func nothingIsRedeemedWithoutConfirmation() {
        var flow = PairingFlow()
        #expect(flow.confirm() == nil)
        flow.propose(invite)
        #expect(flow.confirming == invite)
        #expect(flow.isPairing == false)
        #expect(flow.confirm() == invite)
        #expect(flow.isPairing)
        #expect(flow.confirm() == nil)
    }

    @Test func cancellingTheConfirmationRedeemsNothing() {
        var flow = PairingFlow()
        flow.propose(invite)
        flow.cancelConfirmation()
        #expect(flow.confirming == nil)
        #expect(flow.confirm() == nil)
    }

    @Test func aLinkArrivingMidPairingDoesNotReplaceIt() {
        var flow = PairingFlow()
        flow.propose(invite)
        _ = flow.confirm()
        flow.propose(other)
        #expect(flow.step == .pairing(invite))
    }

    @Test func aFailureReturnsToTheFormWithItsReasonUntilTheNextProposal() {
        var flow = PairingFlow()
        flow.propose(invite)
        _ = flow.confirm()
        flow.fail("The bridge took the pairing code but did not connect.")
        #expect(flow.step == .entering)
        #expect(flow.failure == "The bridge took the pairing code but did not connect.")
        flow.propose(other)
        #expect(flow.failure == nil)
        #expect(flow.confirming == other)
    }
}

@MainActor
@Suite struct NotifierTests {
    private let bot = Bot(
        id: BotID("b1"), name: "bot", title: nil, avatar: .standard, pinned: false, hidden: false, status: .idle,
        unread: 0, question: nil, preview: "", lastAt: .now, createdAt: .now, routines: []
    )

    @Test func eachCardKeepsItsOwnNotificationWhileMessagesShareOnePerBot() {
        let ids = [
            Alert(bot: bot, reason: .message("one")),
            Alert(bot: bot, reason: .message("two")),
            Alert(bot: bot, reason: .permission(id: MessageID("p1"), label: "Push")),
            Alert(bot: bot, reason: .permission(id: MessageID("p2"), label: "Push")),
            Alert(bot: bot, reason: .question(id: MessageID("q1"), question: "Merge?", options: ["Yes"])),
        ].map(Notifier.identifier(for:))
        #expect(ids[0] == ids[1])
        #expect(Set(ids[1...]).count == 4)
    }
}
