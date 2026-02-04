import type { ChildProcessByStdio, ChildProcessWithoutNullStreams, SpawnOptions } from 'child_process';
import cp from 'child_process';
import { EventEmitter } from 'events';
import type { Writable } from 'stream';
import { Readable } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateCommandDocumentation } from './doc-command.js';

/**
 * Creates a mock Readable stream with the given text content.
 */
function createMockReadable(text: string): Readable {
	const readable = new Readable();
	readable._read = (): void => {
		return;
	};
	readable.push(text);
	readable.push(null);
	return readable;
}

/**
 * Creates a mock child process that emits the given stdout content.
 */
function createMockChildProcess(stdout: string): ChildProcessWithoutNullStreams {
	const mockProcess = new EventEmitter() as ChildProcessByStdio<Writable, Readable, Readable>;
	mockProcess.stdout = createMockReadable(stdout);
	mockProcess.stderr = createMockReadable('');
	process.nextTick(() => mockProcess.emit('close', 0));
	return mockProcess;
}

describe('generateCommandDocumentation', () => {
	let spawnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		spawnSpy = vi.spyOn(cp, 'spawn');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('generates documentation for a CLI command', async () => {
		spawnSpy.mockImplementation(
			(command: string, args: readonly string[], _options: SpawnOptions): ChildProcessWithoutNullStreams => {
				return createMockChildProcess('Example command output for ' + [command, ...args].join(' '));
			},
		);

		const documentation = await generateCommandDocumentation('example-command');
		expect(documentation).toBe(
			'```console\n$ example-command\nExample command output for npm --offline exec -- example-command --help\n```\n',
		);

		const lastCall = spawnSpy.mock.calls.pop();
		expect(lastCall?.slice(0, 2)).toStrictEqual(['npm', ['--offline', 'exec', '--', 'example-command', '--help']]);
	});

	it('generates documentation for command with subcommands', async () => {
		const subcommands = ['deps-graph', 'deps-upgrade', 'doc-command', 'doc-insert', 'doc-toc', 'release-npm'];

		// Mock help output for main command
		const mainHelpOutput = `Usage: vrt [options] [command]

A release tool for VersaTiles projects

Options:
  -V, --version   output the version number
  -h, --help      display help for command

Commands:
  deps-graph      Generate dependency graph
  deps-upgrade    Upgrade dependencies
  doc-command     Generate command documentation
  doc-insert      Insert content into markdown
  doc-toc         Generate table of contents
  release-npm     Release to npm
  help [command]  display help for command`;

		// Mock help output for subcommands
		const subcommandHelpOutputs: Record<string, string> = {};
		for (const sub of subcommands) {
			subcommandHelpOutputs[sub] = `Usage: vrt ${sub} [options]

Description for ${sub}

Options:
  -h, --help  display help for command`;
		}

		spawnSpy.mockImplementation(
			(_command: string, args: readonly string[], _options: SpawnOptions): ChildProcessWithoutNullStreams => {
				// args is ['--offline', 'exec', '--', 'vrt', '--help'] for main
				// or ['--offline', 'exec', '--', 'vrt', 'subcommand', '--help'] for subcommand
				const afterDash = args.slice(4); // Everything after 'vrt'

				if (afterDash[0] === '--help') {
					// Main vrt command
					return createMockChildProcess(mainHelpOutput);
				} else {
					// Subcommand - afterDash is ['subcommand', '--help']
					const subcommand = afterDash[0] as string;
					return createMockChildProcess(subcommandHelpOutputs[subcommand] || 'Unknown subcommand');
				}
			},
		);

		const documentation = await generateCommandDocumentation('vrt');
		const lines: string[] = documentation.split('\n');

		// Verify main command structure
		find('```console');
		find('$ vrt');
		find('Usage: vrt');
		find('Commands:');
		find('```');

		// Verify each subcommand structure
		for (const subcommand of subcommands) {
			find('# Subcommand: `vrt ' + subcommand);
			find('```console');
			find('$ vrt ' + subcommand);
			find('Usage: vrt ' + subcommand);
			find('Options:');
			find('```');
		}

		// Verify spawn was called correct number of times (1 main + 6 subcommands)
		expect(spawnSpy).toHaveBeenCalledTimes(7);

		function find(queryLine: string): void {
			while (true) {
				const line = lines.shift();
				if (line == null) {
					throw new Error(`line not found: "${queryLine}"`);
				}
				if (line.startsWith(queryLine)) return;
			}
		}
	});

	it('handles command with no subcommands', async () => {
		const helpOutput = `Usage: simple-cmd [options]

A simple command

Options:
  -h, --help  display help for command`;

		spawnSpy.mockImplementation((): ChildProcessWithoutNullStreams => {
			return createMockChildProcess(helpOutput);
		});

		const documentation = await generateCommandDocumentation('simple-cmd');

		expect(documentation).toContain('```console');
		expect(documentation).toContain('$ simple-cmd');
		expect(documentation).toContain('Usage: simple-cmd');
		expect(documentation).not.toContain('# Subcommand');
	});
});
