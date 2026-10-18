import Foundation
import Testing
@testable import ClaudioBot

private let at = Date(timeIntervalSince1970: 1_792_152_000)

private func bot(_ id: String, _ name: String, minutesAgo: Double = 0, kind: BotKind = .bot, members: [String] = []) -> Bot {
    Bot(
        id: BotID(id), name: name, title: nil, avatar: .standard, pinned: false, hidden: false, status: .idle,
        unread: 0, question: nil, preview: "", lastAt: at - minutesAgo * 60, createdAt: at, routines: [],
        kind: kind, members: members.map { BotID($0) }
    )
}

private let engineer = bot("b1", "engineer", minutesAgo: 5)
private let lead = bot("b2", "Engineering Lead", minutesAgo: 1)
private let digest = bot("b3", "news digest", minutesAgo: 9)
private let crew = bot("g1", "launch crew", kind: .group, members: ["b3", "b1"])
private let github = Connector(name: "github", status: .connected, enabled: true)
private let linear = Connector(name: "linear", status: .needsAuth, enabled: true)

/// Types each character at the caret, the way a keyboard does.
private func typed(_ text: String, into draft: inout ComposerDraft, caret: inout Int) {
    for character in text {
        draft.replace(NSRange(location: caret, length: 0), with: String(character))
        caret += String(character).utf16.count
    }
}

private func backspace(_ draft: inout ComposerDraft, caret: inout Int) {
    let replaced = draft.replace(NSRange(location: caret - 1, length: 1), with: "")
    caret = replaced.location
}

@Suite struct ComposerDraftTests {
    @Test func anAtThatStartsAWordOpensTheMenuWithWhatFollowsAsTheQuery() {
        #expect(ComposerDraft(text: "ask @eng").trigger(caret: 8) == ComposerTrigger(kind: .mention, range: NSRange(location: 4, length: 4), query: "eng"))
        #expect(ComposerDraft(text: "@").trigger(caret: 1)?.query == "")
        #expect(ComposerDraft(text: "mail a@b").trigger(caret: 8) == nil)
        #expect(ComposerDraft(text: "@eng\nnext").trigger(caret: 9) == nil)
        #expect(ComposerDraft(text: "no trigger").trigger(caret: 10) == nil)
    }

    @Test func aSlashOpensTheCommandMenuOnlyAsTheFirstWord() {
        #expect(ComposerDraft(text: "/rev").trigger(caret: 4) == ComposerTrigger(kind: .command, range: NSRange(location: 0, length: 4), query: "rev"))
        #expect(ComposerDraft(text: "/review now").trigger(caret: 2) == ComposerTrigger(kind: .command, range: NSRange(location: 0, length: 7), query: "r"))
        #expect(ComposerDraft(text: "/review now").trigger(caret: 11) == nil)
        #expect(ComposerDraft(text: "use /review").trigger(caret: 11) == nil)
    }

    @Test func pickingAMentionLeavesATokenAndASpaceAndClosesTheMenu() {
        var draft = ComposerDraft()
        var caret = 0
        typed("ask @eng", into: &draft, caret: &caret)
        let trigger = try! #require(draft.trigger(caret: caret))
        caret = draft.pick(.bot(id: BotID("b1"), name: "engineer"), replacing: trigger.range)
        #expect(draft.text == "ask @engineer ")
        #expect(caret == 14)
        #expect(draft.tokens == [MentionToken(range: NSRange(location: 4, length: 9), mention: .bot(id: BotID("b1"), name: "engineer"))])
        #expect(draft.trigger(caret: caret) == nil)
        typed("to look", into: &draft, caret: &caret)
        #expect(draft.text == "ask @engineer to look")
        #expect(draft.mentions == [.bot(id: BotID("b1"), name: "engineer")])
    }

    @Test func backspacingIntoATokenRemovesItWhole() {
        var draft = ComposerDraft()
        var caret = 0
        typed("@news", into: &draft, caret: &caret)
        caret = draft.pick(.bot(id: BotID("b3"), name: "news digest"), replacing: draft.trigger(caret: caret)!.range)
        backspace(&draft, caret: &caret)
        #expect(draft.text == "@news digest")
        backspace(&draft, caret: &caret)
        #expect(draft.text == "")
        #expect(draft.mentions.isEmpty)
        #expect(caret == 0)
    }

    @Test func typingInsideATokenTurnsItIntoPlainTextAndEditsBeforeOneMoveIt() {
        var draft = ComposerDraft()
        var caret = 0
        typed("hi @git", into: &draft, caret: &caret)
        _ = draft.pick(.connector(name: "github"), replacing: draft.trigger(caret: caret)!.range)
        draft.replace(NSRange(location: 0, length: 0), with: "oh ")
        #expect(draft.tokens.map(\.range) == [NSRange(location: 6, length: 7)])
        draft.replace(NSRange(location: 9, length: 0), with: "x")
        #expect(draft.text == "oh hi @gixthub ")
        #expect(draft.mentions.isEmpty)
    }

    @Test func theSendCarriesEveryTokenStillPresentOnceAndKeepsTheText() throws {
        var draft = ComposerDraft()
        var caret = 0
        typed("@eng", into: &draft, caret: &caret)
        caret = draft.pick(.bot(id: BotID("b1"), name: "engineer"), replacing: draft.trigger(caret: caret)!.range)
        typed("use @git", into: &draft, caret: &caret)
        caret = draft.pick(.connector(name: "github"), replacing: draft.trigger(caret: caret)!.range)
        typed("and @eng", into: &draft, caret: &caret)
        caret = draft.pick(.bot(id: BotID("b1"), name: "engineer"), replacing: draft.trigger(caret: caret)!.range)

        let send = draft.send(to: BotID("b9"), uploads: [], clientId: "c1")
        let json = try JSONSerialization.jsonObject(with: Wire.encoder().encode(send)) as? NSDictionary
        #expect(json?["text"] as? String == "@engineer use @github and @engineer")
        #expect(json?["mentions"] as? [NSDictionary] == [
            ["kind": "bot", "id": "b1", "name": "engineer"],
            ["kind": "connector", "name": "github"],
        ])
        let plain = try JSONSerialization.jsonObject(with: Wire.encoder().encode(ComposerDraft(text: "hi").send(to: BotID("b9"), uploads: [], clientId: "c2"))) as? NSDictionary
        #expect(plain?["mentions"] == nil)
    }

    @Test func anEditReadFromTheNewTextMovesTokensAndABackspaceIntoOneTakesItWhole() {
        var draft = ComposerDraft()
        var caret = 0
        typed("hi @eng", into: &draft, caret: &caret)
        caret = draft.pick(.bot(id: BotID("b1"), name: "engineer"), replacing: draft.trigger(caret: caret)!.range)
        #expect(draft.text == "hi @engineer ")

        caret = draft.edit(to: "oh hi @engineer ", caret: 3)
        #expect(caret == 3)
        #expect(draft.tokens.map(\.range) == [NSRange(location: 6, length: 9)])
        caret = draft.edit(to: "oh hi @engineer", caret: 15)
        #expect(draft.mentions.count == 1)
        caret = draft.edit(to: "oh hi @enginee", caret: 14)
        #expect(draft.text == "oh hi ")
        #expect(caret == 6)
        #expect(draft.mentions.isEmpty)
        #expect(draft.edit(to: "oh hi 👋", caret: 8) == 8)
        #expect(draft.text == "oh hi 👋")
    }

    @Test func committedTextTheDraftDidNotSeeKeepsOnlyTokensThatStillReadTheirName() {
        var draft = ComposerDraft()
        var caret = 0
        typed("@eng", into: &draft, caret: &caret)
        _ = draft.pick(.bot(id: BotID("b1"), name: "engineer"), replacing: draft.trigger(caret: caret)!.range)
        draft.sync(to: "@engineer 日本")
        #expect(draft.mentions == [.bot(id: BotID("b1"), name: "engineer")])
        draft.sync(to: "@enginee 日本")
        #expect(draft.mentions.isEmpty)
    }

    @Test func pickingACommandKeepsTheCaretForItsArguments() {
        var draft = ComposerDraft(text: "/re")
        let caret = draft.pick(command: "release-notes", replacing: draft.trigger(caret: 3)!.range)
        #expect(draft.text == "/release-notes ")
        #expect(caret == 15)
        #expect(draft.trigger(caret: caret) == nil)
    }
}

@Suite struct MentionMenuTests {
    @Test func botsComeFirstWithoutTheChatsOwnBotThenConnectorsThatAreOn() {
        let off = Connector(name: "slack", status: .connected, enabled: false)
        let names = MentionMenu.candidates("", in: engineer, bots: [engineer, lead, digest, crew], connectors: [github, off, linear]).map(\.name)
        #expect(names == ["Engineering Lead", "news digest", "github", "linear"])
    }

    @Test func theQueryKeepsAnyNameThatContainsItIgnoringCase() {
        let names = MentionMenu.candidates("ENG", in: digest, bots: [engineer, lead, digest], connectors: [github]).map(\.name)
        #expect(names == ["Engineering Lead", "engineer"])
        #expect(MentionMenu.candidates("hub", in: digest, bots: [engineer], connectors: [github]).map(\.mention) == [.connector(name: "github")])
        #expect(MentionMenu.candidates("eng ", in: digest, bots: [engineer, lead], connectors: []).isEmpty)
    }

    @Test func inAGroupItsMembersLeadInTheirOrder() {
        let names = MentionMenu.candidates("", in: crew, bots: [engineer, lead, digest, crew], connectors: []).map(\.name)
        #expect(names == ["news digest", "engineer", "Engineering Lead"])
    }

    @Test func connectorsShowTheirStateInPlainWords() {
        #expect(github.mentionState == "connected")
        #expect(linear.mentionState == "needs auth")
        #expect(Connector(name: "x", status: .failed, enabled: true).mentionState == "error")
    }
}

@Suite struct ComposerMenuTests {
    private let review = Command(name: "review", description: "Review the open PR", argumentHint: "", source: .skill)

    private func menu(_ text: String, chat: Bot = digest, features: Set<Feature> = [.mentions, .commands]) -> ComposerMenu? {
        let draft = ComposerDraft(text: text)
        return ComposerMenu.at(
            (text as NSString).length, in: draft, chat: chat, features: features,
            bots: [engineer, lead, digest, crew], connectors: [github], commands: [review]
        )
    }

    @Test func eachMenuWaitsForItsFeature() {
        #expect(menu("@eng", features: []) == nil)
        #expect(menu("/re", features: [.mentions]) == nil)
        if case .mentions(_, let found)? = menu("@eng") { #expect(found.map(\.name) == ["Engineering Lead", "engineer"]) } else { Issue.record("no @ menu") }
        if case .commands(_, let found)? = menu("/re") { #expect(found == [review]) } else { Issue.record("no / menu") }
    }

    @Test func aGroupHasNoCommandsAndNoConnectorsToMention() {
        #expect(menu("/re", chat: crew) == nil)
        if case .mentions(_, let found)? = menu("@", chat: crew) {
            #expect(found.map(\.name) == ["news digest", "engineer", "Engineering Lead"])
        } else {
            Issue.record("no @ menu in a group")
        }
    }

    @Test func aQueryThatMatchesNothingClosesTheMenu() {
        #expect(menu("@zzz") == nil)
        #expect(menu("@engineer please") == nil)
        #expect(menu("/zzz") == nil)
    }
}

@Suite struct CommandMenuTests {
    private let commands = [
        Command(name: "review", description: "Review the open PR", argumentHint: "", source: .skill),
        Command(name: "superpowers:brainstorm", description: "Brainstorm", argumentHint: "", source: .skill),
        Command(name: "compact", description: "Compact the conversation", argumentHint: "[instructions]", source: .builtin),
    ]

    @Test func theQueryFiltersByAnyPartOfTheName() {
        #expect(CommandMenu.matches(commands, query: "").map(\.name) == ["review", "superpowers:brainstorm", "compact"])
        #expect(CommandMenu.matches(commands, query: "STORM").map(\.name) == ["superpowers:brainstorm"])
        #expect(CommandMenu.matches(commands, query: "zzz").isEmpty)
    }

    @Test func aPluginSkillSplitsIntoItsPluginAndItsSkill() {
        #expect(CommandMenu.parts("superpowers:brainstorm") == ("superpowers", "brainstorm"))
        #expect(CommandMenu.parts("review") == (nil, "review"))
    }
}

@Suite struct MentionTextTests {
    @Test func eachMentionedNameAtAWordStartBecomesASegment() {
        let mentions: [Mention] = [.bot(id: BotID("b3"), name: "news"), .bot(id: BotID("b4"), name: "news digest"), .connector(name: "github")]
        #expect(MentionText.segments("@news digest, ask @github about a@github and @newsy", mentions: mentions) == [
            .mention(.bot(id: BotID("b4"), name: "news digest"), label: "@news digest"),
            .text(", ask "),
            .mention(.connector(name: "github"), label: "@github"),
            .text(" about a@github and @newsy"),
        ])
        #expect(MentionText.segments("plain", mentions: []) == [.text("plain")])
    }
}

@Suite struct GroupRulesTests {
    @Test func aNewGroupIsNamedAfterItsMembersCutToFortyCharacters() {
        #expect(GroupRules.suggestedName(["engineer", "news digest"]) == "engineer, news digest")
        let long = GroupRules.suggestedName(["release captain", "standup notes", "Engineering Lead"])
        #expect(long == "release captain, standup notes, Enginee…")
        #expect(long.count == 40)
        #expect(GroupRules.suggestedName(["release captain", "standup notes", "a", "b"]).hasSuffix("notes, a, b"))
    }

    @Test func typingNamesTheMembersAtWork() {
        #expect(GroupRules.typing([]) == "Typing…")
        #expect(GroupRules.typing(["engineer"]) == "engineer is typing…")
        #expect(GroupRules.typing(["engineer", "news digest"]) == "engineer and news digest are typing…")
        #expect(GroupRules.typing(["a", "b", "c", "d"]) == "a, b and 2 more are typing…")
    }

    @Test func aRunOfMessagesFromOneMemberShowsItsNameOnce() {
        let messages: [Message] = [
            .bot(id: MessageID("m1"), at: at, text: "one", from: BotID("b1")),
            .bot(id: MessageID("m2"), at: at, text: "two", from: BotID("b1")),
            .bot(id: MessageID("m3"), at: at, text: "three", from: BotID("b2")),
            .user(id: MessageID("m4"), at: at, text: "ok", attachments: []),
            .bot(id: MessageID("m5"), at: at, text: "four", from: BotID("b2")),
        ]
        let rows = Timeline.rows(messages)
        #expect(rows.indices.filter { Timeline.opensRun(rows, at: $0) }.map { rows[$0].id } == ["m1", "m3", "m5"])
    }
}
