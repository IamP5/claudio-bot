import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The message bar: + for attachments, a field that leaves quotes alone, dictation and send.
struct Composer: View {
    let bot: Bot
    let openQuestion: Bool
    var onSend: () -> Void = {}

    @Environment(BridgeClient.self) private var client
    @Environment(AppStore.self) private var store
    #if DEBUG
    @State private var draft = Demo.draft?.draft ?? ComposerDraft()
    @State private var caret = Demo.draft?.caret ?? 0
    #else
    @State private var draft = ComposerDraft()
    @State private var caret = 0
    #endif
    /// Where the menu the user closed with Escape started, so it stays closed until a new trigger.
    @State private var closedMenuAt: Int?
    @State private var uploads: [Upload] = []
    @State private var problem: String?
    @State private var dictation = Dictation()
    @State private var dictationBase = ComposerDraft()
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var takingPhoto = false
    @State private var pickingFiles = false
    /// Counts sends, so each one taps the haptic engine once.
    @State private var sends = 0

    static let uploadLimit = 10 << 20

    private var placeholder: String {
        openQuestion ? "Type your answer, or talk about something else" : "Message \(bot.name)"
    }

    private var canSend: Bool {
        !draft.isBlank || !uploads.isEmpty
    }

    private var menu: ComposerMenu? {
        let menu = ComposerMenu.at(
            caret, in: draft, chat: bot, features: store.features, bots: Array(store.bots.values),
            connectors: store.connectors[bot.id] ?? [], commands: store.commands[bot.id] ?? []
        )
        return menu?.trigger.range.location == closedMenuAt ? nil : menu
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let menu {
                ComposerMenuView(menu: menu, onMention: { pick($0, in: menu) }, onCommand: { pick($0, in: menu) })
                    .transition(.opacity.combined(with: .offset(y: 6)))
            }
            if !uploads.isEmpty { pendingUploads }
            if let note = problem ?? dictation.failure {
                Text(note).font(.footnote).foregroundStyle(AvatarColor.amber.color).padding(.horizontal, 8)
            }
            HStack(alignment: .bottom, spacing: 10) {
                attachMenu
                HStack(alignment: .bottom, spacing: 6) {
                    PromptTextView(
                        draft: $draft, caret: $caret, placeholder: placeholder, maxLines: 6,
                        tokenColor: tokenColor, onReturn: pickFirst, onEscape: closeMenu
                    )
                        .padding(.vertical, 11)
                        .padding(.leading, 16)
                    micButton
                    sendButton
                }
                .padding(.trailing, 5)
                .glass(in: RoundedRectangle(cornerRadius: 23, style: .continuous))
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .animation(.snappy(duration: 0.2), value: menu?.trigger.kind)
        .onChange(of: draft.trigger(caret: caret)?.range.location) { _, location in
            if location != closedMenuAt { closedMenuAt = nil }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: 5, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await addPhotos(items) }
        }
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                if let data = image.jpegData(compressionQuality: 0.85) {
                    add(Upload(name: "photo-\(Int(Date.now.timeIntervalSince1970)).jpg", mime: "image/jpeg", data: data.base64EncodedString()), size: data.count)
                }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            addFiles(result)
        }
        .onDisappear { dictation.stop() }
    }

    private var attachMenu: some View {
        Menu {
            Button { pickingPhotos = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
            Button { takingPhoto = true } label: { Label("Take Photo", systemImage: "camera") }
                .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            Button { pickingFiles = true } label: { Label("Choose File", systemImage: "folder") }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 19, weight: .medium))
                .foregroundStyle(.white)
                .frame(width: 46, height: 46)
                .glass(in: Circle())
        }
        .accessibilityLabel("Attach")
    }

    private var micButton: some View {
        Button {
            if dictation.isRecording {
                dictation.stop()
            } else {
                dictationBase = draft
                Task {
                    await dictation.start { transcript in
                        var spoken = dictationBase
                        spoken.append(dictationBase.text.isEmpty ? transcript : " " + transcript)
                        draft = spoken
                        caret = (spoken.text as NSString).length
                    }
                }
            }
        } label: {
            Image(systemName: dictation.isRecording ? "mic.fill" : "mic")
                .font(.system(size: 17))
                .foregroundStyle(dictation.isRecording ? bot.avatar.color.accent : Theme.secondary)
                .symbolEffect(.pulse, isActive: dictation.isRecording)
                .frame(width: 34, height: 36)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(dictation.isRecording ? "Stop dictation" : "Dictate")
    }

    private var sendButton: some View {
        Button(action: send) {
            Image(systemName: "arrow.up")
                .font(.system(size: 16, weight: .bold))
                .foregroundStyle(bot.avatar.color.onAccent)
                .frame(width: 36, height: 36)
                .background(bot.avatar.color.accent, in: Circle())
                .opacity(canSend ? 1 : 0.45)
                .animation(.easeOut(duration: 0.15), value: canSend)
        }
        .buttonStyle(.pressable)
        .disabled(!canSend)
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .padding(.bottom, 5)
        .accessibilityLabel("Send")
    }

    private var pendingUploads: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(uploads.enumerated()), id: \.offset) { index, upload in
                    HStack(spacing: 6) {
                        Image(systemName: upload.mime.hasPrefix("image/") ? "photo" : "doc")
                        Text(upload.name).lineLimit(1)
                        Button { uploads.remove(at: index) } label: { Image(systemName: "xmark.circle.fill") }
                            .buttonStyle(.plain)
                            .foregroundStyle(Theme.tertiary)
                            .accessibilityLabel("Remove \(upload.name)")
                    }
                    .font(.footnote)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 7)
                    .background(Theme.raised, in: Capsule())
                }
            }
            .padding(.horizontal, 4)
        }
    }

    /// A bot mention reads in that bot's color, a connector in the link color.
    private func tokenColor(_ mention: Mention) -> Color {
        if case .bot(let id, _) = mention, let mentioned = store.bots[id] { return mentioned.avatar.color.accent }
        return Theme.link
    }

    private func pick(_ candidate: MentionCandidate, in menu: ComposerMenu) {
        caret = draft.pick(candidate.mention, replacing: menu.trigger.range)
    }

    private func pick(_ command: Command, in menu: ComposerMenu) {
        caret = draft.pick(command: command.name, replacing: menu.trigger.range)
    }

    /// Return picks the menu's first row. A menu only shows while something matches, so there always is one.
    private func pickFirst() -> Bool {
        guard let menu else { return false }
        switch menu {
        case .mentions(_, let candidates): if let first = candidates.first { pick(first, in: menu) }
        case .commands(_, let commands): if let first = commands.first { pick(first, in: menu) }
        }
        return true
    }

    private func closeMenu() {
        closedMenuAt = menu?.trigger.range.location
    }

    private func send() {
        guard canSend else { return }
        dictation.stop()
        let send = draft.send(to: bot.id, uploads: uploads, clientId: UUID().uuidString)
        store.sendStarted(send)
        client.send(send)
        draft = ComposerDraft()
        caret = 0
        uploads = []
        problem = nil
        sends += 1
        onSend()
    }

    private func add(_ upload: Upload, size: Int) {
        guard size <= Self.uploadLimit else {
            problem = "\(upload.name) is over 10 MB."
            return
        }
        problem = nil
        uploads.append(upload)
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        for (index, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) ?? data
            add(Upload(name: "image-\(index + 1).jpg", mime: "image/jpeg", data: jpeg.base64EncodedString()), size: jpeg.count)
        }
    }

    private func addFiles(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result else { return }
        for url in urls {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { continue }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
            add(Upload(name: url.lastPathComponent, mime: mime, data: data.base64EncodedString()), size: data.count)
        }
    }
}

private struct CameraPicker: UIViewControllerRepresentable {
    let onImage: (UIImage) -> Void
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }

        func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage { parent.onImage(image) }
            parent.dismiss()
        }

        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.dismiss()
        }
    }
}
