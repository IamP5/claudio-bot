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
| 8 | Jump-to-latest button | After the user scrolls up, nothing signals that new messages arrived below, and no control takes them back down | `Views/ChatView.swift:63-72` | M | Medium | Done (1f57e0a). The earlier taps were lost because `.glass(in:)` is `glassEffect` on iOS 26, which isn't hit-testable, so the tap fell through to the list. `.contentShape(Circle())` fixes it. Checked in the simulator by tapping by accessibility id, with Reduce Motion on and off |
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

## Grok Bot parity pass (18 October 2026)

This pass compares the app against the Grok Bot screenshots in `reference/grok/`. Four read-only auditors each took one surface: Home, the chat timeline, the composer and keyboard, and the profile and other screens. The user reported five gaps up front and two more mid-pass.

### Shipped

| Gap | Change | Where |
|---|---|---|
| Avatars on Home never move | `AvatarMotion` (`still`, `idle`, `working`) replaces the `animated` flag. Idle blinks and glances on a 3.8 to 6.6 s cycle, with the cycle and direction seeded per bot so a list doesn't move in step. Working bobs, sways, blinks and looks around. Under Reduce Motion only the blink stays | `Views/Avatar.swift`, every avatar call site |
| Stop sat inside the chat | The send button turns into Stop while the bot works and the field is empty. Typing turns it back into Send, which queues the message. A medium haptic plays on Stop. `StopButton` and `TypingRow.onStop` are gone | `Views/Composer.swift`, `Views/ChatView.swift` |
| The typing row popped in and out | It scales up from its bottom-leading corner on entrance and shrinks back into it on close-out. "Typing…" has a sweeping shimmer. Under Reduce Motion both are a plain fade | `Views/ChatView.swift`, `Shimmer` in `Views/Components.swift` |
| Opening the keyboard while scrolled up hid the newest messages | `keyboardWillShow` takes the list to the bottom, and the follow logic then rides it up with the keyboard. Moving a scrolled-up list by the keyboard's height was tried three ways (`defaultScrollAnchor(.bottom, for: .sizeChanges)`, `scrollTo(y:)` on an inset or size change, deferred `scrollTo(y:)`). None worked mid-transition. `onScrollTargetVisibilityChange` put the chat into a layout loop at 100% CPU | `Views/ChatView.swift` |
| A tap outside the field left the keyboard up | A simultaneous tap on the list resigns the first responder, so links and options still take the tap | `Views/ChatView.swift` |
| Scrolling with the keyboard up kept it up | `scrollDismissesKeyboard(.immediately)` | `Views/ChatView.swift` |
| No fade under the composer | On iOS 26 the composer is a `safeAreaBar`, so the content under it gets the same scroll-edge blur as under the navigation bar. iOS 18 keeps `safeAreaInset` | `composerBar` in `Views/Components.swift` |
| The composer showed a faded Send next to the mic while empty | An empty field shows only the mic. Typing swaps it for a Send capsule (46 by 36 pt, in the bot's color) with a 250 ms spring scale and fade, and clearing the field swaps back. Stop takes the slot while the bot works and the field is empty. Dictation keeps the mic up while words arrive. Under Reduce Motion the swap is a fade | `Views/Composer.swift` |
| Send sat 2.7 pt from the field's top and 4.7 pt from its bottom | The field's geometry comes from `Composer.control` (36 pt) and `Composer.inset` (4 pt). Controls keep the same inset on every side, a one-line field is 44 pt (the HIG minimum touch target), the corner radius is concentric (18 + 4), and + matches the field's height. A taller field pins the controls to its bottom. Measured afterward at 3.7 pt on the top, bottom and trailing sides alike, out to the inner hairline. The mic is centered to within 0.5 px | `Views/Composer.swift` |
| Glass buttons gave no touch response | `.glass(in:interactive:)` uses `.regular.interactive()` for the jump-to-latest and attach buttons | `Views/Components.swift` |
| The account initials were a flat circle | On iOS 26 the toolbar glass draws it, the same as search and + | `Views/HomeView.swift` |
| Question cards ran wider than bubbles, and their option rows were tall with bright letters | The trailing inset is 36, the same as bubbles. Option rows use 10 pt vertical padding. Letter badges are 22 pt, white at 8% with tertiary ink | `Views/ChatItems.swift`, `LetterBadge` |
| Home row rhythm | 16 pt vertical padding, 4 pt between name and preview, an 8 pt unread dot. The name keeps priority over the status chip | `Views/HomeView.swift` |
| Avatar picker and profile tabs snapped | The header avatar scales in on a change, the picker rings animate, and both play a selection haptic. The tab underline slides with `matchedGeometryEffect` | `Views/ProfileView.swift` |

The demo bridge now answers Stop by setting the bot idle, so Stop can be exercised in demo mode.

### Considered and left

- Links stay underlined. The second Grok screenshot underlines "Meta's announcement". Its PR references carry a site icon instead, which needs per-host glyphs.
- The placeholder stays "Message <bot>". The Portuguese "Perguntar a" in the screenshot is a localization, and the product study records the English one.
- Grok has no status chips on Home rows. Ours carry Awaiting approval and Parked, which the product needs.
- Grok has a voice-mode button. ClaudioBot has no voice mode yet.
- The `@` menu sits inside the composer's inset, so opening it lifts the list. Drawing it as an overlay would stop that.
- Grok on iPhone doesn't repeat the question as a bubble above its card, but the Mac app does.

### Verification

- `xcodebuild … test` on the iPhone 17 Pro simulator (iOS 26.2): "Test run with 196 tests in 24 suites passed".
- `grok-home-avatars-working-vs-idle.png` comes from an 8 s recording of Home. The working engineer (top row) sways and blinks, and the idle Claudio Bot (bottom row) glances. The idle rows change in bursts, while the working row changes in every frame.
- `grok-stop-closeout.png` holds 16 frames at 20 fps around a Stop tap. The typing avatar shrinks into its corner and fades, and Stop turns back into a dimmed Send arrow.
- `grok-keyboard-open-from-scrolled-up.png`: scrolled up on the left, keyboard open on the right, with the newest message and the question card above the keyboard.
- `grok-mic-to-send.png` holds 12 frames at 30 fps after typing one letter. The mic shrinks and fades, and Send springs in over about 170 ms.
- `grok-scroll-dismisses-keyboard.png`: a drag with the keyboard up closes it.
- iOS 18.5 (iPhone 16e): Home and a working chat render with the fallbacks, meaning the flat initials circle, `safeAreaInset` for the composer, and Stop in the composer.
- Not checked: haptics (the simulator has none), and the idle avatars under Reduce Motion.
