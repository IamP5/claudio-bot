import SwiftUI

/// A file from the bot's library: markdown, plain text or an image.
struct FileView: View {
    let botId: BotID
    let path: String

    @Environment(AppStore.self) private var store
    @Environment(BridgeClient.self) private var client

    var body: some View {
        Group {
            if let file = store.files[FileKey(botId: botId, path: path)] {
                content(file)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Theme.background)
        .navigationTitle((path as NSString).lastPathComponent)
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { client.send(.file(botId: botId, path: path)) }
    }

    @ViewBuilder
    private func content(_ file: BotFile) -> some View {
        if let data = file.data.flatMap({ Data(base64Encoded: $0) }), let image = PlatformImage.image(from: data) {
            ScrollView([.horizontal, .vertical]) {
                image.resizable().scaledToFit().frame(maxWidth: 900)
            }
        } else if let text = file.content {
            ScrollView {
                Group {
                    if file.mime == "text/markdown" || path.hasSuffix(".md") {
                        MarkdownText(text: text).font(.ui(size: 16))
                    } else {
                        Text(text).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    }
                }
                .foregroundStyle(.white)
                .padding(20)
                .frame(maxWidth: 760, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
        } else {
            ContentUnavailableView(
                "No preview",
                systemImage: Self.symbol(for: path),
                description: Text("ClaudioBot shows text up to 1 MB and images up to 10 MB. This file is in the bot's library folder on \(store.computerName()).")
            )
        }
    }

    static func symbol(for path: String) -> String {
        switch (path as NSString).pathExtension.lowercased() {
        case "png", "jpg", "jpeg", "gif", "heic", "webp": "photo"
        case "md", "txt": "doc.text"
        case "html", "htm": "globe"
        case "json", "js", "ts", "swift", "py", "sh": "chevron.left.forwardslash.chevron.right"
        default: "doc"
        }
    }
}
