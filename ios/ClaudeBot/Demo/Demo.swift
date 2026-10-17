#if DEBUG
import Foundation

/// `-demo` fills the store with sample bots through the reducer, without a bridge.
/// `-demoScreen home|newchat|chat|profile|links|library|file|agent|digest|engineer|factory|pair|settings`
/// opens a screen directly for screenshots.
@MainActor
enum Demo {
    private static let arguments = ProcessInfo.processInfo.arguments
    static let isEnabled = arguments.contains("-demo")
    private static let screen = arguments.firstIndex(of: "-demoScreen").flatMap { at in
        arguments.indices.contains(at + 1) ? arguments[at + 1] : nil
    }

    static func load(into store: AppStore, router: Router) {
        if screen == "pair" { return }
        store.apply(.hello(machine: "MacBook Pro", userName: "Bruno Gabriel", bots: bots))
        for (bot, messages) in conversations {
            store.apply(.conversation(botId: BotID(bot), messages: messages))
        }
        store.apply(.details(botId: BotID("claude"), library: library, links: links, agents: []))
        store.apply(.details(botId: BotID("engineer"), library: [], links: [], agents: agents))
        store.apply(.agent(agents[0], messages: agentMessages))
        store.apply(.file(botId: BotID("claude"), path: "library/comment-prune-plan.md", file: BotFile(mime: "text/markdown", content: plan, data: nil)))

        switch screen {
        case "newchat": router.showingNewChat = true
        case "settings": router.showingSettings = true
        case "chat":
            router.selection = BotID("claude")
            router.showingInspector = true
        case "digest": router.selection = BotID("news")
        case "engineer": router.selection = BotID("engineer")
        case "factory": router.selection = BotID("eggbot")
        case "profile":
            router.selection = BotID("claude")
            router.path = [.profile(BotID("claude"))]
        case "links", "library":
            router.selection = BotID("claude")
            router.path = [.profile(BotID("claude"), tab: screen == "links" ? .links : .library)]
        case "file":
            router.selection = BotID("claude")
            router.path = [.profile(BotID("claude"), tab: .library), .file(BotID("claude"), path: "library/comment-prune-plan.md")]
        case "agent":
            router.selection = BotID("engineer")
            router.path = [.exchange(AgentID("a1"))]
        default: break
        }
    }

    /// A time `days` ago at the given clock time.
    private static func at(_ days: Int, _ hour: Int, _ minute: Int) -> Date {
        let calendar = Calendar.current
        let day = calendar.date(byAdding: .day, value: -days, to: .now) ?? .now
        return calendar.date(bySettingHour: hour, minute: minute, second: 0, of: day) ?? day
    }

    private static func ago(minutes: Double) -> Date { .now - minutes * 60 }

    private static func bot(
        _ id: String, _ name: String, _ shape: AvatarShape, _ color: AvatarColor, last: Date,
        preview: String, unread: Int = 0, question: String? = nil, status: BotStatus = .idle,
        pinned: Bool = false, routines: [Routine] = []
    ) -> Bot {
        Bot(
            id: BotID(id), name: name, title: nil, avatar: Avatar(shape: shape, color: color), pinned: pinned, hidden: false,
            status: status, unread: unread, question: question, preview: preview, lastAt: last,
            createdAt: at(30, 9, 0), routines: routines
        )
    }

    private static func routine(_ id: String, _ name: String, _ schedule: String, _ describe: String, enabled: Bool = true) -> Routine {
        Routine(id: RoutineID(id), name: name, schedule: schedule, describe: describe, prompt: "Run \(name).", enabled: enabled, lastRunAt: nil)
    }

    static let bots: [Bot] = [
        bot("news", "tech news", .pentagon, .teal, last: at(1, 7, 58),
            preview: "Morning, Bruno. Here's what's new since yesterday.", unread: 1,
            routines: [routine("r1", "tech-news-digest", "57 7 * * 1-5", "Weekdays at 7:57 AM")]),
        bot("claude", "Claude Bot", .circle, .white, last: at(2, 15, 9),
            preview: "Want me to merge any of these now?", question: "Want me to merge any of these now?"),
        bot("lead", "Engineering Lead", .drop, .red, last: at(3, 18, 2),
            preview: "Done. Zocão now has premium in Solta o Som until March.",
            routines: [routine("r2", "Engineering chase", "19,49 * * * *", "Every hour at :19 and :49")]),
        bot("engineer", "engineer", .hexagon, .orange, last: ago(minutes: 2),
            preview: "The solta-o-som verification skill is in PR #19.", status: .working,
            routines: [routine("r3", "maintain-verification-skill", "30 8 * * 1-5", "Weekdays at 8:30 AM")]),
        bot("coach", "linkedin coach", .hexagon, .red, last: at(8, 20, 14),
            preview: "A few things to watch for while you write the launch post."),
        bot("eggbot", "dr eggbot", .drop, .red, last: at(9, 23, 40),
            preview: "I made linkedin coach. Its one job is to get your posts ready.",
            routines: [
                routine("r4", "transcript-healthcheck", "44 8 * * *", "Every day at 8:44 AM", enabled: false),
                routine("r5", "routine-healthcheck", "49 8 * * 1", "Mondays at 8:49 AM", enabled: false),
            ]),
    ]

    private static func say(_ id: String, _ date: Date, _ text: String) -> Message {
        .bot(id: MessageID(id), at: date, text: text)
    }

    private static func me(_ id: String, _ date: Date, _ text: String) -> Message {
        .user(id: MessageID(id), at: date, text: text, attachments: [])
    }

    private static let pr = "https://github.com/lamP5/solta-o-som/pull/"

    static let conversations: [(String, [Message])] = [
        ("claude", [
            me("c1", at(3, 21, 2), "Merge the curation stack when it's green, but ask me before anything touches production."),
            say("c2", at(2, 7, 40), "The Solta o som curation PRs (#18 through #27) all finished overnight and are clean. Two things have to be in production before that phase can ship: a `CRON_SECRET` value and the database migration from #20."),
            say("c3", at(2, 7, 40), "Should I add the CRON_SECRET in production and start merging from #18?"),
            .question(id: MessageID("c4"), at: at(2, 7, 41), card: QuestionCard(
                question: "Should I add the CRON_SECRET in production and start merging from #18?",
                options: ["Yes, add it and merge", "Not yet"], answer: .option(1)
            )),
            say("c5", at(2, 8, 50), "Got it. I won't add the secret or merge anything. PRs #18 through #27 stay open until you tell me to go ahead."),
            say("c6", at(2, 15, 8), "The Solta o som PRs are still open, as you asked. The top of the curation stack, [#27](\(pr)27), is in, and [#18](\(pr)18) is clean against main. The verify skill PR, [#19](\(pr)19), can be merged on its own. [#20](\(pr)20) still needs the production migration and `CRON_SECRET` before it lands."),
            say("c7", at(2, 15, 8), "Want me to merge any of these now?"),
            .question(id: MessageID("c8"), at: at(2, 15, 9), card: QuestionCard(
                question: "Want me to merge any of these now?",
                options: ["Merge only #19", "Merge #18 and #19", "Keep holding everything"], answer: nil
            )),
        ]),
        ("news", [
            .note(id: MessageID("n0"), at: at(12, 9, 3), text: "Created routine {0}", refs: [.routine(id: RoutineID("r1"), name: "tech-news-digest")]),
            say("n1", at(1, 7, 58), """
            Morning, Bruno. Here's what's new since yesterday.

            1. **Anthropic shipped Claude Code Review to Team and Enterprise plans.** Admins pick Quick, Standard or Deep review per repo, and eligible orgs get up to $10k in credits by Jan 15. [ClaudeDevs post](https://x.com/ClaudeDevs)
            2. **Meta's new business terms let it scrape sites linked to business accounts.** Starting Oct 30, businesses that keep using Facebook, Instagram or WhatsApp agree to the crawl. [Nieman Lab](https://www.niemanlab.org)
            3. **Goodfire published "Neural Networks Are Already Clean", the top story on Hacker News.** Neurons that seem to do several jobs come from fixable problems, not a basic feature of networks. [The essay](https://goodfire.ai)
            4. **OpenAI and Anthropic are each giving $5M to a new Simons Foundation program for AI in math.** It funds tools that check and build on proofs that AI produces. [OpenAI's post](https://openai.com)
            """),
            say("n2", at(1, 7, 58), "Theo's new video covers version control for agents. Matt Pocock only posted short clips. I couldn't reach Reddit today because it blocked the requests, so this pulls from X, Hacker News and YouTube."),
        ]),
        ("engineer", [
            say("e1", at(5, 22, 10), "I started a cloud agent for the skill. It's running on your default model. Once the skill is merged, I can add a daily upkeep routine."),
            .exchange(id: MessageID("e2"), at: at(5, 22, 26), peer: .agent(id: AgentID("a1"), title: "Set up pstack verification skill for solta-o-som"), sent: 2, received: 2),
            say("e3", at(5, 23, 10), "The solta-o-som verification skill isn't done yet. The agent got its tests passing, but it crashed twice while capturing proof screenshots. I told it to commit, push and open the PR first, and only then retry the screenshots."),
            .exchange(id: MessageID("e4"), at: at(5, 23, 49), peer: .agent(id: AgentID("a1"), title: "Set up pstack verification skill for solta-o-som"), sent: 0, received: 1),
            say("e5", at(5, 23, 49), "The solta-o-som verification skill is in [PR #19](\(pr)19). It's open, I haven't merged it, and the app code is unchanged. It adds the skill, 17 feature recipes, and a control CLI that passes all 27 of its tests."),
            me("e6", ago(minutes: 3), "Nice. Also fix the flaky checkout test, in the cloud this time."),
            .exchange(id: MessageID("e7"), at: ago(minutes: 2), peer: .agent(id: AgentID("a2"), title: "Fix flaky checkout e2e test"), sent: 1, received: 0),
        ]),
        ("eggbot", [
            say("g1", at(13, 23, 33), "Setting things up, then I'll ask what bot you want."),
            .note(id: MessageID("g2"), at: at(13, 23, 33), text: "Created routines {0} and {1}", refs: [
                .routine(id: RoutineID("r4"), name: "transcript-healthcheck"),
                .routine(id: RoutineID("r5"), name: "routine-healthcheck"),
            ]),
            say("g3", at(13, 23, 34), "I design Claude Bots. What's the one job this one should do every time it wakes?"),
            me("g4", at(9, 23, 30), "make a linkedin coach that gets my posts ready"),
            say("g5", at(9, 23, 31), "Reading your last posts now, then I'll build it."),
            .note(id: MessageID("g6"), at: at(9, 23, 38), text: "Created {0}", refs: [
                .bot(id: BotID("coach"), name: "linkedin coach", avatar: Avatar(shape: .hexagon, color: .red)),
            ]),
            .exchange(id: MessageID("g7"), at: at(9, 23, 39), peer: .bot(id: BotID("coach"), name: "linkedin coach", avatar: Avatar(shape: .hexagon, color: .red)), sent: 1, received: 0),
            say("g8", at(9, 23, 40), "I made linkedin coach. Its one job is to get your posts ready: it drafts, trims, and checks each one against what worked before."),
            say("g9", at(9, 23, 40), "If you hate it, long-press it in the list and choose Delete."),
        ]),
        ("lead", [
            me("l1", at(3, 17, 50), "give Zocão premium in Solta o Som"),
            say("l2", at(3, 18, 2), "Done. Zocão now has premium in Solta o Som until March. I set it in the production admin and checked his account page."),
        ]),
        ("coach", [
            say("k1", at(8, 20, 14), "A few things to watch for while you write the launch post: lead with the result, cut the first paragraph, and keep it under 200 words."),
        ]),
    ]

    static let agents: [Agent] = [
        Agent(id: AgentID("a1"), botId: BotID("engineer"), title: "Set up pstack verification skill for solta-o-som", where: .mac,
              projectName: "solta-o-som", status: .waiting, url: nil, createdAt: at(5, 22, 26), updatedAt: at(5, 23, 49)),
        Agent(id: AgentID("a2"), botId: BotID("engineer"), title: "Fix flaky checkout e2e test", where: .cloud,
              projectName: "solta-o-som", status: .inCloud, url: URL(string: "https://claude.ai/code/session_01"),
              createdAt: ago(minutes: 2), updatedAt: ago(minutes: 2)),
    ]

    static let agentMessages: [AgentMessage] = [
        AgentMessage(id: MessageID("am1"), at: at(5, 22, 26), from: .bot, text: "Create a verification skill for solta-o-som with pstack. Work on a branch, verify it against the real app, and open a PR."),
        AgentMessage(id: MessageID("am2"), at: at(5, 23, 0), from: .agent, text: "Tests pass, but the screenshot capture crashed twice at the same step."),
        AgentMessage(id: MessageID("am3"), at: at(5, 23, 2), from: .bot, text: "Commit, push and open the PR first. Then retry the screenshots. If they fail a third time, skip them and list what's missing in the PR."),
        AgentMessage(id: MessageID("am4"), at: at(5, 23, 49), from: .agent, text: "PR #19 is open. The skill, 17 feature recipes and a control CLI. All 27 tests pass. Sign-in and premium flows were not driven because they need a Clerk key."),
    ]

    static let library: [LibraryFile] = [
        LibraryFile(path: "library/comment-prune-plan.md", size: 2048, modifiedAt: at(2, 9, 0)),
        LibraryFile(path: "library/release-checklist.md", size: 1200, modifiedAt: at(20, 9, 0)),
    ]

    static let links: [BotLink] = [20, 19, 18, 27].map { number in
        BotLink(url: URL(string: "\(pr)\(number)")!, host: "github.com", at: at(2, 15, 8))
    } + [BotLink(url: URL(string: "https://claude.ai/code/session_01")!, host: "claude.ai", at: at(4, 10, 0))]

    static let plan = """
    # Comment prune plan

    Remove comments that narrate the code. Keep the ones that explain a decision.

    1. Run the comment audit on `src/`.
    2. Delete every comment that restates the line below it.
    3. Open one PR per package.
    """
}
#endif
