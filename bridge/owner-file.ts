import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

import { HOST } from "./host.ts";
import { isOwnerOnly } from "./owner-only.ts";

// ── OWNER-ONLY CREDENTIAL FILES ──────────────────────────────────────────────────────────────────
//
// `access-password.json` and `open-pending.json` hold material that must never be world-readable and
// must never be read from a file somebody else placed. Both are small JSON documents under the state
// dir, so the same three rules apply to both:
//
//  - READ through a descriptor, never a path: `lstat` refuses a symlink, `O_NOFOLLOW` refuses one
//    that appeared between the check and the open, and `fstat` verifies the OPENED file is regular,
//    owned by this uid, mode 0600 (or stricter), and no larger than the caller's cap.
//  - WRITE to a random name created with `O_EXCL | O_NOFOLLOW` and mode 0600, then `rename` over the
//    target. A pre-placed link at a predictable temp path cannot be followed or reused.
//  - FAIL LOUDLY. Every other error is the caller's own error type, which the store reports as
//    "unavailable" rather than "not configured".

/** Whether an error is a missing file (`ENOENT`). Callers narrow a caught value to `Error` first. */
export function isMissingFileError(err: Error): boolean {
  return "code" in err && err.code === "ENOENT";
}

/** How a caller names its own unreadable-store error, so each module keeps its distinct type. */
export type OwnerFileErrorFactory = (message: string, options?: { cause?: unknown }) => Error;

/** Whether this process can name its uid; `getuid` is absent on Windows. */
function ownUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/**
 * Read an owner-only file, or null when it does not exist. Throws the factory's error when the file
 * exists and cannot be trusted: a symlink, a directory, a foreign owner, any group/other permission,
 * or more than `maxBytes`.
 */
export async function readOwnerFile(
  path: string,
  filename: string,
  maxBytes: number,
  error: OwnerFileErrorFactory,
): Promise<string | null> {
  let before;
  try {
    before = await lstat(path);
  } catch (err) {
    if (err instanceof Error && isMissingFileError(err)) return null;
    throw error(`${filename} cannot be inspected`, { cause: err });
  }
  if (before.isSymbolicLink()) throw error(`${filename} must not be a symbolic link`);
  // A FIFO or a device would block or read forever; only a regular file is a credential store.
  if (!before.isFile()) throw error(`${filename} is not a regular file`);

  // `O_NOFOLLOW` is POSIX-only; on a platform without it the `lstat` above still refused a link.
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
  } catch (err) {
    if (err instanceof Error && isMissingFileError(err)) return null;
    throw error(`${filename} cannot be read`, { cause: err });
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw error(`${filename} is not a regular file`);
    if (st.size > maxBytes) throw error(`${filename} is larger than ${maxBytes} bytes`);
    const uid = ownUid();
    if (uid !== undefined && st.uid !== uid) throw error(`${filename} is not owned by this user`);
    if (HOST.platform === "win32") {
      // NTFS reports synthetic mode bits; the existing ACL reader checks both file and parent.
      // Unlike a general config warning, an unverified credential store must fail closed.
      if (isOwnerOnly(path, HOST).state !== "private") throw error(`${filename} does not have a verified private access list`);
    } else if ((st.mode & 0o077) !== 0) throw error(`${filename} is readable by group or others`);
    // Bounded read from the DESCRIPTOR: a file that grows after the `stat` above must not make this
    // an unbounded `readFile`. One byte over the cap is enough to stop.
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, 64 * 1024));
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw error(`${filename} is larger than ${maxBytes} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Write `text` atomically at mode 0600 under a fresh random temp name. The directory is created with
 * 0700, and `O_EXCL | O_NOFOLLOW` means the temp file is this call's alone. A failed write or rename
 * removes the temp file.
 */
export async function writeOwnerFileAtomic(
  path: string,
  filename: string,
  text: string,
  error: OwnerFileErrorFactory,
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (HOST.platform === "win32" && isOwnerOnly(dir, HOST).state !== "private") {
    throw error(`${filename} requires a verified private state directory`);
  }
  const tmp = `${path}.${randomBytes(12).toString("hex")}.tmp`;
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
    await handle.writeFile(text, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = undefined;
  } catch (err) {
    await handle?.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw error(`${filename} cannot be written`, { cause: err });
  }
  try {
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw error(`${filename} cannot be installed`, { cause: err });
  }
}

/** Remove an owner-only file. False means it was already absent. */
export async function removeOwnerFile(
  path: string,
  filename: string,
  error: OwnerFileErrorFactory,
): Promise<boolean> {
  try {
    await unlink(path);
    return true;
  } catch (err) {
    if (err instanceof Error && isMissingFileError(err)) return false;
    throw error(`${filename} cannot be removed`, { cause: err });
  }
}
