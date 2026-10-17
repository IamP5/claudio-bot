#if DEBUG
import Foundation

/// `-demo` fills the store with sample data through the reducer, without a bridge.
/// `-demoScreen home|new|task|cloud|pair|settings` opens a screen directly for screenshots.
@MainActor
enum Demo {
    private static let arguments = ProcessInfo.processInfo.arguments
    static let isEnabled = arguments.contains("-demo")
    private static let screen = arguments.firstIndex(of: "-demoScreen").flatMap { at in
        arguments.indices.contains(at + 1) ? arguments[at + 1] : nil
    }

    static func load(into store: AppStore, router: Router) {
        if screen == "pair" { return }
        store.apply(.hello(machine: "MacBook Pro", projects: projects, tasks: tasks))
        for (id, items) in transcripts {
            store.apply(.transcript(taskId: id, items: items))
        }
        switch screen {
        case "new": router.showingNewTask = true
        case "task": router.path = [TaskID("t1")]
        case "cloud": router.path = [TaskID("t2")]
        case "settings": router.showingSettings = true
        default: break
        }
    }

    private static func ago(_ minutes: Double) -> Date { .now - minutes * 60 }

    static let projects = [
        Project(id: ProjectID("p1"), name: "drawdown", path: "/Users/me/drawdown", branch: "main", githubRepo: "me/drawdown"),
        Project(id: ProjectID("p2"), name: "api-server", path: "/Users/me/api-server", branch: "dev", githubRepo: "me/api-server"),
        Project(id: ProjectID("p3"), name: "scratch", path: "/Users/me/scratch", branch: nil, githubRepo: nil),
    ]

    static let tasks: [TaskSummary] = [
        task("t1", "Fix the login redirect loop", .local(ProjectID("p1")), "drawdown", .needsInput, 2,
             "I need to edit src/auth.ts to clear the stale session cookie."),
        task("t2", "Add dark mode to settings", .cloud(ProjectID("p1")), "drawdown", .running, 6,
             "Cloud session started. Follow along in the Claude app.",
             cloudUrl: URL(string: "https://claude.ai/code/session_01")),
        task("t3", "Bump Bun and fix type errors", .local(ProjectID("p2")), "api-server", .running, 1,
             "Running bun test after updating 14 imports."),
        task("t4", "Write a README for the CLI", .local(ProjectID("p3")), "scratch", .idle, 64,
             "Added install, usage and examples sections."),
        task("t5", "Migrate users to UUID keys", .local(ProjectID("p2")), "api-server", .failed, 190,
             "Migration failed: users.id is referenced by orders.user_id."),
        task("t6", "Investigate flaky checkout e2e test", .cloud(ProjectID("p2")), "api-server", .idle, 1500,
             "The test races the payment mock. Opened a PR with a wait.",
             cloudUrl: URL(string: "https://claude.ai/code/session_02")),
    ]

    private static func task(
        _ id: String, _ title: String, _ target: Target, _ project: String, _ status: TaskStatus,
        _ minutesAgo: Double, _ preview: String, cloudUrl: URL? = nil
    ) -> TaskSummary {
        TaskSummary(
            id: TaskID(id), title: title, target: target, projectName: project, model: "opus",
            permissionMode: .default, status: status, createdAt: ago(minutesAgo + 3), updatedAt: ago(minutesAgo),
            preview: preview, costUsd: 0.0123, cloudUrl: cloudUrl
        )
    }

    private static func text(_ id: String, _ s: String) -> TextItem {
        TextItem(id: ItemID(id), text: s, at: ago(3))
    }

    static let transcripts: [(TaskID, [Item])] = [
        (TaskID("t1"), [
            .user(text("i1", "Users get bounced back to /login after signing in. Fix the redirect loop.")),
            .assistant(text("i2", "I'll start by reading the auth middleware and the session helpers.")),
            .tool(ToolItem(id: ItemID("i3"), name: "Grep", summary: "redirect.*login in src/", state: .ok,
                           output: "src/auth.ts:42:  return redirect('/login')\nsrc/middleware.ts:18:  if (!session) redirect('/login')", at: ago(3))),
            .tool(ToolItem(id: ItemID("i4"), name: "Read", summary: "src/auth.ts", state: .ok,
                           output: "export async function login(req: Request) {\n  const session = await getSession(req)\n  ...\n}", at: ago(3))),
            .assistant(text("i5", """
            Found it. `getSession` reads the **old** cookie name, so a fresh login still looks signed out:

            ```ts
            const token = cookies.get("sid") // renamed to "session" in v2
            ```

            I'll clear the stale cookie and read the new name.
            """)),
            .tool(ToolItem(id: ItemID("i6"), name: "Bash", summary: "bun test auth", state: .running, output: nil, at: ago(2))),
            .approval(ApprovalItem(id: ItemID("i7"), tool: "Edit", summary: "src/auth.ts",
                                   detail: """
                                   @@ -12,3 +12,4 @@
                                   -  const token = cookies.get("sid")
                                   +  cookies.delete("sid")
                                   +  const token = cookies.get("session")
                                      if (!token) return null
                                   """,
                                   state: .pending, at: ago(2))),
            .question(QuestionItem(id: ItemID("i8"), questions: [
                Question(question: "Should old sessions be migrated or signed out?", header: "Sessions", multiSelect: false, options: [
                    QuestionOption(label: "Migrate", description: "Copy sid into the new cookie once"),
                    QuestionOption(label: "Sign out", description: "Users log in again"),
                ]),
            ], answers: nil, at: ago(2))),
        ]),
        (TaskID("t2"), [
            .user(text("c1", "Add a dark mode toggle to the settings screen and respect the system setting by default.")),
            .notice(NoticeItem(id: ItemID("c2"), text: "Cloud session created on me/drawdown. Output streams in the Claude app.",
                               url: URL(string: "https://claude.ai/code/session_01"), at: ago(6))),
        ]),
        (TaskID("t4"), [
            .user(text("r1", "Write a README for the CLI.")),
            .assistant(text("r2", "Added install, usage and examples sections.")),
            .result(ResultItem(id: ItemID("r3"), ok: true, text: "Done", costUsd: 0.0123, durationMs: 4200, at: ago(64))),
        ]),
    ]
}
#endif
