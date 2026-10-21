import Foundation
import Testing
@testable import ClaudioBot

private func card(
    tool: String = "Bash", detail: String = "perl -e 'sleep 45' && echo late > late.txt",
    always: String = "Bash: perl -e 'sleep 45' · echo late *"
) -> PermissionCard {
    PermissionCard(from: nil, tool: tool, label: "Bash", detail: detail, always: always, answer: nil, expiresAt: .now + 3600)
}

@Suite struct ApprovalCopyTests {
    @Test func everyChoiceSaysWhatItDoesInEachPlace() {
        let scopes: [ApprovalScope] = [.session, .bot(name: "release captain", asker: "release captain"), .trust]
        for scope in scopes {
            let lines = PermissionChoice.allCases.map { $0.consequence(scope) }
            #expect(lines.allSatisfy { !$0.isEmpty })
            #expect(Set(lines).count == 4, "each choice reads differently in \(scope)")
        }
    }

    @Test func neverStopsTheTurnInASessionAndRefusesForGoodInABotChat() {
        #expect(PermissionChoice.never.consequence(.session) == "Skips it and stops the turn.")
        #expect(PermissionChoice.never.consequence(.bot(name: "release captain", asker: "release captain")) == "Skips it and refuses it for release captain from now on.")
        #expect(PermissionChoice.deny.consequence(.session) == "Skips it. Claude carries on and may ask again.")
        #expect(PermissionChoice.deny.consequence(.bot(name: "release captain", asker: "release captain")) == "Skips it and tells release captain not to try it.")
    }

    @Test func theScopeLineSaysHowLongAlwaysLastsBeforeItListsTheRules() {
        #expect(card().scopeLine(.session) == "For the rest of this session, Always allow covers Bash: perl -e 'sleep 45' · echo late *.")
        let bot = card(always: "Push to the default branch, without asking, in turns you start")
        #expect(bot.scopeLine(.bot(name: "release captain", asker: "release captain")) == "From now on, Always allow covers Push to the default branch, without asking, in turns you start.")
    }

    @Test func anAgentsCardTellsTheAgentAboutDenyAndRefusesNeverForItsBot() {
        let fromAgent = PermissionCard(
            from: .agent(id: AgentID("a1"), title: "builder"), tool: "Bash", label: "Bash", detail: "make",
            always: "", answer: nil, expiresAt: .now + 3600
        )
        let scope = ApprovalScope.chat(fromAgent, bot: "release captain")
        #expect(PermissionChoice.deny.consequence(scope) == "Skips it and tells builder not to try it.")
        #expect(PermissionChoice.never.consequence(scope) == "Skips it and refuses it for release captain from now on.")
    }

    @Test func aCardWithNoAlwaysTextOffersNoAlways() {
        let none = card(always: "")
        #expect(none.choices == [.once, .deny, .never])
        #expect(none.scopeLine(.session) == nil)
        #expect(card().choices == [.once, .always, .deny, .never])
    }

    @Test func aTrustCardTalksAboutSettingsNotACall() {
        let trust = card(tool: "Claude Code settings", detail: ".claude/settings.json in /repo", always: "Agents in repo load its own Claude Code settings, hooks and MCP servers, from now on")
        #expect(ApprovalScope.chat(trust, bot: "release captain") == .trust)
        #expect(ApprovalScope.chat(card(), bot: "release captain") == .bot(name: "release captain", asker: "release captain"))
        #expect(PermissionChoice.once.consequence(.trust) == "Trusts it for this agent only.")
        #expect(PermissionChoice.never.consequence(.trust) == "Keeps every agent in this repo on empty settings.")
        let settings = card(tool: "Claude Code settings", detail: ".claude/settings.json in /repo", always: "x")
        #expect(PermissionAnswer.expired.announcement(card: settings, here: false) == "Expired. Nothing was trusted: .claude/settings.json in /repo")
        #expect(PermissionAnswer.chose(.once).announcement(card: settings, here: true) == "Allowed once. Trusted: .claude/settings.json in /repo")
    }

    @Test func eachButtonIsSpokenWithItsToolAndCommand() {
        let c = card()
        #expect(c.spokenLabel(.never) == "Never, Bash perl -e 'sleep 45' && echo late > late.txt")
        #expect(c.spokenLabel(.once) == "Allow once, Bash perl -e 'sleep 45' && echo late > late.txt")
    }

    @Test func aLongOrMultilineCommandIsCutToItsHead() {
        let long = card(detail: String(repeating: "a", count: 80) + "\nsecond line")
        #expect(long.commandHead == String(repeating: "a", count: 59) + "…")
        #expect(card(detail: "git status\ngit diff").commandHead == "git status")
    }

    @Test func aCardClosingIsAnnouncedWithItsOutcomeAndCommand() {
        let c = card(detail: "perl -e 'sleep 45'")
        #expect(PermissionAnswer.expired.announcement(card: c, here: false) == "Expired. Bash did not run: perl -e 'sleep 45'")
        #expect(PermissionAnswer.stopped.announcement(card: c, here: false) == "Stopped by you. Bash did not run: perl -e 'sleep 45'")
        #expect(PermissionAnswer.closed("gone").announcement(card: c, here: false) == "Closed. Bash did not run: perl -e 'sleep 45'")
        #expect(PermissionAnswer.chose(.once).announcement(card: c, here: true) == "Allowed once. Bash: perl -e 'sleep 45'")
        #expect(PermissionAnswer.chose(.never).announcement(card: c, here: true) == "Never allowed. Bash did not run: perl -e 'sleep 45'")
    }

    @Test func anAnswerFromAnotherDeviceSaysSo() {
        let c = card(detail: "perl -e 'sleep 30'")
        #expect(PermissionAnswer.chose(.deny).announcement(card: c, here: false) == "Answered on another device. Denied. Bash did not run: perl -e 'sleep 30'")
        #expect(!PermissionAnswer.expired.announcement(card: c, here: false).contains("another device"))
    }

    @Test func anAllowedCallCutShortIsAnnouncedAsCutShort() {
        let step = ToolStep(id: "s", tool: "Bash", label: "Run perl", state: .stopped, diff: nil, output: nil, cause: "Stopped by you")
        let said = PermissionAnswer.chose(.once).announcement(card: card(detail: "perl -e 'sleep 30'"), step: step, here: true)
        #expect(said == "Allowed once. Stopped by you before it finished. Bash: perl -e 'sleep 30'")
    }
}

@MainActor
@Suite struct DecidedHereTests {
    private func store() -> AppStore {
        let store = AppStore()
        store.apply(.hello(Hello(protocol: 3, machine: "Mac", userName: "Alex", bots: [])))
        return store
    }

    @Test func aDecisionSentHereIsRememberedPastAReconnect() {
        let store = store()
        store.decisionSent(.once, for: MessageID("c1"))
        store.apply(.hello(Hello(protocol: 3, machine: "Mac", userName: "Alex", bots: [])))
        #expect(store.decidedHere.contains(MessageID("c1")))
        #expect(!store.decidedHere.contains(MessageID("c2")))
    }

    @Test func aDecisionTheSocketRefusedIsNotThisPhones() {
        let store = store()
        store.decisionSent(.deny, for: MessageID("c1"))
        store.decisionFailed(for: MessageID("c1"))
        #expect(!store.decidedHere.contains(MessageID("c1")))
    }
}
