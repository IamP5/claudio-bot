import XCTest

/// Reads the Sessions list as the running app draws it, without touching it: every few hundred ms, the spoken labels
/// of the buttons that start with "<PREFIX>, " (rows and the project header) and "Show " (the fold), top to bottom.
/// Appends one JSON line per sample to OUT: {"t": epoch ms, "rows": [...], "more": [...]}. Runs until killed or for
/// SECONDS.
final class ListProbe: XCTestCase {
    private func collect(_ node: XCUIElementSnapshot, _ prefix: String, _ rows: inout [(CGFloat, String)], _ more: inout [String]) {
        if node.elementType == .button {
            if node.label.hasPrefix(prefix) { rows.append((node.frame.minY, node.label)) }
            if node.label.hasPrefix("Show ") && node.label.hasSuffix(" more in \(prefix.dropLast(2))") { more.append(node.label) }
        }
        for child in node.children { collect(child, prefix, &rows, &more) }
    }

    func testWatch() throws {
        let env = ProcessInfo.processInfo.environment
        let out = URL(fileURLWithPath: try XCTUnwrap(env["OUT"]))
        let prefix = try XCTUnwrap(env["PREFIX"]) + ", "
        let deadline = Date() + (Double(env["SECONDS"] ?? "") ?? 600)
        let app = XCUIApplication(bundleIdentifier: "dev.claudiobot.app")
        app.activate()
        FileManager.default.createFile(atPath: out.path, contents: nil)
        let handle = try FileHandle(forWritingTo: out)
        while Date() < deadline {
            var rows: [(CGFloat, String)] = []
            var more: [String] = []
            if let snap = try? app.snapshot() { collect(snap, prefix, &rows, &more) }
            let sample: [String: Any] = ["t": Int(Date().timeIntervalSince1970 * 1000), "rows": rows.sorted { $0.0 < $1.0 }.map(\.1), "more": more]
            handle.write(try JSONSerialization.data(withJSONObject: sample) + Data("\n".utf8))
            usleep(300_000)
        }
        try handle.close()
    }
}
