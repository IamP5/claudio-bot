import Foundation
import Observation
import Testing
@testable import ClaudioBot

private final class BundleToken {}

private let at = Date(timeIntervalSince1970: 1_792_152_000)

private func fixtureThread() throws -> (id: SessionID, frames: [ThreadFrame]) {
    let url = Bundle(for: BundleToken.self).url(forResource: "protocol", withExtension: "json")!
    let root = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: [Any]]
    let frames = try root["server"]!.map { try Wire.decoder().decode(ServerFrame.self, from: JSONSerialization.data(withJSONObject: $0)) }
    let thread = frames.compactMap { frame -> (SessionID, ThreadFrame)? in
        if case let .thread(id, f) = frame.message { (id, f) } else { nil }
    }
    let id = thread[0].0
    return (id, thread.filter { $0.0 == id }.map(\.1))
}

private func project(_ id: String, _ name: String, lastAt: Date? = at) -> SessionProject {
    SessionProject(id: ProjectID(id), name: name, path: "/Users/alex/Dev/\(name)", githubRepo: nil, lastAt: lastAt, canCloud: false)
}

private func row(
    _ id: String, in projectId: String = "p1", parent: String? = nil, title: String? = nil, minutesAgo: Double = 0,
    status: SessionStatus = .idle, unread: Bool = false, hidden: Bool = false, branch: String? = nil
) -> SessionRow {
    SessionRow(
        id: SessionID(id), projectId: ProjectID(projectId), parentId: parent.map { SessionID($0) }, title: title ?? "Session \(id)",
        origin: .terminal, agent: nil, status: status, holder: .nobody, unread: unread, branch: branch, worktree: false, pr: nil,
        mirror: .notMirrored, hidden: hidden, url: nil, createdAt: at - minutesAgo * 60, lastAt: at - minutesAgo * 60
    )
}

private func user(_ id: String, _ text: String = "Do it", queued: Bool = false) -> SessionItem {
    .user(id: ItemID(id), at: at, text: text, from: .user, queued: queued)
}

private func say(_ id: String, _ text: String) -> SessionItem {
    .assistant(id: ItemID(id), at: at, text: text)
}

private func work(_ id: String, _ steps: [ToolStep] = [ToolStep(id: "t", tool: "Read", label: "Read a.ts", state: .ok, diff: nil, output: nil)]) -> SessionItem {
    .work(id: ItemID(id), at: at, steps: steps)
}

private func think(_ id: String) -> SessionItem {
    .thinking(id: ItemID(id), at: at, text: "Hmm", ms: 1200)
}

private let controls = SessionControls(
    canSend: true, reason: nil, working: false, queued: 0, model: nil, models: [], mode: .default, modes: [.default, .plan]
)

private func snapshot(_ items: [SessionItem], rev: Int = 1, before: Cursor? = nil, working: Bool = false, live: ThreadLive? = nil) -> ThreadFrame {
    var c = controls
    c.working = working
    return .snapshot(SessionSnapshot(epoch: "e1", rev: rev, items: items, before: before, controls: c, live: live))
}

@MainActor
private func invalidates(_ read: () -> Void, by change: () -> Void) -> Bool {
    final class Flag: @unchecked Sendable { var fired = false }
    let flag = Flag()
    withObservationTracking(read) { flag.fired = true }
    change()
    return flag.fired
}

@MainActor
@Suite struct SessionIndexTests {
    @Test func aListReplacesEverythingAndADiffUpsertsAndRemoves() {
        let index = SessionIndex()
        #expect(!index.loaded)
        index.apply(.list(projects: [project("p1", "solta-o-som")], rows: [row("a"), row("b")], mirror: .auto), at: at)
        #expect(index.loaded && index.rows.count == 2 && index.mirror == .auto)

        index.apply(.changed(rows: [row("a", title: "Renamed"), row("c", in: "p2")], removed: [SessionID("b")], projects: [project("p2", "claudio-bot")]), at: at)
        #expect(index.rows[SessionID("a")]?.title == "Renamed")
        #expect(index.rows[SessionID("b")] == nil)
        #expect(Set(index.projects.keys) == [ProjectID("p1"), ProjectID("p2")])

        index.apply(.list(projects: [project("p1", "solta-o-som")], rows: [row("z")], mirror: .tap), at: at)
        #expect(Set(index.rows.keys) == [SessionID("z")], "a list frame is the whole list")
    }

    @Test func projectsAndRootsOrderByNewestActivityAndChildrenNestOldestFirst() {
        let rows = [
            row("old", in: "p1", minutesAgo: 300),
            row("parent", in: "p1", minutesAgo: 200),
            row("child2", in: "p1", parent: "parent", minutesAgo: 1),
            row("child1", in: "p1", parent: "parent", minutesAgo: 100),
            row("grandchild", in: "p1", parent: "child1", minutesAgo: 90),
            row("fresh", in: "p2", minutesAgo: 10),
        ].reduce(into: [SessionID: SessionRow]()) { $0[$1.id] = $1 }
        let sections = SessionIndex.sections(
            rows: rows, projects: [ProjectID("p1"): project("p1", "a"), ProjectID("p2"): project("p2", "b")], query: SessionQuery()
        )
        #expect(sections.map(\.project.name) == ["a", "b"], "p1 holds the newest activity, through a child")
        #expect(sections[0].trees.map(\.row.id.rawValue) == ["parent", "old"], "a busy child lifts its parent")
        let nested = sections[0].trees[0].descendants
        #expect(nested.map(\.row.id.rawValue) == ["child1", "grandchild", "child2"])
        #expect(nested.map(\.depth) == [1, 2, 1])
        #expect(nested.map(\.isLast) == [false, false, true])
    }

    @Test func aChildWhoseParentIsGoneOrHiddenStandsAsARoot() {
        let rows = [row("orphan", parent: "missing"), row("hiddenParent", hidden: true), row("kid", parent: "hiddenParent")]
            .reduce(into: [SessionID: SessionRow]()) { $0[$1.id] = $1 }
        let roots = SessionIndex.sections(rows: rows, projects: [ProjectID("p1"): project("p1", "a")], query: SessionQuery())[0].trees
        #expect(Set(roots.map(\.row.id.rawValue)) == ["orphan", "kid"])
        let all = SessionIndex.sections(rows: rows, projects: [ProjectID("p1"): project("p1", "a")], query: SessionQuery(showHidden: true))[0].trees
        #expect(Set(all.map(\.row.id.rawValue)) == ["orphan", "hiddenParent"], "shown, the hidden parent takes its child back")
    }

    @Test func searchMatchesTitleProjectAndBranchAndListsMatchesFlat() {
        let rows = [
            row("a", title: "Fix the fade"), row("b", parent: "a", title: "Check iPad", branch: "feat/fade"),
            row("c", in: "p2", title: "Changelog"),
        ].reduce(into: [SessionID: SessionRow]()) { $0[$1.id] = $1 }
        let projects = [ProjectID("p1"): project("p1", "solta-o-som"), ProjectID("p2"): project("p2", "claudio-bot")]
        let byTitleAndBranch = SessionIndex.sections(rows: rows, projects: projects, query: SessionQuery(text: " fade "))
        let matched = byTitleAndBranch.flatMap(\.trees).map(\.row.id.rawValue).sorted()
        #expect(matched == ["a", "b"])
        let nested = byTitleAndBranch.flatMap(\.trees).flatMap(\.descendants)
        #expect(nested.isEmpty, "a narrowed list is flat")
        let byProject = SessionIndex.sections(rows: rows, projects: projects, query: SessionQuery(text: "CLAUDIO"))
        #expect(byProject.flatMap(\.trees).map(\.row.id.rawValue) == ["c"])
    }

    @Test func filtersPickWorkingNeedsYouAndUnreadAndCountVisibleRows() {
        let index = SessionIndex()
        index.apply(.list(projects: [project("p1", "a")], rows: [
            row("w", status: .working), row("q", status: .awaitingInput), row("p", status: .awaitingApproval),
            row("u", unread: true), row("h", status: .working, hidden: true),
        ], mirror: .auto))
        let ids = { (filter: SessionFilter) in Set(index.sections(SessionQuery(filter: filter)).flatMap(\.trees).map(\.row.id.rawValue)) }
        #expect(ids(.working) == ["w"])
        #expect(ids(.needsYou) == ["q", "p"])
        #expect(ids(.unread) == ["u"])
        #expect(index.counts[.working] == 1 && index.counts[.needsYou] == 2 && index.counts[.all] == 4)
        #expect(index.hiddenCount == 1)
    }

    @Test func theSectionsAreReusedUntilTheRowsChange() {
        let index = SessionIndex()
        index.apply(.list(projects: [project("p1", "a")], rows: [row("a")], mirror: .auto))
        #expect(!invalidates({ _ = index.sections(SessionQuery()) }, by: { _ = index.sections(SessionQuery()) }), "asking again changes nothing")
        #expect(invalidates({ _ = index.sections(SessionQuery()) }, by: { index.apply(.changed(rows: [row("b")], removed: [], projects: [])) }))
        #expect(index.sections(SessionQuery()).flatMap(\.trees).count == 2)
    }

    @Test func aRowWearsItsMostUrgentMarkAndSaysItAll() {
        #expect(SessionMark(row("a", status: .awaitingApproval, unread: true)) == .needsYou)
        #expect(SessionMark(row("a", status: .working, unread: true)) == .working)
        #expect(SessionMark(row("a", status: .unavailable)) == .failed)
        #expect(SessionMark(row("a", unread: true)) == .unread)
        #expect(SessionMark(row("a")) == nil)
        var agent = row("a", title: "Update README", status: .working)
        agent.origin = .agent
        agent.pr = SessionPullRequest(number: 87, url: URL(string: "https://github.com/x/y/pull/87")!, state: .open)
        let spoken = SessionText.spoken(agent, project: "solta-o-som", botName: "Claudio", now: at + 300)
        #expect(spoken.hasPrefix("solta-o-som, Update README, working, by Claudio's agent, PR 87 open, "))
    }

    @Test func anOfflineListSaysHowOldItIsAndNeverLooksAhead() {
        #expect(SessionText.updated(at + 2, now: at) == "Last updated just now")
        #expect(SessionText.updated(at, now: at + 30) == "Last updated just now")
        #expect(SessionText.updated(at, now: at + 180).hasSuffix("ago"))
    }

    @Test func ageIsShort() {
        #expect(SessionText.age(at, now: at + 20) == "now")
        #expect(SessionText.age(at, now: at + 5 * 60) == "5m")
        #expect(SessionText.age(at, now: at + 3 * 3600) == "3h")
        #expect(SessionText.age(at, now: at + 2 * 86_400) == "2d")
    }

    @Test func theStoreFeedsTheIndexAndForgetsItOnUnpair() {
        let store = AppStore()
        store.apply(.sessions(.list(projects: [project("p1", "a")], rows: [row("a")], mirror: .auto)))
        store.apply(.sessionCreated(ref: "r1", sessionId: SessionID("new")))
        #expect(store.sessions.rows.count == 1)
        #expect(store.sessions.created["r1"] == SessionID("new"))
        store.setConnection(.unpaired)
        #expect(!store.sessions.loaded && store.sessions.rows.isEmpty)
    }
}

@MainActor
@Suite struct ThreadModelTests {
    @Test func aDeltaAppliesOnlyAtTheLiveTextsUTF16Length() {
        let model = ThreadModel(id: SessionID("s"))
        model.apply(snapshot([user("u1")], live: ThreadLive(itemId: ItemID("m:1"), text: "Café 👍")))
        #expect(model.live.text == "Café 👍")
        // "Café 👍" is 6 characters and 7 UTF-16 units; the wire counts units.
        model.apply(.delta(itemId: ItemID("m:1"), offset: 6, text: "lost"))
        #expect(model.live.text == "Café 👍", "an offset short of the live length is dropped")
        model.apply(.delta(itemId: ItemID("m:1"), offset: 7, text: " ok"))
        #expect(model.live.text == "Café 👍 ok")
        model.apply(.delta(itemId: ItemID("m:2"), offset: 3, text: "late"))
        #expect(model.live.text == "Café 👍 ok", "another item's delta must start at 0")
        model.apply(.delta(itemId: ItemID("m:2"), offset: 0, text: "Next"))
        #expect(model.live.itemId == ItemID("m:2") && model.live.text == "Next")
    }

    @Test func anUpsertDropsItsLiveTextAndALateDeltaForItIsIgnored() {
        let model = ThreadModel(id: SessionID("s"))
        model.apply(snapshot([user("u1")], working: true, live: ThreadLive(itemId: ItemID("m:1"), text: "Hel")))
        model.apply(.items(rev: 2, items: [say("m:1", "Hello")], removed: [], controls: nil))
        #expect(model.live.itemId == nil && model.live.text.isEmpty)
        model.apply(.delta(itemId: ItemID("m:1"), offset: 0, text: "Hello"))
        #expect(model.live.itemId == nil, "the item has its text; a stale delta would draw it twice")
    }

    @Test func watchingAgainDropsTheLiveTextAndSendsThePositionHeld() {
        let model = ThreadModel(id: SessionID("s"))
        #expect(model.willWatch() == nil, "no position before the first snapshot")
        model.apply(snapshot([user("u1")], rev: 7, live: ThreadLive(itemId: ItemID("m:1"), text: "Hi")))
        model.apply(.items(rev: 9, items: [], removed: [], controls: nil))
        #expect(model.willWatch() == ThreadPosition(epoch: "e1", rev: 9))
        #expect(model.live.text.isEmpty)
        model.apply(.delta(itemId: ItemID("m:1"), offset: 0, text: "Hi there"))
        #expect(model.live.text == "Hi there", "the replay reply resends streaming text from 0")
    }

    @Test func aReplayedUpsertIsANoOpAndRemovalsGo() {
        let model = ThreadModel(id: SessionID("s"))
        model.apply(snapshot([user("u1"), say("a1", "One")]))
        let frame = ThreadFrame.items(rev: 2, items: [say("a2", "Two"), say("a1", "One, edited")], removed: [], controls: nil)
        model.apply(frame)
        let once = model.items
        model.apply(frame)
        #expect(model.items == once)
        #expect(model.items.map(\.id.rawValue) == ["u1", "a1", "a2"], "an upsert replaces in place, a new item appends")
        model.apply(.items(rev: 3, items: [], removed: [ItemID("a1")], controls: nil))
        #expect(model.items.map(\.id.rawValue) == ["u1", "a2"])
        #expect(model.position?.rev == 3)
    }

    @Test func aQueuedEchoIsReplacedByTheBridgesItemsUnderTheClientId() {
        let model = ThreadModel(id: SessionID("s"))
        model.apply(snapshot([user("u1")], working: true))
        model.echo(clientId: "c_1", text: "Also Firefox", at: at)
        #expect(model.items.last == user("c_1", "Also Firefox", queued: true))
        model.apply(.items(rev: 2, items: [.user(id: ItemID("c_1"), at: at + 1, text: "Also Firefox", from: .user, queued: true)], removed: [], controls: nil))
        #expect(model.items.count == 2, "the bridge's queued item is the echo, by id")
        model.apply(.items(rev: 3, items: [user("uuid-2", "Also Firefox")], removed: [ItemID("c_1")], controls: nil))
        #expect(model.items.map(\.id.rawValue) == ["u1", "uuid-2"])
    }

    @Test func aPagePrependsOlderItemsOnceAndOnlyOneRequestIsOut() {
        let model = ThreadModel(id: SessionID("s"))
        #expect(model.requestEarlier() == nil, "nothing to ask before a snapshot")
        model.apply(snapshot([user("u2"), say("a2", "B")], before: Cursor("c1")))
        #expect(model.requestEarlier() == Cursor("c1"))
        #expect(model.requestEarlier() == nil, "one page at a time")
        model.apply(.page(items: [user("u1"), say("a1", "A"), user("u2")], before: nil))
        #expect(model.items.map(\.id.rawValue) == ["u1", "a1", "u2", "a2"])
        #expect(model.before == nil && !model.loadingEarlier)
        #expect(model.requestEarlier() == nil, "the start of the transcript")
    }

    @Test func aRemovedSessionSaysWhereItMoved() {
        let model = ThreadModel(id: SessionID("s"))
        model.apply(snapshot([user("u1")]))
        model.apply(.removed(movedTo: SessionID("s2")))
        #expect(model.phase == .removed(movedTo: SessionID("s2")))
    }

    @Test func theFixtureThreadReplaysToTheItemsAndLiveTextTheBridgeMeant() throws {
        let (id, frames) = try fixtureThread()
        let store = AppStore()
        store.threads.open(id)
        guard case .removed = frames.last else {
            Issue.record("the fixture thread ends removed")
            return
        }
        for frame in frames.dropLast() { store.apply(.thread(sessionId: id, frame)) }
        let model = try #require(store.threads[id])
        #expect(model.live.text == "Now I'll update the fade test.", "the snapshot's live text and its delta at offset 15")
        #expect(model.items.first?.id == ItemID("n_1"), "the page went above")
        #expect(model.items.contains { $0.id == ItemID("toolu_01Ab9") })
        #expect(!model.items.contains { $0.id == ItemID("c_4d2a") })
        #expect(model.toolOutputs["toolu_01Ab5"]?.contains("1 fail") == true)
        #expect(model.position == ThreadPosition(epoch: "e_7f3a", rev: 45))
        store.apply(.thread(sessionId: id, frames.last!))
        #expect(model.phase == .removed(movedTo: SessionID("f2c8b4a6-1e3d-4f9b-a7c5-6d2e8b1f4a37")))
    }

    @Test func aDeltaReRendersTheLiveRowOnlyNeverTheThread() {
        let model = ThreadModel(id: SessionID("s"))
        model.apply(snapshot([user("u1"), say("a1", "Hi")], working: true, live: ThreadLive(itemId: ItemID("m:2"), text: "")))
        #expect(!invalidates({ _ = model.rows; _ = model.items; _ = model.live.itemId }, by: {
            model.apply(.delta(itemId: ItemID("m:2"), offset: 0, text: "Streaming"))
        }), "a delta leaves rows, items and the live item id alone")
        #expect(invalidates({ _ = model.live.text }, by: {
            model.apply(.delta(itemId: ItemID("m:2"), offset: 9, text: " on"))
        }))
        #expect(invalidates({ _ = model.rows }, by: {
            model.apply(.items(rev: 2, items: [say("m:2", "Streaming on")], removed: [], controls: nil))
        }))
    }

    @Test func markdownIsParsedOncePerText() {
        let model = ThreadModel(id: SessionID("s"))
        let first = model.rendered(ItemID("a1"), "**Bold** move")
        #expect(model.rendered(ItemID("a1"), "**Bold** move") == first)
        #expect(model.rendered(ItemID("a1"), "Edited") != first)
    }

    @Test func threadsKeepTheFourMostRecentAndDropFramesForOthers() {
        let threads = SessionThreads()
        for id in ["a", "b", "c", "d"] { threads.open(SessionID(id)) }
        threads.open(SessionID("a"))
        threads.open(SessionID("e"))
        #expect(Set(threads.models.keys.map(\.rawValue)) == ["a", "c", "d", "e"], "b was the least recently opened")
        #expect(threads.apply(SessionID("b"), .items(rev: 1, items: [user("u")], removed: [], controls: nil)).isEmpty)
        #expect(threads[SessionID("b")] == nil, "an upsert for a thread not kept is dropped")
        _ = threads.apply(SessionID("f"), snapshot([user("u")]))
        #expect(threads[SessionID("f")] != nil, "a snapshot is a reply to a watch, so it opens the thread")
    }

    @Test func threadsOnScreenAreNeverEvictedHoweverOldOrMany() {
        let threads = SessionThreads()
        threads.keep([SessionID("a")])
        for id in ["a", "b", "c", "d", "e"] { threads.open(SessionID(id)) }
        #expect(Set(threads.models.keys.map(\.rawValue)) == ["a", "c", "d", "e"], "b goes, not a, which a window shows")

        let five: Set<SessionID> = [SessionID("a"), SessionID("c"), SessionID("d"), SessionID("e"), SessionID("f")]
        threads.keep(five)
        threads.open(SessionID("f"))
        #expect(threads.models.count == 5, "five windows keep five threads, past the capacity")

        threads.keep(five.subtracting([SessionID("a")]))
        #expect(threads[SessionID("a")] == nil, "once off screen, the oldest goes")
        #expect(threads.models.count == 4)
    }

    @Test func theNewSessionModelsComeFromTheLastThreadThatOfferedAny() {
        let threads = SessionThreads()
        var phone = controls
        phone.models = [SessionModelOption(id: "opus", label: "Opus"), SessionModelOption(id: "haiku", label: "Haiku")]
        _ = threads.apply(SessionID("a"), .snapshot(SessionSnapshot(epoch: "e1.1", rev: 0, items: [], before: nil, controls: phone, live: nil)))
        _ = threads.apply(SessionID("b"), snapshot([]))
        #expect(threads.lastModels.map(\.id) == ["opus", "haiku"], "an agent or cloud session offers no models and leaves the menu as it was")
    }

    @Test func aSettledSessionCardClearsItsPendingDecision() {
        let store = AppStore()
        store.apply(.hello(Hello(features: [.sessions], machine: "Mac", userName: "Alex", bots: [])))
        let card = PermissionCard(from: nil, tool: "Bash", label: "Bash", detail: "rm -rf build", always: "rm in a", answer: nil, expiresAt: at + 3600)
        store.decisionSent(.once, for: MessageID("m1"))
        var decided = card
        decided.answer = .chose(.once)
        store.threads.open(SessionID("s"))
        store.apply(.thread(sessionId: SessionID("s"), .items(rev: 1, items: [
            .permission(id: ItemID("t1"), at: at, permission: SessionPermission(cardId: MessageID("m1"), at: at, card: decided)),
        ], removed: [], controls: nil)))
        #expect(store.pendingDecisions[MessageID("m1")] == nil)
    }
}

@Suite struct ThreadLayoutTests {
    @Test func aFinishedTurnFoldsItsStepsAndKeepsTheAnswerAndCards() {
        let items: [SessionItem] = [
            user("u1"), think("t1"), say("a1", "Looking"), work("w1"),
            .notice(id: ItemID("n1"), at: at, text: "Heads up", tone: .info), work("w2"), say("a2", "Done"),
            user("u2"), think("t2"), work("w3"),
        ]
        let rows = ThreadLayout.rows(items, expanded: [], working: true)
        #expect(rows.map(\.id.rawValue) == ["u1", "fold:t1", "n1", "w2", "a2", "u2", "t2", "w3"])
        if case let .fold(_, folded, expanded) = rows[1] {
            #expect(folded.map(\.id.rawValue) == ["t1", "a1", "w1"])
            #expect(!expanded)
        } else {
            Issue.record("the first steps fold")
        }
    }

    @Test func theLastTurnFoldsOnceItStopsWorkingAndAnExpandedFoldListsItsItems() {
        let items: [SessionItem] = [user("u1"), think("t1"), work("w1"), say("a1", "Done")]
        #expect(ThreadLayout.rows(items, expanded: [], working: false).map(\.id.rawValue) == ["u1", "fold:t1", "a1"])
        #expect(ThreadLayout.rows(items, expanded: [ItemID("fold:t1")], working: false).map(\.id.rawValue) == ["u1", "fold:t1", "t1", "w1", "a1"])
        #expect(ThreadLayout.rows(items, expanded: [], working: true).map(\.id.rawValue) == ["u1", "t1", "w1", "a1"])
    }

    @Test func unknownItemsAreSkipped() {
        let rows = ThreadLayout.rows([user("u1"), .unknown(id: ItemID("x"), at: at, kind: "diagram")], expanded: [], working: false)
        #expect(rows.map(\.id.rawValue) == ["u1"])
    }

    @Test func aWorkRunReadsAsOneLine() {
        let steps = [
            ToolStep(id: "1", tool: "Edit", label: "Edit a.ts", state: .ok, diff: ToolDiff(path: "a.ts", added: 3, removed: 1), output: nil),
            ToolStep(id: "2", tool: "Edit", label: "Edit a.ts", state: .ok, diff: ToolDiff(path: "a.ts", added: 2, removed: 0), output: nil),
            ToolStep(id: "3", tool: "Write", label: "Write b.ts", state: .ok, diff: ToolDiff(path: "b.ts", added: 10, removed: 0), output: nil),
            ToolStep(id: "4", tool: "Bash", label: "Run bun test", state: .error, diff: nil, output: "1 fail"),
            ToolStep(id: "5", tool: "Bash", label: "Run git status", state: .ok, diff: nil, output: nil),
            ToolStep(id: "6", tool: "mcp__x__y", label: "Ask x", state: .ok, diff: nil, output: nil),
        ]
        #expect(WorkSummary.text(steps) == "Edited 2 files, ran 2 commands, 1 other step")
        #expect(WorkSummary.errors(steps) == 1)
        let diff = WorkSummary.diff(steps)
        #expect(diff?.added == 15 && diff?.removed == 1)
        #expect(WorkSummary.fold([work("w", steps), say("a", "x")]) == "Edited 2 files, ran 2 commands, 1 other step, 1 message")
    }
}

@MainActor
@Suite struct ThreadScreenTests {
    @Test func theBannerSaysWhoElseHoldsTheSession() {
        var desktop = row("d")
        desktop.holder = .desktop
        var busy = controls
        busy.canSend = false
        #expect(ThreadBanner.of(row: desktop, controls: controls) == .alsoInDesktop)
        #expect(ThreadBanner.of(row: desktop, controls: busy) == .busyElsewhere("Working in the Claude app. Read only."))
        var terminal = row("t")
        terminal.holder = .terminal
        #expect(ThreadBanner.of(row: terminal, controls: controls) == nil, "an idle terminal leaves the phone free to send")
        #expect(ThreadBanner.of(row: terminal, controls: busy) == .busyElsewhere("Working in a terminal. Read only."))
        var cloud = row("c")
        cloud.origin = .cloud
        cloud.url = URL(string: "https://claude.ai/code/session_01")
        #expect(ThreadBanner.of(row: cloud, controls: busy) == .cloud(URL(string: "https://claude.ai/code/session_01")))
        #expect(ThreadBanner.of(row: row("n"), controls: controls) == nil)
        var parked = row("p", status: .parked)
        parked.holder = .desktop
        #expect(ThreadBanner.of(row: parked, controls: busy) == .waiting("Waiting for the Claude app to finish. Your message runs next."))
    }

    @Test func aParkedRowSaysWhatItWaitsFor() {
        var parked = row("p", title: "Fix the fade", status: .parked)
        parked.holder = .desktop
        #expect(SessionMark(parked) == .parked)
        #expect(SessionText.spoken(parked, project: "demo", botName: nil, now: at).hasPrefix("demo, Fix the fade, waiting for the claude app to finish, "))
        parked.holder = .terminal
        #expect(SessionText.parked(parked.holder) == "Waiting for the terminal to finish")
    }

    @Test func theNewestCardThatWaitsOnTheUserIsTheOneAnnounced() {
        let open = PermissionCard(from: nil, tool: "Bash", label: "Delete build", detail: "rm -rf build", always: "rm", answer: nil, expiresAt: at + 60)
        var closed = open
        closed.answer = .chose(.deny)
        let ask = SessionItem.ask(id: ItemID("q"), at: at, questions: [AskQuestion(question: "Which?", header: "", options: [], multiSelect: false)], answers: nil, cardId: MessageID("m2"))
        let answeredElsewhere = SessionItem.ask(id: ItemID("q2"), at: at, questions: [], answers: nil, cardId: nil)
        let permission = { (id: String, card: PermissionCard) in
            SessionItem.permission(id: ItemID(id), at: at, permission: SessionPermission(cardId: MessageID(id), at: at, card: card))
        }
        #expect(SessionThreadView.openCard([permission("p1", open), ask, permission("p2", closed)])?.id == ItemID("q"))
        #expect(SessionThreadView.openCard([ask, permission("p1", open)])?.announcement == "Approval needed: Delete build")
        #expect(SessionThreadView.openCard([answeredElsewhere, permission("p2", closed), say("a", "Done")]) == nil)
        #expect(SessionThreadView.openCard([.plan(id: ItemID("pl"), at: at, text: "1. Do it", state: .proposed, cardId: MessageID("m3"))]) != nil)
    }
}

@MainActor
@Suite struct SessionRoutingTests {
    @Test func aSessionLinkOpensItsThread() {
        #expect(DeepLink(url: URL(string: "claudiobot://session/6b1f3c2a")!) == .session(SessionID("6b1f3c2a")))
        #expect(DeepLink(url: URL(string: "claudiobot://session/")!) == nil)
    }

    @Test func openingASessionSwitchesTheSidebarAndWatchesTheList() {
        let router = Router()
        router.sidebar = .bots
        #expect(!router.watchesSessions)
        router.open(.session(SessionID("s1")))
        #expect(router.sidebar == .sessions && router.selection == .session(SessionID("s1")))
        router.sidebar = .bots
        #expect(router.watchesSessions, "an open thread keeps the list watched for its header")
        router.selection = nil
        #expect(!router.watchesSessions)
    }
}
