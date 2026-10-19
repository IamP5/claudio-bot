import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// The message bar: + for attachments, a field that leaves quotes alone, dictation and send. A group has no +: it has no
/// folder, so the bridge refuses uploads there.
struct Composer: View {
    let bot: Bot
    let openQuestion: Bool
    var onSend: () -> Void = {}

    @Environment(BridgeClient.self) private var client
    @Environment(AppStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    @State private var stops = 0

    static let uploadLimit = 10 << 20
    /// The mic, Send and Stop sit inside the field with the same inset on every side. A one-line field is then 44 pt,
    /// the minimum touch target, and its corners stay concentric with theirs. A Mac's pointer needs less, so there
    /// the circles are 28 pt and + moves inside the field.
    #if os(macOS)
    static let control: CGFloat = 28
    static let inset: CGFloat = 8
    private static let sendWidth = control
    #else
    static let control: CGFloat = 36
    static let inset: CGFloat = 4
    private static let sendWidth = control + 10
    #endif
    static let field = control + 2 * inset

    private var placeholder: String {
        openQuestion ? "Type your answer, or talk about something else" : "Message \(bot.name)"
    }

    private var canSend: Bool {
        !draft.isBlank || !uploads.isEmpty
    }

    /// While the bot works an empty field offers Stop. Typing turns it back into Send, which queues the message.
    private var showsStop: Bool {
        bot.status == .working && !canSend
    }

    /// An empty field offers the mic and nothing to send. Once there is something to send, Send takes the mic's place.
    /// Dictation keeps the mic up so it can be stopped while the words arrive.
    private var showsMic: Bool {
        !canSend || dictation.isRecording
    }

    private var swap: AnyTransition {
        reduceMotion ? .opacity : .scale(scale: 0.5).combined(with: .opacity)
    }

    private var menuTransition: AnyTransition {
        if reduceMotion { return .opacity }
        #if os(macOS)
        return .opacity.combined(with: .scale(scale: 0.97, anchor: .bottom))
        #else
        return .opacity.combined(with: .offset(y: 6))
        #endif
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
            #if os(iOS)
            menuView
            #endif
            if !uploads.isEmpty { pendingUploads }
            if let note = problem ?? dictation.failure {
                Text(note).font(.footnote).foregroundStyle(AvatarColor.amber.color).padding(.horizontal, 8)
            }
            HStack(alignment: .bottom, spacing: 10) {
                #if os(iOS)
                if !bot.isGroup { attachMenu }
                #endif
                HStack(alignment: .bottom, spacing: 6) {
                    #if os(macOS)
                    if !bot.isGroup { attachMenu.padding(.bottom, Self.inset) }
                    #endif
                    PromptTextView(
                        draft: $draft, caret: $caret, placeholder: placeholder, maxLines: 6, autofocus: Self.focusesOnOpen,
                        tokenColor: tokenColor, onReturn: pickFirst, onEscape: closeMenu, onSubmit: send,
                        onAttachFiles: attachFiles, onAttachImage: attachImage
                    )
                        .padding(.vertical, 8)
                        .frame(minHeight: Self.field)
                        .padding(.leading, fieldLeading)
                    if showsMic { micButton.transition(swap) }
                    if canSend || showsStop { sendButton.transition(swap) }
                }
                .padding(.leading, bot.isGroup ? 0 : Self.attachInset)
                .padding(.trailing, Self.inset)
                .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.25, extraBounce: 0.12), value: showsMic)
                .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.25, extraBounce: 0.12), value: canSend || showsStop)
                .glass(in: RoundedRectangle(cornerRadius: Self.control / 2 + Self.inset, style: .continuous))
                #if os(macOS)
                .dropDestination(for: URL.self) { urls, _ in
                    let files = urls.filter(\.isFileURL)
                    guard !bot.isGroup, !files.isEmpty else { return false }
                    addFiles(.success(files))
                    return true
                }
                #endif
            }
            .glassGroup(spacing: 10)
        }
        #if os(macOS)
        // The menu floats over the transcript instead of growing the bar, so the list above it never moves.
        .overlay(alignment: .top) {
            menuView
                .alignmentGuide(.top) { $0[.bottom] + 8 }
                .animation(.easeOut(duration: 0.15), value: menu?.trigger.kind)
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 16)
        #else
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
        .animation(reduceMotion ? .easeOut(duration: 0.15) : .snappy(duration: 0.2), value: menu?.trigger.kind)
        #endif
        .onChange(of: draft.trigger(caret: caret)?.range.location) { _, location in
            if location != closedMenuAt { closedMenuAt = nil }
        }
        .photosPicker(isPresented: $pickingPhotos, selection: $photoItems, maxSelectionCount: 5, matching: .images)
        .onChange(of: photoItems) { _, items in
            guard !items.isEmpty else { return }
            photoItems = []
            Task { await addPhotos(items) }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $takingPhoto) {
            CameraPicker { image in
                if let data = image.jpegData(compressionQuality: 0.85) {
                    add(Upload(name: "photo-\(Int(Date.now.timeIntervalSince1970)).jpg", mime: "image/jpeg", data: data.base64EncodedString()), size: data.count)
                }
            }
            .ignoresSafeArea()
        }
        #endif
        .fileImporter(isPresented: $pickingFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            addFiles(result)
        }
        .onDisappear { dictation.stop() }
    }

    @ViewBuilder private var menuView: some View {
        if let menu {
            ComposerMenuView(menu: menu, onMention: { pick($0, in: menu) }, onCommand: { pick($0, in: menu) })
                .transition(menuTransition)
        }
    }

    #if os(macOS)
    /// A Mac chat opens ready to type.
    private static let focusesOnOpen = true
    private static let attachInset = inset
    private var fieldLeading: CGFloat { bot.isGroup ? 16 : 2 }
    #else
    private static let focusesOnOpen = false
    private static let attachInset: CGFloat = 0
    private let fieldLeading: CGFloat = 16
    #endif

    private var attachMenu: some View {
        Menu {
            Button { pickingPhotos = true } label: { Label("Photo Library", systemImage: "photo.on.rectangle") }
            #if os(iOS)
            Button { takingPhoto = true } label: { Label("Take Photo", systemImage: "camera") }
                .disabled(!UIImagePickerController.isSourceTypeAvailable(.camera))
            #endif
            Button { pickingFiles = true } label: { Label("Choose File", systemImage: "folder") }
        } label: {
            #if os(macOS)
            Image(systemName: "plus")
                .font(.ui(size: 17, weight: .medium))
                .foregroundStyle(.white)
                .frame(width: Self.control, height: Self.control)
                .background(Theme.raised, in: Circle())
                .contentShape(Circle())
            #else
            Image(systemName: "plus")
                .font(.ui(size: 19, weight: .medium))
                .foregroundStyle(.white)
                .frame(width: Self.field, height: Self.field)
                .glass(in: Circle(), interactive: true)
                .contentShape(Circle())
            #endif
        }
        #if os(macOS)
        // A Mac menu otherwise draws its own bezel and arrow around the round button.
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        #endif
        .accessibilityLabel("Attach")
        .help("Attach a Photo or File")
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
                .font(.ui(size: 17))
                .foregroundStyle(dictation.isRecording ? bot.avatar.color.accent : Theme.secondary)
                .symbolEffect(.pulse, isActive: dictation.isRecording)
                .frame(width: Self.control, height: Self.control)
                #if os(macOS)
                .background(Theme.raised, in: Circle())
                .contentShape(Circle())
                #endif
        }
        .buttonStyle(.plain)
        .padding(.bottom, Self.inset)
        .accessibilityLabel(dictation.isRecording ? "Stop dictation" : "Dictate")
        .help(dictation.isRecording ? "Stop Dictation" : "Dictate")
    }

    private var sendButton: some View {
        Button {
            if showsStop { stop() } else { send() }
        } label: {
            Image(systemName: showsStop ? "stop.fill" : "arrow.up")
                .font(.ui(size: showsStop ? 14 : 16, weight: .bold))
                .contentTransition(.symbolEffect(.replace))
                .foregroundStyle(bot.avatar.color.onAccent)
                .frame(width: Self.sendWidth, height: Self.control)
                .background(bot.avatar.color.accent, in: Capsule())
        }
        .buttonStyle(.pressable)
        .sensoryFeedback(.impact(weight: .light), trigger: sends)
        .sensoryFeedback(.impact(weight: .medium), trigger: stops)
        .padding(.bottom, Self.inset)
        #if os(macOS)
        .keyboardShortcut(showsStop ? KeyboardShortcut(".", modifiers: .command) : nil)
        #endif
        .help(showsStop ? "Stop (⌘.)" : "Send (Return)")
        .accessibilityLabel(showsStop ? "Stop" : "Send")
        .accessibilityIdentifier(showsStop ? "stop" : "send")
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

    private func stop() {
        client.send(.stop(botId: bot.id))
        stops += 1
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

    private var attachFiles: (([URL]) -> Void)? {
        guard !bot.isGroup else { return nil }
        return { urls in addFiles(.success(urls)) }
    }

    private var attachImage: ((Data) -> Void)? {
        guard !bot.isGroup else { return nil }
        return { data in addImage(data) }
    }

    /// A pasted image, such as a screenshot, goes up as a JPEG like a picked photo.
    private func addImage(_ data: Data) {
        guard let jpeg = PlatformImage.jpeg(from: data) else { return }
        let name = "image-\(Int(Date.now.timeIntervalSince1970)).jpg"
        add(Upload(name: name, mime: "image/jpeg", data: jpeg.base64EncodedString()), size: jpeg.count)
    }

    private func addPhotos(_ items: [PhotosPickerItem]) async {
        for (index, item) in items.enumerated() {
            guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
            let jpeg = PlatformImage.jpeg(from: data) ?? data
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

#if os(iOS)
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
#endif
