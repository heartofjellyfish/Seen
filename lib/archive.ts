import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { Answers } from "./types";

// How long a submission counts toward dedup. After this, an identical
// submission may pass again.
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const DATA_DIR = path.join(process.cwd(), ".data");
const FILE_PATH = path.join(DATA_DIR, "archive.json");
const TMP_PATH = path.join(DATA_DIR, "archive.json.tmp");

interface Entry {
  id: string; // clientId (opaque, anonymous)
  hash: string; // content hash
  at: number; // submittedAt (ms since epoch)
}

declare global {
  // eslint-disable-next-line no-var
  var __seenArchive: Entry[] | undefined;
}

function load(): Entry[] {
  if (globalThis.__seenArchive) return globalThis.__seenArchive;
  try {
    if (existsSync(FILE_PATH)) {
      const raw = readFileSync(FILE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Entry[];
      if (Array.isArray(parsed)) {
        globalThis.__seenArchive = parsed;
        return parsed;
      }
    }
  } catch {
    // Best-effort: corrupt file starts fresh, we don't crash the request.
  }
  globalThis.__seenArchive = [];
  return globalThis.__seenArchive;
}

function persist(entries: Entry[]) {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    // Write-then-rename so we never leave a half-written file.
    writeFileSync(TMP_PATH, JSON.stringify(entries), "utf-8");
    renameSync(TMP_PATH, FILE_PATH);
  } catch {
    // Archive is non-critical — swallow so the request can still succeed.
  }
}

function prune(entries: Entry[], now: number): Entry[] {
  return entries.filter((e) => now - e.at < RETENTION_MS);
}

/** Canonicalize + hash a set of answers. Empty fields contribute nothing. */
export function hashAnswers(answers: Answers): string {
  const photoDigest = answers.photo
    ? crypto.createHash("sha256").update(answers.photo).digest("hex")
    : "";
  const parts = [answers.country, answers.precious, answers.message, photoDigest]
    .map((s) => (s ?? "").trim().toLowerCase());
  return crypto.createHash("sha256").update(parts.join("\u0001")).digest("hex");
}

/** An empty submission shouldn't be deduped against other empty submissions. */
export function hasContent(a: Answers): boolean {
  return Boolean(a.country || a.precious || a.message || a.photo);
}

export function isDuplicate(hash: string): boolean {
  const now = Date.now();
  const pruned = prune(load(), now);
  globalThis.__seenArchive = pruned;
  return pruned.some((e) => e.hash === hash);
}

export function recordSubmission(clientId: string, hash: string) {
  const now = Date.now();
  const pruned = prune(load(), now);
  pruned.push({ id: clientId, hash, at: now });
  globalThis.__seenArchive = pruned;
  persist(pruned);
}
