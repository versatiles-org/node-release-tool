import type { ChildProcessWithoutNullStreams, ChildProcessByStdio, SpawnOptions } from 'child_process';
import cp from 'child_process';
import { EventEmitter } from 'events';
import type { Writable } from 'stream';
import { Readable } from 'stream';
import { generateCommandDocumentation } from './doc-command.js';
import { afterAll, describe, expect, it, vi } from 'vitest';

describe('generateCommandDocumentation using mocked spawn', () => {
	// Mock implementation of spawn

	const spawnSpy = vi.spyOn(cp, 'spawn');

	spawnSpy.mockImplementation((command: string, args: readonly string[], _options: SpawnOptions): ChildProcessWithoutNullStreams => {
		const mockChildProcess = new EventEmitter() as ChildProcessByStdio<Writable, Readable, Readable>;
		mockChildProcess.stdout = getReader('Example command output for ' + [command, ...args].join(' '));
		mockChildProcess.stderr = getReader('');

		process.nextTick(() => mockChildProcess.emit('close', 0));

		return mockChildProcess;

		function getReader(text: string): Readable {
			const r = new Readable();
			r._read = (): void => {
				return;
			};
			r.push(text);
			r.push(null);
			return r;
		}
	});

	afterAll(() => {
		vi.restoreAllMocks();
	});

	it('generates documentation for a CLI command', async () => {
		const documentation = await generateCommandDocumentation('example-command');
		expect(documentation).toBe('```console\n$ example-command\nExample command output for npm --offline exec -- example-command --help\n```\n');

		const lastCall = spawnSpy.mock.calls.pop();
		expect(lastCall?.slice(0, 2)).toStrictEqual([
			'npm', ['--offline', 'exec', '--', 'example-command', '--help']]);
	});
});

describe('generateCommandDocumentation', () => {
	it('generates documentation for vrt', async () => {
		const documentation = await generateCommandDocumentation('vrt');
		const lines: string[] = documentation.split('\n');

		find('```console');
		find('$ vrt');
		find('Usage: vrt');
		find('Commands:');
		find('```');

		[
			'deps-graph',
			'deps-upgrade',
			'doc-command',
			'doc-insert',
			'doc-toc',
			'release-npm'
		].forEach(subcommand => {
			find('# Subcommand: `vrt ' + subcommand);
			find('```console');
			find('$ vrt ' + subcommand);
			find('Usage: vrt ' + subcommand);
			find('Options:');
			find('```');
		});

		function find(queryLine: string): void {
			while (true) {
				const line = lines.shift();
				if (line == null) {
					console.log(documentation.split('\n'));
					throw new Error(`line not found: "${queryLine}"`);
				}
				if (line.startsWith(queryLine)) return;
			}
		}
	}, 30e3);
});
