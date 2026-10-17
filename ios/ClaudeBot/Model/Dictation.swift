import AVFoundation
import Observation
import Speech

/// On-device dictation into the composer with the Speech framework.
@Observable
@MainActor
final class Dictation {
    private(set) var isRecording = false
    private(set) var failure: String?

    @ObservationIgnored private var engine: AVAudioEngine?
    @ObservationIgnored private var request: SFSpeechAudioBufferRecognitionRequest?
    @ObservationIgnored private var task: SFSpeechRecognitionTask?

    /// Starts listening; `onText` receives the whole transcript so far each time it improves.
    func start(onText: @escaping @MainActor (String) -> Void) async {
        failure = nil
        guard await Self.authorize() else {
            failure = "Allow Microphone and Speech Recognition for ClaudeBot in Settings to dictate."
            return
        }
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            failure = "Dictation is not available right now."
            return
        }
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            let engine = AVAudioEngine()
            let request = SFSpeechAudioBufferRecognitionRequest()
            request.shouldReportPartialResults = true
            Self.feed(engine.inputNode, into: request)
            engine.prepare()
            try engine.start()
            self.engine = engine
            self.request = request
            task = Self.recognize(request, with: recognizer) { [weak self] text, finished in
                if let text { onText(text) }
                if finished { self?.stop() }
            }
            isRecording = true
        } catch {
            failure = error.localizedDescription
            stop()
        }
    }

    func stop() {
        engine?.stop()
        engine?.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.finish()
        engine = nil
        request = nil
        task = nil
        isRecording = false
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private static func authorize() async -> Bool {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard speech == .authorized else { return false }
        return await AVAudioApplication.requestRecordPermission()
    }

    // The tap and the result handler run on audio and recognition queues, so they are built outside the main actor.
    private nonisolated static func feed(_ input: AVAudioInputNode, into request: SFSpeechAudioBufferRecognitionRequest) {
        let format = input.outputFormat(forBus: 0)
        nonisolated(unsafe) let request = request
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
    }

    private nonisolated static func recognize(
        _ request: SFSpeechAudioBufferRecognitionRequest,
        with recognizer: SFSpeechRecognizer,
        update: @escaping @MainActor (String?, Bool) -> Void
    ) -> SFSpeechRecognitionTask {
        recognizer.recognitionTask(with: request) { result, error in
            let text = result?.bestTranscription.formattedString
            let finished = error != nil || (result?.isFinal ?? false)
            Task { @MainActor in update(text, finished) }
        }
    }
}
