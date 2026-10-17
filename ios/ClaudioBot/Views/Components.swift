import SwiftUI

struct StatusDot: View {
    let color: Color
    var pulsing = false
    @State private var expanded = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .background {
                if pulsing && !reduceMotion {
                    Circle()
                        .fill(color.opacity(0.5))
                        .scaleEffect(expanded ? 2.4 : 1)
                        .opacity(expanded ? 0 : 1)
                        .animation(.easeOut(duration: 1.2).repeatForever(autoreverses: false), value: expanded)
                        .onAppear { expanded = true }
                }
            }
    }
}

/// Shrinks a touch while pressed, the way system controls answer a finger. Reduce Motion dims instead of scaling.
struct PressableStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.96 : 1)
            .opacity(configuration.isPressed && reduceMotion ? 0.7 : 1)
            .animation(.easeOut(duration: configuration.isPressed ? 0.08 : 0.18), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == PressableStyle {
    static var pressable: PressableStyle { PressableStyle() }
}

struct ConnectionBadge: View {
    let state: ConnectionState

    var body: some View {
        HStack(spacing: 6) {
            switch state {
            case .connected(let machine):
                StatusDot(color: .green)
                Text(machine)
            case .connecting:
                ProgressView().controlSize(.mini)
                Text("Connecting")
            case .disconnected(let retryAt):
                StatusDot(color: .orange)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    let seconds = Int(max(0, retryAt.timeIntervalSince(context.date)).rounded(.up))
                    Text(seconds > 0 ? "Retrying in \(seconds)s" : "Reconnecting")
                        .monospacedDigit()
                }
            case .unpaired:
                StatusDot(color: .gray)
                Text("Not paired")
            case .unrecognized:
                StatusDot(color: .red)
                Text("Not recognized")
            }
        }
        .font(.footnote.weight(.medium))
        .foregroundStyle(.primary)
        .lineLimit(1)
    }
}

extension ConnectionState {
    var summary: String {
        switch self {
        case .unpaired: "Not paired"
        case .connecting: "Connecting"
        case .connected: "Connected"
        case .disconnected: "Reconnecting"
        case .unrecognized: "Not recognized"
        }
    }
}

/// The latest error, shown over whatever is on screen until it times out or is tapped away.
struct ErrorToast: View {
    @Environment(AppStore.self) private var store

    var body: some View {
        if let notice = store.lastError {
            Label(notice.message, systemImage: "exclamationmark.triangle.fill")
                .font(.footnote.weight(.medium))
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(Theme.raised, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .onTapGesture { store.dismissError(notice) }
                .task(id: notice.id) {
                    try? await Task.sleep(for: .seconds(5))
                    store.dismissError(notice)
                }
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Dismisses the error")
        }
    }
}

extension View {
    /// The floating glass look of the reference controls, with a plain fill before iOS 26.
    @ViewBuilder
    func glass<S: Shape>(in shape: S) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(.regular, in: shape)
        } else {
            background(Theme.raised.opacity(0.92), in: shape)
        }
    }
}

/// The lettered square in front of a question option.
struct LetterBadge: View {
    let index: Int
    var fill: Color = Theme.letter
    var ink: Color = Theme.secondary

    var body: some View {
        Text(String(UnicodeScalar(UInt8(65 + index % 26))))
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(ink)
            .frame(width: 24, height: 24)
            .background(fill, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

struct AgentStatusPill: View {
    let status: AgentStatus

    private var color: Color {
        switch status {
        case .working: AvatarColor.orange.color
        case .waiting: AvatarColor.amber.color
        case .failed: AvatarColor.red.color
        case .inCloud: AvatarColor.blue.color
        case .awaitingApproval: Theme.attention
        case .unavailable: AvatarColor.red.color
        case .parked, .capped, .unknown: Theme.secondary
        }
    }

    var body: some View {
        StatusPill(text: status.title, color: color, pulsing: status == .working)
    }
}

/// "Awaiting approval", "Parked" or "Unavailable" beside a bot's name.
struct BotStatusChip: View {
    let status: BotStatus

    var body: some View {
        if let text = status.chip {
            StatusPill(text: text, color: status == .awaitingApproval ? Theme.attention : status == .unavailable ? AvatarColor.red.color : Theme.secondary)
        }
    }
}

struct StatusPill: View {
    let text: String
    let color: Color
    var pulsing = false

    var body: some View {
        HStack(spacing: 5) {
            StatusDot(color: color, pulsing: pulsing)
            Text(text)
        }
        .font(.caption.weight(.semibold))
        .lineLimit(1)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .foregroundStyle(color)
        .background(color.opacity(0.16), in: Capsule())
    }
}
