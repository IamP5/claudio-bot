/** The answer to a client request that changes state: nothing to send back, or why it was refused. */
export type Result = { ok: true } | { ok: false; error: string };

export const refused = (error: string): Result => ({ ok: false, error });
