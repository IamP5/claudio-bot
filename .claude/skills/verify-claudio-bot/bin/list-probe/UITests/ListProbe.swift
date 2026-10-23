import XCTest

/// Reads the Sessions list as the running app draws it, without touching it: about once a second, the spoken labels
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
            // A whole-tree snapshot is heavy; sampled faster, it slowed the bridge enough to fail S7.6's 1.5 s.
            usleep(1_000_000)
        }
        try handle.close()
    }

    private func hits(_ node: XCUIElementSnapshot, _ phrases: [String], _ out: inout [[String: Any]]) {
        if phrases.contains(where: { node.label.contains($0) }) {
            out.append(["label": node.label, "button": node.elementType == .button, "enabled": node.isEnabled])
        }
        for child in node.children { hits(child, phrases, &out) }
    }

    /// Reads, about once a second, every element whose label holds one of PHRASES (newline-separated), with whether
    /// each is a button and takes a tap. Appends {"t": epoch ms, "hits": [{label, button, enabled}]} to OUT.
    func testLabels() throws {
        let env = ProcessInfo.processInfo.environment
        let out = URL(fileURLWithPath: try XCTUnwrap(env["OUT"]))
        let phrases = try XCTUnwrap(env["PHRASES"]).split(separator: "\n").map(String.init)
        let deadline = Date() + (Double(env["SECONDS"] ?? "") ?? 600)
        let app = XCUIApplication(bundleIdentifier: "dev.claudiobot.app")
        app.activate()
        FileManager.default.createFile(atPath: out.path, contents: nil)
        let handle = try FileHandle(forWritingTo: out)
        while Date() < deadline {
            var found: [[String: Any]] = []
            if let snap = try? app.snapshot() { hits(snap, phrases, &found) }
            let sample: [String: Any] = ["t": Int(Date().timeIntervalSince1970 * 1000), "hits": found]
            handle.write(try JSONSerialization.data(withJSONObject: sample) + Data("\n".utf8))
            usleep(1_000_000)
        }
        try handle.close()
    }
}
