/*
 * Copyright Elasticsearch B.V. and contributors
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Programmatic runner for the elastic CLI.
 *
 * Allows callers to invoke any elastic CLI command in-process without spawning
 * a subprocess. The caller supplies a pre-built ResolvedConfig so that file
 * discovery and secret resolution are bypassed entirely.
 *
 * stdout is captured and returned as a string; the process stream is never
 * written to. stderr errors from Commander are also captured.
 */

import { Command } from 'commander'
import { setResolvedConfig } from './config/store.ts'
import { defineGroup } from './factory.ts'
import { capture, write, writeErr } from './io.ts'
import { _testResetTransport } from './lib/transport.ts'
import type { ResolvedConfig } from './config/types.ts'

export type RunResult = { output: string; code: number }

/**
 * Run an elastic CLI command in-process.
 *
 * @param argv - Arguments after the program name, e.g. `['stack', 'es', 'cluster', 'health', '--json']`.
 *               The shorthands `es` and `kb` are auto-redirected to `stack es` / `stack kb`.
 * @param config - Pre-resolved configuration (credentials + context).  Bypasses `.elasticrc` loading.
 * @returns Captured stdout and exit code.
 */
export async function runCommand(argv: string[], config: ResolvedConfig): Promise<RunResult> {
  setResolvedConfig(config)
  _testResetTransport()

  // Normalise deprecated shorthands: elastic es → elastic stack es, elastic kb → elastic stack kb
  const args = argv[0] === 'es' || argv[0] === 'kb' ? ['stack', ...argv] : [...argv]

  const program = new Command('elastic')
    .option('--json', 'output as JSON')
    .option('--output-fields <list>', 'comma-separated list of fields to include in output')
    .option('--output-template <string>', 'Mustache-like template for custom text output')
    .option('--use-context <name>', 'override the active context')
    .exitOverride()
    .configureOutput({
      writeOut: write,
      writeErr: writeErr,
    })

  const first = args[0]
  const second = args[1]
  const esSet = new Set(['es', 'elasticsearch'])
  const kbSet = new Set(['kb', 'kibana'])

  // Fake argv that the register sniffers expect: ['node', 'elastic', ...actual args]
  const fakeArgv = ['node', 'elastic', ...args]

  if (first === 'stack') {
    const children = []
    if (second == null || esSet.has(second)) {
      const { registerEsCommandsLazy } = await import('./es/register.ts')
      const g = await registerEsCommandsLazy({ argv: fakeArgv })
      g.alias('elasticsearch')
      children.push(g)
    } else {
      children.push(defineGroup({ name: 'es', description: 'Interact with Elasticsearch' }))
    }
    if (second == null || kbSet.has(second)) {
      const { registerKbCommandsLazy } = await import('./kb/register.ts')
      const g = await registerKbCommandsLazy({ argv: fakeArgv })
      g.alias('kibana')
      children.push(g)
    } else {
      children.push(defineGroup({ name: 'kb', description: 'Interact with Kibana' }))
    }
    program.addCommand(defineGroup({ name: 'stack', description: 'Interact with Elastic Stack' }, ...children))
  } else if (first === 'cloud') {
    const { registerCloudCommands } = await import('./cloud/register.ts')
    program.addCommand(registerCloudCommands())
  } else if (first === 'docs') {
    const { registerDocsCommands } = await import('./docs/register.ts')
    program.addCommand(registerDocsCommands())
  } else if (first === 'config') {
    const { registerConfigCommands } = await import('./config/commands.ts')
    program.addCommand(registerConfigCommands())
  } else {
    program.addCommand(defineGroup({ name: 'stack', description: 'Interact with Elastic Stack' }))
    program.addCommand(defineGroup({ name: 'cloud', description: 'Manage Elastic Cloud' }))
    program.addCommand(defineGroup({ name: 'docs', description: 'Search Elastic documentation' }))
  }

  // Apply exitOverride + configureOutput recursively so errors from any
  // subcommand always route through io.write/io.writeErr and never reach
  // the real process streams (which would corrupt the TUI).
  function wire(cmd: Command) {
    cmd.exitOverride().configureOutput({ writeOut: write, writeErr: writeErr })
    for (const sub of cmd.commands) wire(sub)
  }
  wire(program)

  const restore = capture()
  let code = 0
  try {
    await program.parseAsync(fakeArgv)
  } catch (e: unknown) {
    const err = e as { code?: string; exitCode?: number; message?: string }
    if (err.code !== 'commander.helpDisplayed' && err.code !== 'commander.version') {
      code = err.exitCode ?? 1
    }
  } finally {
    const output = restore()
    return { output, code }
  }
}
