# S3 Background work finishes while the app is in the background

outcome **judged**; lane simulator on ClaudioBot-UX-1; run 20261021-031010-8394 build c11fb968ac; 115 s; $0.0097
rubric: 1 pass, 3 fail, 3 review, 0 not judged, 0 skipped

## Preconditions
- ok: the app on the leased simulator paired with the run's bridge (paired)
- ok: session s3 was created (986dca92-a7b8-42fa-ba26-e687e1adda0c)
- ok: the transcript runs Bash with run_in_background (yes)
- ok: bg3.txt exists in the seed project (present)
- ok: the app went to the background before the command finished (yes)

## Rubric
| id | lane | tells | verdict | why |
| --- | --- | --- | --- | --- |
| S3.1 | protocol | state | fail | no push after bg-done (1 pushes in the run) |
| S3.2 | protocol | what | fail | no push links to the session |
| S3.3 | protocol | state | fail | row unread=false, status idle |
| S3.4 | protocol | state | pass | new or changed: assistant:msg_011CgEefQZc5NYRW7nKhyxwA:1 |
| S3.5 | simulator | state | review | judge from screenshots/thread-before.png |
| S3.6 | simulator | state | review | judge from screenshots/while-away.png |
| S3.7 | simulator | state | review | judge from screenshots/thread-after.png |

marks (s): {"s3-started":23.8,"s3-ended":27.9,"backgrounded":32.6,"bg-done":86.3,"list-after":106.3,"foregrounded":106.8}
