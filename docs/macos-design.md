# ClaudioBot for Mac: design

This is the design for the native macOS app. It came from a three-way design arena (maximal sharing, Mac-native screens, leanest path) judged against one rubric. The base is the lean candidate. Grafts from the other two are marked.

## What the user gets

- **On the Mac that runs Claude Code.** Open ClaudioBot.app and click **Use this Mac**. The app finds the bridge's LaunchAgent, pairs itself without a code, and opens the same Bots | Sessions app as the iPhone. **Pair iPhone…** (⇧⌘P) shows a QR that carries every address of the bridge. The iPhone scans it. The app can install, start, stop and restart the bridge service, and it opens a project or worktree in your editor, Finder or Terminal.
- **On another Mac.** Click **Another Mac**, then paste a `claudiobot://pair?…` link, or type the bridge's URL and a code from a paired phone's **Pair another device**. Everything except the local-folder actions works.
- **Bots keep running** when the app quits. launchd owns the bridge, and the app is only a client.
- **Phone pushes keep working** while the Mac app is open. The Mac app tells the bridge when nobody is looking at it.

## Decisions

### 1. Code sharing: one module, two targets

`ios/project.yml` gains `ClaudioBotMac` (macOS 26) and `ClaudioBotMacTests`. They compile the same `ios/ClaudioBot/` folders into the same module name, `ClaudioBot`, plus `ios/ClaudioBotMac/` for Mac-only files. There is no package and no `public` churn. A new shared file builds for both platforms by default, so an iOS-only API in a shared file fails the Mac build at once.

Only two files are excluded from the Mac target: `Info.plist` and `Views/PromptTextView.swift`, which has a Mac twin. The Mac tests compile `ClaudioBotTests/` except `PromptTextViewTests.swift`.

Seams, each with one home:

| Seam | Home | Mac behavior |
|---|---|---|
| iPhone-only navigation-bar and keyboard modifiers | `ClaudioBotMac/MacShims.swift`, same names, Mac only | No-op or the Mac equivalent |
| Text engine | `ClaudioBotMac/PromptTextView.swift`, same type name and API | `NSTextView`. Return sends, ⇧↩ or ⌥↩ adds a newline, smart quotes off, image paste |
| Device name and "This iPhone" copy | `App/Platform.swift` `ThisDevice` | "ClaudioBot on <Computer Name>", noun "Mac" |
| Pasteboard, app-active check, images, QR rendering | `App/Platform.swift` (`Clipboard`, `AppActivity`, `PlatformImage`) | `NSPasteboard`, `NSApp.isActive`, ImageIO/CoreImage |
| Camera, VisionKit scanner, keyboard-show scrolling, background task, `AVAudioSession` | `#if os(iOS)` at the site | Dropped. Paste a link instead of scanning; drag and drop or paste images |
| Size class | The Mac root injects `.horizontalSizeClass = .regular` | The iPad layout: list selection, profile beside the chat |
| Keychain | `PairingVault`, `#if os(macOS)` | Data-protection keychain when signed, file keychain otherwise |
| Local folder actions | `LocalOpener?` environment value, read by the shared `LocalPathMenu` | `NSWorkspace` editor, Finder, Terminal. Nil on iOS and for a remote bridge |

Session-origin copy becomes neutral ("Started in ClaudioBot"), since a Mac starts sessions too (graft from the sharing candidate).

### 2. Bridge ownership: adopt the LaunchAgent

The app never spawns a bridge and never ships one in v1. It adopts `com.claudiobot.bridge`, the service `claudiobot install` writes.

- **Installed (this Mac today).** The app reads the plist for the port, `CLAUDIOBOT_HOME` and the checkout. Start, Stop and Restart go through `launchctl` on that one label.
- **Not installed.** **Install the bridge…** runs `bun install --frozen-lockfile && bun run claudiobot install` in the checkout, through the user's login shell so `install` captures their real `PATH`. The default checkout is the repository the app was built from (baked into Info.plist at build time). The user can pick another.
- **Started from a terminal.** `/health` answers but launchd has no job. The app connects and pairs, and hides the service controls.
- **Two bridges.** None can come from the app. The home lock refuses a second bridge.
- **Bundling the compiled bridge with `SMAppService`** is deferred. It needs hardened-runtime JIT entitlements that are untested, and its second label would fight the CLI's over the lock.

`LocalBridge` derives a `ServiceState` from one probe (plist, `launchctl print`, `GET /health`, the control socket file, the log tail) with a pure function:

```
checking ─probe─► notInstalled ─install─► starting
                  stopped ─start─► starting
starting ─health ok─► running(managed, selfPairing)   starting ─15 s─► failed(reason, logTail)
running ─stop─► stopped        running ─restart─► starting        failed ─start/restart─► starting
```

### 3. Same-Mac self-pairing: a control socket that mints a code

The bridge adds `<home>/run/control.sock` (directory 0700, socket 0600), an HTTP server on a unix socket with one route, `POST /pair-code`. It returns `{code, expiresAt, urls}`. The app calls it with `/usr/bin/curl --unix-socket` and redeems the code through the unchanged `BridgeClient.pair` at `ws://127.0.0.1:<port>/ws`. The Mac becomes an ordinary device that any phone can revoke.

- One function makes every pairing offer: `offer() = {...devices.newCode(), urls}`. The socket `pair_code` reply uses it too, so a phone's or the Mac's **Pair another device** QR now carries every address (graft: the loopback filter `PairCode.invite(fallingBackTo:)` drops `127.0.0.1` from a QR).
- Security: no secret at rest, no network listener. Bots can't reach it, because the sandbox allows no unix socket but `SSH_AUTH_SOCK` and the gate refuses tool calls naming the bridge home. The socket only exists while the bridge holds the home lock. Every mint logs `local pair code minted`, without the code.
- The app pairs itself only on a click. After a revoke (close 4001) it returns to the welcome screen and never re-pairs on its own.

### 4. Phone pushes while the Mac app is open (graft from the Mac-native candidate)

The bridge pushes to the phone only while no socket was heard in the last 45 s (`serve.ts` `quietAt`). An always-connected Mac app would silence every phone push. The fix is a client message `presence {attended: Bool}` behind a `presence` hello feature. `SocketData.attended` defaults to true, so the iPhone behaves as today. `quietAt` counts only attended sockets. The Mac app sends `attended = NSApp.isActive` on every change and after every hello.

### 5. Mode model

Two facts, each with one owner:

```swift
enum BridgePlace { case thisMac, otherMac }   // derived from the saved pairing URL (loopback = this Mac); never stored
ServiceState                                  // LocalBridge, derived from one probe
ConnectionState                               // the existing AppStore value
```

Local folder actions exist only when the place is this Mac and the path exists (graft: local actions gated by one value). Settings › Bridge switches between this Mac and another Mac through `BridgeClient.pair`, which replaces the pairing only after the new bridge says hello.

### 6. Mac UI

| Area | v1 |
|---|---|
| Windows | One main window (default 1180×780, minimum 760×520) and a Settings window. Closing the window keeps the app alive for notifications. |
| Sidebar | The shared Bots \| Sessions switch. ⌘1 Bots, ⌘2 Sessions. |
| Detail | Shared ChatView and SessionThreadView with their drill-ins. |
| Profile | The shared profile beside the chat, toggled with ⌥⌘I. |
| Settings (⌘,) | **General** is the shared Settings. **Bridge** is Mac-only: place, service state and controls, switch bridge, preferred editor. |
| Menus | File: New Chat ⌘N, New Session ⌥⌘N, Pair iPhone ⇧⌘P. View: Bots ⌘1, Sessions ⌘2, Profile ⌥⌘I, Plan Usage ⇧⌘U, Refresh ⌘R. Bridge: Start, Stop, Restart, Show Log. |
| Menu bar extra | Minimal `.menu` style (graft from both other candidates): connection line, waiting-on-you count, Pair iPhone, Open ClaudioBot, Quit. |
| Dock badge | Open question and permission cards plus sessions awaiting you. Derived. |
| Notifications | The shared Notifier, skipped for the chat on screen while the app is active. |
| Deep links | `claudiobot://pair`, `bot/<id>`, `session/<id>`. |

Deferred: multi-window (needs a per-window `Viewing` lease in `BridgeClient`), ⌘K palette, find in chat, a diff panel, a terminal, a session in any folder, the bundled bridge, several bridges at once.

## Build order

Each unit ends in a check.

1. Bridge: `control.ts`, `offer()` wiring, `pair_code.urls`, `presence`, fixtures. Check: `bun test`, then a throwaway bridge: the socket is 0600, its code redeems at `POST /pair`, and a quiet unattended socket lets a push through.
2. iOS seams, behavior-neutral. Check: the iOS `xcodebuild test` and the demo screens unchanged.
3. The Mac target compiles. Check: `xcodebuild -scheme ClaudioBotMac build`, then the shared tests on macOS.
4. Remote mode against a throwaway bridge: pair by URL and code, chat, answer a question card, decide a permission card.
5. `LocalBridge` probe and service controls, against a throwaway label.
6. Self-pairing and the phone QR. The iOS simulator pairs from the Mac app's link.
7. Mac chrome: commands, Settings tabs, dock badge, menu bar extra, local folder actions, presence.

## Rejected

- **A local Swift package holding everything.** It gives a compiler wall and `swift test`, but means a `git mv` of the whole iOS app and a model refactor before the Mac runs at all.
- **Mac-only screens sharing only the model.** It looks most native, but every feature would need two UIs (about 6k lines of Mac views).
- **Shipping the compiled bridge with `SMAppService`.** Deferred, as above.
- **A `local.key` file plus a loopback route.** It leaves a secret on disk, and a local forwarder can make remote traffic look like loopback.
- **A control socket that returns a token.** It works, but it is a second way to create a device. Minting a code keeps one path through `POST /pair`.
