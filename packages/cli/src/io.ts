/*
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Module-level I/O writers.
 *
 * Commands in factory.ts use `io.write` / `io.writeErr` instead of
 * `process.stdout.write` / `process.stderr.write` directly. This lets the
 * programmatic runner swap the writers for in-process output capture without
 * relying on monkey-patching the process streams (which is unreliable in Bun's
 * TUI context).
 */

let _out: (s: string) => void = (s) => { process.stdout.write(s) }
let _err: (s: string) => void = (s) => { process.stderr.write(s) }

/** Write to the current stdout writer. */
export function write(s: string) { _out(s) }

/** Write to the current stderr writer. */
export function writeErr(s: string) { _err(s) }

/**
 * Redirect all writes to an internal buffer.
 * Returns a `restore` function that resets the writers and returns the captured string.
 */
export function capture(): () => string {
  let buf = ''
  const prev = { out: _out, err: _err }
  _out = (s) => { buf += s }
  _err = (s) => { buf += s }
  return () => {
    _out = prev.out
    _err = prev.err
    return buf
  }
}
