export const meta = {
  name: 'ux-audit',
  description: 'Audit one ClaudioBot area (or all) with protocol and simulator auditors until two dry rounds, then 3 skeptics per finding',
  whenToUse: 'Each audit round of the ClaudioBot UX program. args: {area: "sessions"|"chat"|"home"|"pairing"|"settings"|"all", stamp: "<utc stamp>", repo: "<worktree path>"}',
  phases: [
    { title: 'Load', detail: 'read the scenario registry, rubric docs, patterns and known findings' },
    { title: 'Audit', detail: 'protocol lane runs freely, simulator lane at most 3 at once on leased pool devices', model: 'sonnet' },
    { title: 'Dedupe', detail: 'drop findings already in the ledger or seen in an earlier round' },
    { title: 'Skeptics', detail: '3 Opus skeptics try to refute each finding', model: 'opus' },
  ],
}

const AREA = (args && args.area) || 'sessions'
const STAMP = (args && args.stamp) || 'nostamp'
const REPO = (args && args.repo) || '.'
const MAX_ROUNDS = (args && args.maxRounds) || 6
const SIM_SLOTS = 3
const EVID = `$CLAUDIOBOT_VERIFY_DIR/ux-audit/${AREA}/${STAMP}`

const COMMON = `You are auditing the ClaudioBot iPhone app (repo: ${REPO}; run every command from there).
Program goal: every screen is clear, responsive, and honest about state. In Sessions especially the user can always tell what is running (subagents, background processes), how many, for how long, done, failed or stuck, and how to stop it.
Rules:
- export CLAUDIOBOT_VERIFY_BUDGET_USD=100000 before any helper command. Use the scenario runner .claude/skills/verify-claudio-bot/bin/scenario.ts (read docs/ux-program/runner.md first). Its runs own their bridge; for any direct control-claudio.ts command always pass --run <id>, never rely on "current".
- Never touch the user's bridge on port 7878 or ~/.claudiobot. Never boot, clone or shut down any simulator except a pool device you leased through the runner (ClaudioBot-UX-1..3). Never touch the booted iPhone 17 Pro 81E949D3.
- Screenshots may show the user's real session titles: keep them under $CLAUDIOBOT_VERIFY_DIR, never copy them into the repo, never quote a real title in a finding.
- Do not edit repo files. Write scratch output only under ${EVID}/<your label>/.
- A finding is a concrete thing the user sees (or cannot see) that breaks the goal, with evidence (report/timeline/screenshot paths, and the app or bridge file:line that causes it). Opinions with no evidence are not findings.
- Read docs/ux-program/patterns.md if it exists and name the pattern a fix would follow.`

const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'stable kebab slug: <area>-<what-is-wrong>' },
          title: { type: 'string' },
          scenario: { type: 'string', description: 'scenario or check id, e.g. S2 or X-dynamic-type' },
          what_user_sees: { type: 'string' },
          expected: { type: 'string' },
          evidence: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'string' }, description: 'repo files a fix would touch' },
          pattern: { type: 'string' },
          severity_guess: { type: 'string', enum: ['P0', 'P1', 'P2'] },
        },
        required: ['key', 'title', 'scenario', 'what_user_sees', 'expected', 'evidence', 'files', 'severity_guess'],
      },
    },
    blocked: { type: 'array', items: { type: 'string' }, description: 'checks you could not run, with the reason' },
  },
  required: ['findings', 'blocked'],
}

const PLAN = {
  type: 'object',
  properties: {
    known: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' } }, required: ['key', 'title'] } },
    protocol: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, brief: { type: 'string' } }, required: ['id', 'brief'] } },
    simulator: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, brief: { type: 'string' } }, required: ['id', 'brief'] } },
  },
  required: ['known', 'protocol', 'simulator'],
}

phase('Load')
const plan = await agent(`${COMMON}

Build the audit plan for area "${AREA}" (if "all", every area). Do not run scenarios.
1. Read docs/ux-program/findings.tsv if it exists and return every row's key and title as "known" (all areas, so the audit never re-files a finding).
2. Run \`bun .claude/skills/verify-claudio-bot/bin/scenario.ts list\` and read docs/ux-program/scenarios/*.md for the area.
3. "protocol": one job per scenario whose rubric has protocol items (id = scenario id; brief = what to run and what to look for beyond the rubric).
4. "simulator": one job per scenario with simulator items (run with --sim), plus one job per cross-cutting check for the area, each id prefixed X-: X-empty-error-offline (empty lists, bridge down, socket dropped), X-dynamic-type (xcrun simctl ui <udid> content_size accessibility-extra-extra-extra-large on the leased device), X-voiceover (accessibility labels/traits/grouping read from the SwiftUI code of the area's screens, plus large-text screenshots; VoiceOver itself cannot run under simctl), X-dark-mode (xcrun simctl ui <udid> appearance dark), X-ipad (see docs/ux-program/decisions.tsv for how iPad is judged).
Keep briefs concrete: commands, screens, what the user must be able to tell.`, { label: `plan:${AREA}`, phase: 'Load', schema: PLAN, model: 'sonnet', effort: 'medium' })

const seen = plan.known.map(k => ({ key: k.key, title: k.title }))
const fresh = []
log(`plan: ${plan.protocol.length} protocol jobs, ${plan.simulator.length} simulator jobs, ${seen.length} known findings`)

const LENSES = [
  'state honesty: does every visible state match what is actually happening (running, idle, waiting, done, failed, stuck, stopped)?',
  'responsiveness: latency from event to screen, silent gaps, spinners that lie, stale data after reconnect or return',
  'clarity: copy, counts, durations, titles, disambiguation, what the user can do next (stop, retry, open)',
  'edges: failures, interruptions, many items, long text, slow network, app killed or backgrounded mid-run',
]

function auditPrompt(job, lane, round) {
  const seenList = seen.map(s => `- ${s.key}: ${s.title}`).join('\n') || '(none)'
  const sim = lane === 'simulator'
    ? `\nSimulator lane: lease a pool device through the runner (\`run <id> --sim\` leases for you; for X- checks use \`lease acquire --label "ux-audit ${AREA} r${round} ${job.id}" --boot --wait 3600\`, heartbeat at least every 5 minutes, and ALWAYS \`lease release\` when done, even on failure). Wait when all 3 are taken. Install/pair the app the way runner.md describes. Judge screenshots in place.`
    : `\nProtocol lane: bridge and socket only, no simulator.`
  return `${COMMON}${sim}

Job ${job.id} (round ${round}, lane ${lane}): ${job.brief}
Lens for this round: ${LENSES[(round - 1) % LENSES.length]}
Run the scenario or check for real, read the report, timeline, transcripts and screenshots, then read the app (ios/ClaudioBot) and bridge (bridge/src) code behind what you saw.
Already known, do not re-report these (or anything that is the same problem in other words):
${seenList}
Report only NEW findings. Report checks you could not run under "blocked" with the reason; never swap in an easier path.`
}

function limit(n) {
  let active = 0
  const queue = []
  const next = () => {
    if (active >= n || !queue.length) return
    active++
    const { fn, res } = queue.shift()
    fn().then(res, () => res(null)).finally(() => { active--; next() })
  }
  return fn => new Promise(res => { queue.push({ fn, res }); next() })
}

const DEDUPE = {
  type: 'object',
  properties: { new_indexes: { type: 'array', items: { type: 'integer' } } },
  required: ['new_indexes'],
}

const blockedAll = []
let dry = 0
let round = 0
while (dry < 2 && round < MAX_ROUNDS) {
  round++
  phase('Audit')
  const simGate = limit(SIM_SLOTS)
  const jobs = [
    ...plan.protocol.map(j => () => agent(auditPrompt(j, 'protocol', round), { label: `r${round}:proto:${j.id}`, phase: 'Audit', schema: FINDINGS, model: 'sonnet', effort: 'medium', agentType: 'general-purpose' })),
    ...plan.simulator.map(j => () => simGate(() => agent(auditPrompt(j, 'simulator', round), { label: `r${round}:sim:${j.id}`, phase: 'Audit', schema: FINDINGS, model: 'sonnet', effort: 'medium', agentType: 'general-purpose' }))),
  ]
  const results = (await parallel(jobs)).filter(Boolean)
  results.forEach(r => blockedAll.push(...r.blocked.map(b => `r${round}: ${b}`)))
  const found = results.flatMap(r => r.findings)
  const keyed = found.filter(f => !seen.some(s => s.key === f.key))
  if (!keyed.length) { dry++; log(`round ${round}: nothing new (dry ${dry}/2)`); continue }

  phase('Dedupe')
  const d = await agent(`Deduplicate audit findings. KNOWN (already filed or seen):
${seen.map((s, i) => `K${i}. ${s.key}: ${s.title}`).join('\n') || '(none)'}

CANDIDATES:
${keyed.map((f, i) => `${i}. ${f.key}: ${f.title}. Sees: ${f.what_user_sees}`).join('\n')}

Return the indexes of candidates that are a genuinely new problem: not the same user-visible problem as any KNOWN item and not a duplicate of a lower-indexed candidate. Same root cause seen in two scenarios counts as one; keep the lower index.`, { label: `r${round}:dedupe`, phase: 'Dedupe', schema: DEDUPE, model: 'sonnet', effort: 'medium' })
  const added = (d ? d.new_indexes : []).filter(i => i >= 0 && i < keyed.length).map(i => keyed[i])
  if (!added.length) { dry++; log(`round ${round}: ${keyed.length} candidates, all duplicates (dry ${dry}/2)`); continue }
  dry = 0
  added.forEach(f => { seen.push({ key: f.key, title: f.title }); fresh.push({ ...f, round }) })
  log(`round ${round}: ${added.length} new findings (${fresh.length} total)`)
}
if (dry < 2) log(`stopped at MAX_ROUNDS=${MAX_ROUNDS} before two dry rounds`)

phase('Skeptics')
const VERDICT = {
  type: 'object',
  properties: {
    refuted: { type: 'boolean' },
    reason: { type: 'string' },
    severity: { type: 'string', enum: ['P0', 'P1', 'P2'], description: 'if not refuted. P0: user is misled about state or cannot stop/recover; P1: state is unclear, slow or needs guesswork; P2: polish' },
  },
  required: ['refuted', 'reason', 'severity'],
}
const LENS = ['does the evidence actually show it (reread the files cited)', 'is it really wrong for the user, or intended and fine', 'does the cause in code match, or is it a harness artifact']
const judged = await parallel(fresh.map(f => () =>
  parallel(LENS.map((lens, i) => () => agent(`You are a skeptic. Try to REFUTE this ClaudioBot UX finding. Read the evidence files it cites and the code; you need no simulator and must not run scenarios or boot devices. Do not edit files. Lens: ${lens}. Default to refuted=true if the evidence does not hold up.

Finding ${f.key} (${f.scenario}): ${f.title}
User sees: ${f.what_user_sees}
Expected: ${f.expected}
Evidence: ${f.evidence.join('; ')}
Files: ${f.files.join(', ')}`, { label: `skeptic${i + 1}:${f.key}`, phase: 'Skeptics', schema: VERDICT, model: 'opus', effort: 'medium' })))
    .then(vs => {
      const v = vs.filter(Boolean)
      const upheld = v.filter(x => !x.refuted)
      const order = ['P0', 'P1', 'P2']
      const sev = upheld.map(x => order.indexOf(x.severity)).sort()[Math.floor(upheld.length / 2)]
      return { ...f, survives: upheld.length >= 2, severity: upheld.length ? order[sev] : null, votes: v.map(x => ({ refuted: x.refuted, severity: x.severity, reason: x.reason })) }
    })))

const all = judged.filter(Boolean)
return {
  area: AREA,
  rounds: round,
  dry_rounds_reached: dry >= 2,
  survivors: all.filter(f => f.survives),
  refuted: all.filter(f => !f.survives).map(f => ({ key: f.key, title: f.title, votes: f.votes })),
  blocked: blockedAll,
}
