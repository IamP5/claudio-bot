import XCTest

/// Opens a demo screen (or the app as it runs, with ATTACH=1), swipes the thread down once and appends
/// "<screen> <seconds>" to OUT. XCUITest waits up to 60 s for the app to go idle after a swipe, so a main thread
/// that never settles shows as a swipe of about a minute.
final class Swipe: XCTestCase {
    func testSwipeDown() throws {
        let env = ProcessInfo.processInfo.environment
        let screen = env["SCREEN"] ?? "workrun"
        let app = XCUIApplication(bundleIdentifier: "dev.claudiobot.app")
        if env["ATTACH"] == "1" {
            app.activate()
        } else {
            app.terminate()
            app.launchArguments = ["-demo", "-demoScreen", screen]
            app.launch()
        }
        sleep(3)
        // A screen named "...kb" is swiped with the keyboard up, which typing is what brings up.
        if screen.hasSuffix("kb") {
            app.textViews.firstMatch.tap()
            app.textViews.firstMatch.typeText("x")
            sleep(1)
        }
        let start = Date()
        app.swipeDown()
        let seconds = Date().timeIntervalSince(start)
        let line = String(format: "%@ %.1f\n", screen, seconds)
        let url = URL(fileURLWithPath: try XCTUnwrap(env["OUT"]))
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile()
            handle.write(Data(line.utf8))
            try handle.close()
        } else {
            try line.write(to: url, atomically: true, encoding: .utf8)
        }
    }
}
