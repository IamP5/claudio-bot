/** A child's output as it arrives, so a test waits for the line it needs instead of a fixed sleep. */
export function collect(stream: ReadableStream<Uint8Array>) {
  let text = "";
  const decoder = new TextDecoder();
  const done = (async () => {
    for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  })();
  return {
    text: () => text,
    async until(pattern: RegExp, ms = 10_000): Promise<string> {
      const started = Date.now();
      while (!pattern.test(text)) {
        if (Date.now() - started > ms) throw new Error(`no output matched ${pattern} within ${ms} ms. Output so far:\n${text}`);
        await Bun.sleep(20);
      }
      return text;
    },
    all: async () => (await done, text),
  };
}

/**
 * Resolves once a started bridge has booted. Its last start line comes just before hub.boot, which runs synchronously,
 * so the first /health answer is the proof that boot finished and the signal handlers are in place. Returns the port.
 */
export async function bridgeReady(out: ReturnType<typeof collect>): Promise<number> {
  const text = await out.until(/^(pair: |\d+ paired devices?\.)/m);
  const port = Number(text.match(/ws:\/\/[^/\s]+:(\d+)\/ws/)![1]);
  await fetch(`http://127.0.0.1:${port}/health`);
  return port;
}
