import Foundation
import Testing
@testable import ClaudioBot

private final class BundleToken {}

/// The items of the fixture's running thread: three subagent steps, two cards that name their subagent.
private func runningThread() throws -> [SessionItem] {
    let url = try #require(Bundle(for: BundleToken.self).url(forResource: "protocol", withExtension: "json"))
    let root = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: [Any]])
    let frames = try (root["server"] ?? []).map {
        try Wire.decoder().decode(ServerFrame.self, from: JSONSerialization.data(withJSONObject: $0))
    }
    let items = frames.compactMap { frame -> [SessionItem]? in
        if case let .thread(_, .items(_, items, _, controls?)) = frame.message, controls.tasks != nil { items } else { nil }
    }
    return try #require(items.first)
}

private func permission(_ cardId: String, in items: [SessionItem]) throws -> SessionPermission {
    let found = items.compactMap { item -> SessionPermission? in
        if case let .permission(_, _, permission) = item, permission.cardId == MessageID(cardId) { permission } else { nil }
    }
    return try #require(found.first)
}

private func step(_ state: ToolStepState, cause: String? = nil) -> ToolStep {
    ToolStep(id: "toolu_1", tool: "Bash", label: "Run perl", state: state, diff: nil, output: nil, cause: cause)
}

@Suite struct ApprovalCardTests {
    @Test func aSubagentsCardNamesTheSubagentAndFindsTheStepItHoldsBack() throws {
        let items = try runningThread()
        let card = try permission("m23", in: items)
        #expect(card.title == "sleeper two wants to run Bash")
        #expect(card.asker == "sleeper two")

        let held = try #require(HeldStep.find(card.stepId, in: items))
        #expect(held.row == ItemID("toolu_01Ac1"))
        #expect(held.step.id == "toolu_01Ac2" && held.step.state == .waiting && held.step.owner == "toolu_01Ac1")
    }

    @Test func aCardWhoseStepIsNotInTheThreadHasNothingToShow() throws {
        let items = try runningThread()
        #expect(HeldStep.find(try permission("m24", in: items).stepId, in: items) == nil)
        #expect(HeldStep.find(nil, in: items) == nil)
    }

    @Test func aCardTheMainThreadRaisedKeepsItsOwnLabel() {
        let card = PermissionCard(
            from: nil, tool: "Bash", label: "Delete node_modules and reinstall", detail: "rm -rf node_modules",
            always: "rm -rf node_modules", answer: nil, expiresAt: .now
        )
        let permission = SessionPermission(cardId: MessageID("c"), at: .now, card: card)
        #expect(permission.title == "Delete node_modules and reinstall")
        #expect(permission.asker == "Bash")
    }

    @Test func aCardStoppedBeforeAnyoneAnsweredSaysSoAndIsNotGreen() throws {
        let card = try permission("m24", in: try runningThread())
        let outcome = try #require(card.card.answer).outcome()
        #expect(outcome.text == "Stopped by you. It did not run.")
        #expect(outcome.short == "Stopped by you")
        #expect(outcome.tone == .ended)
    }

    @Test func anAllowedCallCutShortNoLongerReadsAsAllowed() {
        let stopped = PermissionAnswer.chose(.once).outcome(step: step(.stopped, cause: "Stopped by you"))
        #expect(stopped.text == "Allowed once. Stopped by you before it finished.")
        #expect(stopped.short == "Allowed once, then stopped")
        #expect(stopped.tone == .ended)

        let restarted = PermissionAnswer.chose(.always).outcome(step: step(.stopped, cause: "The bridge restarted"))
        #expect(restarted.text == "Always allowed. The bridge restarted before it finished.")

        let failed = PermissionAnswer.chose(.once).outcome(step: step(.error, cause: "Exit code 1"))
        #expect(failed.short == "Allowed once, then failed" && failed.tone == .failed)
    }

    @Test func anAllowedCallTheBridgeCannotFollowSaysItMayStillRunAndNotStopped() {
        let unsure = PermissionAnswer.chose(.once).outcome(step: step(.unsure, cause: "Can't tell whether this still runs on your Mac"))
        #expect(unsure == PermissionOutcome(short: "Allowed once · may still run", text: "Allowed once. May still run on your Mac.", tone: .unsure))
        #expect(unsure.glyph == "questionmark.circle")
        let ended = PermissionAnswer.chose(.once).outcome(step: step(.ended, cause: "It ended without a result"))
        #expect(ended == PermissionOutcome(short: "Allowed once · ended, result unknown", text: "Allowed once. It ended; its result is unknown.", tone: .unsure))
    }

    @Test(arguments: [ToolStepState.running, .waiting, .ok])
    func anAllowedCallThatRunsOrFinishedReadsAllowed(state: ToolStepState) {
        #expect(PermissionAnswer.chose(.once).outcome(step: step(state)) == PermissionOutcome(short: "Allowed once", text: "Allowed once", tone: .allowed))
        #expect(PermissionAnswer.chose(.once).outcome() == PermissionOutcome(short: "Allowed once", text: "Allowed once", tone: .allowed))
    }

    @Test func refusalsAndClosingsSayTheCallDidNotRun() {
        #expect(PermissionAnswer.chose(.deny).outcome(step: step(.stopped)) == PermissionOutcome(short: "Denied", text: "Denied", tone: .refused))
        #expect(PermissionAnswer.chose(.never).outcome().tone == .refused)
        #expect(PermissionAnswer.expired.outcome() == PermissionOutcome(short: "Expired", text: "Expired. It did not run.", tone: .ended))
        #expect(PermissionAnswer.closed("withdrawn").outcome() == PermissionOutcome(short: "Closed", text: "Closed. It did not run.", tone: .ended))
    }
}
