import type { ChildProcessWithoutNullStreams, ChildProcessByStdio, SpawnOptions } from 'child_process';
import cp from 'child_process';
import { EventEmitter } from 'events';
import type { Writable } from 'stream';
import { Readable } from 'stream';
import { generateCommandDocumentation } from './doc-command.js';
import { jest } from '@jest/globals';

describe('generateCommandDocumentation using mocked spawn', () => {
	// Mock implementation of spawn

	const spawnSpy = jest.spyOn(cp, 'spawn');

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	spawnSpy.mockImplementation((command: string, args: readonly string[], options: SpawnOptions): ChildProcessWithoutNullStreams => {
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
		jest.restoreAllMocks();
	});

	it('generates documentation for a CLI command', async () => {
		const documentation = await generateCommandDocumentation('example-command');
		expect(documentation).toBe('```console\n$ example-command\nExample command output for npx example-command --help\n```\n');

		const lastCall = spawnSpy.mock.calls.pop();
		expect(lastCall?.slice(0, 2)).toStrictEqual(['npx', ['example-command', '--help']]);
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

		function find(text: string): void {
			while (true) {
				const line = lines.shift();
				if (line == null) {
					console.log(documentation.split('\n'));
					throw new Error(`line not found: "${text}"`);
				}
				if (line.startsWith(text)) return;
			}
		}
	}, 30e3);
});
