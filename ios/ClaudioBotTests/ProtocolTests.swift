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
        if case .unknown(let raw) = bot.kind { found.append("bot kind \(raw)") }
        if case .unknown(let raw) = bot.avatar.shape { found.append("shape \(raw)") }
        if case .unknown(let raw) = bot.avatar.color { found.append("color \(raw)") }
        return found + bot.routines.flatMap(inRoutine)
    }
    func inAgent(_ agent: Agent) -> [String] {
        if case .unknown(let raw) = agent.status { return ["agent status \(raw)"] }
        return []
    }
    func inRow(_ row: SessionRow) -> [String] {
        var found: [String] = []
        if case .unknown(let raw) = row.origin { found.append("origin \(raw)") }
        if case .unknown(let raw) = row.status { found.append("session status \(raw)") }
        if case .unknown(let raw) = row.holder { found.append("holder \(raw)") }
        if case .unknown(let raw) = row.mirror { found.append("mirror \(raw)") }
        if case .unknown(let raw)? = row.pr?.state { found.append("pr state \(raw)") }
        if case .unknown(let raw)? = row.outcome?.kind { found.append("outcome kind \(raw)") }
        return found
    }
    func inControls(_ controls: SessionControls?) -> [String] {
        guard let controls else { return [] }
        let modes = ([controls.mode] + controls.modes).compactMap { if case .unknown(let raw) = $0 { "mode \(raw)" } else { nil } }
        let kinds = (controls.tasks ?? []).compactMap { if case .unknown(let raw) = $0.kind { "task kind \(raw)" } else { nil } }
        return modes + kinds
    }
    func inItem(_ item: SessionItem) -> [String] {
        switch item {
        case .unknown(_, _, let kind): return ["item kind \(kind)"]
        case .user(_, _, _, let from, _, _): return if case .unknown(let raw) = from { ["author \(raw)"] } else { [] }
        case .work(_, _, let steps): return steps.compactMap { if case .unknown(let raw) = $0.state { "step state \(raw)" } else { nil } }
        case .todo(_, _, let todos): return todos.compactMap { if case .unknown(let raw) = $0.state { "todo state \(raw)" } else { nil } }
        case .plan(_, _, _, let state, _): return if case .unknown(let raw) = state { ["plan state \(raw)"] } else { [] }
        case .permission(_, _, let p): return if case .unknown(let raw) = p.card.answer { ["permission answer \(raw)"] } else { [] }
        case .ask(_, _, _, let answers, _): return if case .closed(let raw) = answers { ["ask answers \(raw)"] } else { [] }
        case .notice(_, _, _, let tone, let reason):
            var found: [String] = []
            if case .unknown(let raw) = tone { found.append("tone \(raw)") }
            if case .unknown(let raw)? = reason { found.append("notice reason \(raw)") }
            return found
        default: return []
        }
    }
    func inMessage(_ message: Message) -> [String] {
        switch message {
        case .unknown(_, _, let kind): ["message kind \(kind)"]
        case .user(_, _, _, _, _, let mentions): mentions.compactMap { if case .unknown(let kind) = $0 { "mention kind \(kind)" } else { nil } }
        case .permission(_, _, let card): if case .unknown(let raw) = card.answer { ["permission answer \(raw)"] } else { [] }
        default: []
        }
    }
    func inPush(_ push: PushState?) -> [String] {
        if case .unknown(let raw)? = push { return ["push state \(raw)"] }
        return []
    }
    switch message {
    case .unknown(let type): return ["type \(type)"]
    case .hello(let hello): return hello.bots.flatMap(inBot) + inPush(hello.push)
    case .pushState(let push): return inPush(push)
    case .sessionAlert(let alert): return if case .unknown(let raw) = alert.reason { ["alert reason \(raw)"] } else { [] }
    case .error(_, .unknown(let raw)?): return ["error about \(raw)"]
    case .bot(let b): return inBot(b)
    case .conversation(_, let messages): return messages.flatMap(inMessage)
    case .message(_, let m): return inMessage(m)
    case .details(_, _, _, let agents, let routines): return agents.flatMap(inAgent) + routines.flatMap(inRoutine)
    case .agent(let a, _): return inAgent(a)
    case .commands(_, let commands): return commands.compactMap { if case .unknown(let raw) = $0.source { "command source \(raw)" } else { nil } }
    case .usage(.unavailable(let reason, _)): return if case .unknown(let raw) = reason { ["usage reason \(raw)"] } else { [] }
    case .sessions(.list(_, let rows, let mirror)):
        let pref: [String] = if case .unknown(let raw) = mirror { ["mirror pref \(raw)"] } else { [] }
        return rows.flatMap(inRow) + pref
    case .sessions(.changed(let rows, _, _)): return rows.flatMap(inRow)
    case .thread(_, .snapshot(let snapshot)): return snapshot.items.flatMap(inItem) + inControls(snapshot.controls)
    case .thread(_, .items(_, let items, _, let controls)): return items.flatMap(inItem) + inControls(controls)
    case .thread(_, .page(let items, _)): return items.flatMap(inItem)
    case .usage(.ok(_, _, _, let windows)):
        return windows.flatMap { w -> [String] in
            var found: [String] = []
            if case .unknown(let raw) = w.kind { found.append("window kind \(raw)") }
            if case .unknown(let raw) = w.severity { found.append("severity \(raw)") }
            return found
        }
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

    @Test func aFactWithoutConfirmedReadsAsConfirmedAndAProposalKeepsFalse() throws {
        let old = try decode(Fact.self, #"{"id":"f_1","text":"Likes jazz","at":"2026-10-16T12:00:00.000Z","by":null}"#)
        let proposed = try decode(Fact.self, #"{"id":"f_2","text":"Likes tea","at":"2026-10-16T12:00:00.000Z","by":"Eng","confirmed":false}"#)
        #expect(old.confirmed == true)
        #expect(proposed.confirmed == false)
        #expect(proposed.by == "Eng")
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
        #expect(bot.spend == Spend(spentUsd: 8.4, limitUsd: 10))
        #expect(hello.features.contains(.spend))
    }

    @Test func aBotFromABridgeWithoutSpendHasNoSpendAndEncodesNone() throws {
        let json = #"{"id":"b1","name":"e","title":null,"avatar":{"shape":"circle","color":"white"},"pinned":false,"hidden":false,"status":"idle","unread":0,"question":null,"preview":"","lastAt":"2026-10-16T12:00:00.000Z","createdAt":"2026-10-16T12:00:00.000Z","routines":[]}"#
        let bot = try decode(Bot.self, json)
        #expect(bot.spend == nil)
        #expect(try jsonObject(Wire.encoder().encode(bot))["spentTodayUsd"] == nil)
    }

    @Test func agentFramesCarryAMacAgentsSpendAndNullForACloudAgent() throws {
        let details = try Fixture.server().compactMap { frame -> [Agent]? in
            if case .details(_, _, _, let agents, _) = frame.message { agents } else { nil }
        }.first ?? []
        #expect(details.first { $0.where == .mac }?.spend == Spend(spentUsd: 1.2, limitUsd: 5))
        #expect(details.first { $0.where == .cloud }?.spend == nil)
    }

    @Test func usageFramesDecodeTheWindowsOrWhyThereAreNone() throws {
        let usage = try Fixture.server().compactMap { frame -> PlanUsage? in
            if case .usage(let u) = frame.message { #expect(frame.seq == nil, "usage is a live signal"); return u } else { return nil }
        }
        guard usage.count == 2, case let .ok(plan, _, stale, windows) = usage[0] else { Issue.record("not ok first: \(usage)"); return }
        #expect(plan == "max" && !stale)
        #expect(windows.map(\.kind) == [.session, .weekly, .weeklyModel])
        #expect(windows.map(\.severity) == [.normal, .warning, .critical])
        #expect(windows[0].utilization == 0.37)
        #expect(windows[2].resetsAt == nil)
        #expect(usage[0].session?.label == "Current session")
        guard case .unavailable(.apiKey, _) = usage[1] else { Issue.record("not api_key: \(usage[1])"); return }
        #expect(try decode(UsageSeverity.self, #""exceeded""#) == .unknown("exceeded"))
        let future = try decode(PlanUsage.self, #"{"state":"paused","fetchedAt":"2026-10-16T14:00:00.000Z"}"#)
        guard case .unavailable(.failed, _) = future else { Issue.record("an unknown state is not failed: \(future)"); return }
    }

    @Test func theSessionsListDecodesItsProjectsAndRowsWithNoSeq() throws {
        let frames = try Fixture.server().compactMap { frame -> SessionsFrame? in
            if case .sessions(let f) = frame.message { #expect(frame.seq == nil, "session frames are never sequenced"); return f } else { return nil }
        }
        guard frames.count == 3, case let .list(projects, rows, mirror) = frames[0], case let .changed(changed, removed, touched) = frames[1] else {
            Issue.record("not a list then a diff: \(frames)"); return
        }
        #expect(projects.map(\.name) == ["solta-o-som", "claudio-bot"])
        #expect(projects[0].githubRepo == "IamP5/solta-o-som")
        #expect(mirror == .auto)
        #expect(rows.map(\.origin) == [.agent, .desktop, .cloud])
        #expect(rows[0].agent == SessionAgentLink(botId: BotID("b1"), agentId: AgentID("a3")))
        #expect(rows[0].holder == .claudio && rows[0].mirror == .pending && rows[0].worktree)
        #expect(rows[1].holder == .desktop && rows[1].unread && rows[1].mirror == .imported)
        #expect(rows[1].pr?.number == 87 && rows[1].pr?.state == .open)
        #expect(rows[2].url == URL(string: "https://claude.ai/code/session_01Hq7vXk3mRt9wYpL2nB5cDe"))
        #expect(rows[2].mirror == .notMirrored && rows[2].holder == .nobody)
        #expect(changed.map(\.status) == [.awaitingApproval, .awaitingInput])
        #expect(changed[1].parentId == rows[1].id)
        #expect(removed == [SessionID("0d4e7b2a-9f1c-4e3b-b8a6-5c2d1e7f9a04")])
        #expect(touched.map(\.id) == [projects[0].id])
    }

    @Test func threadFramesDecodeEveryItemKindAndTheLiveText() throws {
        let frames = try Fixture.server().compactMap { frame -> (SessionID, ThreadFrame)? in
            if case let .thread(id, f) = frame.message { #expect(frame.seq == nil, "session frames are never sequenced"); return (id, f) } else { return nil }
        }
        let thread = frames.map(\.1)
        guard case .snapshot(let snapshot) = thread.first else { Issue.record("no snapshot first"); return }
        #expect(snapshot.position == ThreadPosition(epoch: "e_7f3a", rev: 42))
        #expect(snapshot.before == Cursor("8812331:2b7c9e41"))
        #expect(snapshot.controls.modes == [.default, .acceptEdits, .plan])
        guard case let .work(_, _, steps) = snapshot.items[3] else { Issue.record("no work item"); return }
        #expect(steps.map(\.state) == [.ok, .ok, .error])
        #expect(steps[1].diff == ToolDiff(path: "src/audio/fade.ts", added: 12, removed: 4))
        #expect(steps[2].output == " 13 pass\n 1 fail\n")

        let live = try #require(snapshot.live)
        guard case let .delta(itemId, offset, _) = thread[1] else { Issue.record("no delta after the snapshot"); return }
        #expect(itemId == live.itemId)
        #expect(offset == live.text.utf16.count, "a delta applies at the live text's UTF-16 length")

        let all = thread.flatMap { frame -> [SessionItem] in
            switch frame {
            case .snapshot(let s): s.items
            case .items(_, let items, _, _), .page(let items, _): items
            default: []
            }
        }
        let kinds = Set(all.map { (try? jsonObject(Wire.encoder().encode($0)))?["kind"] as? String ?? "?" })
        #expect(kinds == ["user", "assistant", "thinking", "work", "todo", "plan", "permission", "ask", "notice", "compaction"])
        let permission = all.compactMap { if case .permission(_, _, let p) = $0 { p } else { nil } }.first
        #expect(permission?.cardId == MessageID("m20"))
        #expect(permission?.card.tool == "Bash" && permission?.card.answer == nil)
        let asks = all.compactMap { if case let .ask(_, _, questions, answers, cardId) = $0 { (questions, answers, cardId) } else { nil } }
        #expect(asks.map { $0.2 } == [MessageID("m21"), nil, MessageID("m18")], "a closed question keeps its card id")
        #expect(asks[0].1 == nil && asks[0].0[0].options.map(\.label) == ["Web Audio API", "Howler.js"])
        #expect(asks[1].1 == .answered(["Which audio library should the fade use?": "Web Audio API"]))
        let plans = all.compactMap { if case let .plan(_, _, _, state, cardId) = $0 { "\(state.rawValue):\(cardId?.rawValue ?? "-")" } else { nil } }
        #expect(plans == ["proposed:m22", "approved:-", "rejected:m19"], "a decided plan keeps its card id")

        let removals: [SessionID?] = thread.compactMap { frame -> SessionID?? in
            if case .removed(let movedTo) = frame { .some(movedTo) } else { nil }
        }
        #expect(removals == [SessionID("f2c8b4a6-1e3d-4f9b-a7c5-6d2e8b1f4a37"), nil])
        #expect(thread.contains { if case .toolOutput("toolu_01Ab5", _) = $0 { true } else { false } })
    }

    @Test func unknownSessionValuesDecodeAndKeepTheirWireStrings() throws {
        let item = try decode(SessionItem.self, #"{"kind":"diagram","id":"i9","at":"2026-10-16T12:00:00.000Z","svg":"<svg/>"}"#)
        #expect(item == .unknown(id: ItemID("i9"), at: at, kind: "diagram"))
        #expect(try decode(SessionOrigin.self, #""ide""#) == .unknown("ide"))
        #expect(try decode(SessionStatus.self, #""compacting""#) == .unknown("compacting"))
        #expect(try decode(SessionHolder.self, #""none""#) == .nobody)
        #expect(try decode(SessionMirror.self, #""none""#) == .notMirrored)
        #expect(try decode(PermissionMode.self, #""yolo""#) == .unknown("yolo"))
        #expect(try decode(AskAnswers.self, #""withdrawn""#) == .closed("withdrawn"))
        // A card the user's Stop closed: this app has no word for it yet and reads it as closed, not expired.
        #expect(try decode(AskAnswers.self, #""stopped""#) == .closed("stopped"))
        #expect(try decode(PlanState.self, #""stopped""#) == .unknown("stopped"))
        #expect(try decode(AskAnswers.self, #""expired""#) == .expired)
        #expect(try Wire.encoder().encode(SessionHolder.nobody) == Data(#""none""#.utf8))
    }

    @Test func rowsCarryTheirRunAndHowTheLastRunEnded() throws {
        let rows = try Fixture.server().compactMap { frame -> [SessionRow]? in
            if case .sessions(.changed(let rows, _, _)) = frame.message, rows.contains(where: { $0.since != nil || $0.outcome != nil }) { rows } else { nil }
        }.first ?? []
        #expect(rows.count == 3)
        #expect(rows[0].since == at && rows[0].running == SessionRunning(agents: 1, commands: 1))
        #expect(rows[0].activity == "Waiting for approval: Bash" && rows[0].outcome == nil)
        #expect(rows[1].outcome?.kind == .failed && rows[1].outcome?.text == "Claude Code exited: out of memory")
        #expect(rows[2].outcome?.kind == .stopped && rows[2].since == nil && rows[2].running == nil)
    }

    @Test func aRunningThreadJoinsItsTasksToTheStepsTheyStarted() throws {
        let frames = try Fixture.server().compactMap { frame -> (items: [SessionItem], controls: SessionControls)? in
            if case let .thread(_, .items(_, items, _, controls?)) = frame.message, controls.tasks != nil { (items, controls) } else { nil }
        }
        guard frames.count == 2 else { Issue.record("not a running frame then a wake turn: \(frames.count)"); return }
        let (items, controls) = frames[0]
        #expect(controls.working && controls.turn == SessionTurn(startedAt: "2026-10-16T12:00:00.000Z", wake: false))
        #expect(controls.heardAt == at.addingTimeInterval(7200))
        let tasks = try #require(controls.tasks)
        #expect(tasks.map(\.kind) == [.agent, .command, .command])
        #expect(tasks[0].waiting == MessageID("m23") && tasks[0].progress?.tools == 3 && tasks[0].progress?.last == "Bash")
        #expect(tasks[1].owner == "toolu_01Ac1" && tasks[1].progress == nil && tasks[1].background)
        #expect(tasks.map(\.outlived) == [false, false, true])
        #expect(tasks[2].label == "perl -e 'sleep 90'" && !tasks[2].background)
        #expect(try jsonObject(Wire.encoder().encode(tasks[2]))["outlived"] as? Bool == true)
        #expect(try jsonObject(Wire.encoder().encode(tasks[0]))["outlived"] == nil)

        guard case let .work(_, _, steps) = items.first else { Issue.record("no work item first"); return }
        #expect(steps.map(\.state) == [.running, .waiting, .running, .error, .stopped, .unsure, .ended, .running])
        #expect(tasks.compactMap(\.stepId).allSatisfy { id in steps.contains { $0.id == id } }, "every task names a step in the thread")
        #expect(steps[0].background && steps[0].detail == "general-purpose" && steps[0].startedAt == at)
        #expect(!steps[1].background && steps[1].owner == "toolu_01Ac1" && steps[1].startedAt == nil)
        #expect(steps[3].cause == "Exit code 1: ls: late.txt: No such file or directory" && steps[3].endedAt == at.addingTimeInterval(7200))
        #expect(steps[4].usage == ToolUsage(tools: 4, ms: 31000) && steps[4].cause == "Stopped by you")
        #expect(steps[5].cause == "Can't tell whether this still runs on your Mac" && steps[5].background)

        let cards = items.compactMap { if case .permission(_, _, let p) = $0 { p } else { nil } }
        #expect(cards.map(\.stepId) == ["toolu_01Ac2", "toolu_01Ac6", "toolu_01Ac7"])
        #expect(cards.map(\.subagent) == ["sleeper two", "sleeper one", nil])
        #expect(cards.map(\.card.answer) == [nil, .stopped, .closed])
        #expect(cards[2].card.answer?.outcome().short == "Closed", "a card Claude Code abandoned reads closed, not expired")
        let reasons = items.compactMap { if case let .notice(_, _, _, _, reason) = $0 { reason } else { nil } }
        #expect(reasons == [.task, .stop])

        let wake = frames[1].controls
        #expect(wake.working && wake.turn?.wake == true && wake.tasks == [])
    }

    @Test func pushStateAndErrorsAboutARequestDecodeToTypedValues() throws {
        let frames = try Fixture.server().map(\.message)
        guard case .hello(let hello) = frames[0] else { Issue.record("not hello"); return }
        #expect(hello.push == .on)
        let pushes = frames.compactMap { if case .pushState(let p) = $0 { p } else { nil } }
        #expect(pushes == [.failing(error: "The push server answered 500", at: at.addingTimeInterval(7200)), .off])
        let abouts = frames.compactMap { if case .error(_, let about?) = $0 { about } else { nil } }
        let agent = SessionID("6b1f3c2a-8d4e-4f7a-9c1b-2e5d7a9f0c31")
        #expect(abouts == [
            .stop(sessionId: agent), .set(sessionId: agent), .send(sessionId: agent, clientId: "c_4d2a"), .tool(sessionId: agent, toolUseId: "toolu_01Ab5"), .create(ref: "s1"),
            .decide(sessionId: agent, cardId: MessageID("m20")), .page(sessionId: agent),
        ])
        let plain = frames.compactMap { if case let .error(message, nil) = $0 { message } else { nil } }
        #expect(plain == ["Unknown bot"])
    }

    @Test func framesWithoutTheRunStateKeysDecodeAsBeforeAndEncodeNone() throws {
        let step = try decode(ToolStep.self, #"{"id":"t1","tool":"Bash","label":"Run ls","state":"ok","diff":null,"output":null}"#)
        #expect(step.detail == nil && step.startedAt == nil && step.endedAt == nil && !step.background && step.owner == nil && step.cause == nil && step.usage == nil)
        #expect(try jsonObject(Wire.encoder().encode(step)).allKeys.count == 6)
        let controls = try decode(SessionControls.self, #"{"canSend":true,"reason":null,"working":true,"queued":0,"model":null,"models":[],"mode":"default","modes":[]}"#)
        #expect(controls.turn == nil && controls.tasks == nil && controls.heardAt == nil && controls.stopping == nil)
        #expect(try jsonObject(Wire.encoder().encode(controls))["tasks"] == nil)
        #expect(try jsonObject(Wire.encoder().encode(controls))["stopping"] == nil)
        let notice = try decode(SessionItem.self, #"{"kind":"notice","id":"n1","at":"2026-10-16T12:00:00.000Z","text":"Interrupted","tone":"info"}"#)
        #expect(notice == .notice(id: ItemID("n1"), at: at, text: "Interrupted", tone: .info, reason: nil))
        let hello = try decode(ServerMessage.self, #"{"type":"hello","protocol":3,"machine":"Mac","userName":"Alex","bots":[]}"#)
        guard case .hello(let old) = hello else { Issue.record("not hello"); return }
        #expect(old.push == nil)
        let stop = try decode(ClientMessage.self, #"{"type":"session_stop","sessionId":"s1"}"#)
        #expect(stop == .sessionStop(sessionId: SessionID("s1"), target: nil, turnStartedAt: nil))
        let send = ClientMessage.sessionSend(sessionId: SessionID("s1"), text: "hi", clientId: "c1", interrupt: true)
        #expect(try jsonObject(Wire.encoder().encode(send))["turnStartedAt"] == nil)
    }

    @Test func aStopClaudeCodeHasNotConfirmedSaysWhenTheBridgeGivesUpWaiting() throws {
        let stopping = try Fixture.server().compactMap { frame -> SessionStopping? in
            if case let .thread(_, .items(_, _, _, controls?)) = frame.message { controls.stopping } else { nil }
        }
        #expect(stopping == [SessionStopping(at: at.addingTimeInterval(7200), deadline: at.addingTimeInterval(7215))])
    }

    @Test(arguments: ["2026-10-21T07:21:24.608Z", "2026-10-21T07:21:24.6081Z", "2026-10-21T07:21:24Z"])
    func aStopSendsBackTheTurnStartExactlyAsTheBridgeWroteIt(startedAt: String) throws {
        let json = #"{"canSend":true,"reason":null,"working":true,"queued":0,"model":null,"models":[],"mode":"default","modes":[],"turn":{"startedAt":"\#(startedAt)","wake":false}}"#
        let turn = try #require(try decode(SessionControls.self, json).turn)
        let stop = ClientMessage.sessionStop(sessionId: SessionID("s1"), target: .turn, turnStartedAt: turn.startedAt)
        #expect(try jsonObject(Wire.encoder().encode(stop))["turnStartedAt"] as? String == startedAt)
    }

    @Test func runStateValuesANewerBridgeInventsDecodeAndKeepTheirWireStrings() throws {
        let step = try decode(ToolStep.self, #"{"id":"t1","tool":"Bash","label":"Run ls","state":"paused","diff":null,"output":null}"#)
        #expect(step.state == .unknown("paused"))
        #expect(try jsonObject(Wire.encoder().encode(step))["state"] as? String == "paused")
        #expect(try decode(SessionTaskKind.self, #""monitor""#) == .unknown("monitor"))
        #expect(try decode(SessionOutcomeKind.self, #""cancelled""#) == .unknown("cancelled"))
        #expect(try decode(NoticeReason.self, #""compact""#) == .unknown("compact"))
        #expect(try decode(PushState.self, #"{"state":"snoozed"}"#) == .unknown("snoozed"))
        #expect(try decode(ErrorAbout.self, #"{"kind":"approve","sessionId":"s1"}"#) == .unknown("approve"))
        #expect(try decode(PermissionAnswer.self, #""withdrawn""#) == .unknown("withdrawn"))
    }

    @Test func theSessionRequestsTheAppBuildsAreTheFixtureFrames() throws {
        let fixtures = try Fixture.entries("client").map(jsonObject)
        let agent = SessionID("6b1f3c2a-8d4e-4f7a-9c1b-2e5d7a9f0c31")
        let built: [ClientMessage] = [
            .watchSessions,
            .unwatchSessions,
            .watchSession(sessionId: agent, after: nil),
            .watchSession(sessionId: agent, after: ThreadPosition(epoch: "e_7f3a", rev: 42)),
            .unwatchSession(sessionId: agent),
            .sessionPage(sessionId: agent, before: Cursor("8812331:2b7c9e41")),
            .sessionSend(sessionId: agent, text: "Also check it on Firefox", clientId: "c_4d2a", interrupt: false),
            .sessionSend(
                sessionId: SessionID("b109b727-4c1e-4a8b-9e2f-7d3c5a1b8e40"), text: "Stop, use the Web Audio API instead", clientId: "c_4d2c", interrupt: true,
                turnStartedAt: "2026-10-16T12:00:00.000Z"
            ),
            .sessionStop(sessionId: agent),
            .sessionStop(sessionId: agent, target: .turn, turnStartedAt: "2026-10-16T12:00:00.000Z"),
            .sessionStop(sessionId: agent, target: .task(TaskID("bk2x9q7")), turnStartedAt: "2026-10-16T12:00:00.000Z"),
            .sessionUnqueue(sessionId: agent, clientId: "c_4d2a"),
            .sessionDecide(sessionId: agent, cardId: MessageID("m20"), choice: .once),
            .sessionAnswer(sessionId: agent, cardId: MessageID("m21"), answers: ["Which audio library should the fade use?": "Howler.js"]),
            .sessionAnswer(sessionId: agent, cardId: MessageID("m21"), answers: nil),
            .sessionCreate(ref: "s1", projectId: ProjectID("3f9a1c7e2b4d6a80"), text: "Add a mute button to the player", model: nil, mode: .plan, isolate: .worktree),
            .sessionSet(sessionId: SessionID("b109b727-4c1e-4a8b-9e2f-7d3c5a1b8e40"), patch: SessionPatch(title: "Volume slider", hidden: true)),
            .sessionSet(sessionId: agent, patch: SessionPatch(model: .some(nil), mode: .acceptEdits)),
            .sessionOpenDesktop(sessionId: agent),
            .sessionTool(sessionId: agent, toolUseId: "toolu_01Ab5"),
            .sessionPrefs(mirror: .tap),
        ]
        for message in built {
            let json = try jsonObject(Wire.encoder().encode(message))
            #expect(fixtures.contains(json), "\(json)")
        }
    }

    @Test func aBotWithNoCapDecodesTodaysSpendWithNoLimit() throws {
        let bots = try Fixture.server().compactMap { frame -> Bot? in
            if case .bot(let bot) = frame.message { bot } else { nil }
        }
        let uncapped = try #require(bots.first { $0.muted })
        #expect(uncapped.capUsd == nil)
        #expect(uncapped.spend == Spend(spentUsd: 1.25, limitUsd: nil))
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
        #expect(seqs == ["bot:42", "bot_removed:-", "bot:48", "bot:49", "bot:51", "bot:54", "bot:57"])
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
        #expect(routines.map(\.id) == [RoutineID("r1"), RoutineID("r2")])
        #expect(routines.first?.runs.map(\.id) == ["run4", "run3", "run2", "run1"].map { RunID($0) })

        let old = try decode(ServerMessage.self, #"{"type":"details","botId":"b1","library":[],"links":[],"agents":[]}"#)
        guard case .details(_, _, _, _, let none) = old else { Issue.record("not details"); return }
        #expect(none.isEmpty)
    }

    @Test func botsAndAgentsCarryTheNewStatusesAndTheDailyCap() throws {
        #expect(try Fixture.bots().map(\.status) == [.idle, .working, .awaitingApproval, .parked, .unavailable, .idle, .idle])
        #expect(try Fixture.bots().map(\.dailyCapUsd) == [nil, 5, nil, nil, nil, nil, nil])
        let agentStatuses = try Fixture.server().compactMap { frame -> AgentStatus? in
            if case .agent(let agent, _) = frame.message { agent.status } else { nil }
        }
        #expect(agentStatuses == [.waiting, .awaitingApproval, .unavailable, .capped])
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
        #expect(code == PairCode(
            code: "K7QD-M2XP", expiresAt: Date(timeIntervalSince1970: 1_792_152_600),
            urls: ["ws://mac.tail1234.ts.net:7878/ws", "ws://Mac.local:7878/ws", "ws://192.168.1.20:7878/ws"]
        ))
    }

    @Test func anUnknownPermissionAnswerStillClosesTheCard() throws {
        let json = #"{"kind":"permission","id":"m1","at":"2026-10-16T12:00:00.000Z","from":null,"tool":"Bash","label":"l","detail":"d","always":"a","answer":"withdrawn","expiresAt":"2026-10-16T13:00:00.000Z"}"#
        guard case .permission(_, _, let card) = try decode(Message.self, json) else { Issue.record("not permission"); return }
        #expect(card.answer == .unknown("withdrawn"))
    }

    @Test func unknownMessageTypeDecodesInsteadOfThrowing() throws {
        let msg = try decode(ServerMessage.self, #"{"type":"quota","tokens":12}"#)
        guard case .unknown(let type) = msg else { Issue.record("expected unknown"); return }
        #expect(type == "quota")
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
        #expect(try decode(TriggerKind.self, #""email""#) == .unknown("email"))
        #expect(try decode(Feature.self, #""rooms""#) == .unknown("rooms"))
        #expect(try decode(ConnectorStatus.self, #""disabled""#) == .unknown("disabled"))
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
        #expect(BotStatus.allCases.map(\.rawValue) == ["idle", "working", "awaiting_approval", "parked", "unavailable"])
        #expect(AgentStatus.allCases.map(\.rawValue) == ["working", "waiting", "failed", "in_cloud", "awaiting_approval", "parked", "unavailable", "capped"])
        #expect(Feature.allCases.map(\.rawValue) == [
            "memory", "activity", "mute", "worktrees", "connectors", "skills", "webhooks", "spend",
            "mentions", "commands", "exchanges", "groups", "usage", "sessions", "presence",
            "session_tasks", "session_unqueue", "push_state", "decide_ack",
        ])
        #expect(ToolStepState.allCases.map(\.rawValue) == ["running", "waiting", "ok", "error", "denied", "stopped", "unsure", "ended"])
        #expect(SessionTaskKind.allCases.map(\.rawValue) == ["agent", "command", "other"])
        #expect(SessionOutcomeKind.allCases.map(\.rawValue) == ["finished", "failed", "stopped", "lost"])
        #expect(NoticeReason.allCases.map(\.rawValue) == ["stop", "task", "restart", "failure", "approval"])
        #expect(SessionOrigin.allCases.map(\.rawValue) == ["phone", "agent", "desktop", "terminal", "sdk", "cloud"])
        #expect(SessionStatus.allCases.map(\.rawValue) == ["idle", "working", "awaiting_approval", "awaiting_input", "failed", "parked", "unavailable"])
        #expect(SessionHolder.allCases.map(\.rawValue) == ["none", "claudio", "desktop", "terminal", "other"])
        #expect(SessionMirror.allCases.map(\.rawValue) == ["imported", "pending", "failed", "none"])
        #expect(MirrorPref.allCases.map(\.rawValue) == ["auto", "tap", "never"])
        #expect(PermissionMode.allCases.map(\.rawValue) == ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"])
        #expect(SessionIsolation.allCases.map(\.rawValue) == ["none", "worktree"])
        #expect(UsageWindowKind.allCases.map(\.rawValue) == ["session", "weekly", "weekly_model"])
        #expect(UsageSeverity.allCases.map(\.rawValue) == ["normal", "warning", "critical"])
        #expect(UsageUnavailable.allCases.map(\.rawValue) == ["api_key", "third_party", "logged_out", "no_scope", "failed"])
        #expect(BotKind.allCases.map(\.rawValue) == ["bot", "group"])
        #expect(CommandSource.allCases.map(\.rawValue) == ["skill", "builtin"])
        #expect(ConnectorStatus.allCases.map(\.rawValue) == ["connected", "pending", "failed", "needs_auth", "unchecked"])
        #expect(RunStatus.allCases.map(\.rawValue) == ["running", "ok", "quiet", "failed", "skipped"])
        #expect(PermissionChoice.allCases.map(\.rawValue) == ["once", "always", "deny", "never"])
    }

    @Test func helloListsTheBridgeFeaturesAndAnOlderHelloListsNone() throws {
        guard case .hello(let hello) = try Fixture.server()[0].message else { Issue.record("not hello"); return }
        #expect(hello.features == Feature.allCases)
        let old = try decode(ServerMessage.self, #"{"type":"hello","protocol":3,"machine":"Mac","userName":"Alex","bots":[]}"#)
        guard case .hello(let none) = old else { Issue.record("not hello"); return }
        #expect(none.features.isEmpty)
    }

    @Test func aBotFromBeforeMuteIsNotMutedAndAnAgentFromBeforeEvidenceHasNone() throws {
        let bot = try decode(Bot.self, #"{"id":"b1","name":"n","title":null,"avatar":{"shape":"circle","color":"white"},"pinned":false,"hidden":false,"status":"idle","unread":0,"question":null,"preview":"","lastAt":"2026-10-16T12:00:00.000Z","createdAt":"2026-10-16T12:00:00.000Z","routines":[]}"#)
        #expect(bot.muted == false)
        let agent = try decode(Agent.self, #"{"id":"a1","botId":"b1","title":"t","where":"mac","projectName":"p","status":"waiting","url":null,"createdAt":"2026-10-16T12:00:00.000Z","updatedAt":"2026-10-16T12:00:00.000Z"}"#)
        #expect(agent.evidence == nil)
        #expect(agent.worktree == nil)
    }

    @Test func theFramesOfThePass3FeaturesDecodeToTypedValues() throws {
        let frames = try Fixture.server().map(\.message)
        let activity = frames.compactMap { if case let .activity(botId, agentId, text, _) = $0 { "\(botId):\(agentId.map(\.rawValue) ?? "-"):\(text ?? "-")" } else { nil } }
        #expect(activity == ["b1:-:Reading hub.ts", "b1:a1:-"])
        let facts = frames.compactMap { if case .memory(let f) = $0 { f } else { nil } }.first
        #expect(facts?.map(\.by) == [nil, "engineer"])
        let connectors = frames.compactMap { if case .connectors(_, let c) = $0 { c } else { nil } }.first
        #expect(connectors?.map(\.status) == [.connected, .needsAuth, .unchecked])
        #expect(connectors?.map(\.enabled) == [true, true, false])
        let skills = frames.compactMap { if case .skills(_, let s) = $0 { s } else { nil } }.first
        #expect(skills?.map(\.name) == ["release-notes"])
        let token = frames.compactMap { if case .webhookToken(_, let t) = $0 { t } else { nil } }.first
        #expect(token == WebhookToken(routineId: RoutineID("r2"), url: URL(string: "http://127.0.0.1:7879/hook/r2")!, token: "whk_3s9dK2"))
        let capped = frames.compactMap { if case .agent(let a, _) = $0, a.status == .capped { a } else { nil } }.first
        #expect(capped?.evidence?.ahead == 3)
        #expect(capped?.evidence?.pr == URL(string: "https://github.com/acme/web/pull/142"))
        #expect(capped?.worktree == Worktree(path: "/Users/alex/.claudiobot-worktrees/web/a1", branch: "claudio/verify-skill"))
        let echoed = try Fixture.messages().compactMap { if case let .user(_, _, _, _, clientId, _) = $0 { clientId } else { nil } }
        #expect(echoed == ["c_9b1e"])
        #expect(try Fixture.bots().map(\.muted) == [false, false, false, false, false, true, false])
    }

    @Test func theMentionsCommandsExchangesAndGroupsFramesDecodeToTypedValues() throws {
        let frames = try Fixture.server().map(\.message)
        let group = try #require(try Fixture.bots().first { $0.kind == .group })
        #expect(group.members == [BotID("b1"), BotID("b2")])
        #expect(try Fixture.bots().filter { $0.kind == .bot }.allSatisfy(\.members.isEmpty))
        let mentions = try Fixture.messages().compactMap { if case let .user(_, _, _, _, _, m) = $0, !m.isEmpty { m } else { nil } }.first
        #expect(mentions == [.bot(id: BotID("b1"), name: "engineer"), .connector(name: "github")])
        let posters = try Fixture.messages().compactMap { if case let .bot(_, _, _, from) = $0 { from } else { nil } }
        #expect(posters == [BotID("b1")])
        let commands = frames.compactMap { if case .commands(_, let c) = $0 { c } else { nil } }.first
        #expect(commands?.map(\.source) == [.skill, .builtin])
        #expect(commands?.map(\.argumentHint) == ["", "[instructions]"])
        let exchange = frames.compactMap { if case let .exchange(_, peer, m) = $0 { (peer, m) } else { nil } }.first
        #expect(exchange?.0 == BotID("b2"))
        #expect(exchange?.1.map(\.from) == [BotID("b1"), BotID("b2")])
    }

    @Test func framesFromABridgeWithoutTheNewFeaturesDecodeWithDefaults() throws {
        let bot = try decode(Bot.self, #"{"id":"b1","name":"n","title":null,"avatar":{"shape":"circle","color":"white"},"pinned":false,"hidden":false,"status":"idle","unread":0,"question":null,"preview":"","lastAt":"2026-10-16T12:00:00.000Z","createdAt":"2026-10-16T12:00:00.000Z","routines":[]}"#)
        #expect(bot.kind == .bot)
        #expect(bot.members == [])
        let user = try decode(Message.self, #"{"kind":"user","id":"m1","at":"2026-10-16T12:00:00.000Z","text":"hi","attachments":[]}"#)
        #expect(user == .user(id: MessageID("m1"), at: at, text: "hi", attachments: [], clientId: nil, mentions: []))
        let reply = try decode(Message.self, #"{"kind":"bot","id":"m2","at":"2026-10-16T12:00:00.000Z","text":"ok"}"#)
        #expect(reply == .bot(id: MessageID("m2"), at: at, text: "ok", from: nil))
        #expect(try jsonObject(Wire.encoder().encode(reply))["from"] == nil)
        #expect(try jsonObject(Wire.encoder().encode(user))["mentions"] == nil)
    }

    @Test func aFactFromABridgeWithoutProposerBotIdHasNone() throws {
        let old = try decode(Fact.self, #"{"id":"f_2","text":"Likes tea","at":"2026-10-16T12:00:00.000Z","by":"Eng","confirmed":false}"#)
        #expect(old.proposerBotId == nil)
        let proposed = try decode(Fact.self, #"{"id":"f_2","text":"Likes tea","at":"2026-10-16T12:00:00.000Z","by":"Eng","confirmed":false,"proposerBotId":"b1"}"#)
        #expect(proposed.proposerBotId == BotID("b1"))
    }

    @Test func aDeleteWithoutForceLeavesTheKeyOut() throws {
        let plain = try jsonObject(Wire.encoder().encode(ClientMessage.deleteBot(botId: BotID("b1"))))
        #expect(plain == ["type": "delete_bot", "botId": "b1"] as NSDictionary)
        #expect(try decode(ClientMessage.self, #"{"type":"delete_bot","botId":"b1"}"#) == .deleteBot(botId: BotID("b1"), force: false))
    }

    @Test func aSendWithoutAClientIdLeavesTheKeyOut() throws {
        let send = try jsonObject(Wire.encoder().encode(ClientMessage.send(botId: BotID("b1"), text: "hi", uploads: [])))
        #expect(send == ["type": "send", "botId": "b1", "text": "hi", "uploads": []] as NSDictionary)
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
        let several = PairInvite(url: URL(string: "ws://mac.tail1.ts.net:7878/ws")!, code: "K7QD-M2XP", fallbacks: [socket])
        #expect(PairInvite(link: several.link) == several)
    }

    @Test func aLinkWithSeveralAddressesKeepsThemBestFirstAndSkipsTheUnusableOnes() {
        let link = URL(string: "claudiobot://pair?url=ws%3A%2F%2Fmac.tail1.ts.net%3A7878%2Fws&url=http%3A%2F%2Fevil.com&url=ws%3A%2F%2Fmac.local%3A7878%2Fws&url=ws%3A%2F%2F10.0.0.20%3A7878%2Fws&code=k7qd-m2xp")!
        let invite = PairInvite(link: link)
        #expect(invite?.url == URL(string: "ws://mac.tail1.ts.net:7878/ws")!)
        #expect(invite?.fallbacks == [URL(string: "ws://mac.local:7878/ws")!, socket])
        #expect(invite?.code == "K7QD-M2XP")
        let unusableFirst = URL(string: "claudiobot://pair?url=ws%3A%2F%2Fhost%3A7878%2Fsocket&url=ws%3A%2F%2F10.0.0.20%3A7878%2Fws&code=X")!
        #expect(PairInvite(link: unusableFirst) == PairInvite(url: socket, code: "X"))
        let noneUsable = URL(string: "claudiobot://pair?url=http%3A%2F%2Fevil.com&url=ws%3A%2F%2Fhost%3A7878%2Fsocket&code=X")!
        #expect(PairInvite(link: noneUsable) == nil)
    }

    @Test(arguments: [
        // The bridge's addresses, minus the loopback ones, whatever this app pairs at.
        (["ws://mac.tail1.ts.net:7878/ws", "ws://127.0.0.1:7878/ws", "ws://10.0.0.20:7878/ws"], "ws://127.0.0.1:7878/ws",
         ["ws://mac.tail1.ts.net:7878/ws", "ws://10.0.0.20:7878/ws"]),
        (["ws://[::1]:7878/ws", "ws://localhost:7878/ws", "ws://mac.local:7878/ws"], "ws://10.0.0.20:7878/ws", ["ws://mac.local:7878/ws"]),
        // A bridge that listed none, or only loopback ones, falls back to this app's own address.
        ([], "ws://10.0.0.20:7878/ws", ["ws://10.0.0.20:7878/ws"]),
        (["ws://127.0.0.1:7878/ws"], "ws://mac.tail1.ts.net:7878/ws", ["ws://mac.tail1.ts.net:7878/ws"]),
        // ... unless that is loopback too: nothing another device could reach.
        (["ws://127.0.0.1:7878/ws"], "ws://127.0.0.1:7878/ws", []),
        ([], nil, []),
        // 127.example is a name, not the loopback network.
        (["ws://127.example:7878/ws"], nil, ["ws://127.example:7878/ws"]),
    ] as [([String], String?, [String])])
    func aPairCodeInviteCarriesEveryAddressAnotherDeviceCanReach(urls: [String], own: String?, expected: [String]) {
        let invite = PairCode(code: "K7QD-M2XP", expiresAt: .now, urls: urls).invite(fallingBackTo: own.flatMap(URL.init(string:)))
        #expect(invite?.addresses.map(\.absoluteString) ?? [] == expected)
        if let invite { #expect(invite.code == "K7QD-M2XP") }
    }

    @Test func aPairCodeFromBeforeUrlsDecodesWithNone() throws {
        let old = try decode(ServerMessage.self, #"{"type":"pair_code","code":"K7QD-M2XP","expiresAt":"2026-10-16T12:10:00.000Z"}"#)
        guard case .pairCode(let code) = old else { Issue.record("not pair_code"); return }
        #expect(code.urls == nil)
    }

    @Test func theConfirmationListsTheOtherAddressesItWillTry() {
        let tailnet = URL(string: "ws://mac.tail1.ts.net:7878/ws")!
        let local = URL(string: "ws://mac.local:7878/ws")!
        let one = PairInvite(url: tailnet, code: "X", fallbacks: [socket]).confirmation(replacing: nil)
        #expect(one.title == "Pair with mac.tail1.ts.net:7878?")
        #expect(one.detail == "If it does not answer, ClaudioBot tries 10.0.0.20:7878.")
        let home = Pairing(url: socket, credential: .device(DeviceID("d1"), token: "abc"))
        let two = PairInvite(url: tailnet, code: "X", fallbacks: [local, socket]).confirmation(replacing: home)
        #expect(two.detail == "If it does not answer, ClaudioBot tries mac.local:7878 and 10.0.0.20:7878, in that order. This replaces your pairing with 10.0.0.20:7878.")
    }

    @Test func theProofMatchesTheBridgesHmacAndRejectsAnyOther() throws {
        let nonce = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
        let proof = try #require(Data(hex: "6d94ad91bd2ce00b22986b88b0dd02d65039a108e2e89cb3f11641ff4a426130"))
        #expect(Pairing.proves(proof, nonce: nonce, token: "t1"))
        #expect(!Pairing.proves(proof, nonce: nonce, token: "t2"))
        #expect(!Pairing.proves(proof, nonce: "ff" + nonce.dropFirst(2), token: "t1"))
        #expect(!Pairing.proves(proof.dropLast(), nonce: nonce, token: "t1"))
        #expect(Data(hex: "zz") == nil)
        #expect(Data(hex: "abc") == nil)
    }

    @Test func theHealthCheckHappensBesideTheSocketPath() {
        #expect(URL(string: "wss://example.com/claudio/ws")!.besideSocket("health").absoluteString == "https://example.com/claudio/health")
        #expect(socket.besideSocket("health").absoluteString == "http://10.0.0.20:7878/health")
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

    @Test func aSessionLinkCarriesTheCardItsPushWasAbout() {
        #expect(DeepLink(url: URL(string: "claudiobot://session/s1?card=m30")!) == .session(SessionID("s1"), card: MessageID("m30")))
        #expect(DeepLink(url: URL(string: "claudiobot://session/s1")!) == .session(SessionID("s1"), card: nil))
        #expect(DeepLink(url: URL(string: "claudiobot://session/s1?card=")!) == .session(SessionID("s1"), card: nil))
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
            Alert.bot(bot, .message("one")),
            .bot(bot, .message("two")),
            .bot(bot, .permission(id: MessageID("p1"), label: "Push")),
            .bot(bot, .permission(id: MessageID("p2"), label: "Push")),
            .bot(bot, .question(id: MessageID("q1"), question: "Merge?", options: ["Yes"])),
        ].map(Notifier.identifier(for:))
        #expect(ids[0] == ids[1])
        #expect(Set(ids[1...]).count == 4)
    }

    private func session(_ id: String, _ reason: SessionAlertReason, count: Int = 1, title: String = "Sleep in parallel", kind: SessionCardKind? = .permission) -> Alert {
        let card = reason == .card || reason == .reminder
        return .session(SessionAlert(
            sessionId: SessionID(id), reason: reason, count: count, title: title, cardId: reason == .card ? MessageID("m30") : nil, cardKind: card ? kind : nil
        ))
    }

    private func ending(_ reason: SessionAlertReason, agents: Int, commands: Int) -> Alert {
        .session(SessionAlert(
            sessionId: SessionID("s1"), reason: reason, count: 1, title: "Sleep in parallel", cardId: nil,
            running: SessionRunning(agents: agents, commands: commands)
        ))
    }

    @Test func endingAlertsFromTheBridgeNameWhatStillRuns() throws {
        let endings = try Fixture.server().compactMap { frame -> SessionAlert? in
            if case .sessionAlert(let alert) = frame.message, alert.reason == .failed || alert.reason == .lost { alert } else { nil }
        }
        #expect(endings.map(\.reason) == [.lost, .failed, .lost])
        #expect(endings.map(\.running) == [nil, SessionRunning(agents: 0, commands: 2), SessionRunning(agents: 0, commands: 1)])
        #expect(endings.compactMap { Notifier.text(of: $0)?.body } == [
            "Interrupted by a bridge restart",
            "Stopped with an error. 2 commands still run on your Mac.",
            "Interrupted by a bridge restart. 1 command still runs on your Mac.",
        ])
    }

    @Test func aSessionHasOneNotificationInItsOwnThread() {
        let card = session("s1", .card, count: 3)
        let done = session("s1", .finished)
        #expect(Notifier.identifier(for: card) == "session-s1")
        #expect(Notifier.identifier(for: done) == "session-s1")
        #expect(Notifier.thread(of: done) == "s1")
        #expect(Notifier.identifier(for: session("s2", .card)) == "session-s2")
    }

    @Test func aSessionAlertNamesTheSessionAndWhatItWants() {
        func text(_ alert: Alert) -> [String]? {
            guard case .session(let s) = alert, let t = Notifier.text(of: s) else { return nil }
            return [t.title, t.body]
        }
        #expect(text(session("s1", .card)) == ["Sleep in parallel", "Needs your approval"])
        #expect(text(session("s1", .card, count: 3)) == ["Sleep in parallel", "Needs 3 approvals"])
        #expect(text(session("s1", .reminder, count: 2)) == ["Sleep in parallel", "Still waiting for 2 approvals"])
        #expect(text(session("s1", .reminder)) == ["Sleep in parallel", "Still waiting for your approval"])
        #expect(text(session("s1", .card, kind: .ask)) == ["Sleep in parallel", "Has a question for you"])
        #expect(text(session("s1", .card, kind: nil)) == ["Sleep in parallel", "Needs you"], "mixed kinds, or a bridge that does not say")
        #expect(text(session("s1", .finished, title: "  ")) == ["Claude Code session", "Finished"])
        #expect(text(session("s1", .failed)) == ["Sleep in parallel", "Stopped with an error"])
        #expect(text(session("s1", .lost)) == ["Sleep in parallel", "Interrupted by a bridge restart"])
        #expect(text(ending(.failed, agents: 0, commands: 2)) == ["Sleep in parallel", "Stopped with an error. 2 commands still run on your Mac."])
        #expect(text(ending(.lost, agents: 0, commands: 1)) == ["Sleep in parallel", "Interrupted by a bridge restart. 1 command still runs on your Mac."])
        #expect(text(ending(.lost, agents: 1, commands: 0)) == ["Sleep in parallel", "Interrupted by a bridge restart. 1 agent still runs on your Mac."])
        #expect(text(ending(.failed, agents: 1, commands: 1)) == ["Sleep in parallel", "Stopped with an error. 1 agent, 1 command still run on your Mac."])
        #expect(text(ending(.failed, agents: 0, commands: 0)) == ["Sleep in parallel", "Stopped with an error"])
        #expect(text(session("s1", .unknown("paused"))) == nil)
    }

    @Test func nothingBuzzesForWhatIsOnScreenWhileTheAppIsActive() {
        var onScreen = OnScreen()
        _ = onScreen.set(Viewing(bot: BotID("b1"), session: SessionID("s1")), for: ViewingLease())
        let other = session("s2", .card)
        #expect(Notifier.shows(session("s1", .card), active: true, onScreen: onScreen) == false)
        #expect(Notifier.shows(other, active: true, onScreen: onScreen) == true)
        #expect(Notifier.shows(.bot(bot, .message("hi")), active: true, onScreen: onScreen) == false)
        #expect(Notifier.shows(session("s1", .finished), active: false, onScreen: onScreen) == true)
    }
}
