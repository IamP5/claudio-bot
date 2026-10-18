import SwiftUI

enum SplashPhase: Comparable {
    case hidden, enter, blink, glance, exit, fade, done

    var scale: CGFloat {
        switch self {
        case .hidden: 0.4
        case .enter, .blink, .glance: 1
        case .exit, .fade, .done: 14
        }
    }

    var characterOpacity: Double { self == .hidden || self >= .fade ? 0 : 1 }
    var backgroundOpacity: Double { self >= .exit ? 0 : 1 }
    var lid: Double { self == .blink ? 0.12 : 1 }
    var look: CGSize { self >= .glance ? CGSize(width: 0.06, height: 0.02) : .zero }
}

/// The mark greeting a cold launch, drawn over the app while it connects underneath.
struct SplashView: View {
    @State private var phase = SplashPhase.hidden
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Step {
        let phase: SplashPhase
        /// Seconds from the first frame.
        let at: Double
        let animation: Animation?
    }

    private var timeline: [Step] {
        reduceMotion
            ? [
                Step(phase: .enter, at: 0, animation: .easeOut(duration: 0.2)),
                Step(phase: .fade, at: 0.5, animation: .easeInOut(duration: 0.3)),
                Step(phase: .done, at: 0.8, animation: nil),
            ]
            : [
                Step(phase: .enter, at: 0, animation: .spring(duration: 0.45, bounce: 0.4)),
                Step(phase: .blink, at: 0.5, animation: .easeInOut(duration: 0.09)),
                Step(phase: .glance, at: 0.6, animation: .easeOut(duration: 0.15)),
                Step(phase: .exit, at: 0.95, animation: .easeIn(duration: 0.35)),
                Step(phase: .fade, at: 1.0, animation: .easeOut(duration: 0.2)),
                Step(phase: .done, at: 1.3, animation: nil),
            ]
    }

    var body: some View {
        ZStack {
            if phase != .done {
                Brand.launch.opacity(phase.backgroundOpacity).ignoresSafeArea()
                BrandCharacter(lid: phase.lid, look: phase.look)
                    .frame(width: 160, height: 160)
                    .scaleEffect(reduceMotion ? 1 : phase.scale)
                    .opacity(phase.characterOpacity)
            }
        }
        .allowsHitTesting(phase < .exit)
        .accessibilityHidden(true)
        .task {
            let start = ContinuousClock.now
            for step in timeline {
                try? await Task.sleep(until: start + .seconds(step.at))
                withAnimation(step.animation) { phase = step.phase }
            }
        }
    }
}
