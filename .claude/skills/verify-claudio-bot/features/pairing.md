# Pairing and devices

A phone pairs with the bridge by a one-time code (printed at first start, or shown on an already paired phone under Settings, Pair another device), trading it at `POST /pair` for a token of its own. Settings lists paired devices, and revoking one closes its socket at once. No model turn is involved, so this is the cheapest end-to-end check of the bridge's front door.

## Sub-features

- `pair-first` the first start prints `pair code: XXXX-XXXX`, and `POST /pair` with it returns a 64-hex token the log never contains.
- `pair-another` a paired device asks for a new code over the socket (`pair_code`) and a second device pairs with it.
- `pair-single-use` a code works once; a second `POST /pair` with it is refused.
- `pair-devices` `devices` lists both phones, the asker marked `current`.
- `pair-revoke` `revoke_device` closes the revoked phone's socket with code 4001 and its token gets 401.

## How to get to it (user POV)

- First launch: Scan QR code or type the address and code.
- Settings, Pair another device; Settings, the device list with Revoke.

## Driving it with control-claudio

Preconditions:

- A run is READY (launch already proved `pair-first`: its output shows `paired device d_… with code …`).

- **New code.** Run `$H raw '{"type":"pair_code"}' --frames pair_code`. A `pair_code` frame with `code` like `ABCD-1234` and an `expiresAt` about 10 minutes out.
- **Second phone.** Run `curl -s -X POST http://127.0.0.1:<port>/pair -d '{"code":"<code>","name":"second phone"}'`. JSON with `deviceId` and a 64-hex `token`; `grep -c <token> <run>/bridge.log` prints `0`.
- **Single use.** Repeat the same curl. A non-200 status and no token.
- **Devices.** Run `$H raw '{"type":"devices"}' --frames devices`. Two devices, `verify phone` with `current:true` and `second phone`.
- **Revoke.** Run `$H raw '{"type":"revoke_device","deviceId":"<second deviceId>"}' --frames devices`. The list has one device. `curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer <second token>" http://127.0.0.1:<port>/ws` prints `401`.
- **Proof.** Run `$H evidence pairing`; `state.json` holds the device list (hashes, not tokens).

## Gotchas

- Never revoke the helper's own device (`current:true`); every later command would fail with 401 until a new launch.
- `/health` answers anyone; it is not an auth check. Use the socket.
- Do not print the second token into evidence files; keep it in a shell variable.
