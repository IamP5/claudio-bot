import Foundation
import Testing
@testable import ClaudeBot

private let at = Date(timeIntervalSince1970: 1_792_152_000)

private func summary(_ id: String, _ status: TaskStatus, updated: TimeInterval = 0, title: String = "Task") -> TaskSummary {
    TaskSummary(
        id: TaskID(id), title: title, target: .local(ProjectID("p1")), projectName: "drawdown", model: "opus",
        permissionMode: .default, status: status, createdAt: at, updatedAt: at + updated,
        preview: "", costUsd: 0, cloudUrl: nil
    )
}

private func approval(_ id: String, _ state: ApprovalItem.State) -> Item {
    .approval(ApprovalItem(id: ItemID(id), tool: "Edit", summary: "src/auth.ts", detail: "- a\n+ b", state: state, at: at))
}

private func assistant(_ id: String, _ text: String) -> Item {
    .assistant(TextItem(id: ItemID(id), text: text, at: at))
}

@MainActor
@Suite struct StoreTests {
    private func store(with tasks: [TaskSummary] = [summary("t1", .running)]) -> AppStore {
        let store = AppStore()
        store.apply(.hello(machine: "Mac", projects: [], tasks: tasks))
        return store
    }

    @Test func helloMeansConnected() {
        #expect(store().connection == .connected(machine: "Mac"))
    }

    @Test func replayingAnItemIsANoOp() {
        let store = store()
        let first = store.apply(.item(taskId: TaskID("t1"), item: approval("i1", .pending)))
        let snapshot = store.transcripts
        let replay = store.apply(.item(taskId: TaskID("t1"), item: approval("i1", .pending)))
        #expect(first.count == 1)
        #expect(replay.isEmpty)
        #expect(store.transcripts == snapshot)
        #expect(store.transcripts[TaskID("t1")]?.items.count == 1)
    }

    @Test func upsertReplacesInPlaceAndKeepsOrder() {
        let store = store()
        for item in [assistant("a", "one"), approval("b", .pending), assistant("c", "three")] {
            store.apply(.item(taskId: TaskID("t1"), item: item))
        }
        store.apply(.item(taskId: TaskID("t1"), item: approval("b", .allowed)))
        let items = store.transcripts[TaskID("t1")]?.items ?? []
        #expect(items.map(\.id.rawValue) == ["a", "b", "c"])
        #expect(items[1] == approval("b", .allowed))
    }

    @Test func transcriptReplacesWhatWasThere() {
        let store = store()
        store.apply(.item(taskId: TaskID("t1"), item: assistant("old", "stale")))
        store.apply(.transcript(taskId: TaskID("t1"), items: [assistant("x", "fresh"), assistant("y", "next")]))
        #expect(store.transcripts[TaskID("t1")]?.items.map(\.id.rawValue) == ["x", "y"])
    }

    @Test func taskMessageUpdatesStatusAndReportsTheFinish() {
        let store = store()
        let attention = store.apply(.task(summary("t1", .idle)))
        #expect(store.tasks[TaskID("t1")]?.status == .idle)
        #expect(attention.map(\.reason) == [.finished])
        #expect(store.apply(.task(summary("t1", .idle))).isEmpty)
    }

    @Test func aNewTaskIsRecordedForNavigation() {
        let store = store()
        store.apply(.task(summary("t9", .running)))
        #expect(store.lastNewTask == TaskID("t9"))
        #expect(store.tasks.count == 2)
    }

    @Test func needsInputDefersToThePendingApproval() {
        let store = store()
        let fromItem = store.apply(.item(taskId: TaskID("t1"), item: approval("i1", .pending)))
        let fromStatus = store.apply(.task(summary("t1", .needsInput)))
        #expect(fromItem.count == 1)
        #expect(fromStatus.isEmpty)
    }

    @Test func resolvedApprovalDoesNotAlert() {
        let store = store()
        store.apply(.item(taskId: TaskID("t1"), item: approval("i1", .pending)))
        #expect(store.apply(.item(taskId: TaskID("t1"), item: approval("i1", .allowed))).isEmpty)
    }

    @Test func homeGroupsByWhatTheUserShouldDoNext() {
        let tasks = [
            summary("done", .idle, updated: 50),
            summary("run-old", .running, updated: 10),
            summary("ask", .needsInput, updated: 0),
            summary("run-new", .running, updated: 40),
            summary("fail", .failed, updated: 60),
        ]
        let sections = HomeSection.make(from: tasks, matching: "")
        #expect(sections.map(\.kind) == [.needsYou, .running, .recent])
        #expect(sections.map { $0.tasks.map(\.id.rawValue) } == [["ask"], ["run-new", "run-old"], ["fail", "done"]])
    }

    @Test func searchFiltersAndDropsEmptySections() {
        let tasks = [summary("a", .running, title: "Fix login"), summary("b", .idle, title: "Dark mode")]
        let sections = HomeSection.make(from: tasks, matching: "LOGIN")
        #expect(sections.map(\.kind) == [.running])
        #expect(sections.first?.tasks.map(\.id.rawValue) == ["a"])
    }

    @Test func unpairingForgetsTheMac() {
        let store = store()
        store.setConnection(.unpaired)
        #expect(store.tasks.isEmpty)
        #expect(store.connection == .unpaired)
    }
}

@Suite struct MarkdownTests {
    @Test func fencesSplitProseFromCode() {
        let blocks = MarkdownBlock.parse("Found it:\n\n```ts\nconst a = 1\n```\nDone.")
        #expect(blocks == [.prose("Found it:"), .code(language: "ts", "const a = 1"), .prose("Done.")])
    }

    @Test func anUnclosedFenceRunsToTheEnd() {
        #expect(MarkdownBlock.parse("```\nstreaming") == [.code(language: nil, "streaming")])
    }

    @Test func headingsAreTheirOwnBlock() {
        #expect(MarkdownBlock.parse("## Plan\nstep one") == [.heading("Plan"), .prose("step one")])
    }
}
