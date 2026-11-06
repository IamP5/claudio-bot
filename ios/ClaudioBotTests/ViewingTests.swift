import Foundation
import Testing
@testable import ClaudioBot

@Suite struct ViewingTests {
    private let main = ViewingLease()
    private let second = ViewingLease()

    @Test func aBotIsOpenedOnlyWhenItFirstComesOnScreen() {
        var screen = OnScreen()
        #expect(screen.set(Viewing(bot: BotID("a")), for: main).opened == [BotID("a")])
        #expect(screen.set(Viewing(bot: BotID("a")), for: second).isEmpty, "already on screen in the main window")
        #expect(screen.set(Viewing(bot: BotID("b")), for: second).opened == [BotID("b")])
        #expect(screen.bots == [BotID("a"), BotID("b")])
    }

    @Test func aThreadIsUnwatchedOnlyWhenItsLastWindowLeaves() {
        var screen = OnScreen()
        let s1 = SessionID("s1")
        #expect(screen.set(Viewing(session: s1), for: main).watched == [s1])
        #expect(screen.set(Viewing(session: s1), for: second).isEmpty)
        #expect(screen.set(nil, for: second).isEmpty, "the main window still shows it")
        let change = screen.set(Viewing(session: SessionID("s2")), for: main)
        #expect(change.unwatched == [s1])
        #expect(change.watched == [SessionID("s2")])
        #expect(screen.sessions == [SessionID("s2")])
    }

    @Test func theListIsWatchedWhileAnyWindowWantsIt() {
        var screen = OnScreen()
        #expect(screen.set(Viewing(sessionsList: true), for: main).sessionsList == true)
        #expect(screen.set(Viewing(sessionsList: true), for: second).sessionsList == nil)
        #expect(screen.set(Viewing(), for: main).sessionsList == nil, "the second window still wants it")
        #expect(screen.set(nil, for: second).sessionsList == false)
        #expect(!screen.sessionsList)
    }

    @Test func returningALeaseTheScreenNeverHadChangesNothing() {
        var screen = OnScreen()
        #expect(screen.set(nil, for: main).isEmpty)
        #expect(screen == OnScreen())
    }

    private func device(_ id: String, legacy: Bool = false, current: Bool = false) -> Device {
        Device(id: DeviceID(id), name: id, createdAt: .now, lastSeenAt: nil, legacy: legacy, current: current)
    }

    @Test func thePairSheetNamesTheDeviceMissingFromTheFirstListItHeard() {
        var watch = NewDeviceWatch()
        let first = watch.heard([device("mac", current: true), device("old")])
        let again = watch.heard([device("mac", current: true), device("old")])
        let revoked = watch.heard([device("mac", current: true)])
        let paired = watch.heard([device("mac", current: true), device("Kim's iPad")])
        #expect(first == nil, "the first list is what was paired before")
        #expect(again == nil)
        #expect(revoked == nil, "a revoke is not a new device")
        #expect(paired?.name == "Kim's iPad")
    }

    @Test func pairAnotherSaysWhyItCannotHandOutACode() {
        let token = Pairing.Credential.device(DeviceID("me"), token: "t")
        let shared = Pairing.Credential.legacy(token: "t")
        #expect(PairAnother.blocked(online: true, credential: token, devices: [device("me", current: true)]) == nil)
        #expect(PairAnother.blocked(online: true, credential: token, devices: nil) == nil)
        #expect(PairAnother.blocked(online: false, credential: token, devices: nil) == "Connect to your Mac to pair another device.")
        let legacyLine = "This \(ThisDevice.noun) still uses the old shared token, so your Mac won't give it a code for another device. Unpair it, then pair it again with a code from your Mac."
        #expect(PairAnother.blocked(online: true, credential: shared, devices: nil) == legacyLine)
        #expect(PairAnother.blocked(online: true, credential: token, devices: [device("me", legacy: true, current: true)]) == legacyLine, "the Mac's list wins over the saved pairing")
        #expect(PairAnother.blocked(online: false, credential: shared, devices: nil) == legacyLine, "a reconnect does not fix the shared token")
    }
}
