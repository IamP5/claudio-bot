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

/// Shrinks a touch while pressed, the way system controls answer a finger. Reduce Motion dims instead of scaling, and
/// so does a Mac, whose buttons darken under a click rather than shrink.
struct PressableStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var dims: Bool {
        #if os(macOS)
        true
        #else
        reduceMotion
        #endif
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !dims ? 0.96 : 1)
            .opacity(configuration.isPressed && dims ? 0.7 : 1)
            .animation(.easeOut(duration: configuration.isPressed ? 0.08 : 0.18), value: configuration.isPressed)
    }
}

/// A highlight that sweeps across text while a bot works. Reduce Motion leaves the text as it is.
struct Shimmer: ViewModifier {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content.overlay {
                TimelineView(.animation(minimumInterval: 1 / 30)) { context in
                    let sweep = -0.3 + 1.6 * context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8) / 1.8
                    LinearGradient(
                        stops: [
                            .init(color: .clear, location: sweep - 0.25),
                            .init(color: .white.opacity(0.85), location: sweep),
                            .init(color: .clear, location: sweep + 0.25),
                        ],
                        startPoint: .leading, endPoint: .trailing
                    )
                }
                .mask { content }
                .allowsHitTesting(false)
            }
        }
    }
}

extension View {
    func shimmering() -> some View { modifier(Shimmer()) }
}

extension View {
    /// Pins the composer under a scroll view. On iOS 26 it is a safe area bar, so the content scrolling beneath it
    /// fades and blurs the way it does under the navigation bar.
    @ViewBuilder
    func composerBar(@ViewBuilder _ content: () -> some View) -> some View {
        if #available(iOS 26.0, *) {
            safeAreaBar(edge: .bottom, content: content)
        } else {
            safeAreaInset(edge: .bottom, content: content)
        }
    }
}

extension View {
    @ViewBuilder
    func topBar(@ViewBuilder _ content: () -> some View) -> some View {
        if #available(iOS 26.0, *) {
            safeAreaBar(edge: .top, content: content)
        } else {
            safeAreaInset(edge: .top, content: content)
        }
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
    /// The floating glass look of the reference controls, with a plain fill before iOS 26. `interactive` glass answers
    /// a touch with the system's press shimmer. Use it on glass that is a button.
    @ViewBuilder
    func glass<S: Shape>(in shape: S, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, *) {
            glassEffect(interactive ? .regular.interactive() : .regular, in: shape)
        } else {
            background(Theme.raised.opacity(0.92), in: shape)
        }
    }

    /// Sibling glass shapes sample one shared layer, so they read as one surface and blend where they meet.
    @ViewBuilder
    func glassGroup(spacing: CGFloat? = nil) -> some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) { self }
        } else {
            self
        }
    }
}

/// The lettered square in front of a question option.
struct LetterBadge: View {
    let index: Int
    var fill: Color = .white.opacity(0.08)
    var ink: Color = Theme.tertiary

    #if os(macOS)
    private static let side: CGFloat = 24
    private static let radius: CGFloat = 6
    #else
    private static let side: CGFloat = 22
    private static let radius: CGFloat = 5
    #endif

    var body: some View {
        Text(String(UnicodeScalar(UInt8(65 + index % 26))))
            .font(.ui(size: 12, weight: .medium))
            .foregroundStyle(ink)
            .frame(width: Self.side, height: Self.side)
            .background(fill, in: RoundedRectangle(cornerRadius: Self.radius, style: .continuous))
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

/// On the Mac, opens a chat or session in a window of its own. Elsewhere it shows nothing.
struct OpenInNewWindowButton: View {
    let selection: Selection
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        #if os(macOS)
        Button {
            openWindow(value: selection)
        } label: {
            Label("Open in New Window", systemImage: "macwindow.badge.plus")
        }
        #endif
    }
}
