// Canonical-addendum handoff between the Kimaki bot process and the
// system-addendum opencode plugin.
//
// Kimaki delivers its Discord addendum (getOpencodeSystemMessage) as the
// per-message `system` parameter of session.prompt calls. OpenCode joins that
// parameter onto the end of the system prompt, so every prompt sent through a
// Kimaki call site carries the addendum. But requests that do NOT originate
// from a Kimaki prompt call reuse the same session with NO `system` parameter:
// slash-command turns (session.command), the post-compaction synthetic
// "continue" turn, and revert/redo replays. Those requests assemble a system
// prompt that ends at `</available_skills>` where every other turn continues
// into the addendum — on a prefix-cached backend (qMLX) the shared KV prefix
// snaps right there and the rest of the conversation re-prefills cold.
//
// The fix is split across the process boundary because the addendum content
// is owned by the bot (agents list fetched from the opencode server, critique
// flag from bot config) while the requests that need patching are assembled
// inside the opencode server process where only the plugin runs:
// - the BOT writes the canonical addendum bytes for a project directory to a
//   well-known file under the kimaki data dir (this module, write-if-changed)
//   every time it builds a system message;
// - the PLUGIN (system-addendum-plugin.ts) reads that file and appends the
//   bytes to any system prompt that has the skills block but no addendum,
//   reproducing OpenCode's own join byte-for-byte.
//
// Fail-safe by construction: if the file is missing or unreadable the plugin
// appends nothing and behaviour is exactly today's; the bot call sites keep
// passing `system` so the main path never depends on this file.

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './config.js'

const ADDENDUM_DIR = 'system-addendum'

// Stable substring of the addendum used to detect its presence in an
// assembled system prompt. system-message.test.ts asserts the real addendum
// still contains this, so a wording change fails CI instead of silently
// turning the plugin into a no-op.
export const ADDENDUM_SIGNATURE = 'reading your messages from inside Discord'

// One file per project directory: the agents list embedded in the addendum is
// project-scoped, so directories cannot share a file. Hash the directory to a
// filesystem-safe fixed-length name.
export function addendumFilePath(directory: string): string {
  const key = crypto
    .createHash('sha256')
    .update(path.resolve(directory))
    .digest('hex')
    .slice(0, 32)
  return path.join(getDataDir(), ADDENDUM_DIR, `${key}.txt`)
}

// Persist the canonical addendum for `directory`, write-if-changed so
// repeated prompts don't churn the file (and the plugin's mtime cache stays
// valid). Best-effort: persistence failures must never break a prompt call.
export function persistCanonicalAddendum({
  directory,
  content,
}: {
  directory: string
  content: string
}): void {
  try {
    if (!content) return
    const file = addendumFilePath(directory)
    try {
      if (fs.readFileSync(file, 'utf-8') === content) return
    } catch {
      // Missing file: fall through to write.
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  } catch {
    // Best-effort only.
  }
}

// Read the canonical addendum for `directory`. Returns undefined when absent
// or unreadable (the fail-safe no-op signal for the plugin).
export function readCanonicalAddendum(directory: string): string | undefined {
  try {
    const content = fs.readFileSync(addendumFilePath(directory), 'utf-8')
    return content || undefined
  } catch {
    return undefined
  }
}
