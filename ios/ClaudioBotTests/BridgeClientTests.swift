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
}
