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

private func hello(world: String) -> String {
    #"{"type":"hello","protocol":3,"features":["machines"],"machine":"omarchy","userName":"Alex","bots":[],"epoch":"e1","seq":0,"resumed":false,"world":{"id":"\#(world)","name":"Alex's bots"},"machines":[]}"#
}

private func broadcast(_ seq: Int) -> String {
    #"{"type":"bot_removed","botId":"gone","seq":\#(seq)}"#
}

private let quick = BridgeClient.Timing(greeting: .seconds(1), reply: .seconds(1), legacyRetry: .milliseconds(300))

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
        client.retry()
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

    @Test func anotherAddressOfTheSameWorldKeepsTheStoreAndAnotherWorldEmptiesIt() {
        let dead = URL(string: "ws://127.0.0.1:9/ws")!
        let credential = Pairing.Credential.device(DeviceID("d1"), token: "t1")
        let client = BridgeClient(store: AppStore(), vault: scratchVault(), timing: quick)
        var forgotten = 0
        client.onForget = { forgotten += 1 }
        let held = Bot(
            id: BotID("b1"), name: "eng", title: nil, avatar: .standard, pinned: false, hidden: false, status: .idle, unread: 0,
            question: nil, preview: "", lastAt: .now, createdAt: .now, routines: []
        )
        client.start(Pairing(url: dead, credential: credential, world: WorldID("w1")))
        client.store.apply(.hello(Hello(machine: "omarchy", userName: "Alex", bots: [held])))

        client.start(Pairing(url: URL(string: "ws://127.0.0.1:8/ws")!, credential: credential, world: WorldID("w1")))
        #expect(client.store.bots[held.id] != nil && forgotten == 0)

        client.start(Pairing(url: URL(string: "ws://127.0.0.1:8/ws")!, credential: credential, world: WorldID("w2")))
        #expect(client.store.bots.isEmpty && forgotten == 1)
        client.stop()
    }

    @Test func theFirstWorldAPairingHearsIsSavedAndADifferentOneLaterEmptiesTheStore() async throws {
        let world = OSAllocatedUnfairLock(initialState: "w1")
        let bridge = try FakeBridge(onOpen: { $0.send(hello(world: world.withLock { $0 })) })
        let vault = scratchVault()
        defer { vault.clear() }
        let migrated = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        try vault.save(migrated)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        var forgotten = 0
        client.onForget = { forgotten += 1 }
        client.start(migrated)
        try await eventually("the hello") { client.store.machine != nil }
        #expect(vault.load()?.world == WorldID("w1") && client.pairing?.world == WorldID("w1"))
        #expect(forgotten == 0)

        world.withLock { $0 = "w2" }
        bridge.sockets.first?.close(code: 1001)
        try await eventually("the other world's hello") { client.pairing?.world == WorldID("w2") }
        #expect(vault.load()?.world == WorldID("w2"))
        #expect(forgotten == 1)
        client.stop()
    }

    @Test func aConnectThatFailsMovesToTheNextAddressOfTheWorldThatProvesItself() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(hello()) }, onHealth: FakeBridge.proving("t1"))
        let vault = scratchVault()
        defer { vault.clear() }
        let good = try await bridge.start()
        let dead = URL(string: "ws://127.0.0.1:9/ws")!
        let pairing = Pairing(url: dead, credential: .device(DeviceID("d1"), token: "t1"), urls: [dead, good])
        try vault.save(pairing)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(pairing)

        try await eventually("the hello at the next address") { client.store.machine == "Mac" }
        #expect(client.pairing == pairing.at(good))
        #expect(vault.load() == pairing.at(good))
        #expect(bridge.healthChecks.count == 1)
        #expect(bridge.upgrades.allSatisfy { $0.authorization == "Bearer t1" })
        client.stop()
    }

    @Test func anAddressOfTheWorldThatCannotProveItselfNeverReceivesTheToken() async throws {
        let impostor = try FakeBridge(onOpen: { $0.send(hello()) }, onHealth: { _ in (200, #"{"ok":true}"#) })
        let vault = scratchVault()
        defer { vault.clear() }
        let dead = URL(string: "ws://127.0.0.1:9/ws")!
        let pairing = Pairing(url: dead, credential: .device(DeviceID("d1"), token: "t1"), urls: [dead, try await impostor.start()])
        try vault.save(pairing)
        let client = BridgeClient(store: AppStore(), vault: vault, timing: quick)
        client.start(pairing)

        try await eventually("two failed connects") { client.failures >= 2 && impostor.healthChecks.count >= 2 }
        #expect(impostor.upgrades.isEmpty)
        #expect(client.pairing == pairing && vault.load() == pairing)
        client.stop()
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

    @Test func aStopTappedOfflineLongAgoIsNotSentWhileAMessageStillIs() async throws {
        let bridge = try FakeBridge(onOpen: { $0.send(hello()) })
        let pairing = Pairing(url: try await bridge.start(), credential: .device(DeviceID("d1"), token: "t1"))
        var timing = quick
        timing.staleStop = 0
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

        #expect(vault.load() == Pairing(url: good, credential: dead.credential, urls: [dead.url, good]))
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

        let paired = Pairing(url: good, credential: .device(DeviceID("d2"), token: "t2"), urls: [dead, good])
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
}
