import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

/// The device this app runs on, in copy and in the name the bridge lists.
enum ThisDevice {
    /// "This iPhone was removed from your Mac."
    static var noun: String {
        #if os(iOS)
        "iPhone"
        #else
        "Mac"
        #endif
    }

    /// "Your bots keep working there while this phone is away."
    static var casualNoun: String {
        #if os(iOS)
        "phone"
        #else
        "Mac"
        #endif
    }

    /// "Pick a bot, or tap + to start a chat."
    static var tapVerb: String {
        #if os(iOS)
        "tap"
        #else
        "click"
        #endif
    }

    /// Sent with POST /pair and shown in every device list.
    @MainActor static var pairingName: String {
        #if os(iOS)
        UIDevice.current.name
        #else
        "ClaudioBot on \(Host.current().localizedName ?? "Mac")"
        #endif
    }
}

enum Clipboard {
    @MainActor static func copy(_ text: String) {
        #if os(iOS)
        UIPasteboard.general.string = text
        #else
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        #endif
    }
}

enum AppActivity {
    @MainActor static var isActive: Bool {
        #if os(iOS)
        UIApplication.shared.applicationState == .active
        #else
        NSApp.isActive
        #endif
    }
}

enum PlatformImage {
    /// nil when the data is not an image.
    static func image(from data: Data) -> Image? {
        #if os(iOS)
        UIImage(data: data).map { Image(uiImage: $0) }
        #else
        NSImage(data: data).map { Image(nsImage: $0) }
        #endif
    }

    /// The composer's photo re-encode. nil when the data is not an image.
    static func jpeg(from data: Data, quality: Double = 0.85) -> Data? {
        #if os(iOS)
        UIImage(data: data)?.jpegData(compressionQuality: quality)
        #else
        NSBitmapImageRep(data: data)?.representation(using: .jpeg, properties: [.compressionFactor: quality])
        #endif
    }
}

extension ImageRenderer {
    @MainActor var platformImage: Image? {
        #if os(iOS)
        uiImage.map { Image(uiImage: $0) }
        #else
        nsImage.map { Image(nsImage: $0) }
        #endif
    }
}

/// Opens a path the bridge sent in apps on this computer. Only a Mac whose bridge runs on the same Mac provides one;
/// on iOS and for a bridge elsewhere it is nil and `LocalPathMenu` shows nothing.
struct LocalOpener: Sendable {
    var editorName: String
    var openInEditor: @MainActor @Sendable (String) -> Void
    var revealInFinder: @MainActor @Sendable (String) -> Void
    var openInTerminal: @MainActor @Sendable (String) -> Void
    var exists: @Sendable (String) -> Bool
}

extension EnvironmentValues {
    @Entry var localOpener: LocalOpener? = nil
}

struct LocalPathMenu: View {
    let path: String
    @Environment(\.localOpener) private var opener

    var body: some View {
        if let opener, opener.exists(path) {
            Divider()
            Button { opener.openInEditor(path) } label: {
                Label("Open in \(opener.editorName)", systemImage: "chevron.left.forwardslash.chevron.right")
            }
            Button { opener.revealInFinder(path) } label: { Label("Reveal in Finder", systemImage: "folder") }
            Button { opener.openInTerminal(path) } label: { Label("Open in Terminal", systemImage: "terminal") }
            Button { Clipboard.copy(path) } label: { Label("Copy Path", systemImage: "doc.on.doc") }
        }
    }
}
