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
    @State private var text = ""
    @State private var uploads: [Upload] = []
    @State private var problem: String?
    @State private var dictation = Dictation()
    @State private var dictationBase = ""
    @State private var pickingPhotos = false
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var takingPhoto = false
    @State private var pickingFiles = false

    static let uploadLimit = 10 << 20

    private var placeholder: String {
        openQuestion ? "Type your answer, or talk about something else" : "Message \(bot.name)"
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !uploads.isEmpty
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !uploads.isEmpty { pendingUploads }
            if let note = problem ?? dictation.failure {
                Text(note).font(.footnote).foregroundStyle(AvatarColor.amber.color).padding(.horizontal, 8)
            }
            HStack(alignment: .bottom, spacing: 10) {
                attachMenu
                HStack(alignment: .bottom, spacing: 6) {
                    PromptTextView(text: $text, placeholder: placeholder, maxLines: 6)
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
                dictationBase = text
                Task {
                    await dictation.start { transcript in
                        text = dictationBase.isEmpty ? transcript : dictationBase + " " + transcript
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
        }
        .buttonStyle(.plain)
        .disabled(!canSend)
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

    private func send() {
        let message = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend else { return }
        dictation.stop()
        let send = ClientMessage.send(botId: bot.id, text: message, uploads: uploads, clientId: UUID().uuidString)
        store.sendStarted(send)
        client.send(send)
        text = ""
        uploads = []
        problem = nil
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
