import type { Command } from 'commander';
import { Readable } from 'stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./commands/check.js', () => ({
	check: vi.fn(),
}));
const { check } = await import('./commands/check.js');

vi.mock('./commands/deps-graph.js', () => ({
	generateDependencyGraph: vi.fn().mockResolvedValue(undefined),
}));
const { generateDependencyGraph } = await import('./commands/deps-graph.js');

vi.mock('./commands/deps-upgrade.js', () => ({
	upgradeDependencies: vi.fn().mockResolvedValue(undefined),
}));
const { upgradeDependencies } = await import('./commands/deps-upgrade.js');

vi.mock('./commands/doc-command.js', () => ({
	generateCommandDocumentation: vi.fn().mockResolvedValue('generateCommandDocumentation'),
}));
const { generateCommandDocumentation } = await import('./commands/doc-command.js');

vi.mock('./commands/doc-typescript.js', () => ({
	generateTypescriptDocs: vi.fn().mockResolvedValue(undefined),
}));
const { generateTypescriptDocs } = await import('./commands/doc-typescript.js');

vi.mock('./commands/release-npm.js', () => ({
	release: vi.fn().mockResolvedValue(undefined),
}));
const { release } = await import('./commands/release-npm.js');

vi.mock('./commands/markdown.js', () => ({
	injectMarkdown: vi.fn().mockReturnValue('injectMarkdown'),
	updateTOC: vi.fn().mockReturnValue('updateTOC'),
}));
const { injectMarkdown } = await import('./commands/markdown.js');

vi.mock('./lib/log.js', () => ({
	setVerbose: vi.fn(),
}));
const { setVerbose } = await import('./lib/log.js');

vi.mock(import('fs'), async (importOriginal) => {
	const fs = await importOriginal();
	return {
		...fs,
		existsSync: vi.fn(fs.existsSync),
		readFileSync: vi.fn(fs.readFileSync),
		writeFileSync: vi.fn(() => {}),
	} as unknown as typeof import('fs');
});
const { existsSync, readFileSync, writeFileSync } = await import('fs');

const mockStdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

const rootDir = new URL('../', import.meta.url).pathname;

describe('release-tool CLI', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterAll(() => {
		vi.restoreAllMocks();
	});

	describe('verbose option', () => {
		it('should set verbose mode when -v flag is passed', async () => {
			await run('-v', 'check');

			expect(setVerbose).toHaveBeenCalledWith(true);
		});

		it('should set verbose mode when --verbose flag is passed', async () => {
			await run('--verbose', 'check');

			expect(setVerbose).toHaveBeenCalledWith(true);
		});
	});

	describe('check command', () => {
		it('should call check with current working directory', async () => {
			await run('check');

			expect(check).toHaveBeenCalledWith(process.cwd());
		});
	});

	describe('deps-graph command', () => {
		it('should call generateDependencyGraph with current working directory', async () => {
			await run('deps-graph');

			expect(generateDependencyGraph).toHaveBeenCalledWith(process.cwd());
		});
	});

	describe('deps-upgrade command', () => {
		it('should call upgradeDependencies with current working directory', async () => {
			await run('deps-upgrade');

			expect(upgradeDependencies).toHaveBeenCalledWith(process.cwd());
		});
	});

	describe('doc-command command', () => {
		it('should call generateCommandDocumentation', async () => {
			const command = 'test';

			await run('doc-command', command);

			expect(generateCommandDocumentation).toHaveBeenCalledWith(command);
			expect(mockStdout).toHaveBeenCalledWith('generateCommandDocumentation');
		});
	});

	describe('doc-insert command', () => {
		it('should read from stdin and insert markdown into file', async () => {
			const readme = rootDir + 'README.md';
			const heading = '## API';
			const stdinContent = 'test content';

			const originalStdin = process.stdin;
			const mockStdin = Readable.from([Buffer.from(stdinContent)]);
			Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

			try {
				await run('doc-insert', readme, heading);

				expect(existsSync).toHaveBeenCalledWith(readme);
				expect(readFileSync).toHaveBeenCalledWith(readme, 'utf8');
				expect(injectMarkdown).toHaveBeenCalledWith(
					expect.any(String),
					'<!--- This chapter is generated automatically --->\n' + stdinContent,
					heading,
					false,
				);
				expect(writeFileSync).toHaveBeenCalledWith(readme, 'injectMarkdown');
			} finally {
				Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true });
			}
		});

		it('should exit with error for non-existent file', async () => {
			const nonExistentFile = '/non/existent/file.md';

			// Commander calls process.exit(1) for invalid arguments
			await expect(run('doc-insert', nonExistentFile)).rejects.toThrow('process.exit');
		});
	});

	describe('doc-toc command', () => {
		it('should update TOC in file', async () => {
			const readme = rootDir + 'README.md';
			const heading = '## heading';

			await run('doc-toc', readme, heading);

			expect(existsSync).toHaveBeenCalledWith(readme);
			expect(readFileSync).toHaveBeenCalledWith(readme, 'utf8');
			expect(writeFileSync).toHaveBeenCalledWith(readme, 'updateTOC');
		});

		it('should exit with error for non-existent file', async () => {
			const nonExistentFile = '/non/existent/file.md';

			// Commander calls process.exit(1) for invalid arguments
			await expect(run('doc-toc', nonExistentFile)).rejects.toThrow('process.exit');
		});
	});

	describe('doc-typescript command', () => {
		it('should call generateTypescriptDocs with default options', async () => {
			await run('doc-typescript');

			expect(generateTypescriptDocs).toHaveBeenCalledWith({});
		});

		it('should call generateTypescriptDocs with input option', async () => {
			await run('doc-typescript', '-i', './src/main.ts');

			expect(generateTypescriptDocs).toHaveBeenCalledWith({
				input: './src/main.ts',
			});
		});

		it('should call generateTypescriptDocs with output option', async () => {
			await run('doc-typescript', '-o', './api-docs');

			expect(generateTypescriptDocs).toHaveBeenCalledWith({
				output: './api-docs',
			});
		});

		it('should call generateTypescriptDocs with format option', async () => {
			await run('doc-typescript', '-f', 'html');

			expect(generateTypescriptDocs).toHaveBeenCalledWith({
				format: 'html',
			});
		});

		it('should call generateTypescriptDocs with all options', async () => {
			await run('doc-typescript', '--input', './src/lib.ts', '--output', './docs', '--format', 'wiki');

			expect(generateTypescriptDocs).toHaveBeenCalledWith({
				input: './src/lib.ts',
				output: './docs',
				format: 'wiki',
			});
		});
	});

	describe('release-npm command', () => {
		it('should call release with default path and options', async () => {
			await run('release-npm');

			expect(release).toHaveBeenCalledWith(process.cwd(), 'main', false);
		});

		it('should call release with specified path', async () => {
			await run('release-npm', './packages/core');

			expect(release).toHaveBeenCalledWith(expect.stringContaining('packages/core'), 'main', false);
		});

		it('should call release with dry-run flag', async () => {
			await run('release-npm', '-n');

			expect(release).toHaveBeenCalledWith(process.cwd(), 'main', true);
		});

		it('should call release with --dry-run flag', async () => {
			await run('release-npm', '--dry-run');

			expect(release).toHaveBeenCalledWith(process.cwd(), 'main', true);
		});

		it('should call release with path and dry-run flag', async () => {
			await run('release-npm', '-n', './packages/cli');

			expect(release).toHaveBeenCalledWith(expect.stringContaining('packages/cli'), 'main', true);
		});
	});

	async function run(...args: string[]): Promise<void> {
		const moduleUrl = './index.js?t=' + Math.random().toString(16).slice(2);
		const module = await import(moduleUrl);

		const program = module.program as Command;
		await program.parseAsync(['node', 'vrt', ...args]);
	}
});
