import Foundation
import Testing
@testable import ClaudeBot

private final class BundleToken {}

/// fixtures/protocol.json split into raw JSON entries, so each can be decoded and compared on its own.
private enum Fixture {
    static func entries(_ side: String) -> [Data] {
        let url = Bundle(for: BundleToken.self).url(forResource: "protocol", withExtension: "json")!
        let root = try! JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: [Any]]
        return root[side]!.map { try! JSONSerialization.data(withJSONObject: $0) }
    }
}

private func jsonObject(_ data: Data) throws -> NSDictionary {
    try JSONSerialization.jsonObject(with: data) as! NSDictionary
}

@Suite struct ProtocolTests {
    @Test func everyServerFixtureDecodesToAKnownMessage() throws {
        let entries = Fixture.entries("server")
        #expect(entries.count == 5)
        for data in entries {
            let msg = try Wire.decoder().decode(ServerMessage.self, from: data)
            if case .unknown(let type) = msg { Issue.record("fixture decoded as unknown type \(type)") }
        }
    }

    @Test func helloCarriesProjectsAndTypedTasks() throws {
        let msg = try Wire.decoder().decode(ServerMessage.self, from: Fixture.entries("server")[0])
        guard case let .hello(machine, projects, tasks) = msg else { Issue.record("not hello"); return }
        #expect(machine == "MacBook")
        #expect(projects.map(\.githubRepo) == ["me/drawdown", nil])
        #expect(tasks.first?.status == .needsInput)
        #expect(tasks.first?.target == .local(ProjectID("p1")))
        #expect(tasks.first?.createdAt == Date(timeIntervalSince1970: 1_792_152_000))
    }

    @Test func transcriptDecodesEveryItemKindInOrder() throws {
        let msg = try Wire.decoder().decode(ServerMessage.self, from: Fixture.entries("server")[2])
        guard case let .transcript(taskId, items) = msg else { Issue.record("not transcript"); return }
        #expect(taskId == TaskID("t1"))
        let kinds = items.map { item -> String in
            switch item {
            case .user: "user"
            case .assistant: "assistant"
            case .tool: "tool"
            case .approval: "approval"
            case .question: "question"
            case .result: "result"
            case .notice: "notice"
            case .unknown: "unknown"
            }
        }
        #expect(kinds == ["user", "assistant", "tool", "tool", "approval", "question", "result", "notice"])
        #expect(items.map(\.awaitsUser) == [false, false, false, false, true, true, false, false])
    }

    @Test func clientFixturesRoundTripToIdenticalJSON() throws {
        let entries = Fixture.entries("client")
        #expect(entries.count == 6)
        for data in entries {
            let msg = try Wire.decoder().decode(ClientMessage.self, from: data)
            let encoded = try Wire.encoder().encode(msg)
            #expect(try jsonObject(encoded) == jsonObject(data))
        }
    }

    @Test func swiftBuiltDecideMatchesTheBridgeFixture() throws {
        let msg = ClientMessage.decide(taskId: TaskID("t1"), itemId: ItemID("i5"), decision: .allowAlways)
        #expect(try jsonObject(Wire.encoder().encode(msg)) == jsonObject(Fixture.entries("client")[3]))
    }

    @Test func unknownMessageTypeDecodesInsteadOfThrowing() throws {
        let data = Data(#"{"type":"usage","tokens":12}"#.utf8)
        let msg = try Wire.decoder().decode(ServerMessage.self, from: data)
        guard case .unknown(let type) = msg else { Issue.record("expected unknown"); return }
        #expect(type == "usage")
    }

    @Test func unknownItemKindKeepsItsId() throws {
        let data = Data(#"{"type":"item","taskId":"t1","item":{"kind":"thinking","id":"i9","at":"2026-10-16T12:00:00.000Z"}}"#.utf8)
        let msg = try Wire.decoder().decode(ServerMessage.self, from: data)
        guard case let .item(_, item) = msg else { Issue.record("expected item"); return }
        #expect(item == .unknown(id: ItemID("i9"), kind: "thinking"))
    }
}

@Suite struct PairingTests {
    @Test func deepLinkParsesUrlAndToken() {
        let link = URL(string: "claudebot://pair?url=ws%3A%2F%2F192.168.1.20%3A7878%2Fws&token=abc123")!
        let pairing = Pairing(link: link)
        #expect(pairing == Pairing(url: URL(string: "ws://192.168.1.20:7878/ws")!, token: "abc123"))
        #expect(pairing?.socketURL.absoluteString == "ws://192.168.1.20:7878/ws?token=abc123")
    }

    @Test func linksThatAreNotWebSocketPairingsAreRejected() {
        #expect(Pairing(link: URL(string: "claudebot://pair?url=http%3A%2F%2Fevil.com&token=x")!) == nil)
        #expect(Pairing(link: URL(string: "claudebot://pair?url=ws%3A%2F%2Fhost%3A7878%2Fws")!) == nil)
        #expect(Pairing(link: URL(string: "https://pair?url=ws%3A%2F%2Fhost%3A7878%2Fws&token=x")!) == nil)
    }

    @Test func backoffDoublesAndCapsAtThirtySeconds() {
        #expect((0..<8).map { Backoff.delay(afterFailures: $0) } == [1, 2, 4, 8, 16, 30, 30, 30])
    }
}
