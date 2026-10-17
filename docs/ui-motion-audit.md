# UI and motion audit (October 2026)

This audit covers the iPhone app in `ios/ClaudioBot`. It compares the app's motion and feedback against current practice and lists what is missing.

## Sources

"Grok bot features" turned out to mean Grok Bot, xAI's bots app. `docs/grok-bot-reference.md` studies it as ClaudioBot's UX reference. The repo has no Grok API, X/Twitter search, Grok skill or MCP tool, and none was added. Grok Bot served here as a product reference, not a research tool. Its motion cues are:

- the avatar animates while the bot works, next to a "Typing…" row
- an answered question card dims and keeps only the chosen option
- permission is a card in the conversation, not a modal

The general practice comes from web research and well-known guidance:

- Apple HIG on motion and haptics, and SwiftUI's `accessibilityReduceMotion` and `sensoryFeedback` ([Use Your Loaf on reduced motion](https://useyourloaf.com/blog/reducing-motion-of-animations/), [Create with Swift on reduced motion](https://www.createwithswift.com/ensure-visual-accessibility-supporting-reduced-motion-preferences-in-swiftui/), [Use Your Loaf on sensory feedback](https://useyourloaf.com/blog/swiftui-sensory-feedback/), [Swift with Majid on sensory feedback](https://swiftwithmajid.com/2023/10/10/sensory-feedback-in-swiftui/))
- Emil Kowalski-style interaction rules, summarized from secondary sources ([emil-design-eng](https://www.ui-skills.com/skills/emilkowalski/emil-design-eng), [emilkowal-animations](https://skills.sh/mrmps/smry/emilkowal-animations)). UI motion stays under about 300 ms. Ease-out is the default. Springs suit gestures because they keep velocity when interrupted. Pressed controls answer at once.

The practices this audit checks:

1. Every animation has a Reduce Motion fallback. Movement, scaling and parallax are removed, and opacity and color changes stay.
2. Pressed controls answer at once, with a small scale (about 0.96) or a highlight.
3. Haptics fire on taps that commit something, such as send, answer, approve or deny. They use the system styles for their meanings: selection, impact, success and warning. Use them sparingly.
4. State changes animate: a card closing, a button turning enabled, a status appearing. They take 150 to 300 ms and can be interrupted.
5. Chat content enters with a short fade or slide instead of popping in, and the list follows the bottom only while the user is there.
6. Continuous animation (typing, pulsing) is limited to "something is happening" signals and stops under Reduce Motion.

## Gap list, ranked

| # | Practice | Why it matters | Where | Effort | Impact | Status |
|---|---|---|---|---|---|---|
| 1 | Reduce Motion fallback for continuous motion | The typing avatar bobs and sways forever, and the status dot pulses forever. Both are vestibular triggers the user asked the OS to stop | `Views/Avatar.swift:178-205`, `Views/Components.swift:13-19` | S | High | Done (766a434) |
| 2 | Press feedback on custom buttons | Send, Stop, question options and permission choices use `.plain`, which gives almost no sign of a touch | `Views/Composer.swift:114-126`, `Views/ChatView.swift:195`, `Views/ChatItems.swift:131-138`, `Views/ChatItems.swift:266-281` | S | High | Done (766a434, b3c345b, e5b988d) |
| 3 | Haptics on committing taps | The app had no haptics at all. Send, answering a question and approving or denying a tool call are the moments that deserve one | same as #2 | S | High | Done (b3c345b, e5b988d) |
| 4 | Animate a card closing | An answered question or permission card snapped from its full option list to one row, and the layout jumped | `Views/ChatItems.swift:96-155`, `Views/ChatItems.swift:177-245` | S | Medium | Done (e5b988d) |
| 5 | Animate the send button's state | The send button snapped between 45% and 100% opacity as you typed | `Views/Composer.swift:121` | XS | Low | Done (b3c345b) |
| 6 | Message entrance transition | New bubbles, the typing row and status notes pop in. A short fade with a 4–8 pt rise, or a plain fade under Reduce Motion, would read as arrival. The risk is a clash with the scroll-follow logic in `onScrollGeometryChange`, so it needs a check on a simulator | `Views/ChatView.swift:19-55`, `:63-72` | M | High | Done (8d629e9) |
| 7 | The activity line's fade never runs | `.transition` and `.animation` sit inside the `if`, so the line pops in and out. Moving the animation to a wrapper is easy, but an empty wrapper adds a spacing slot in `ExchangeView`'s `LazyVStack(spacing: 8)` | `Views/ActivityLine.swift:16-30` | S | Low | Done (10f936b), wrapped in a `Group`, which takes no stack slot |
| 8 | Jump-to-latest button | After the user scrolls up, nothing signals that new messages arrived below, and no control takes them back down | `Views/ChatView.swift:63-72` | M | Medium | Tried, not shipped. The button showed at the right time, but in the simulator a Maestro tap never reached its action, whether it sat in a ScrollView overlay, a composer overlay or the composer's inset stack (checked with a log line). Needs a hands-on look |
| 9 | Home row changes animate | The unread dot, the attention badge and row reordering when a bot posts all change without animation | `Views/HomeView.swift:46`, `:234`, `:264` | S | Medium | Done (e81db16) |
| 10 | The inspector slide under Reduce Motion | `.transition(.move(edge: .trailing))` should become `.opacity` | `Views/MainView.swift:51-54` | XS | Low | Done (f0dbc73), not seen: needs an iPad simulator |
| 11 | Haptic when a bot starts waiting on you | The orange "waiting" state is the app's most important signal, but it has no haptic when the app is open. Wire it with care so routine output does not buzz the user | `Model/Store.swift` (state change), `Views/ChatView.swift` | S | Medium | Done (f0dbc73). Fires only when a known bot goes from no question to one, so a reconnect snapshot stays quiet. Not felt: the simulator has no haptics |

Effort: XS under 15 minutes, S under an hour, M a few hours.

## What was implemented

- `PressableStyle` (`.pressable`) in `Views/Components.swift` scales to 0.96 on press with an 80 ms ease-out, and springs back in 180 ms. Under Reduce Motion it dims to 70% and does not scale.
- Under Reduce Motion, `AvatarView` keeps the blink but drops the bob and sway, and `StatusDot` does not pulse.
- Send plays a light impact haptic. Answering a question plays a selection haptic. A permission choice plays success when it allows and warning when it denies. These are trigger-based `sensoryFeedback`, so the system haptics setting still applies.
- Question and permission cards animate the answered state with a 250 ms `.snappy` spring. Under Reduce Motion they change at once.
- The send button fades between enabled and disabled in 150 ms.

## Verification

Run on Xcode 26 with the iPhone 17 Pro simulator, on 17 October 2026.

- `xcodebuild -scheme ClaudioBot -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build test`: BUILD SUCCEEDED, and "Test run with 162 tests in 17 suites passed". The XCTest line reads "Executed 0 tests" because the suite uses Swift Testing.
- `scripts/screenshots.sh` ran for home, chat, approval, engineer, agent, profile and settings. Copies are in `ui-motion-screenshots/static-*.png`.
- Motion was checked from screen recordings (`simctl io recordVideo`, frames pulled with ffmpeg) of Maestro flows in demo mode. Reduce Motion was toggled with `defaults write com.apple.Accessibility ReduceMotionEnabled`:
  - `option-press-scale.png`: option A shrinks while held.
  - `question-close-motion.png`: the card collapses over about 150 ms. `question-close-reduce-motion.png`: it switches in one frame.
  - `typing-avatar-motion-vs-reduce.png`: the top row bobs and sways. The bottom row, under Reduce Motion, stays still.
  - `send-typing-activity-reply.png`: a sent message, then "Typing…", then the activity line, then the reply. The list keeps following the bottom.
  - `home-reorder.png`: a bot that starts asking slides to the top with its dot and badge.
- Not seen: the pulsing status dot (the demo has no working agent), the iPad side panel, haptics (the simulator has none), and whether the activity line's `Group` leaves no gap in the agent view.

New demo screens: `-demoScreen live` turns on the activity feature for the release captain chat, and `-demoScreen homelive` makes standup notes ask a question after 6 s.
