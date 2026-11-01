// Scenarios for the bot areas: Chat with bots (C), Home and navigation (H), Pairing and first run (P), Settings (T).
// They drive the bot protocol through `raw` frames and read what came back from ev.inbox; sessions.ts-style helpers
// live in scenarios.ts and are not shared, since these read bot frames rather than session threads.
import type { Frame } from "./control-claudio";
import type { Action, Ev, Precondition, RubricItem, Scenario, Tell, Verdict } from "./scenarios";

type Bot = { id: string; name: string; status: string; unread: number; question: string | null; preview: string; lastAt: string };
type Msg = { kind: string; id: string; at: string; text?: string; question?: string; options?: string[]; answer?: unknown; expiresAt?: string | null; clientId?: string };
type Fact = { id: string; text: string; confirmed: boolean; proposerBotId: string | null; by: string | null };

const ok = (why: string): Verdict => ({ ok: true, why });
const no = (why: string): Verdict => ({ ok: false, why });
const notJudged = (why: string): Verdict => ({ ok: false, why: `not judged: ${why}` });
const s = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

// ---- reading the inbox

const framesOf = (ev: Ev, type: string, from = 0) => ev.inbox.filter((x) => x.frame.type === type && x.at >= from);
const idOf = (ev: Ev, ref: string) => framesOf(ev, "created").find((x) => x.frame.ref === ref)?.frame.botId as string | undefined;
/** Every state of the bot the phone saw, from each hello's list and each bot frame. */
function botStates(ev: Ev, ref: string) {
  const id = idOf(ev, ref);
  if (!id) return [];
  return ev.inbox.flatMap((x) => {
    if (x.frame.type === "bot" && (x.frame.bot as Bot).id === id) return [{ at: x.at, bot: x.frame.bot as Bot }];
    if (x.frame.type === "hello") return ((x.frame.bots as Bot[]) ?? []).filter((b) => b.id === id).map((bot) => ({ at: x.at, bot }));
    return [];
  });
}
const botAt = (ev: Ev, ref: string, at: number) => botStates(ev, ref).filter((x) => x.at <= at).at(-1)?.bot;
/** Each message frame for the bot (a message changes in place, so one id can come several times). */
function messages(ev: Ev, ref: string, from = 0) {
  const id = idOf(ev, ref);
  return framesOf(ev, "message", from).filter((x) => x.frame.botId === id).map((x) => ({ at: x.at, m: x.frame.message as Msg }));
}
const replies = (ev: Ev, ref: string, from: number) => messages(ev, ref, from).filter((x) => x.m.kind === "bot");
const cards = (ev: Ev, ref: string, from = 0) => messages(ev, ref, from).filter((x) => x.m.kind === "question");
const latestFacts = (ev: Ev, from = 0) => (framesOf(ev, "memory", from).at(-1)?.frame.facts as Fact[] | undefined) ?? null;
const devicesAfter = (ev: Ev, from: number) => framesOf(ev, "devices", from).at(-1)?.frame.devices as { id: string; name: string }[] | undefined;
const offers = (ev: Ev, from = 0) => framesOf(ev, "pair_code", from).map((x) => ({ at: x.at, code: String(x.frame.code), expiresAt: String(x.frame.expiresAt), urls: (x.frame.urls as string[]) ?? [] }));
const mark = (ev: Ev, m: string) => ev.marks[m];
const need = (ev: Ev, ...ms: string[]) => {
  const missing = ms.filter((m) => mark(ev, m) === undefined);
  return missing.length ? notJudged(`mark ${missing.join(", ")} never reached`) : null;
};
const resting = (b: Bot | undefined) => !!b && b.status !== "working";

// ---- setup builders

/** The user taps New chat: create_bot, then the bot's onboarding turn runs to its end. */
const newBot = (ref: string): Action[] => [
  { do: "raw", mark: `${ref}-create`, what: `create_bot with ref \`${ref}\``, frame: () => ({ type: "create_bot", ref }) },
  { do: "until", mark: `${ref}-created`, what: `the created reply for \`${ref}\``, timeoutS: 15, test: (ev) => idOf(ev, ref) !== undefined },
  {
    do: "until",
    mark: `${ref}-ready`,
    what: `\`${ref}\`'s first turn to end`,
    timeoutS: 180,
    test: (ev) => (replies(ev, ref, 0).length > 0 || cards(ev, ref).length > 0) && resting(botStates(ev, ref).at(-1)?.bot),
  },
];
const say = (ref: string, text: string, m: string): Action => ({
  do: "raw",
  mark: m,
  what: `send in \`${ref}\`: "${text}"`,
  frame: (ev) => ({ type: "send", botId: idOf(ev, ref), text, uploads: [], clientId: `${m}-${ev.now()}` }),
});
/** Waits for a reply after `from` and the bot at rest after it. */
const answered = (ref: string, from: string, m: string, timeoutS = 150): Action => ({
  do: "until",
  mark: m,
  what: `\`${ref}\`'s reply and the bot at rest`,
  timeoutS,
  test: (ev) => {
    const r = replies(ev, ref, mark(ev, from) ?? Infinity).at(-1);
    return !!r && resting(botStates(ev, ref).at(-1)?.bot) && botStates(ev, ref).at(-1)!.at >= r.at;
  },
});
const cardOpen = (ref: string, from: string, m: string): Action => ({
  do: "until",
  mark: m,
  what: `a question card from \`${ref}\``,
  timeoutS: 150,
  test: (ev) => cards(ev, ref, mark(ev, from) ?? Infinity).some((x) => x.m.answer === null),
});
const answerCard = (ref: string, from: string, m: string): Action => ({
  do: "raw",
  mark: m,
  what: `answer \`${ref}\`'s open question with its first option`,
  frame: (ev) => ({ type: "answer", botId: idOf(ev, ref), messageId: cards(ev, ref, mark(ev, from) ?? 0).at(-1)!.m.id, option: 0 }),
});
const created = (ref: string): Precondition => ({ what: `bot ${ref} was created`, check: (ev) => (idOf(ev, ref) ? ok(idOf(ev, ref)!) : no("no created reply")) });
const shot = (id: string, tell: Tell, text: string, pass: string, fail: string, shots: string[]): RubricItem => ({ id, tell, lane: "simulator", text, pass, fail, shots });

// ---- shared rubric items

const comesToRest = (id: string, ref: string, from: string): RubricItem => ({
  id,
  tell: "state",
  lane: "protocol",
  text: "When the reply is in, the bot stops saying it is working.",
  pass: "a bot frame with a status other than working arrives within 5 s of the last reply",
  fail: "the bot stays working (Typing…) after its reply, or never says it is done",
  check: (ev) => {
    const r = replies(ev, ref, mark(ev, from) ?? Infinity).at(-1);
    if (!r) return notJudged("no reply");
    const rest = botStates(ev, ref).find((x) => x.at >= r.at && resting(x.bot));
    return rest && rest.at - r.at <= 5000 ? ok(`${rest.bot.status} ${s(rest.at - r.at)} after the reply`) : no(rest ? `at rest only ${s(rest.at - r.at)} after the reply` : "never at rest after the reply");
  },
});
const noLabelGap = (id: string, from: string, text: string): RubricItem => ({
  id,
  tell: "responsive",
  lane: "simulator",
  text,
  pass: "the label probe reads the app at least every 5 s from the mark to the end of the setup",
  fail: "a gap over 5 s between samples: the app's main thread did not answer (a hang)",
  check: (ev) => {
    const at = mark(ev, from);
    if (at === undefined) return notJudged(`mark ${from} never reached`);
    const times = ev.labels.map((l) => l.at).filter((t) => t >= at - 1000);
    if (times.length < 5) return notJudged(`only ${times.length} label samples after ${from}`);
    const gaps = times.slice(1).map((t, i) => t - times[i]!);
    const worst = Math.max(...gaps);
    return worst <= 5000 ? ok(`${times.length} samples, longest gap ${s(worst)}`) : no(`longest gap between samples ${s(worst)}`);
  },
});

// ---- Chat with bots

const C1: Scenario = {
  id: "C1",
  area: "chat",
  title: "A plain message and its reply",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["The user creates a bot and waits for its greeting.", "They open the chat and send a short message.", "They watch the bot work and read its reply.", "They leave and open the chat again."],
  setup: [
    ...newBot("c1"),
    { do: "open-bot", ref: "c1", mark: "c1-open" },
    say("c1", "Reply with one short sentence that contains the word pong.", "c1-send"),
    { do: "sleep", s: 2 },
    { do: "screenshot", shot: "c1-working" },
    answered("c1", "c1-send", "c1-done"),
    { do: "sleep", s: 2 },
    { do: "screenshot", shot: "c1-done" },
    { do: "open-bot", ref: "c1", mark: "c1-reopen" },
    { do: "sleep", s: 2 },
  ],
  pre: [created("c1"), { what: "the bot replied after the send", check: (ev) => (replies(ev, "c1", mark(ev, "c1-send") ?? Infinity).length ? ok("replied") : no("no reply")) }],
  rubric: [
    {
      id: "C1.1",
      tell: "responsive",
      lane: "protocol",
      text: "The message the user sent shows as sent at once.",
      pass: "the bridge echoes the user message with the send's clientId within 1 s",
      fail: "no echo, or it takes over 1 s, so the bubble hangs unconfirmed",
      check: (ev) => {
        const at = mark(ev, "c1-send");
        const echo = messages(ev, "c1", at ?? Infinity).find((x) => x.m.kind === "user" && x.m.clientId?.startsWith("c1-send"));
        if (at === undefined) return notJudged("no send");
        return echo && echo.at - at <= 1000 ? ok(`echoed in ${s(echo.at - at)}`) : no(echo ? `echoed after ${s(echo.at - at)}` : "never echoed");
      },
    },
    {
      id: "C1.2",
      tell: "state",
      lane: "protocol",
      text: "The bot says it is working soon after the send.",
      pass: "a bot frame with status working within 2 s of the send",
      fail: "no working status, or it comes late, so the chat looks ignored",
      check: (ev) => {
        const at = mark(ev, "c1-send");
        if (at === undefined) return notJudged("no send");
        const w = botStates(ev, "c1").find((x) => x.at >= at && x.bot.status === "working");
        return w && w.at - at <= 2000 ? ok(`working after ${s(w.at - at)}`) : no(w ? `working only after ${s(w.at - at)}` : "never working");
      },
    },
    {
      id: "C1.3",
      tell: "state",
      lane: "protocol",
      text: "The bot never says it is done before its reply is in.",
      pass: "from the first working status to the last reply, every bot frame says working",
      fail: "an idle status between the send and the reply: the typing row vanishes while the bot still writes",
      check: (ev) => {
        const at = mark(ev, "c1-send");
        const last = replies(ev, "c1", at ?? Infinity).at(-1);
        if (at === undefined || !last) return notJudged("no reply");
        const first = botStates(ev, "c1").find((x) => x.at >= at && x.bot.status === "working");
        if (!first) return notJudged("never working");
        const early = botStates(ev, "c1").filter((x) => x.at > first.at && x.at < last.at && resting(x.bot));
        return early.length ? no(`${early[0]!.bot.status} at +${s(early[0]!.at - at)}, reply at +${s(last.at - at)}`) : ok("working until the reply");
      },
    },
    comesToRest("C1.4", "c1", "c1-send"),
    {
      id: "C1.5",
      tell: "recover",
      lane: "protocol",
      text: "Opening the chat again shows the same messages.",
      pass: "the conversation that answers the second open holds the user message and the reply",
      fail: "either is missing from the reopened chat",
      check: (ev) => {
        const at = mark(ev, "c1-reopen");
        if (at === undefined) return notJudged("no reopen");
        const conv = framesOf(ev, "conversation", at).find((x) => x.frame.botId === idOf(ev, "c1"));
        if (!conv) return no("no conversation after the reopen");
        const ms = conv.frame.messages as Msg[];
        const reply = replies(ev, "c1", mark(ev, "c1-send")!).at(-1)!.m.id;
        const mine = ms.some((m) => m.kind === "user" && m.clientId?.startsWith("c1-send"));
        return mine && ms.some((m) => m.id === reply) ? ok(`${ms.length} messages, both present`) : no(`user message ${mine ? "present" : "missing"}, reply ${ms.some((m) => m.id === reply) ? "present" : "missing"}`);
      },
    },
    shot("C1.6", "state", "While the bot works, the chat shows it: the user's bubble, the typing row and a Stop button.", "Typing… under the user's bubble, Stop in place of Send", "no typing row, or Send instead of Stop, or the bubble missing", ["c1-working"]),
    shot("C1.7", "clarity", "After the reply, the chat is at rest and the reply reads whole.", "the reply in full, no typing row, Send back", "a typing row left over, the reply cut, or the composer stuck on Stop", ["c1-done"]),
  ],
};

const C2: Scenario = {
  id: "C2",
  area: "chat",
  title: "The bot asks the user a question",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["The user asks a bot to check with them first.", "A question card shows in the chat.", "They pick an option, and the bot carries on."],
  setup: [
    ...newBot("c2"),
    { do: "open-bot", ref: "c2", mark: "c2-open" },
    say("c2", "Use your ask tool to ask me exactly: Which color do you prefer? with the options Red and Blue. Then end your turn.", "c2-send"),
    cardOpen("c2", "c2-send", "c2-card"),
    { do: "sleep", s: 3 },
    { do: "screenshot", shot: "c2-card" },
    answerCard("c2", "c2-send", "c2-answer"),
    answered("c2", "c2-answer", "c2-done"),
    { do: "sleep", s: 2 },
    { do: "screenshot", shot: "c2-done" },
  ],
  pre: [created("c2"), { what: "a question card opened", check: (ev) => (mark(ev, "c2-card") !== undefined ? ok("card") : no("no card")) }],
  rubric: [
    {
      id: "C2.1",
      tell: "clarity",
      lane: "protocol",
      text: "The card says what is asked, what the choices are and until when.",
      pass: "a question, at least two options and an expiry in the future",
      fail: "an empty question, fewer than two options, or no expiry",
      check: (ev) => {
        const c = cards(ev, "c2", mark(ev, "c2-send") ?? Infinity)[0];
        if (!c) return notJudged("no card");
        const okExp = c.m.expiresAt !== null && c.m.expiresAt !== undefined && Date.parse(c.m.expiresAt) > Date.parse(c.m.at);
        return c.m.question?.trim() && (c.m.options?.length ?? 0) >= 2 && okExp ? ok(`"${c.m.question}" ${JSON.stringify(c.m.options)} until ${c.m.expiresAt}`) : no(JSON.stringify(c.m));
      },
    },
    {
      id: "C2.2",
      tell: "state",
      lane: "protocol",
      text: "While the card is open, the bot says it waits on the user, not that it is working.",
      pass: "within 5 s of the card, the bot's question is set and its status is not working",
      fail: "no question on the bot, or it still says working while it waits",
      check: (ev) => {
        const at = mark(ev, "c2-card");
        if (at === undefined) return notJudged("no card");
        const b = botAt(ev, "c2", at + 5000);
        return b?.question && resting(b) ? ok(`${b.status}, question "${b.question}"`) : no(`status ${b?.status}, question ${JSON.stringify(b?.question)}`);
      },
    },
    {
      id: "C2.3",
      tell: "responsive",
      lane: "protocol",
      text: "The answer takes at once: the card shows the choice and the bot's question clears.",
      pass: "within 2 s of the answer, the card carries it and the bot's question is null",
      fail: "the card stays open, or the bot keeps its question",
      check: (ev) => {
        const at = mark(ev, "c2-answer");
        if (at === undefined) return notJudged("no answer");
        const done = cards(ev, "c2", at).find((x) => x.m.answer !== null);
        const b = botAt(ev, "c2", at + 2000);
        const cardOk = done && done.at - at <= 2000;
        return cardOk && b && b.question === null ? ok(`card answered in ${s(done!.at - at)}; question cleared`) : no(`card ${done ? `answered after ${s(done.at - at)}` : "never answered"}, question ${JSON.stringify(b?.question)}`);
      },
    },
    {
      id: "C2.4",
      tell: "state",
      lane: "protocol",
      text: "The bot picks the answer up and works again.",
      pass: "working within 5 s of the answer",
      fail: "nothing happens after the answer",
      check: (ev) => {
        const at = mark(ev, "c2-answer");
        if (at === undefined) return notJudged("no answer");
        const w = botStates(ev, "c2").find((x) => x.at >= at && x.bot.status === "working");
        return w && w.at - at <= 5000 ? ok(`working after ${s(w.at - at)}`) : no(w ? `working after ${s(w.at - at)}` : "never working");
      },
    },
    shot("C2.5", "clarity", "The open card reads as a question with tappable options and its expiry.", "question, both options as buttons, an expiry line", "options missing, cut, or not buttons", ["c2-card"]),
    shot("C2.6", "state", "The answered card shows what the user chose and no longer offers the options.", "the choice marked, buttons gone or disabled", "the card still looks open", ["c2-done"]),
  ],
};

const C3: Scenario = {
  id: "C3",
  area: "chat",
  title: "Stop a reply that runs long",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["The user asks a bot for something slow.", "They change their mind and tap Stop.", "The chat says it stopped."],
  setup: [
    ...newBot("c3"),
    { do: "open-bot", ref: "c3", mark: "c3-open" },
    say("c3", "Use the Bash tool to run `sleep 60`, then tell me it finished.", "c3-send"),
    { do: "until", mark: "c3-working", what: "c3 working", timeoutS: 30, test: (ev) => botStates(ev, "c3").some((x) => x.at >= (mark(ev, "c3-send") ?? Infinity) && x.bot.status === "working") },
    { do: "sleep", s: 10 },
    { do: "screenshot", shot: "c3-working" },
    { do: "raw", mark: "c3-stop", what: "stop on `c3`", frame: (ev) => ({ type: "stop", botId: idOf(ev, "c3") }) },
    { do: "sleep", s: 8 },
    { do: "screenshot", shot: "c3-stopped" },
  ],
  pre: [
    created("c3"),
    { what: "the bot was working when Stop went", check: (ev) => (mark(ev, "c3-stop") !== undefined && botAt(ev, "c3", mark(ev, "c3-stop")!)?.status !== "idle" ? ok(String(botAt(ev, "c3", mark(ev, "c3-stop")!)?.status)) : no("idle at the stop")) },
  ],
  rubric: [
    {
      id: "C3.1",
      tell: "state",
      lane: "protocol",
      text: "Stop takes: the bot says it is no longer working.",
      pass: "a status other than working within 5 s of Stop",
      fail: "the bot keeps working, or the stop is refused",
      check: (ev) => {
        const at = mark(ev, "c3-stop");
        if (at === undefined) return notJudged("no stop");
        const err = framesOf(ev, "error", at).find((x) => x.at - at < 2000);
        const rest = botStates(ev, "c3").find((x) => x.at >= at && resting(x.bot));
        if (err) return no(`error: ${err.frame.message}`);
        return rest && rest.at - at <= 5000 ? ok(`${rest.bot.status} after ${s(rest.at - at)}`) : no(rest ? `at rest after ${s(rest.at - at)}` : "never at rest");
      },
    },
    {
      id: "C3.2",
      tell: "clarity",
      lane: "protocol",
      text: "The chat says the turn was stopped.",
      pass: "a note within 5 s of Stop that says it stopped",
      fail: "no note: the reply just ends with no reason",
      check: (ev) => {
        const at = mark(ev, "c3-stop");
        if (at === undefined) return notJudged("no stop");
        const note = messages(ev, "c3", at).find((x) => x.m.kind === "note" && /stop/i.test(x.m.text ?? ""));
        return note && note.at - at <= 5000 ? ok(`"${note.m.text}" after ${s(note.at - at)}`) : no(note ? `note after ${s(note.at - at)}` : "no stop note");
      },
    },
    {
      id: "C3.3",
      tell: "state",
      lane: "protocol",
      text: "Nothing claims the work finished after the stop.",
      pass: "no bot reply after Stop",
      fail: "a bot reply after Stop (it said it finished what was stopped)",
      check: (ev) => {
        const at = mark(ev, "c3-stop");
        if (at === undefined) return notJudged("no stop");
        const late = replies(ev, "c3", at + 500);
        return late.length ? no(`"${late[0]!.m.text?.slice(0, 80)}" ${s(late[0]!.at - at)} after Stop`) : ok("no reply after Stop");
      },
    },
    shot("C3.4", "stop", "While the bot works, Stop is offered in the composer.", "a Stop button where Send was, with the typing row", "no way to stop from the chat", ["c3-working"]),
    shot("C3.5", "state", "After Stop, the chat is at rest and says it stopped.", "the stop note, no typing row, Send back", "a typing row or Stop button left, or no note", ["c3-stopped"]),
  ],
};

const C4: Scenario = {
  id: "C4",
  area: "chat",
  title: "A very tall reply at the largest text size",
  needsSimulator: false,
  sidebar: "bots",
  ui: { contentSize: "accessibility-extra-extra-extra-large" },
  journey: ["The user reads with the largest text size.", "They ask a bot for a long list.", "The reply lands and they scroll it."],
  setup: [
    ...newBot("c4"),
    { do: "open-bot", ref: "c4", mark: "c4-open" },
    { do: "watch-labels", phrases: ["Message ", "Typing"] },
    say("c4", "Reply with a numbered list from 1 to 150, one short line per number, and nothing else.", "c4-send"),
    answered("c4", "c4-send", "c4-done", 240),
    { do: "sleep", s: 20 },
    { do: "screenshot", shot: "c4-done" },
  ],
  pre: [created("c4"), { what: "the long reply arrived", check: (ev) => (replies(ev, "c4", mark(ev, "c4-send") ?? Infinity).length ? ok("replied") : no("no reply")) }],
  rubric: [
    comesToRest("C4.1", "c4", "c4-send"),
    noLabelGap("C4.2", "c4-done", "The app keeps answering after a very tall reply lands at the largest text size (backlog: it may hang)."),
    shot("C4.3", "clarity", "The tall reply reads at the largest text size and the composer is reachable.", "the list wraps and reads; the composer shows", "text cut or overlapping, a blank chat, or no composer", ["c4-done"]),
  ],
};

// ---- Home and navigation

const H1: Scenario = {
  id: "H1",
  area: "home",
  title: "Unread and preview on the bot list",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["A new bot greets the user while they are on the list.", "They open it, ask something, and go back to the list.", "The reply lands; later they mark the chat unread to come back to it."],
  setup: [
    ...newBot("h1"),
    { do: "sleep", s: 2 },
    { do: "screenshot", shot: "h1-greeting" },
    { do: "open-bot", ref: "h1", mark: "h1-open" },
    say("h1", "Reply with one short sentence about tea.", "h1-send"),
    { do: "show-list" },
    answered("h1", "h1-send", "h1-done"),
    { do: "sleep", s: 2 },
    { do: "screenshot", shot: "h1-reply" },
    { do: "raw", mark: "h1-mark-unread", what: "mark_unread on `h1`", frame: (ev) => ({ type: "mark_unread", botId: idOf(ev, "h1") }) },
    { do: "sleep", s: 2 },
    { do: "show-list" },
    { do: "screenshot", shot: "h1-marked" },
  ],
  pre: [created("h1"), { what: "the reply arrived", check: (ev) => (mark(ev, "h1-done") !== undefined ? ok("replied") : no("no reply")) }],
  rubric: [
    {
      id: "H1.1",
      tell: "state",
      lane: "protocol",
      text: "A greeting that lands while the user is on the list shows as unread, with the greeting as the preview.",
      pass: "at h1-ready the bot is unread and its preview starts the last bot message",
      fail: "read, or the preview is not the greeting",
      check: (ev) => {
        const at = mark(ev, "h1-ready");
        if (at === undefined) return notJudged("never ready");
        const b = botAt(ev, "h1", at);
        const last = replies(ev, "h1", 0).filter((x) => x.at <= at).at(-1);
        if (!b || !last) return notJudged("no greeting");
        return b.unread > 0 && previewOf(b, last.m.text ?? "") ? ok(`unread ${b.unread}, "${b.preview.slice(0, 60)}"`) : no(`unread ${b.unread}, preview "${b.preview.slice(0, 60)}" vs "${(last.m.text ?? "").slice(0, 60)}"`);
      },
    },
    {
      id: "H1.2",
      tell: "responsive",
      lane: "protocol",
      text: "Opening the chat clears its unread mark.",
      pass: "unread 0 within 1 s of the open",
      fail: "the mark stays",
      check: (ev) => {
        const at = mark(ev, "h1-open");
        if (at === undefined) return notJudged("no open");
        const read = botStates(ev, "h1").find((x) => x.at >= at && x.bot.unread === 0);
        return read && read.at - at <= 1000 ? ok(`read after ${s(read.at - at)}`) : no(read ? `read after ${s(read.at - at)}` : "never read");
      },
    },
    {
      id: "H1.3",
      tell: "state",
      lane: "protocol",
      text: "A reply that lands while the user is on the list marks the chat unread and shows the reply as the preview.",
      pass: "at h1-done unread is over 0, the preview starts the reply, and lastAt is the reply's time or later",
      fail: "read, an old preview, or an old time",
      check: (ev) => {
        const at = mark(ev, "h1-done");
        const r = replies(ev, "h1", mark(ev, "h1-send") ?? Infinity).at(-1);
        if (at === undefined || !r) return notJudged("no reply");
        const b = botAt(ev, "h1", at)!;
        const fresh = Date.parse(b.lastAt) >= Date.parse(r.m.at);
        return b.unread > 0 && previewOf(b, r.m.text ?? "") && fresh ? ok(`unread ${b.unread}, "${b.preview.slice(0, 60)}"`) : no(`unread ${b.unread}, preview "${b.preview.slice(0, 60)}", lastAt ${b.lastAt} vs reply ${r.m.at}`);
      },
    },
    {
      id: "H1.4",
      tell: "responsive",
      lane: "protocol",
      text: "Mark as Unread takes at once.",
      pass: "unread 1 or more within 1 s",
      fail: "nothing changes",
      check: (ev) => {
        const at = mark(ev, "h1-mark-unread");
        if (at === undefined) return notJudged("no mark_unread");
        const u = botStates(ev, "h1").find((x) => x.at >= at && x.bot.unread > 0);
        return u && u.at - at <= 1000 ? ok(`unread after ${s(u.at - at)}`) : no(u ? `unread after ${s(u.at - at)}` : "never unread");
      },
    },
    shot("H1.5", "clarity", "The row tells who wrote, what, and when, and marks it unread.", "name, a preview of the latest reply, a time and an unread dot", "a stale preview, no dot, or a cut name", ["h1-greeting", "h1-reply"]),
    shot("H1.6", "state", "A chat marked unread looks unread on the list.", "the unread dot on the row", "no dot", ["h1-marked"]),
  ],
};
const previewOf = (b: Bot, text: string) => {
  const flat = (t: string) => t.replace(/[*_`#>\-]/g, "").replace(/\s+/g, " ").trim();
  const p = flat(b.preview).slice(0, 30);
  return p.length > 0 && flat(text).startsWith(p.replace(/…$/, ""));
};

const H2: Scenario = {
  id: "H2",
  area: "home",
  title: "The list while a bot works and then waits on the user",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["The user sends a bot a task and stays on the list.", "The row shows what it does.", "The bot asks a question; the row says it waits on them.", "They answer."],
  setup: [
    ...newBot("h2"),
    say("h2", "Run `ls -la` with the Bash tool and `sleep 8`, then use your ask tool to ask me: Ship it today? with the options Yes and No. Then end your turn.", "h2-send"),
    { do: "sleep", s: 4 },
    { do: "screenshot", shot: "h2-working" },
    cardOpen("h2", "h2-send", "h2-card"),
    { do: "sleep", s: 3 },
    { do: "screenshot", shot: "h2-card" },
    answerCard("h2", "h2-send", "h2-answer"),
    answered("h2", "h2-answer", "h2-done"),
  ],
  pre: [created("h2"), { what: "a question card opened", check: (ev) => (mark(ev, "h2-card") !== undefined ? ok("card") : no("no card")) }],
  rubric: [
    {
      id: "H2.1",
      tell: "state",
      lane: "protocol",
      text: "While the bot works, its row says what it is doing.",
      pass: "at least one activity frame with text for the bot between the send and the card",
      fail: "no activity: the row only says Typing…",
      check: (ev) => {
        const [a, b] = [mark(ev, "h2-send"), mark(ev, "h2-card")];
        if (a === undefined || b === undefined) return notJudged("no card");
        const act = framesOf(ev, "activity", a).filter((x) => x.at <= b && x.frame.botId === idOf(ev, "h2") && x.frame.text);
        return act.length ? ok(`${act.length} lines, first "${act[0]!.frame.text}"`) : no("none");
      },
    },
    {
      id: "H2.2",
      tell: "state",
      lane: "protocol",
      text: "When the bot waits on a question, the row says so and shows the question.",
      pass: "within 2 s of the card, the bot's question is set and it is not working",
      fail: "no question on the row, or it still says working",
      check: (ev) => {
        const at = mark(ev, "h2-card");
        if (at === undefined) return notJudged("no card");
        const b = botAt(ev, "h2", at + 2000);
        return b?.question && resting(b) ? ok(`${b.status}, "${b.question}"`) : no(`status ${b?.status}, question ${JSON.stringify(b?.question)}`);
      },
    },
    {
      id: "H2.3",
      tell: "state",
      lane: "protocol",
      text: "When the bot stops working, its activity line goes away.",
      pass: "the last activity for the bot before the card plus 5 s has no text",
      fail: "an activity line stays after the work ended",
      check: (ev) => {
        const [a, b] = [mark(ev, "h2-send"), mark(ev, "h2-card")];
        if (a === undefined || b === undefined) return notJudged("no card");
        const act = framesOf(ev, "activity", a).filter((x) => x.at <= b + 5000 && x.frame.botId === idOf(ev, "h2") && x.frame.agentId === null);
        if (!act.length) return notJudged("no activity at all");
        const lastAct = act.at(-1)!;
        return lastAct.frame.text ? no(`"${lastAct.frame.text}" still on at the card`) : ok("cleared");
      },
    },
    {
      id: "H2.4",
      tell: "responsive",
      lane: "protocol",
      text: "Answering clears the waiting mark on the row.",
      pass: "the bot's question is null within 2 s of the answer",
      fail: "the row still shows the question",
      check: (ev) => {
        const at = mark(ev, "h2-answer");
        if (at === undefined) return notJudged("no answer");
        const c = botStates(ev, "h2").find((x) => x.at >= at && x.bot.question === null);
        return c && c.at - at <= 2000 ? ok(`cleared after ${s(c.at - at)}`) : no(c ? `cleared after ${s(c.at - at)}` : "never cleared");
      },
    },
    shot("H2.5", "state", "The row of a working bot says it works and what it does.", "a working mark and an activity line on the row", "nothing tells the bot is busy", ["h2-working"]),
    shot("H2.6", "state", "The row of a bot that waits on the user stands out and shows the question.", "an attention badge and the question as the preview", "the row looks like any other", ["h2-card"]),
  ],
};

const H3: Scenario = {
  id: "H3",
  area: "home",
  title: "The Mac goes away for half a minute",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["The user has the bot list open.", "The Mac drops off the network for 30 s.", "It comes back."],
  setup: [
    ...newBot("h3"),
    { do: "screenshot", shot: "h3-online" },
    { do: "reconnect", afterS: 30, mark: "h3-back", how: "close", compare: false, shot: { name: "h3-offline", afterS: 20 } },
    { do: "sleep", s: 4 },
    { do: "screenshot", shot: "h3-back" },
  ],
  pre: [created("h3")],
  rubric: [
    {
      id: "H3.1",
      tell: "recover",
      lane: "protocol",
      text: "When the Mac is back, the list is as it was: nothing lost, nothing doubled.",
      pass: "the hello after the drop lists the same bots with the same unread counts",
      fail: "a bot missing, doubled, or with a changed count",
      check: (ev) => {
        const at = mark(ev, "h3-back-dropped") ?? mark(ev, "h3-back");
        if (at === undefined) return notJudged("no drop");
        const hellos = framesOf(ev, "hello");
        const before = hellos.filter((x) => x.at < at).at(-1);
        const after = hellos.find((x) => x.at > at);
        if (!before || !after) return notJudged("no hello on either side");
        const key = (f: Frame) => JSON.stringify(((f.bots as Bot[]) ?? []).map((b) => `${b.id}:${b.unread}`).sort());
        const latest = new Map(((before.frame.bots as Bot[]) ?? []).map((b) => [b.id, b]));
        for (const x of ev.inbox) if (x.at > before.at && x.at < at && x.frame.type === "bot") latest.set((x.frame.bot as Bot).id, x.frame.bot as Bot);
        const want = JSON.stringify([...latest.values()].map((b) => `${b.id}:${b.unread}`).sort());
        return key(after.frame) === want ? ok(`${latest.size} bots, same counts`) : no(`before ${want}, after ${key(after.frame)}`);
      },
    },
    shot("H3.2", "recover", "While the Mac is away, the list says so and offers a way out, and keeps the chats on screen.", "a banner that the Mac is not answering, with Retry, and the list still drawn", "no banner, a blank list, or Connected", ["h3-offline"]),
    shot("H3.3", "state", "When the Mac is back, the banner goes.", "no banner, the list as before", "a banner left over", ["h3-back"]),
  ],
};

// ---- Pairing and first run

const getCode = (m: string): Action[] => [
  { do: "raw", mark: m, what: "pair_code (Settings, Pair another device)", frame: () => ({ type: "pair_code" }) },
  { do: "until", mark: `${m}-in`, what: "the pair_code reply", timeoutS: 10, test: (ev) => offers(ev, mark(ev, m) ?? Infinity).length > 0 },
];
const codeAt = (m: string) => (ev: Ev) => offers(ev, mark(ev, m) ?? Infinity)[0]!.code;
/** The code with its last character changed, as a typo would. */
const typo = (m: string) => (ev: Ev) => {
  const c = codeAt(m)(ev);
  return c.slice(0, -1) + (c.endsWith("A") ? "B" : "A");
};
const listDevices = (m: string): Action[] => [
  { do: "raw", mark: m, what: "devices", frame: () => ({ type: "devices" }) },
  { do: "until", mark: `${m}-in`, what: "the devices reply", timeoutS: 10, test: (ev) => devicesAfter(ev, mark(ev, m) ?? Infinity) !== undefined },
];
const pairOf = (ev: Ev, m: string) => ev.pairs.find((p) => p.mark === m);
const NEXT_STEP = /new (pairing )?code|Settings|on (your|the) Mac/i;

const P1: Scenario = {
  id: "P1",
  area: "pairing",
  title: "Pair a phone with a code",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["The user reads the pairing code on a paired phone or the Mac.", "They type it on a new phone, which pairs and connects.", "Later someone tries the same code again."],
  setup: [
    ...getCode("p1-code"),
    { do: "pair", mark: "p1-paired", name: "UX second phone", what: "the code", code: codeAt("p1-code"), connect: true },
    ...listDevices("p1-devices"),
    { do: "pair", mark: "p1-reuse", name: "UX third phone", what: "the same code again", code: codeAt("p1-code") },
  ],
  pre: [{ what: "the bridge gave a pairing code", check: (ev) => (offers(ev).length ? ok(offers(ev)[0]!.code) : no("no pair_code")) }],
  rubric: [
    {
      id: "P1.1",
      tell: "clarity",
      lane: "protocol",
      text: "The code is short to type and says how long it lasts.",
      pass: "eight characters as XXXX-XXXX, an expiry 9 to 11 minutes out, and at least one address",
      fail: "another shape, no expiry, or no address to reach the Mac",
      check: (ev) => {
        const o = offers(ev)[0];
        if (!o) return notJudged("no code");
        const left = Date.parse(o.expiresAt) - Date.now() + (ev.now() - o.at);
        const okShape = /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(o.code);
        return okShape && left > 9 * 60_000 && left < 11 * 60_000 && o.urls.length ? ok(`${o.code}, ${Math.round(left / 1000)} s, ${o.urls.length} urls`) : no(`${o.code}, expires ${o.expiresAt}, ${o.urls.length} urls`);
      },
    },
    {
      id: "P1.2",
      tell: "responsive",
      lane: "protocol",
      text: "The right code pairs at once and the new phone connects.",
      pass: "POST /pair answers 200 within 2 s and the new socket gets its hello",
      fail: "a refusal, a slow answer, or a socket that never says hello",
      check: (ev) => {
        const p = pairOf(ev, "p1-paired");
        if (!p) return notJudged("no pair");
        return p.status === 200 && p.ms <= 2000 && p.hello ? ok(`200 in ${p.ms} ms, hello`) : no(`${p.status} in ${p.ms} ms${p.error ? ` "${p.error}"` : ""}, hello ${p.hello}`);
      },
    },
    {
      id: "P1.3",
      tell: "state",
      lane: "protocol",
      text: "The paired list shows the new phone by its name.",
      pass: "devices lists UX second phone",
      fail: "the new phone is missing",
      check: (ev) => {
        const d = devicesAfter(ev, mark(ev, "p1-devices") ?? Infinity);
        if (!d) return notJudged("no devices reply");
        return d.some((x) => x.name === "UX second phone") ? ok(d.map((x) => x.name).join(", ")) : no(d.map((x) => x.name).join(", "));
      },
    },
    {
      id: "P1.4",
      tell: "recover",
      lane: "protocol",
      text: "A used code is refused with a reason and the next step.",
      pass: "401 with a message that says where to get a new code",
      fail: "accepted again, or a refusal that does not say what to do",
      check: (ev) => {
        const p = pairOf(ev, "p1-reuse");
        if (!p) return notJudged("no second try");
        return p.status === 401 && NEXT_STEP.test(p.error ?? "") ? ok(`"${p.error}"`) : no(`${p.status} "${p.error}"`);
      },
    },
    shot("P1.5", "state", "The app pairs from the link and lands on the bot list, connected.", "the pairing step, then the list with no error", "an error, a blank screen, or a pairing screen left up", ["pair-link", "paired"]),
  ],
};

const P2: Scenario = {
  id: "P2",
  area: "pairing",
  title: "A mistyped pairing code",
  needsSimulator: false,
  journey: ["The user mistypes the code once, then types it right.", "Later, with a new code, they mistype it five times, then type it right."],
  setup: [
    ...getCode("p2-code"),
    { do: "pair", mark: "p2-typo", name: "UX typo phone", what: "the code with one character wrong", code: typo("p2-code") },
    { do: "pair", mark: "p2-right", name: "UX typo phone", what: "the right code", code: codeAt("p2-code") },
    ...getCode("p2-code2"),
    ...[1, 2, 3, 4, 5].map((n): Action => ({ do: "pair", mark: `p2-wrong${n}`, name: "UX locked phone", what: `the new code with one character wrong (try ${n})`, code: typo("p2-code2") })),
    { do: "pair", mark: "p2-after", name: "UX locked phone", what: "the right new code", code: codeAt("p2-code2") },
  ],
  pre: [{ what: "the bridge gave two codes", check: (ev) => (offers(ev).length >= 2 ? ok(`${offers(ev).length} codes`) : no(`${offers(ev).length} codes`)) }],
  rubric: [
    {
      id: "P2.1",
      tell: "clarity",
      lane: "protocol",
      text: "A mistyped code is called wrong.",
      pass: "401 with a message that says the code is wrong",
      fail: "another status, or a message that blames something else",
      check: (ev) => {
        const p = pairOf(ev, "p2-typo");
        if (!p) return notJudged("no try");
        return p.status === 401 && /wrong|incorrect/i.test(p.error ?? "") ? ok(`"${p.error}"`) : no(`${p.status} "${p.error}"`);
      },
    },
    {
      id: "P2.2",
      tell: "recover",
      lane: "protocol",
      text: "After one typo, the right code still pairs.",
      pass: "200",
      fail: "the typo burned the code",
      check: (ev) => {
        const p = pairOf(ev, "p2-right");
        return p ? (p.status === 200 ? ok("200") : no(`${p.status} "${p.error}"`)) : notJudged("no try");
      },
    },
    {
      id: "P2.3",
      tell: "recover",
      lane: "protocol",
      text: "After too many wrong tries, the message says how to go on.",
      pass: "the fifth refusal says where to get a new code",
      fail: "no next step",
      check: (ev) => {
        const p = pairOf(ev, "p2-wrong5");
        if (!p) return notJudged("no fifth try");
        return p.status !== 200 && NEXT_STEP.test(p.error ?? "") ? ok(`"${p.error}"`) : no(`${p.status} "${p.error}"`);
      },
    },
    {
      id: "P2.4",
      tell: "state",
      lane: "protocol",
      text: "Once locked out, typing the right code is not called wrong.",
      pass: "a refusal that does not say the code is wrong, and says how to go on",
      fail: "the right code is called wrong, or no next step",
      check: (ev) => {
        const p = pairOf(ev, "p2-after");
        if (!p) return notJudged("no try");
        if (p.status === 200) return ok("200: the lockout spared the code");
        return !/wrong/i.test(p.error ?? "") && NEXT_STEP.test(p.error ?? "") ? ok(`"${p.error}"`) : no(`${p.status} "${p.error}"`);
      },
    },
  ],
};

const P3: Scenario = {
  id: "P3",
  area: "pairing",
  title: "Remove a paired phone",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["The user pairs a second phone.", "They remove it from Settings, Paired devices.", "On the simulator lane they also remove the app's own iPhone and look at it."],
  setup: [
    ...getCode("p3-code"),
    { do: "pair", mark: "p3-paired", name: "UX second phone", what: "the code", code: codeAt("p3-code"), connect: true },
    ...listDevices("p3-listed"),
    { do: "raw", mark: "p3-revoke", what: "revoke_device for UX second phone", frame: (ev) => ({ type: "revoke_device", deviceId: pairOf(ev, "p3-paired")?.deviceId }) },
    {
      do: "raw",
      mark: "p3-revoke-app",
      what: "revoke_device for the app's own iPhone (simulator lane; on the protocol lane, where there is none, a devices request)",
      frame: (ev) => {
        const app = devicesAfter(ev, mark(ev, "p3-listed") ?? Infinity)?.find((d) => d.name !== "verify phone" && d.name !== "UX second phone");
        return app ? { type: "revoke_device", deviceId: app.id } : { type: "devices" };
      },
    },
    { do: "sleep", s: 6 },
    { do: "screenshot", shot: "p3-revoked" },
    ...listDevices("p3-after"),
  ],
  pre: [{ what: "the second phone paired and connected", check: (ev) => (pairOf(ev, "p3-paired")?.hello ? ok("connected") : no(JSON.stringify(pairOf(ev, "p3-paired") ?? null))) }],
  rubric: [
    {
      id: "P3.1",
      tell: "responsive",
      lane: "protocol",
      text: "The removed phone learns it was removed, not just that the Mac is away.",
      pass: "its socket closes within 2 s with code 4001",
      fail: "no close, a late one, or another code (the app would retry as if offline)",
      check: (ev) => {
        const p = pairOf(ev, "p3-paired");
        const at = mark(ev, "p3-revoke");
        if (!p || at === undefined) return notJudged("no revoke");
        const c = p.closed;
        if (!c) return no("never closed");
        const after = c.at - at;
        return c.code === 4001 && after <= 2000 ? ok(`4001 "${c.reason}" after ${s(after)}`) : no(`${c.code} "${c.reason}" after ${s(after)}`);
      },
    },
    {
      id: "P3.2",
      tell: "state",
      lane: "protocol",
      text: "Its old token no longer opens a socket.",
      pass: "the second try after the close is refused",
      fail: "the removed phone gets back in",
      check: (ev) => {
        const p = pairOf(ev, "p3-paired");
        if (!p?.closed) return notJudged("never closed");
        return p.rejoined === false ? ok("refused") : no(p.rejoined === null ? "the second try never settled" : "it opened");
      },
    },
    {
      id: "P3.3",
      tell: "state",
      lane: "protocol",
      text: "The paired list drops the removed phone and keeps this one.",
      pass: "devices after the revoke lacks UX second phone and lists the current phone",
      fail: "the removed phone still listed, or this phone gone",
      check: (ev) => {
        const d = devicesAfter(ev, mark(ev, "p3-after") ?? Infinity) as { name: string; current?: boolean }[] | undefined;
        if (!d) return notJudged("no devices reply");
        return !d.some((x) => x.name === "UX second phone") && d.some((x) => x.current) ? ok(d.map((x) => x.name).join(", ")) : no(d.map((x) => `${x.name}${x.current ? " (current)" : ""}`).join(", "));
      },
    },
    shot("P3.4", "recover", "A removed iPhone says it was removed and how to pair again, instead of reconnecting forever.", "a pairing screen that says it was removed from the Mac", "Reconnecting, an offline banner, or the old list", ["p3-revoked"]),
  ],
};

// ---- Settings and account

const T1: Scenario = {
  id: "T1",
  area: "settings",
  title: "Pair another device from Settings",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["The user opens Settings and taps Pair another device.", "They leave the code on screen for a minute while they find the other phone.", "On the protocol lane, the phone asks for a second code and the first is tried."],
  setup: [
    { do: "tap", label: "Settings", mark: "t1-settings" },
    { do: "screenshot", shot: "t1-settings" },
    { do: "tap", label: "Pair another device", mark: "t1-sheet" },
    { do: "screenshot", shot: "t1-code" },
    { do: "watch-labels", phrases: ["Expires", "expires", "expired"] },
    { do: "sleep", s: 70 },
    { do: "screenshot", shot: "t1-later" },
    ...getCode("t1-first"),
    ...getCode("t1-second"),
    { do: "pair", mark: "t1-old", name: "UX old-code phone", what: "the first code", code: codeAt("t1-first") },
  ],
  pre: [{ what: "two codes were given", check: (ev) => (offers(ev).length >= 2 ? ok(`${offers(ev).length}`) : no(`${offers(ev).length}`)) }],
  rubric: [
    {
      id: "T1.1",
      tell: "recover",
      lane: "protocol",
      text: "Asking for a new code retires the old one, with a reason that points to the new one.",
      pass: "the first code is refused with a message that names the next step",
      fail: "the old code still pairs, or the refusal gives no next step",
      check: (ev) => {
        const p = pairOf(ev, "t1-old");
        if (!p) return notJudged("no try");
        return p.status === 401 && NEXT_STEP.test(p.error ?? "") ? ok(`"${p.error}"`) : no(`${p.status} "${p.error}"`);
      },
    },
    {
      id: "T1.2",
      tell: "how-long",
      lane: "simulator",
      text: "The code's countdown ticks while the screen sits still (backlog: it may not).",
      pass: "the label probe reads at least two different expiry texts over the minute",
      fail: "the same text for the whole minute",
      check: (ev) => {
        const at = mark(ev, "t1-sheet");
        if (at === undefined) return notJudged("no sheet");
        const texts = new Set(ev.labels.filter((l) => l.at >= at).flatMap((l) => l.hits.map((h) => h.label)));
        if (!texts.size) return notJudged("no label holding Expires was read");
        return texts.size >= 2 ? ok([...texts].slice(0, 3).join(" | ")) : no(`only "${[...texts][0]}"`);
      },
    },
    shot("T1.3", "clarity", "The sheet shows the code, a QR code and how long the code lasts; a minute later the time left is less.", "code, QR and an expiry that went down between the two shots", "no expiry, or the same time left after a minute", ["t1-code", "t1-later"]),
    shot("T1.4", "state", "Settings opens with the Mac's status, address and the paired devices.", "Connected, the address, the device list", "a blank or wrong status", ["t1-settings"]),
  ],
};

const T2: Scenario = {
  id: "T2",
  area: "settings",
  title: "Confirm a fact a bot remembered, in dark mode",
  needsSimulator: false,
  sidebar: "bots",
  ui: { appearance: "dark" },
  journey: ["The user tells a bot something to remember.", "Settings, Memory shows it as a proposal from that bot.", "They confirm it."],
  setup: [
    ...newBot("t2"),
    say("t2", "Remember this about me: my favorite tea is genmaicha. Use your memory tool to save it, then reply in one short sentence.", "t2-send"),
    answered("t2", "t2-send", "t2-done"),
    { do: "raw", mark: "t2-memory", what: "memory", frame: () => ({ type: "memory" }) },
    { do: "until", mark: "t2-proposed", what: "an unconfirmed fact", timeoutS: 10, test: (ev) => (latestFacts(ev, mark(ev, "t2-memory") ?? Infinity) ?? []).some((f) => !f.confirmed) },
    { do: "open-bot", ref: "t2", mark: "t2-open" },
    { do: "screenshot", shot: "t2-chat" },
    { do: "show-list" },
    { do: "tap", label: "Settings" },
    { do: "tap", label: "Memory" },
    { do: "screenshot", shot: "t2-memory" },
    { do: "raw", mark: "t2-confirm", what: "confirm_fact for the proposal", frame: (ev) => ({ type: "confirm_fact", factId: latestFacts(ev, mark(ev, "t2-memory")!)!.find((f) => !f.confirmed)!.id }) },
    { do: "sleep", s: 3 },
  ],
  pre: [created("t2"), { what: "the bot proposed a fact", check: (ev) => (mark(ev, "t2-proposed") !== undefined ? ok("proposed") : no("no unconfirmed fact")) }],
  rubric: [
    {
      id: "T2.1",
      tell: "clarity",
      lane: "protocol",
      text: "Memory says the fact is a proposal and which bot made it.",
      pass: "unconfirmed, with the bot as proposer and its name in by",
      fail: "shown as confirmed, or no proposer",
      check: (ev) => {
        const f = (latestFacts(ev, mark(ev, "t2-memory") ?? Infinity) ?? []).find((x) => !x.confirmed);
        if (!f) return notJudged("no proposal");
        return f.proposerBotId === idOf(ev, "t2") && f.by ? ok(`"${f.text}" by ${f.by}`) : no(JSON.stringify(f));
      },
    },
    {
      id: "T2.2",
      tell: "responsive",
      lane: "protocol",
      text: "Confirm takes at once.",
      pass: "a memory frame with the fact confirmed within 2 s",
      fail: "no change, or an error",
      check: (ev) => {
        const at = mark(ev, "t2-confirm");
        if (at === undefined) return notJudged("no confirm");
        const m = framesOf(ev, "memory", at).find((x) => !(x.frame.facts as Fact[]).some((f) => !f.confirmed));
        const err = framesOf(ev, "error", at)[0];
        if (err) return no(`error "${err.frame.message}"`);
        return m && m.at - at <= 2000 ? ok(`confirmed after ${s(m.at - at)}`) : no(m ? `after ${s(m.at - at)}` : "never confirmed");
      },
    },
    shot("T2.3", "clarity", "In dark mode, the Memory proposal's Confirm button is readable (backlog: the pill is blank).", "a Confirm label visible on its fill, next to Forget", "a blank or unreadable pill", ["t2-memory"]),
    shot("T2.4", "clarity", "In dark mode, the chat's memory notice and its Confirm are readable.", "the notice and its buttons read clearly", "blank or low-contrast buttons", ["t2-chat"]),
  ],
};

const T3: Scenario = {
  id: "T3",
  area: "settings",
  title: "Settings while the Mac stays away for over a minute",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["The user has Settings open.", "The Mac drops off the network for 80 s.", "It comes back."],
  setup: [
    { do: "tap", label: "Settings", mark: "t3-settings" },
    { do: "watch-labels", phrases: ["Reconnecting", "Connected", "Connecting", "answering", "reach", "Offline", "offline"] },
    { do: "reconnect", afterS: 80, mark: "t3-back", how: "close", compare: false, shot: { name: "t3-away", afterS: 70 } },
    { do: "sleep", s: 10 },
    { do: "screenshot", shot: "t3-back" },
  ],
  pre: [],
  rubric: [
    {
      id: "T3.1",
      tell: "recover",
      lane: "protocol",
      text: "After 80 s away, the phone picks up where it left off.",
      pass: "the hello after the drop resumed the stream",
      fail: "a fresh start: whatever happened while away is replaced, not replayed",
      check: (ev) => {
        const r = ev.resumes.find((x) => x.mark === "t3-back");
        return r ? (r.resumed ? ok(`resumed, ${r.replayed} frames replayed`) : no(`not resumed (${r.reply})`)) : notJudged("no reconnect");
      },
    },
    {
      id: "T3.2",
      tell: "state",
      lane: "simulator",
      text: "After a minute away, Settings stops saying Reconnecting and says the Mac is not answering (backlog).",
      pass: "no label reads Reconnecting from 62 s into the drop until it ends",
      fail: "Reconnecting still shown after a minute",
      check: (ev) => {
        const at = mark(ev, "t3-back-dropped");
        const end = mark(ev, "t3-back");
        if (at === undefined || end === undefined) return notJudged("no drop");
        const late = ev.labels.filter((l) => l.at >= at + 62_000 && l.at <= end - 1000);
        if (!late.length) return notJudged("no label samples late in the drop");
        const bad = late.filter((l) => l.hits.some((h) => h.label.includes("Reconnecting")));
        return bad.length ? no(`Reconnecting in ${bad.length}/${late.length} samples, e.g. "${bad[0]!.hits.find((h) => h.label.includes("Reconnecting"))!.label}"`) : ok(`${late.length} samples: ${[...new Set(late.flatMap((l) => l.hits.map((h) => h.label)))].join(" | ")}`);
      },
    },
    {
      id: "T3.3",
      tell: "responsive",
      lane: "simulator",
      text: "When the Mac is back, Settings says Connected soon.",
      pass: "a label reads Connected within 15 s after the network returns",
      fail: "no Connected within 15 s",
      check: (ev) => {
        const end = mark(ev, "t3-back");
        if (end === undefined) return notJudged("no reconnect");
        const hit = ev.labels.find((l) => l.at >= end - 5000 && l.hits.some((h) => /\bConnected\b/.test(h.label)));
        if (!ev.labels.some((l) => l.at >= end)) return notJudged("no samples after the reconnect");
        return hit && hit.at - end <= 15_000 ? ok(`Connected at +${s(Math.max(0, hit.at - end))}`) : no("no Connected label within 15 s");
      },
    },
    shot("T3.4", "recover", "Away for over a minute, Settings tells the truth and offers a way out.", "a status that says the Mac is not answering, and Change address", "Reconnecting with nothing else to do", ["t3-away"]),
  ],
};

const T4: Scenario = {
  id: "T4",
  area: "settings",
  title: "Plan usage and paired devices in Settings",
  needsSimulator: false,
  sidebar: "bots",
  journey: ["The user opens Settings.", "They pull to refresh plan usage.", "They look at the paired devices."],
  setup: [
    { do: "tap", label: "Settings", mark: "t4-settings" },
    { do: "sleep", s: 3 },
    { do: "screenshot", shot: "t4-settings" },
    { do: "raw", mark: "t4-usage", what: "refresh_usage", frame: () => ({ type: "refresh_usage" }) },
    { do: "until", mark: "t4-usage-in", what: "a usage or error reply", timeoutS: 20, optional: true, test: (ev) => [...framesOf(ev, "usage", mark(ev, "t4-usage") ?? Infinity), ...framesOf(ev, "error", mark(ev, "t4-usage") ?? Infinity)].length > 0 },
    ...listDevices("t4-devices"),
  ],
  pre: [],
  rubric: [
    {
      id: "T4.1",
      tell: "responsive",
      lane: "protocol",
      text: "Refreshing plan usage answers within 10 s.",
      pass: "a usage frame (or an error) within 10 s",
      fail: "nothing, so the spinner spins on",
      check: (ev) => {
        const at = mark(ev, "t4-usage");
        if (at === undefined) return notJudged("no refresh");
        const r = [...framesOf(ev, "usage", at), ...framesOf(ev, "error", at)].sort((a, b) => a.at - b.at)[0];
        return r && r.at - at <= 10_000 ? ok(`${r.frame.type} after ${s(r.at - at)}`) : no(r ? `after ${s(r.at - at)}` : "no answer");
      },
    },
    {
      id: "T4.2",
      tell: "clarity",
      lane: "protocol",
      text: "Plan usage either shows numbers or says why it cannot.",
      pass: "state ok with at least one window, or state unavailable with a reason",
      fail: "ok with no windows, or unavailable with no reason",
      check: (ev) => {
        const u = framesOf(ev, "usage", mark(ev, "t4-usage") ?? Infinity)[0]?.frame.usage as { state: string; windows?: unknown[]; reason?: string } | undefined;
        if (!u) return notJudged("no usage frame");
        if (u.state === "ok") return (u.windows?.length ?? 0) > 0 ? ok(`${u.windows!.length} windows`) : no("ok with no windows");
        return u.reason ? ok(`unavailable: ${u.reason}`) : no(`${u.state} with no reason`);
      },
    },
    {
      id: "T4.3",
      tell: "state",
      lane: "protocol",
      text: "The paired devices list marks this phone and says when each was last seen.",
      pass: "one device is current, and every device has a name",
      fail: "no current device, or a device with no name",
      check: (ev) => {
        const d = devicesAfter(ev, mark(ev, "t4-devices") ?? Infinity) as { name: string; current: boolean; lastSeenAt: string | null }[] | undefined;
        if (!d) return notJudged("no devices reply");
        return d.filter((x) => x.current).length === 1 && d.every((x) => x.name.trim()) ? ok(d.map((x) => `${x.name}${x.current ? " (current)" : ""}`).join(", ")) : no(JSON.stringify(d));
      },
    },
    shot("T4.4", "clarity", "Settings reads clearly: the Mac's status, plan usage and the device list.", "each section with a value, none blank or cut", "a blank section, a stuck spinner, or cut text", ["t4-settings"]),
  ],
};

export const AREAS: Scenario[] = [C1, C2, C3, C4, H1, H2, H3, P1, P2, P3, T1, T2, T3, T4];
