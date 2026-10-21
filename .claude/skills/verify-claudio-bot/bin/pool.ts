// The simulator pool for scenario runs: three cloned iPhones, a per-device lease, and the only code that boots them.
// A lease is a directory leases/<device>/ made with mkdir (atomic), holding owner.json and a heartbeat file the holder
// touches; a heartbeat older than STALE_MS marks the lease reclaimable. Nothing here touches a device outside POOL.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BASE, REPO } from "./control-claudio";

export const POOL = ["ClaudioBot-UX-1", "ClaudioBot-UX-2", "ClaudioBot-UX-3"] as const;
export type PoolDevice = (typeof POOL)[number];
export const BUNDLE = "dev.claudiobot.app";
export const STALE_MS = 10 * 60_000;
const HEARTBEAT_MS = 60_000;
const LEASES = join(BASE, "leases");
const RECLAIM_LOCK = join(LEASES, ".reclaim");
const CLONE_SOURCE_NAME = "iPhone 17 Pro";

export type Owner = { pid: number; label: string; token: string; acquiredAt: string };
export type Lease = { device: PoolDevice; udid: string; owner: Owner; dir: string };

const run = (argv: string[]) => {
  const p = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
};
const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);

type SimDevice = { udid: string; name: string; state: string; isAvailable: boolean };
function devices(): { runtime: string; d: SimDevice }[] {
  const r = run(["xcrun", "simctl", "list", "devices", "-j"]);
  if (!r.ok) throw new Error(`simctl list: ${r.err}`);
  const byRuntime = JSON.parse(r.out).devices as Record<string, SimDevice[]>;
  return Object.entries(byRuntime).flatMap(([runtime, ds]) => ds.map((d) => ({ runtime, d })));
}
const runtimeVersion = (id: string) => (id.match(/iOS-(\d+)-(\d+)/)?.slice(1).map(Number) ?? [0, 0]) as [number, number];
const isPool = (name: string): name is PoolDevice => (POOL as readonly string[]).includes(name);

export function poolStatus() {
  const all = devices();
  return POOL.map((name) => {
    const found = all.filter((x) => x.d.name === name);
    if (found.length > 1) throw new Error(`more than one simulator is named ${name}; rename the extras by hand`);
    return { name, udid: found[0]?.d.udid ?? null, state: found[0]?.d.state ?? "missing", runtime: found[0]?.runtime ?? null };
  });
}

/** Clones the missing pool devices from a shut-down iPhone 17 Pro on the newest iOS runtime. Never boots anything. */
export function ensurePool() {
  const missing = poolStatus().filter((d) => d.udid === null);
  for (const d of poolStatus()) if (d.udid) log(`pool ${d.name} exists ${d.udid} (${d.state})`);
  if (!missing.length) return;
  const candidates = devices()
    .filter((x) => x.runtime.includes("SimRuntime.iOS-") && x.d.name === CLONE_SOURCE_NAME && x.d.isAvailable && x.d.state === "Shutdown")
    .sort((a, b) => {
      const [am, an] = runtimeVersion(a.runtime);
      const [bm, bn] = runtimeVersion(b.runtime);
      return bm - am || bn - an;
    });
  const source = candidates[0] ?? null;
  if (!source) throw new Error(`no shut-down ${CLONE_SOURCE_NAME} to clone`);
  const newest = devices().filter((x) => x.runtime.includes("SimRuntime.iOS-")).map((x) => runtimeVersion(x.runtime)).sort((a, b) => b[0] - a[0] || b[1] - a[1])[0]!;
  if (runtimeVersion(source.runtime).join(".") !== newest.join(".")) throw new Error(`the newest runtime has no shut-down ${CLONE_SOURCE_NAME}; refusing an older one`);
  for (const d of missing) {
    const r = run(["xcrun", "simctl", "clone", source.d.udid, d.name]);
    if (!r.ok) throw new Error(`clone ${d.name}: ${r.err}`);
    log(`pool ${d.name} cloned from ${CLONE_SOURCE_NAME} ${source.d.udid} (${source.runtime}) as ${r.out}`);
  }
}

const ownerOf = (dir: string): Owner | null => {
  try {
    return JSON.parse(readFileSync(join(dir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
};
const heartbeatAge = (dir: string) => {
  try {
    return Date.now() - statSync(join(dir, "heartbeat")).mtimeMs;
  } catch {
    // A lease dir without a heartbeat is a holder that died between mkdir and its first write: judge it by the dir.
    try {
      return Date.now() - statSync(dir).mtimeMs;
    } catch {
      return 0;
    }
  }
};

function shutdown(udid: string, why: string) {
  const r = run(["xcrun", "simctl", "shutdown", udid]);
  log(`shutdown ${udid} (${why}): ${r.ok ? "ok" : r.err.includes("current state: Shutdown") ? "was already shut down" : r.err}`);
}

/** Removes one stale lease under a global reclaim mutex, so two reclaimers never both judge and remove the same one. */
function reclaimIfStale(device: PoolDevice, udid: string): boolean {
  if (heartbeatAge(join(LEASES, device)) <= STALE_MS) return false;
  try {
    mkdirSync(RECLAIM_LOCK);
  } catch {
    // Another waiter holds the mutex, or it just let go. A mutex older than a minute belongs to a reclaimer that died.
    try {
      if (Date.now() - statSync(RECLAIM_LOCK).mtimeMs > 60_000) rmSync(RECLAIM_LOCK, { recursive: true, force: true });
    } catch {}
    return false;
  }
  try {
    const dir = join(LEASES, device);
    if (!existsSync(dir)) return false;
    const age = heartbeatAge(dir);
    if (age <= STALE_MS) return false;
    const judged = ownerOf(dir);
    const aside = join(LEASES, `.reclaimed-${device}-${Date.now()}`);
    renameSync(dir, aside);
    const moved = ownerOf(aside);
    if (moved?.token !== judged?.token) {
      // The lease changed hands between the check and the rename: put the live one back.
      renameSync(aside, dir);
      return false;
    }
    log(`reclaimed stale lease ${device}: heartbeat ${Math.round(age / 60_000)} min old, owner pid ${judged?.pid ?? "?"} label "${judged?.label ?? "?"}"`);
    shutdown(udid, "reclaimed from a stale lease");
    rmSync(aside, { recursive: true, force: true });
    return true;
  } finally {
    rmSync(RECLAIM_LOCK, { recursive: true, force: true });
  }
}

function tryLease(device: PoolDevice, udid: string, label: string): Lease | null {
  const dir = join(LEASES, device);
  mkdirSync(LEASES, { recursive: true });
  for (const attempt of [0, 1]) {
    try {
      mkdirSync(dir);
    } catch {
      if (attempt === 0 && reclaimIfStale(device, udid)) continue;
      return null;
    }
    const owner: Owner = { pid: process.pid, label, token: crypto.randomUUID(), acquiredAt: new Date().toISOString() };
    writeFileSync(join(dir, "owner.json"), JSON.stringify(owner, null, 2));
    writeFileSync(join(dir, "heartbeat"), owner.acquiredAt);
    return { device, udid, owner, dir };
  }
  return null;
}

/** Leases a pool device, polling every 5 s while all are held, up to waitS. */
export async function acquire(label: string, waitS = 3600): Promise<Lease> {
  const deadline = Date.now() + waitS * 1000;
  let said = false;
  for (;;) {
    for (const d of poolStatus()) {
      if (!d.udid) throw new Error(`${d.name} is missing: run \`scenario.ts pool ensure\``);
      const lease = tryLease(d.name, d.udid, label);
      if (lease) {
        log(`lease acquired ${lease.device} ${lease.udid} by "${label}" pid ${process.pid}`);
        return lease;
      }
    }
    if (Date.now() > deadline) throw new Error(`no pool device free within ${waitS}s`);
    if (!said) log(`all ${POOL.length} pool devices are leased; "${label}" waits`);
    said = true;
    await Bun.sleep(5000);
  }
}

/** The lease as the token holder sees it, or null when it is gone or held by someone else. */
export function held(device: string, token: string): Lease | null {
  if (!isPool(device)) return null;
  const dir = join(LEASES, device);
  const owner = ownerOf(dir);
  const udid = poolStatus().find((d) => d.name === device)?.udid;
  return owner?.token === token && udid ? { device, udid, owner, dir } : null;
}

export function heartbeat(lease: Lease): boolean {
  if (!held(lease.device, lease.owner.token)) return false;
  const now = new Date();
  utimesSync(join(lease.dir, "heartbeat"), now, now);
  return true;
}

/** Shuts the device down, then frees the lease. Synchronous, so exit and signal handlers can call it. */
export function release(lease: Lease, why = "released") {
  if (!held(lease.device, lease.owner.token)) {
    log(`lease ${lease.device} is no longer ours; not shutting it down`);
    return;
  }
  shutdown(lease.udid, why);
  rmSync(lease.dir, { recursive: true, force: true });
  log(`lease released ${lease.device} by "${lease.owner.label}"`);
}

export function leaseStatus() {
  return poolStatus().map((d) => {
    const dir = join(LEASES, d.name);
    const owner = existsSync(dir) ? ownerOf(dir) : null;
    const age = existsSync(dir) ? heartbeatAge(dir) : null;
    return { ...d, owner, heartbeatAgeS: age === null ? null : Math.round(age / 1000), stale: age !== null && age > STALE_MS };
  });
}

/**
 * Holds a lease for this process: heartbeats every minute, and releases (shutting the device down) on exit, SIGINT,
 * SIGTERM and uncaught errors. onLost runs if the lease was reclaimed from under us. beforeRelease runs on every one of
 * those paths while the device is still booted (to undo settings that outlive a shutdown); if it throws, the release
 * still happens.
 */
export function holdForProcess(lease: Lease, onLost: () => void = () => process.exit(1), beforeRelease: () => void = () => {}) {
  let done = false;
  const timer = setInterval(() => {
    if (!heartbeat(lease)) {
      log(`lease ${lease.device} was lost (reclaimed or released elsewhere)`);
      done = true;
      clearInterval(timer);
      onLost();
    }
  }, HEARTBEAT_MS);
  const free = (why: string) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    try {
      beforeRelease();
    } catch (e) {
      log(`before releasing ${lease.device}: ${(e as Error).message}`);
    }
    release(lease, why);
  };
  process.on("exit", () => free("process exit"));
  for (const [sig, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const)
    process.on(sig, () => {
      free(sig);
      process.exit(code);
    });
  process.on("uncaughtException", (e) => {
    console.error(e);
    free("uncaught error");
    process.exit(1);
  });
  return { release: (why = "released") => free(why) };
}

/** Boots a leased pool device and waits for it. Refuses anything this process does not hold. */
export function boot(lease: Lease) {
  if (!isPool(lease.device) || !held(lease.device, lease.owner.token)) throw new Error(`refusing to boot ${lease.device}: not leased by this holder`);
  const state = poolStatus().find((d) => d.name === lease.device)?.state;
  if (state !== "Booted") {
    const r = run(["xcrun", "simctl", "boot", lease.udid]);
    if (!r.ok && !r.err.includes("current state: Booted")) throw new Error(`boot ${lease.device}: ${r.err}`);
  }
  const b = run(["xcrun", "simctl", "bootstatus", lease.udid, "-b"]);
  if (!b.ok) throw new Error(`bootstatus ${lease.device}: ${b.err}`);
  log(`booted ${lease.device} ${lease.udid}`);
}

export function screenshot(lease: Lease, file: string) {
  if (!held(lease.device, lease.owner.token)) throw new Error(`refusing to screenshot ${lease.device}: not leased by this holder`);
  const r = run(["xcrun", "simctl", "io", lease.udid, "screenshot", file]);
  if (!r.ok) throw new Error(`screenshot ${lease.device}: ${r.err}`);
  return file;
}

export function simctl(lease: Lease, ...a: string[]) {
  if (!held(lease.device, lease.owner.token)) throw new Error(`refusing simctl ${a[0]} on ${lease.device}: not leased by this holder`);
  return run(["xcrun", "simctl", a[0]!, lease.udid, ...a.slice(1)]);
}

const BUILDS = join(BASE, "ios-build");
const KEEP_BUILDS = 3;
const STAMP_DIR = /^[0-9a-f]{40}(\+[0-9a-f]+)?$/;

/** One ios/ tree's Debug build, in its own derived-data folder ios-build/<stamp>/ that no other tree writes. */
export type Build = { stamp: string; dir: string; app: string };

/** The ios/ tree's hash, plus a hash of any uncommitted change under ios/. */
export function treeStamp() {
  const tree = run(["git", "-C", REPO, "rev-parse", "HEAD:ios"]).out;
  const dirty = run(["git", "-C", REPO, "status", "--porcelain", "--", "ios"]).out;
  return `${tree}${dirty ? `+${Bun.hash(dirty).toString(16)}` : ""}`;
}

const buildFor = (stamp: string): Build => {
  const dir = join(BUILDS, stamp);
  return { stamp, dir, app: join(dir, "Build/Products/Debug-iphonesimulator/ClaudioBot.app") };
};
/** The stamp a finished build in b.dir carries, or null while it is missing or building. */
const builtStamp = (b: Build) => {
  try {
    return existsSync(b.app) ? readFileSync(join(b.dir, "stamp"), "utf8") : null;
  } catch {
    return null;
  }
};

/** Keeps the KEEP_BUILDS most recently used builds, and never removes one that is building. */
function pruneBuilds() {
  const used = (n: string) => {
    try {
      return statSync(join(BUILDS, n, "stamp")).mtimeMs;
    } catch {
      return 0;
    }
  };
  const idle = readdirSync(BUILDS).filter((n) => STAMP_DIR.test(n) && !existsSync(join(BUILDS, `${n}.lock`)));
  for (const n of idle.sort((a, b) => used(b) - used(a)).slice(KEEP_BUILDS)) {
    rmSync(join(BUILDS, n), { recursive: true, force: true });
    log(`pruned the iOS build ${n.slice(0, 12)}`);
  }
}

/**
 * Builds the Debug app for the simulator once per ios/ tree, into that tree's own folder, so a run that waits for a
 * lease still installs its own tree's app however many other trees build meanwhile. A lock per stamp keeps concurrent
 * runs of one tree from building twice; the others wait for it.
 */
export async function buildApp(): Promise<Build> {
  const b = buildFor(treeStamp());
  const lock = `${b.dir}.lock`;
  mkdirSync(BUILDS, { recursive: true });
  for (;;) {
    if (builtStamp(b) === b.stamp) {
      const now = new Date();
      utimesSync(join(b.dir, "stamp"), now, now);
      return b;
    }
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 30 * 60_000) rmSync(lock, { recursive: true, force: true });
      } catch {}
      await Bun.sleep(5000);
    }
  }
  try {
    log(`building the iOS app (stamp ${b.stamp}) into ${b.dir}`);
    rmSync(join(b.dir, "stamp"), { force: true });
    mkdirSync(b.dir, { recursive: true });
    const p = Bun.spawnSync(
      ["xcodebuild", "-project", join(REPO, "ios/ClaudioBot.xcodeproj"), "-scheme", "ClaudioBot", "-configuration", "Debug", "-destination", "generic/platform=iOS Simulator", "-derivedDataPath", b.dir, "build"],
      { stdout: "pipe", stderr: "pipe" },
    );
    writeFileSync(join(b.dir, "build.log"), p.stdout.toString() + p.stderr.toString());
    if (p.exitCode !== 0) throw new Error(`xcodebuild failed; log ${join(b.dir, "build.log")}`);
    writeFileSync(join(b.dir, "stamp"), b.stamp);
    log(`built ${b.app}`);
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
  pruneBuilds();
  return b;
}

/** A digest of every file in an app bundle, by relative path and content. */
function bundleDigest(app: string) {
  const files = (readdirSync(app, { recursive: true }) as string[]).filter((f) => statSync(join(app, f)).isFile()).sort();
  const h = new Bun.CryptoHasher("sha256");
  for (const f of files) h.update(f).update(readFileSync(join(app, f)));
  return h.digest("hex");
}

/**
 * Installs and launches the app on a leased, booted device, and throws unless the bundle the device then holds is the
 * build of the expected stamp. Debug launch arguments: -pairingVault keeps a throwaway pairing per device,
 * -pairingAutoConfirm confirms a pairing link without the tap simctl cannot make, and -sidebarMode opens on the
 * Sessions list.
 */
export function installAndLaunch(lease: Lease, build: Build, extra: string[] = []) {
  const found = builtStamp(build);
  if (found !== build.stamp) throw new Error(`refusing to install: ${build.dir} holds ${found ? `stamp ${found}` : "no finished build"}, not ${build.stamp}`);
  const want = bundleDigest(build.app);
  const i = simctl(lease, "install", build.app);
  if (!i.ok) throw new Error(`install on ${lease.device}: ${i.err}`);
  const container = simctl(lease, "get_app_container", BUNDLE, "app");
  if (!container.ok) throw new Error(`app container on ${lease.device}: ${container.err}`);
  const got = bundleDigest(container.out);
  if (got !== want) throw new Error(`the app on ${lease.device} is not the build of stamp ${build.stamp}: bundle ${got.slice(0, 12)}, built ${want.slice(0, 12)}`);
  simctl(lease, "terminate", BUNDLE);
  const l = simctl(lease, "launch", BUNDLE, "-pairingVault", `claudiobot-ux-${lease.device}`, "-pairingAutoConfirm", "YES", "-sidebarMode", "sessions", ...extra);
  if (!l.ok) throw new Error(`launch on ${lease.device}: ${l.err}`);
  log(`installed stamp ${build.stamp} (bundle ${got.slice(0, 12)}) and launched ${BUNDLE} on ${lease.device}`);
  return got;
}

export const leaseDirs = () => (existsSync(LEASES) ? readdirSync(LEASES).filter((n) => isPool(n)) : []);
