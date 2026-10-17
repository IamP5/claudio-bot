import { expect, test } from "bun:test";
import { followUpAccepted, parseCloudCreated } from "../src/runners/cloud";

const captured =
  "\x1b[?25l\x1b[2K\x1b[1G\x1b[32mCreated cloud session: README summary\x1b[39m\r\n" +
  "\x1b[2mView: \x1b[22m\x1b[4mhttps://claude.ai/code/session_01M5EKdEfpE3XXvTDtviQK29?from=cli&m=0\x1b[24m\r\n" +
  "Resume with: claude --teleport session_01M5EKdEfpE3XXvTDtviQK29\r\n\x1b[?25h";

test("parses title, url without query, and session id from claude --cloud output", () => {
  expect(parseCloudCreated(captured)).toEqual({
    title: "README summary",
    url: "https://claude.ai/code/session_01M5EKdEfpE3XXvTDtviQK29",
    sessionId: "session_01M5EKdEfpE3XXvTDtviQK29",
  });
});

test("output without a View line is a failure", () => {
  expect(parseCloudCreated("Error: not logged in\r\n")).toBeNull();
});

test("follow-up JSON from claude -p --cloud is accepted unless it reports failure", () => {
  expect(followUpAccepted('{"ok":true,"session_id":"session_01","url":"https://claude.ai/code/session_01?from=cli"}')).toBe(true);
  expect(followUpAccepted('{"ok":false,"error":"nope"}')).toBe(false);
  expect(followUpAccepted("Error: session not found")).toBe(false);
});
