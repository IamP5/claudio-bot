# S1b Three parallel subagents in the background (Claude Code's default)

outcome **judged**; lane protocol; run 20261021-030306-951f build e7acec3566; 40 s; $0.0219
rubric: 1 pass, 6 fail, 0 review, 0 not judged, 2 skipped

## Preconditions
- ok: session s1b was created (d464cbf3-a1ad-4113-9207-ea5d9bea6be2)
- ok: the 3 Agent calls ran with run_in_background true (3 calls)
- ok: 3 subagents ran at the same time (their own transcripts overlap) (3 subagents, all running together for 33 s)

## Rubric
| id | lane | tells | verdict | why |
| --- | --- | --- | --- | --- |
| S1b.1 | protocol | what | pass | Agent: sleeper one / Agent: sleeper two / Agent: sleeper three |
| S1b.2 | protocol | how-many | fail | max 0 running at once |
| S1b.3 | protocol | state | fail | row idle/not-working for about 33 of the 36 s the subagents ran |
| S1b.4 | protocol | state | fail | Agent: sleeper one read ok 33 s before its subagent ended; Agent: sleeper two read ok 31 s before its subagent ended; Agent: sleeper three read ok 31 s before its subagent ended |
| S1b.5 | protocol | how-long | fail | no step of a subagent ever reads running, so nothing on the wire says how long it has run |
| S1b.6 | protocol | what | fail | no child row, no output while running |
| S1b.7 | protocol | stop | fail | 7/15 states had working=false, first at +2s |
| S1b.8 | simulator | how-many | skipped | simulator item; protocol lane |
| S1b.9 | simulator | state | skipped | simulator item; protocol lane |

marks (s): {"s1b-started":1.9,"agents-launched":4.9,"mid-run":16.9,"all-done":40.4,"s1b-ended":40.4,"agents-from":3.7,"agents-to":39.2}
