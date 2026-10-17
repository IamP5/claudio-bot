import Foundation
import Testing
@testable import ClaudioBot

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

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try Wire.decoder().decode(type, from: Data(json.utf8))
}

@Suite struct ProtocolTests {
    @Test func everyServerFixtureDecodesToAKnownMessageAndEncodesBackToTheSameJSON() throws {
        let entries = Fixture.entries("server")
        #expect(entries.count == 12)
        for data in entries {
            let msg = try Wire.decoder().decode(ServerMessage.self, from: data)
            if case .unknown(let type) = msg { Issue.record("fixture decoded as unknown type \(type)") }
            #expect(try jsonObject(Wire.encoder().encode(msg)) == jsonObject(data))
        }
    }

    @Test func everyClientFixtureEncodesToTheSameJSON() throws {
        let entries = Fixture.entries("client")
        #expect(entries.count == 12)
        for data in entries {
            let msg = try Wire.decoder().decode(ClientMessage.self, from: data)
            #expect(try jsonObject(Wire.encoder().encode(msg)) == jsonObject(data))
        }
    }

    @Test func helloCarriesTypedBots() throws {
        let msg = try Wire.decoder().decode(ServerMessage.self, from: Fixture.entries("server")[0])
        guard case let .hello(machine, userName, bots) = msg else { Issue.record("not hello"); return }
        #expect(machine == "MacBook")
        #expect(userName == "Bruno")
        let bot = try #require(bots.first)
        #expect(bot.avatar == Avatar(shape: .hexagon, color: .orange))
        #expect(bot.title == nil)
        #expect(bot.question == "Want me to merge any of these now?")
        #expect(bot.routines.first?.describe == "Weekdays at 7:57 AM")
        #expect(bot.lastAt == Date(timeIntervalSince1970: 1_792_152_000))
    }

    @Test func conversationDecodesEveryMessageKindInOrder() throws {
        let msg = try Wire.decoder().decode(ServerMessage.self, from: Fixture.entries("server")[4])
        guard case let .conversation(_, messages) = msg else { Issue.record("not conversation"); return }
        let kinds = messages.map { m -> String in
            switch m {
            case .user: "user"
            case .bot: "bot"
            case .question: "question"
            case .exchange: "exchange"
            case .note: "note"
            case .unknown: "unknown"
            }
        }
        #expect(kinds == ["user", "bot", "exchange", "note", "exchange", "question"])
    }

    @Test func questionAnswersDecodeAsOpenChosenOrDismissed() throws {
        let entries = Fixture.entries("server")
        let answers = try [5, 6].map { index -> Answer? in
            guard case let .message(_, .question(_, _, card)) = try Wire.decoder().decode(ServerMessage.self, from: entries[index])
            else { return nil }
            return card.answer
        }
        #expect(answers == [.option(1), .dismissed])
    }

    @Test func unknownMessageTypeDecodesInsteadOfThrowing() throws {
        let msg = try decode(ServerMessage.self, #"{"type":"usage","tokens":12}"#)
        guard case .unknown(let type) = msg else { Issue.record("expected unknown"); return }
        #expect(type == "usage")
    }

    @Test func unknownMessageKindKeepsItsIdAndTime() throws {
        let msg = try decode(ServerMessage.self, #"{"type":"message","botId":"b1","message":{"kind":"poll","id":"m9","at":"2026-10-16T12:00:00.000Z"}}"#)
        guard case let .message(_, message) = msg else { Issue.record("expected message"); return }
        #expect(message == .unknown(id: MessageID("m9"), at: Date(timeIntervalSince1970: 1_792_152_000), kind: "poll"))
    }

    @Test func unknownShapeColorStatusAndPeerDecodeAndKeepTheirWireStrings() throws {
        #expect(try decode(Avatar.self, #"{"shape":"heart","color":"gold"}"#) == Avatar(shape: .unknown("heart"), color: .unknown("gold")))
        #expect(try decode(BotStatus.self, #""sleeping""#) == .unknown("sleeping"))
        #expect(try decode(AgentStatus.self, #""queued""#) == .unknown("queued"))
        #expect(try decode(AgentPlace.self, #""ssh""#) == .unknown("ssh"))
        #expect(try decode(Peer.self, #"{"kind":"group","id":"g1"}"#) == .unknown(kind: "group"))
        #expect(try Wire.encoder().encode(AvatarShape.unknown("heart")) == Data(#""heart""#.utf8))
    }

    @Test func everyShapeAndColorMatchesTheBridgeLists() {
        #expect(AvatarShape.allCases.map(\.rawValue) == [
            "circle", "cloud", "diamond", "star4", "flower", "blob", "scallop",
            "drop", "pill", "triangle", "pentagon", "star6", "hexagon",
        ])
        #expect(AvatarColor.allCases.map(\.rawValue) == [
            "white", "brown", "red", "orange", "amber", "green", "teal", "blue", "purple", "pink", "gray",
        ])
        #expect(AgentStatus.inCloud.rawValue == "in_cloud")
    }

    @Test func patchSendsOnlyTheFieldsThatAreSet() throws {
        let rename = try jsonObject(Wire.encoder().encode(ClientMessage.updateBot(botId: BotID("b1"), patch: BotPatch(name: "eng"))))
        #expect(rename == ["type": "update_bot", "botId": "b1", "patch": ["name": "eng"]] as NSDictionary)
        let clear = try Wire.encoder().encode(BotPatch(title: .some(nil)))
        #expect(String(decoding: clear, as: UTF8.self) == #"{"title":null}"#)
    }
}

@Suite struct PairingTests {
    @Test func deepLinkParsesUrlAndToken() {
        let link = URL(string: "claudiobot://pair?url=ws%3A%2F%2F192.168.1.20%3A7878%2Fws&token=abc123")!
        let pairing = Pairing(link: link)
        #expect(pairing == Pairing(url: URL(string: "ws://192.168.1.20:7878/ws")!, token: "abc123"))
        #expect(pairing?.socketURL.absoluteString == "ws://192.168.1.20:7878/ws?token=abc123")
    }

    @Test func linksThatAreNotWebSocketPairingsAreRejected() {
        #expect(Pairing(link: URL(string: "claudiobot://pair?url=http%3A%2F%2Fevil.com&token=x")!) == nil)
        #expect(Pairing(link: URL(string: "claudiobot://pair?url=ws%3A%2F%2Fhost%3A7878%2Fws")!) == nil)
        #expect(Pairing(link: URL(string: "https://pair?url=ws%3A%2F%2Fhost%3A7878%2Fws&token=x")!) == nil)
    }

    @Test func backoffDoublesAndCapsAtThirtySeconds() {
        #expect((0..<8).map { Backoff.delay(afterFailures: $0) } == [1, 2, 4, 8, 16, 30, 30, 30])
    }
}
