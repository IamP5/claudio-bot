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

    @Test func thePairSheetClosesOnADeviceMissingFromTheFirstListItHeard() {
        func device(_ id: String) -> Device {
            Device(id: DeviceID(id), name: id, createdAt: .now, lastSeenAt: nil, legacy: false, current: id == "mac")
        }
        var watch = NewDeviceWatch()
        let first = watch.heard([device("mac"), device("old")])
        let again = watch.heard([device("mac"), device("old")])
        let revoked = watch.heard([device("mac")])
        let paired = watch.heard([device("mac"), device("phone")])
        #expect(!first, "the first list is what was paired before")
        #expect(!again)
        #expect(!revoked, "a revoke is not a new device")
        #expect(paired)
    }
}
