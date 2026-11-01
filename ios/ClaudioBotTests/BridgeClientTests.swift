import Foundation
import os
import Testing
@testable import ClaudioBot

private struct TimedOut: Error, CustomStringConvertible {
    let what: String
    var description: String { "timed out waiting for \(what)" }
}

@MainActor
private func eventually(_ what: String, within timeout: Duration = .seconds(5), _ condition: () -> Bool) async throws {
    let deadline = ContinuousClock.now + timeout
    while !condition() {
        guard ContinuousClock.now < deadline else { throw TimedOut(what: what) }
        try await Task.sleep(for: .milliseconds(20))
    }
}

private func hello(epoch: String = "e1", seq: Int = 0, protocol version: Int = 3) -> String {
    #"{"type":"hello","protocol":\#(version),"machine":"Mac","userName":"Alex","bots":[],"epoch":"\#(epoch)","seq":\#(seq),"resumed":false}"#
}

private func broadcast(_ seq: Int) -> String {
    #"{"type":"bot_removed","botId":"gone","seq":\#(seq)}"#
}

private let quick = BridgeClient.Timing(greeting: .seconds(1), reply: .seconds(1), legacyRetry: .milliseconds(300))

private let threadsHello = #"{"type":"hello","protocol":3,"features":["sessions","presence"],"machine":"Mac","userName":"Alex","bots":[],"epoch":"e1","seq":0,"resumed":false}"#

private func controls(working: Bool) -> String {
    #"{"canSend":true,"reason":null,"working":\#(working),"queued":0,"model":null,"models":[],"mode":"default","modes":["default"]}"#
}

private func snapshot(working: Bool = true) -> String {
    #"{"type":"session","sessionId":"s1","epoch":"e_1","rev":7,"items":[],"before":null,"live":null,"controls":\#(controls(working: working))}"#
}

/// A bridge that says hello on every socket and answers every watch of s1 with its snapshot.
private func threadBridge(snapshot: String = snapshot()) throws -> FakeBridge {
    try FakeBridge(
        onOpen: { $0.send(threadsHello) },
        onText: { socket, text in if text.contains(#""type":"watch_session""#) { socket.send(snapshot) } }
    )
}

private extension FakeBridge {
    var watches: [String] { texts.filter { $0.contains(#""type":"watch_session""#) } }
}

private extension ConnectionState {
    var quiet: Bool {
        if case .connected(_, .some) = self { true } else { false }
    }
}

/// Each test gets its own Keychain item, so tests never touch the app's pairing or each other's.
private func scratchVault() -> PairingVault {
    PairingVault(service: "dev.claudiobot.tests.\(UUID().uuidString)")
}

@MainActor
@Suite struct BridgeClientTests {
    @Test func savingTwiceUpdatesThePairingInPlace() throws {
        let vault = scratchVault()
        defer { vault.clear() }
        let first = Pairing(url: URL(string: "ws://10.0.0.20:7878/ws")!, credential: .legacy(token: "shared"))
        let second = Pairing(url: URL(string: "ws://10.0.0.20:7878/ws")!, credential: .device(DeviceID("d1"), token: "own"))
        try vault.save(first)
        try vault.save(second)
        #expect(vault.load() == second)
        vault.clear()
        #expect(vault.load() == nil)
    }

    @Test func aConfirmedPairingSwitchesOnlyOnceTheNewBridgeSaysHello() async throws {
        let home = try FakeBridge(onOpen: { $0.send(hello()) })
        let next = try FakeBridge(
            onOpen: { $0.send(hello()) },
            onPair: { _ in (200, #"{"deviceId":"d2","token":"t2"}"#) }
        )
        let vault = scratchVault()
        defer { vault.clear() }
        let old = Pairing(url: try await home.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let nextURL = try await next.start()
        try vault.save(old)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(old)
        try await eventually("the home bridge's hello") { client.store.machine != nil }

        try await client.pair(PairInvite(url: nextURL, code: "K7QD-M2XP"))

        let paired = Pairing(url: nextURL, credential: .device(DeviceID("d2"), token: "t2"))
        #expect(vault.load() == paired)
        #expect(client.pairing == paired)
        #expect(next.pairBodies.first?.contains(#""code":"K7QD-M2XP""#) == true)
        try await eventually("the client's socket to the new bridge") { next.upgrades.count == 2 }
        #expect(next.upgrades.allSatisfy { $0.authorization == "Bearer t2" })
    }

    @Test func aBridgeThatNeverSaysHelloLeavesTheOldPairingInPlace() async throws {
        let home = try FakeBridge(onOpen: { $0.send(hello()) })
        let silent = try FakeBridge(onPair: { _ in (200, #"{"deviceId":"d2","token":"t2"}"#) })
        let vault = scratchVault()
        defer { vault.clear() }
        let old = Pairing(url: try await home.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let silentURL = try await silent.start()
        try vault.save(old)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(old)
        try await eventually("the home bridge's hello") { client.store.machine != nil }

        await #expect(throws: Pairing.Failure.self) { try await client.pair(PairInvite(url: silentURL, code: "K7QD-M2XP")) }

        #expect(silent.upgrades.count == 1)
        #expect(vault.load() == old)
        #expect(client.pairing == old)
        #expect(client.store.machine == "Mac")
    }

    @Test func a401KeepsThePairingAndWaitsForTheUserToRetry() async throws {
        let recognized = OSAllocatedUnfairLock(initialState: false)
        let bridge = try FakeBridge(
            onUpgrade: { _ in recognized.withLock { $0 } ? .accept : .refuse(status: 401) },
            onOpen: { $0.send(hello()) }
        )
        let vault = scratchVault()
        defer { vault.clear() }
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        try vault.save(pairing)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(pairing)

        try await eventually("the unrecognized state") { client.store.connection == .unrecognized }
        #expect(vault.load() == pairing)
        #expect(client.pairing == pairing)
        try await Task.sleep(for: .milliseconds(1500))
        #expect(bridge.upgrades.count == 1, "a refused phone does not keep knocking")

        recognized.withLock { $0 = true }
        client.retryNow()
        try await eventually("the hello after retrying") { client.store.machine == "Mac" }
    }

    @Test func aRevokedCloseUnpairsAndForgetsTheToken() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(hello()) })
        let vault = scratchVault()
        defer { vault.clear() }
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        try vault.save(pairing)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        var forgotten = false
        client.onForget = { forgotten = true }
        client.start(pairing)
        try await eventually("the hello") { client.store.machine != nil }

        bridge.sockets.first?.close(code: 4001)

        try await eventually("unpairing") { client.store.connection == .unpaired }
        #expect(vault.load() == nil)
        #expect(client.pairing == nil)
        #expect(client.unpairedReason != nil)
        #expect(forgotten)
    }

    @Test func afterEveryHelloTheListAndTheOpenThreadAreWatchedAgainFromWhereTheAppStands() async throws {
        let sessionsHello = #"{"type":"hello","protocol":3,"features":["sessions"],"machine":"Mac","userName":"Alex","bots":[],"epoch":"","seq":0,"resumed":false}"#
        let snapshot = #"{"type":"session","sessionId":"s1","epoch":"e_1","rev":7,"items":[],"before":null,"live":{"itemId":"m:1","text":"Half"},"controls":{"canSend":true,"reason":null,"working":true,"queued":0,"model":null,"models":[],"mode":"default","modes":["default"]}}"#
        let bridge = try FakeBridge(
            onOpen: { $0.send(sessionsHello) },
            onText: { socket, text in
                if socket.index == 0, text.contains(#""type":"watch_session""#) {
                    socket.send(snapshot)
                    socket.close(code: 1000)
                }
            }
        )
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        let window = ViewingLease()
        client.view(Viewing(session: SessionID("s1"), sessionsList: true), as: window)
        client.start(pairing)

        try await eventually("the second watch of the thread", within: .seconds(8)) {
            bridge.texts.filter { $0.contains(#""type":"watch_session""#) }.count == 2
        }
        let watches = bridge.texts.filter { $0.contains(#""type":"watch_session""#) }
        #expect(watches[0].contains(#""after":null"#), "the first watch asks for a snapshot")
        #expect(watches[1].contains(#""epoch":"e_1""#) && watches[1].contains(#""rev":7"#), "the next resumes from the snapshot's position")
        #expect(bridge.texts.filter { $0.contains(#""type":"watch_sessions""#) }.count == 2)
        #expect(client.store.threads[SessionID("s1")]?.live.text == "", "watching again drops the live text, as the contract says")

        client.view(Viewing(sessionsList: true), as: window)
        try await eventually("the unwatch") { bridge.texts.contains { $0.contains(#""type":"unwatch_session""#) } }
        client.stop()
    }

    @Test func twoWindowsKeepTheirBotsAndAThreadTheyShareLiveUntilTheLastLeaves() async throws {
        let sessionsHello = #"{"type":"hello","protocol":3,"features":["sessions"],"machine":"Mac","userName":"Alex","bots":[],"epoch":"","seq":0,"resumed":false}"#
        let bridge = try FakeBridge(onOpen: { $0.send(sessionsHello) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        let main = ViewingLease(), second = ViewingLease()
        client.view(Viewing(bot: BotID("b1")), as: main)
        client.view(Viewing(bot: BotID("b2")), as: second)
        client.start(pairing)
        try await eventually("both bots opened after the hello") {
            bridge.texts.contains(#"{"botId":"b1","type":"open"}"#) && bridge.texts.contains(#"{"botId":"b2","type":"open"}"#)
        }

        client.view(Viewing(session: SessionID("s1"), sessionsList: true), as: main)
        client.view(Viewing(session: SessionID("s1"), sessionsList: true), as: second)
        try await eventually("the watch") { bridge.texts.contains { $0.contains(#""type":"watch_session""#) } }
        #expect(bridge.texts.filter { $0.contains(#""type":"watch_session""#) }.count == 1, "a thread on screen twice is watched once")

        client.view(nil, as: second)
        client.send(.devices)
        try await eventually("the window's close to be handled") { bridge.texts.contains(#"{"type":"devices"}"#) }
        #expect(!bridge.texts.contains { $0.contains("unwatch") }, "the main window still shows the thread and the list")

        client.view(nil, as: main)
        try await eventually("the unwatches") {
            bridge.texts.contains { $0.contains(#""type":"unwatch_session""#) } && bridge.texts.contains(#"{"type":"unwatch_sessions"}"#)
        }
        client.stop()
    }

    @Test func aGapInTheStreamReconnectsForAFreshHello() async throws {
        let bridge = try FakeBridge(onOpen: { socket in
            switch socket.index {
            case 0:
                socket.send(hello(seq: 5))
                socket.send(broadcast(6))
                socket.send(broadcast(8))
            case 1:
                socket.send(hello(seq: 8))
                socket.send(broadcast(9))
                socket.close(code: 1000)
            default:
                socket.send(hello(seq: 9))
            }
        })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.start(pairing)

        try await eventually("three connects", within: .seconds(8)) { bridge.upgrades.count == 3 }
        #expect(bridge.upgrades[1].query["epoch"] == nil, "after the gap the client asks for a fresh hello")
        #expect(bridge.upgrades[1].query["after"] == nil)
        #expect(bridge.upgrades[2].query["epoch"] == "e1", "an in-order stream resumes")
        #expect(bridge.upgrades[2].query["after"] == "9")
        client.stop()
    }

    @Test func aSendTheSocketDroppedBeforeItsEchoIsResentWithTheSameClientIdAfterReconnecting() async throws {
        let muteHello = #"{"type":"hello","protocol":3,"features":["mute"],"machine":"Mac","userName":"Alex","epoch":"","seq":0,"resumed":false,"bots":[{"id":"b1","name":"engineer","title":null,"avatar":{"shape":"hexagon","color":"orange"},"pinned":false,"hidden":false,"status":"idle","unread":0,"question":null,"preview":"","lastAt":"2026-10-16T12:00:00.000Z","createdAt":"2026-10-16T12:00:00.000Z","routines":[]}]}"#
        let bridge = try FakeBridge(onOpen: { $0.send(muteHello) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.start(pairing)
        try await eventually("the hello") { client.store.machine != nil }

        let send = ClientMessage.send(botId: BotID("b1"), text: "status?", uploads: [], clientId: "c1")
        client.store.sendStarted(send)
        client.send(send)
        try await eventually("the first copy") { bridge.texts.contains { $0.contains(#""clientId":"c1""#) } }
        bridge.sockets.first?.close(code: 1000)

        try await eventually("the resend", within: .seconds(8)) { bridge.texts.filter { $0.contains(#""clientId":"c1""#) }.count == 2 }
        #expect(bridge.upgrades.count == 2)
        client.stop()
    }

    @Test func anUndecodableBroadcastCountsAsAGap() async throws {
        let bridge = try FakeBridge(onOpen: { socket in
            switch socket.index {
            case 0:
                socket.send(hello(seq: 5))
                socket.send(#"{"type":"message","seq":6,"botId":"b1","message":{"kind":"bot"}}"#)
            default:
                socket.send(hello(seq: 6))
            }
        })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.start(pairing)

        try await eventually("the reconnect", within: .seconds(8)) { bridge.upgrades.count == 2 }
        #expect(bridge.upgrades[1].query["epoch"] == nil)
        client.stop()
    }

    @Test func aLegacyPhoneTradesItsSharedTokenForItsOwn() async throws {
        let bridge = try FakeBridge(
            onOpen: { $0.send(hello()) },
            onText: { socket, text in
                if text.contains(#""type":"pair_code""#) {
                    socket.send(#"{"type":"pair_code","code":"K7QD-M2XP","expiresAt":"2026-10-17T12:10:00.000Z"}"#)
                }
            },
            onPair: { body in
                body.contains(#""code":"K7QD-M2XP""#) ? (200, #"{"deviceId":"d9","token":"own"}"#) : (401, #"{"error":"Wrong code."}"#)
            }
        )
        let vault = scratchVault()
        defer { vault.clear() }
        let url = try await bridge.start()
        let legacy = Pairing(url: url, credential: .legacy(token: "shared"))
        try vault.save(legacy)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(legacy)

        let upgraded = Pairing(url: url, credential: .device(DeviceID("d9"), token: "own"))
        try await eventually("the saved device pairing") { vault.load() == upgraded }
        try await eventually("the Bearer reconnect") { bridge.upgrades.count == 2 }
        #expect(bridge.upgrades[0].query["token"] == "shared")
        #expect(bridge.upgrades[1].query["token"] == nil)
        #expect(bridge.upgrades[1].authorization == "Bearer own")
        #expect(client.pairing == upgraded)
        client.stop()
    }

    @Test func aFailedTradeKeepsTheLegacyPairingAndTriesAgain() async throws {
        let bridge = try FakeBridge(
            onOpen: { $0.send(hello()) },
            onText: { socket, text in
                if text.contains(#""type":"pair_code""#) {
                    socket.send(#"{"type":"pair_code","code":"K7QD-M2XP","expiresAt":"2026-10-17T12:10:00.000Z"}"#)
                }
            },
            onPair: { _ in (401, #"{"error":"That code expired."}"#) }
        )
        let vault = scratchVault()
        defer { vault.clear() }
        let legacy = Pairing(url: try await bridge.start(), credential: .legacy(token: "shared"))
        try vault.save(legacy)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(legacy)

        try await eventually("a second attempt") { bridge.pairBodies.count >= 2 }
        #expect(vault.load() == legacy)
        #expect(client.pairing == legacy)
        #expect(bridge.upgrades.count == 1)
        client.stop()
    }

    @Test func aLegacyPhoneOnAProtocol2BridgeDoesNotAskForACode() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(hello(epoch: "", protocol: 2)) })
        let legacy = Pairing(url: try await bridge.start(), credential: .legacy(token: "shared"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.start(legacy)
        try await eventually("the hello") { client.store.machine != nil }
        try await Task.sleep(for: .milliseconds(500))
        #expect(bridge.texts.allSatisfy { !$0.contains("pair_code") })
        client.stop()
    }

    @Test func unpairingRevokesThisDeviceOnTheBridgeFirst() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(hello()) })
        let vault = scratchVault()
        defer { vault.clear() }
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        try vault.save(pairing)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(pairing)
        try await eventually("the hello") { client.store.machine != nil }

        await client.unpair()

        #expect(client.store.connection == .unpaired)
        #expect(vault.load() == nil)
        try await eventually("the revoke frame") { bridge.texts.contains(#"{"deviceId":"d1","type":"revoke_device"}"#) }
    }

    @Test func aBridgeWithMemoryIsAskedForItsFactsOnEveryHello() async throws {
        let memoryHello = #"{"type":"hello","protocol":3,"features":["memory"],"machine":"Mac","userName":"Alex","epoch":"","seq":0,"resumed":false,"bots":[]}"#
        let bridge = try FakeBridge(onOpen: { $0.send(memoryHello) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.start(pairing)
        try await eventually("the memory request") { bridge.texts.contains(#"{"type":"memory"}"#) }
        client.stop()
    }

    @Test func anAppThatTracksAttentionSaysSoAfterEveryHelloAndOnEveryChangeOnlyToABridgeWithPresence() async throws {
        let presenceHello = #"{"type":"hello","protocol":3,"features":["presence"],"machine":"Mac","userName":"Alex","epoch":"","seq":0,"resumed":false,"bots":[]}"#
        let bridge = try FakeBridge(onOpen: { $0.send($0.index == 0 ? presenceHello : hello()) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.attended = false
        client.start(pairing)
        try await eventually("presence after the hello") { bridge.texts.contains(#"{"attended":false,"type":"presence"}"#) }
        client.attended = true
        try await eventually("presence on the change") { bridge.texts.contains(#"{"attended":true,"type":"presence"}"#) }

        bridge.sockets[0].close(code: 1000)
        try await eventually("the second hello") { client.store.machine != nil && bridge.sockets.count == 2 }
        client.attended = false
        client.send(.devices)
        try await eventually("the devices request") { bridge.texts.filter { $0 == #"{"type":"devices"}"# }.count == 1 }
        #expect(bridge.texts.filter { $0.contains("presence") }.count == 2)
        client.stop()
    }

    @Test func anAppLaunchedInTheBackgroundSaysItIsAwayAtHelloAndAttendedOnItsFirstTimeOnScreen() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(threadsHello) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.attended = false
        client.send(.answer(botId: BotID("b1"), messageId: MessageID("m1"), option: 0))
        client.start(pairing)
        try await eventually("the answer") { bridge.texts.contains { $0.contains(#""type":"answer""#) } }
        #expect(bridge.texts.first == #"{"attended":false,"type":"presence"}"#, "said before anything else")
        client.comeBack()
        try await eventually("presence on screen") { bridge.texts.contains(#"{"attended":true,"type":"presence"}"#) }
        client.stop()
    }

    @Test func anAppThatNeverSetsAttentionNeverSendsPresence() async throws {
        let presenceHello = #"{"type":"hello","protocol":3,"features":["presence"],"machine":"Mac","userName":"Alex","epoch":"","seq":0,"resumed":false,"bots":[]}"#
        let bridge = try FakeBridge(onOpen: { $0.send(presenceHello) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.start(pairing)
        try await eventually("the hello") { client.store.machine != nil }
        client.send(.devices)
        try await eventually("the devices request") { bridge.texts.contains(#"{"type":"devices"}"#) }
        #expect(!bridge.texts.contains { $0.contains("presence") })
        client.stop()
    }

    @Test func aSessionSendTheSocketDroppedIsResentOnceAfterReconnectingAndSettlesWhenShownBack() async throws {
        let echo = #"{"type":"session_items","sessionId":"s1","rev":8,"items":[{"kind":"user","id":"c1","at":"2026-10-16T12:00:00.000Z","text":"Run the tests","from":"user","queued":true}],"removed":[],"controls":null}"#
        let bridge = try FakeBridge(
            onOpen: { $0.send(threadsHello) },
            onText: { socket, text in
                if text.contains(#""type":"watch_session""#) { socket.send(snapshot()) }
                if text.contains(#""type":"session_send""#) {
                    if socket.index == 0 { socket.close(code: 1000) } else { socket.send(echo) }
                }
            }
        )
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        let lease = ViewingLease()
        client.view(Viewing(session: SessionID("s1")), as: lease)
        client.start(pairing)
        try await eventually("the thread") { client.store.threads[SessionID("s1")]?.phase == .ready }
        let model = try #require(client.store.threads[SessionID("s1")])
        model.echo(clientId: "c1", text: "Run the tests")
        client.send(.sessionSend(sessionId: SessionID("s1"), text: "Run the tests", clientId: "c1", interrupt: false))

        try await eventually("the echo after the reconnect", within: .seconds(8)) { model.pendingSends.isEmpty }
        let copies = bridge.texts.filter { $0.contains(#""type":"session_send""#) && $0.contains(#""clientId":"c1""#) }
        #expect(copies.count == 2, "the first copy went with the socket; the resend after hello is the only other")
        #expect(bridge.upgrades.count == 2)
        #expect(client.store.resendsAfterHello().isEmpty)
        client.stop()
    }

    @Test func aSessionStopHeldOfflinePastItsAgeIsNotSentAndSaysSo() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(threadsHello) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.outboxAge = 0
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        client.send(.sessionStop(sessionId: SessionID("s1"), target: .all, turnStartedAt: "2026-10-16T12:00:00.000Z"))
        client.send(.markUnread(botId: BotID("b1")))
        try await Task.sleep(for: .milliseconds(50))
        client.start(pairing)
        try await eventually("the queued message") { bridge.texts.contains { $0.contains("mark_unread") } }
        #expect(!bridge.texts.contains { $0.contains(#""type":"session_stop""#) })
        #expect(client.store.sessionErrors[SessionID("s1")]?.text == "Stop not sent: your Mac was unreachable.")
        client.stop()
    }

    @Test func aRequestHeldOfflineSaysItWasNotSentWhenItsAgeRunsOutWithNoHelloAtAll() async throws {
        var timing = quick
        timing.outboxAge = 0.05
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        let sid = SessionID("s1")
        client.store.apply(.sessions(.list(projects: [], rows: [], mirror: .auto)))

        client.send(.sessionSet(sessionId: sid, patch: SessionPatch(mode: .plan)))
        try await eventually("the mode change's note", within: .seconds(1)) {
            client.store.sessionErrors[sid]?.text == "Mode change not sent: your Mac was unreachable."
        }
        client.send(.sessionSet(sessionId: sid, patch: SessionPatch(hidden: true)))
        try await eventually("the hide toast", within: .seconds(1)) { client.store.lastError?.message == "Hide not sent: your Mac was unreachable." }
        client.send(.sessionPrefs(mirror: .never))
        #expect(client.store.sessions.mirror == .never)
        try await eventually("the setting put back", within: .seconds(1)) { client.store.sessions.mirror == .auto }
        #expect(client.store.mirrorNote == "Not changed: your Mac was unreachable.")
        #expect(client.store.lastError?.message == "Hide not sent: your Mac was unreachable.", "said beside the setting, not in a toast under the Settings sheet")
    }

    @Test func discardTakesASendOutOfTheOutboxSoTheNextHelloNeverSendsIt() async throws {
        let bridge = try threadBridge()
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        let sid = SessionID("s1")
        let model = client.store.threads.open(sid)
        model.echo(clientId: "c1", text: "Run the tests")
        client.send(.sessionSend(sessionId: sid, text: "Run the tests", clientId: "c1", interrupt: false))
        client.discard(sessionId: sid, clientId: "c1")
        #expect(model.pendingSends.isEmpty && model.items.isEmpty)
        client.send(.markUnread(botId: BotID("b1")))
        client.start(pairing)
        try await eventually("the queued message") { bridge.texts.contains { $0.contains("mark_unread") } }
        #expect(!bridge.texts.contains { $0.contains(#""type":"session_send""#) })
        client.stop()
    }

    @Test func aStopTappedOfflineLongAgoIsNotSentWhileAMessageStillIs() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(hello()) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.outboxAge = 0
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        client.send(.stop(botId: BotID("b1")))
        client.send(.markUnread(botId: BotID("b1")))
        try await Task.sleep(for: .milliseconds(50))
        client.start(pairing)
        try await eventually("the queued message") { bridge.texts.contains { $0.contains("mark_unread") } }
        #expect(!bridge.texts.contains { $0.contains(#""type":"stop""#) })
        client.stop()
    }

    @Test func failedConnectsCountUpAndAnotherAddressOfTheSameMacReplacesThePairingOnceItProvesItself() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(hello()) }, onHealth: FakeBridge.proving("t1"))
        let vault = scratchVault()
        defer { vault.clear() }
        let good = try await bridge.start()
        let dead = Pairing(url: URL(string: "ws://127.0.0.1:9/ws")!, credential: .device(DeviceID("d1"), token: "t1"))
        try vault.save(dead)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(dead)
        try await eventually("a failed connect") { client.failures >= 1 }

        try await client.changeAddress(to: good)

        #expect(vault.load() == Pairing(url: good, credential: dead.credential))
        try await eventually("the hello at the new address") { client.store.machine == "Mac" }
        #expect(client.failures == 0)
        #expect(bridge.upgrades.allSatisfy { $0.authorization == "Bearer t1" })
        let check = try #require(bridge.healthChecks.first)
        #expect(check["device"] == "d1")
        #expect(check["nonce"]?.count == 64 && check["nonce"]?.allSatisfy(\.isHexDigit) == true)
        client.stop()
    }

    @Test(arguments: [
        #"{"ok":true}"#,
        #"{"ok":true,"proof":"6d94ad91bd2ce00b22986b88b0dd02d65039a108e2e89cb3f11641ff4a426130"}"#,
        #"{"ok":true,"proof":"not hex"}"#,
        "<html>",
    ])
    func anAddressThatCannotProveItIsTheSameMacNeverReceivesTheToken(health: String) async throws {
        let home = try FakeBridge(onOpen: { $0.send(hello()) })
        let impostor = try FakeBridge(onOpen: { $0.send(hello()) }, onHealth: { _ in (200, health) })
        let vault = scratchVault()
        defer { vault.clear() }
        let old = Pairing(url: try await home.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let impostorURL = try await impostor.start()
        try vault.save(old)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(old)
        try await eventually("the home bridge's hello") { client.store.machine != nil }

        await #expect(throws: Pairing.AddressChange.unproven(impostorURL)) { try await client.changeAddress(to: impostorURL) }

        #expect(impostor.healthChecks.count == 1)
        #expect(impostor.upgrades.isEmpty, "no socket, so no Authorization header, reached the unproven address")
        #expect(vault.load() == old)
        #expect(client.pairing == old)
        client.stop()
    }

    @Test func anAddressThatDoesNotAnswerKeepsThePairing() async throws {
        let vault = scratchVault()
        defer { vault.clear() }
        let old = Pairing(url: URL(string: "ws://127.0.0.1:9/ws")!, credential: .device(DeviceID("d1"), token: "t1"))
        try vault.save(old)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(old)
        let dead = URL(string: "ws://127.0.0.1:7/ws")!

        await #expect(throws: Pairing.AddressChange.unreachable(dead)) { try await client.changeAddress(to: dead) }

        #expect(vault.load() == old)
        #expect(client.pairing == old)
        client.stop()
    }

    @Test func aLegacyPairingCannotChangeItsAddress() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(hello()) }, onHealth: FakeBridge.proving("shared"))
        let legacy = Pairing(url: URL(string: "ws://127.0.0.1:9/ws")!, credential: .legacy(token: "shared"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.start(legacy)
        let url = try await bridge.start()

        await #expect(throws: Pairing.AddressChange.legacy) { try await client.changeAddress(to: url) }

        #expect(bridge.healthChecks.isEmpty)
        #expect(bridge.upgrades.isEmpty)
        #expect(client.pairing == legacy)
        client.stop()
    }

    @Test func pairingTriesTheNextAddressOnlyWhenTheLastOneDidNotAnswer() async throws {
        let bridge = try FakeBridge(
            onOpen: { $0.send(hello()) },
            onPair: { _ in (200, #"{"deviceId":"d2","token":"t2"}"#) }
        )
        let vault = scratchVault()
        defer { vault.clear() }
        let good = try await bridge.start()
        let dead = URL(string: "ws://127.0.0.1:9/ws")!
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)

        try await client.pair(PairInvite(url: dead, code: "K7QD-M2XP", fallbacks: [good]))

        let paired = Pairing(url: good, credential: .device(DeviceID("d2"), token: "t2"))
        #expect(vault.load() == paired)
        #expect(client.pairing == paired)
        client.stop()
    }

    @Test func aBridgeThatRefusesTheCodeEndsPairingWithoutTryingTheOtherAddresses() async throws {
        let refusing = try FakeBridge(onPair: { _ in (401, #"{"error":"That code expired."}"#) })
        let other = try FakeBridge(
            onOpen: { $0.send(hello()) },
            onPair: { _ in (200, #"{"deviceId":"d2","token":"t2"}"#) }
        )
        let refusingURL = try await refusing.start()
        let otherURL = try await other.start()
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)

        await #expect(throws: Pairing.Failure.self) {
            try await client.pair(PairInvite(url: refusingURL, code: "K7QD-M2XP", fallbacks: [otherURL]))
        }

        #expect(refusing.pairBodies.count == 1)
        #expect(other.pairBodies.isEmpty)
        #expect(client.pairing == nil)
    }

    @Test func aSocketWhosePongMissesItsDeadlineIsReplacedAtOnceAndResumes() async throws {
        let bridge = try FakeBridge(onOpen: { socket in
            socket.send(hello())
            if socket.index == 0 { socket.goSilent() }
        })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.ping = .milliseconds(200)
        timing.pong = .milliseconds(300)
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        client.start(pairing)

        try await eventually("a new socket after the missed pong", within: .seconds(2)) { bridge.upgrades.count == 2 }
        #expect(bridge.upgrades[1].query["epoch"] == "e1", "the new socket resumes where the dead one stopped")
        try await eventually("the hello on the new socket") { client.store.machine != nil }
        client.stop()
    }

    @Test func aSocketThatAnswersItsPingsIsKept() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(hello()) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.ping = .milliseconds(100)
        timing.pong = .milliseconds(300)
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        client.start(pairing)
        try await eventually("the hello") { client.store.machine != nil }

        try await Task.sleep(for: .milliseconds(1200))

        #expect(bridge.upgrades.count == 1)
        #expect(client.store.machine == "Mac")
        client.stop()
    }

    @Test func aSocketStillDeliveringFramesIsKeptWhenItsPongIsLate() async throws {
        let bridge = try FakeBridge(onOpen: { socket in
            socket.send(hello())
            socket.goSilent()
        })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.ping = .milliseconds(200)
        timing.pong = .milliseconds(300)
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        client.start(pairing)
        try await eventually("the hello") { client.store.machine != nil }

        for seq in 1...12 {
            bridge.sockets[0].send(broadcast(seq))
            try await Task.sleep(for: .milliseconds(100))
        }

        #expect(bridge.upgrades.count == 1)
        client.stop()
    }

    @Test func aBridgeThatAcceptsTheSocketButNeverSaysHelloIsTriedAgain() async throws {
        let bridge = try FakeBridge()
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.start(pairing)

        try await eventually("a second attempt", within: .seconds(4)) { bridge.upgrades.count == 2 }
        #expect(client.failures >= 1)
        client.stop()
    }

    @Test func retryingNowEndsTheWaitBetweenFailedConnects() async throws {
        let bridge = try FakeBridge(onUpgrade: { _ in .refuse(status: 503) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.start(pairing)
        try await eventually("two failed connects", within: .seconds(3)) { bridge.upgrades.count == 2 }
        try await Task.sleep(for: .milliseconds(100))
        guard case .disconnected = client.store.connection else { throw TimedOut(what: "the wait before the third connect") }

        client.retryNow()

        try await eventually("the third connect, before the 2 s wait ends", within: .milliseconds(600)) { bridge.upgrades.count == 3 }
        client.stop()
    }

    @Test func aNetworkThatComesBackEndsTheWaitAtOnce() async throws {
        let bridge = try FakeBridge(onUpgrade: { _ in .refuse(status: 503) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.settle = .milliseconds(50)
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        client.networkChanged(NetworkPath(satisfied: false, interfaces: []))
        client.start(pairing)
        try await eventually("two failed connects", within: .seconds(3)) { bridge.upgrades.count == 2 }
        try await Task.sleep(for: .milliseconds(100))

        client.networkChanged(NetworkPath(satisfied: true, interfaces: ["en0"]))

        try await eventually("a connect as soon as the network settles", within: .milliseconds(600)) { bridge.upgrades.count == 3 }
        client.stop()
    }

    @Test func aNetworkPathThatDoesNotChangeLeavesTheWaitAlone() async throws {
        let bridge = try FakeBridge(onUpgrade: { _ in .refuse(status: 503) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.settle = .milliseconds(50)
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        let wifi = NetworkPath(satisfied: true, interfaces: ["en0"])
        client.networkChanged(wifi)
        client.start(pairing)
        try await eventually("two failed connects", within: .seconds(3)) { bridge.upgrades.count == 2 }
        try await Task.sleep(for: .milliseconds(100))

        client.networkChanged(wifi)

        try await Task.sleep(for: .milliseconds(600))
        #expect(bridge.upgrades.count == 2, "the backoff still holds for a bridge that refuses")
        client.stop()
    }

    @Test func leavingTheScreenSaysSoAndStopsWatchingThreadsThenComingBackSoonWatchesThemAgainOnTheSameSocket() async throws {
        let bridge = try threadBridge()
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.view(Viewing(session: SessionID("s1")), as: ViewingLease())
        client.start(pairing)
        try await eventually("the snapshot") { client.store.threads[SessionID("s1")]?.controls != nil }

        client.leave()

        try await eventually("presence and the unwatch") {
            bridge.texts.contains(#"{"attended":false,"type":"presence"}"#) && bridge.texts.contains { $0.contains(#""type":"unwatch_session""#) }
        }

        client.comeBack()

        try await eventually("the watch again and presence") {
            bridge.watches.count == 2 && bridge.texts.contains(#"{"attended":true,"type":"presence"}"#)
        }
        #expect(bridge.watches[1].contains(#""rev":7"#), "the thread resumes from the snapshot it holds")
        #expect(bridge.upgrades.count == 1)
        client.stop()
    }

    @Test func awayTheAppWatchesNoThreadAfterAReconnectAndComingBackLaterConnectsAgain() async throws {
        let bridge = try threadBridge()
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.awayBeforeReconnect = 0.2
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        client.view(Viewing(session: SessionID("s1")), as: ViewingLease())
        client.start(pairing)
        try await eventually("the snapshot") { client.store.threads[SessionID("s1")]?.controls != nil }
        client.leave()
        try await eventually("the unwatch") { bridge.texts.contains { $0.contains(#""type":"unwatch_session""#) } }

        bridge.sockets[0].close(code: 1000)
        try await eventually("the hello on the second socket", within: .seconds(3)) { bridge.upgrades.count == 2 && client.store.machine != nil }
        try await Task.sleep(for: .milliseconds(300))
        #expect(bridge.watches.count == 1, "a reconnect while away does not watch the thread")

        client.comeBack()

        try await eventually("a third socket that watches the thread", within: .seconds(2)) { bridge.upgrades.count == 3 && bridge.watches.count == 2 }
        #expect(bridge.watches[1].contains(#""rev":7"#))
        client.stop()
    }

    @Test func comingBackToASocketThatNoLongerAnswersConnectsAgainWithinTheProbe() async throws {
        let bridge = try threadBridge()
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.probe = .milliseconds(300)
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        client.view(Viewing(session: SessionID("s1")), as: ViewingLease())
        client.start(pairing)
        try await eventually("the snapshot") { client.store.threads[SessionID("s1")]?.controls != nil }
        client.leave()
        bridge.sockets[0].goSilent()

        client.comeBack()

        try await eventually("a new socket", within: .seconds(1)) { bridge.upgrades.count == 2 }
        try await eventually("the thread watched on it") { bridge.watches.count == 3 }
        client.stop()
    }

    @Test func aWorkingThreadThatHearsNothingMakesTheConnectionQuietUntilTheNextFrame() async throws {
        let socketOpen = OSAllocatedUnfairLock<FakeBridge.Socket?>(initialState: nil)
        let bridge = try FakeBridge(
            onOpen: { socket in
                socketOpen.withLock { $0 = socket }
                socket.send(threadsHello)
            },
            onText: { socket, text in if text.contains(#""type":"watch_session""#) { socket.send(snapshot(working: true)) } }
        )
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.quiet = 0.3
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        client.view(Viewing(session: SessionID("s1")), as: ViewingLease())
        client.start(pairing)
        try await eventually("the working thread") { client.store.threads[SessionID("s1")]?.controls?.working == true }
        #expect(!client.store.connection.quiet)

        try await eventually("the quiet connection", within: .seconds(2)) { client.store.connection.quiet }
        #expect(client.store.machine == "Mac")

        let rest = #"{"type":"session_items","sessionId":"s1","rev":8,"items":[],"removed":[],"controls":\#(controls(working: false))}"#
        socketOpen.withLock { $0 }?.send(rest)
        try await eventually("the frame ends the quiet") { !client.store.connection.quiet }
        try await Task.sleep(for: .milliseconds(700))
        #expect(!client.store.connection.quiet, "a thread at rest is allowed to be silent")
        client.stop()
    }

    @Test func aThreadThatMissesARevIsWatchedAgainAtOnceAndEndsAsAFreshOpenShowsIt() async throws {
        let fresh = thread(rev: 4, [askedLs, ranLs("ok"), listed], working: false)
        let watched = OSAllocatedUnfairLock(initialState: 0)
        let bridge = try FakeBridge(
            onOpen: { $0.send(threadsHello) },
            onText: { socket, text in
                guard text.contains(#""type":"watch_session""#) else { return }
                if watched.withLock({ $0 += 1; return $0 }) > 1 { return socket.send(fresh) }
                socket.send(thread(rev: 1, [askedLs], working: true))
                socket.send(changes(rev: 2, [ranLs("running")]))
                socket.send(changes(rev: 4, [listed]))
            }
        )
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.view(Viewing(session: SessionID("s1")), as: ViewingLease())
        client.start(pairing)

        try await eventually("the second watch") { bridge.watches.count == 2 }
        #expect(bridge.watches[1].contains(#""after":null"#), "rev 3 never came, so the app asks for a snapshot")
        try await eventually("the snapshot") { client.store.threads[SessionID("s1")]?.position?.rev == 4 }
        let expected = try Wire.decoder().decode(ServerFrame.self, from: Data(fresh.utf8))
        guard case let .thread(_, .snapshot(snapshot)) = expected.message else { throw CocoaError(.coderReadCorrupt) }
        #expect(client.store.threads[SessionID("s1")]?.items == snapshot.items)
        #expect(bridge.upgrades.count == 1, "the socket stays up")
        client.stop()
    }

    @Test func aRepairWhoseReplyNeverComesIsAskedOnceMoreAfterAWhile() async throws {
        let watched = OSAllocatedUnfairLock(initialState: 0)
        let bridge = try FakeBridge(
            onOpen: { $0.send(threadsHello) },
            onText: { socket, text in
                guard text.contains(#""type":"watch_session""#) else { return }
                switch watched.withLock({ $0 += 1; return $0 }) {
                case 1:
                    socket.send(thread(rev: 1, [askedLs], working: true))
                    socket.send(changes(rev: 3, [listed]))
                case 2: break
                default: socket.send(thread(rev: 3, [askedLs, listed], working: false))
                }
            }
        )
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.repairWait = .milliseconds(300)
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: timing)
        client.view(Viewing(session: SessionID("s1")), as: ViewingLease())
        client.start(pairing)

        try await eventually("the repair's snapshot") { client.store.threads[SessionID("s1")]?.position?.rev == 3 }
        #expect(bridge.watches.count == 3)
        #expect(bridge.watches[2].contains(#""after":null"#))
        try await Task.sleep(for: .milliseconds(700))
        #expect(bridge.watches.count == 3, "one retry, no more")
        client.stop()
    }

    @Test func aThreadOrListFrameTheAppCannotReadIsWatchedAgainOnTheSameSocket() async throws {
        let halfEmoji = #"{"type":"session_items","sessionId":"s1","rev":2,"items":[{"kind":"assistant","id":"r1","at":"2026-10-21T10:00:05.000Z","text":"Done \ud83d"}],"removed":[],"controls":null}"#
        let halfRow = #"{"type":"session_rows","rows":[{"id":"s9","title":"Refactor \ud83d"}],"removed":[],"projects":[]}"#
        let watched = OSAllocatedUnfairLock(initialState: 0)
        let bridge = try FakeBridge(
            onOpen: { $0.send(threadsHello) },
            onText: { socket, text in
                if text.contains(#""type":"watch_sessions""#) {
                    socket.send(#"{"type":"sessions","projects":[],"rows":[],"mirror":"auto"}"#)
                    if watched.withLock({ $0 }) == 0 { socket.send(halfRow) }
                }
                guard text.contains(#""type":"watch_session""#) else { return }
                if watched.withLock({ $0 += 1; return $0 }) > 1 { return socket.send(thread(rev: 2, [askedLs, listed], working: false)) }
                socket.send(thread(rev: 1, [askedLs], working: true))
                socket.send(halfEmoji)
            }
        )
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        client.view(Viewing(session: SessionID("s1"), sessionsList: true), as: ViewingLease())
        client.start(pairing)

        try await eventually("the thread watched again") { bridge.watches.count == 2 }
        #expect(bridge.watches[1].contains(#""after":null"#))
        try await eventually("its snapshot") { client.store.threads[SessionID("s1")]?.items.count == 2 }
        try await eventually("the list watched again") { bridge.texts.filter { $0.contains(#""type":"watch_sessions""#) }.count == 2 }
        #expect(bridge.upgrades.count == 1)
        client.stop()
    }
}

private let askedLs = #"{"kind":"user","id":"u1","at":"2026-10-21T10:00:00.000Z","text":"Run ls","from":"user","queued":false}"#
private let listed = #"{"kind":"assistant","id":"r1","at":"2026-10-21T10:00:05.000Z","text":"Listed."}"#

private func ranLs(_ state: String) -> String {
    #"{"kind":"work","id":"toolu_1","at":"2026-10-21T10:00:01.000Z","steps":[{"id":"toolu_1","tool":"Bash","label":"Run ls","state":"\#(state)","diff":null,"output":null}]}"#
}

private func thread(rev: Int, _ items: [String], working: Bool) -> String {
    #"{"type":"session","sessionId":"s1","epoch":"e_1","rev":\#(rev),"items":[\#(items.joined(separator: ","))],"before":null,"live":null,"controls":\#(controls(working: working))}"#
}

private func changes(rev: Int, _ items: [String]) -> String {
    #"{"type":"session_items","sessionId":"s1","rev":\#(rev),"items":[\#(items.joined(separator: ","))],"removed":[],"controls":null}"#
}
