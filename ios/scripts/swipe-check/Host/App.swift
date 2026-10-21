import SwiftUI

/// XCUITest needs a host app of its own. The test drives ClaudioBot by its bundle id.
@main struct HostApp: App {
    var body: some Scene { WindowGroup { Text("swipe-check host") } }
}
