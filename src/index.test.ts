import type { Command } from 'commander';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./commands/doc-command.js', () => ({
	generateCommandDocumentation: vi.fn().mockResolvedValue('generateCommandDocumentation'),
}));
const { generateCommandDocumentation } = await import('./commands/doc-command.js');

vi.mock('./commands/markdown.js', () => ({
	injectMarkdown: vi.fn().mockReturnValue('injectMarkdown'),
	updateTOC: vi.fn().mockReturnValue('updateTOC'),
}));


vi.mock(import('fs'), async (importOriginal) => {
	const fs = await importOriginal();
	return {
		...fs,
		existsSync: vi.fn(fs.existsSync),
		readFileSync: vi.fn(fs.readFileSync),
		writeFileSync: vi.fn(() => { }),
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

	describe('doc-command command', () => {
		it('should call generateCommandDocumentation', async () => {
			const command = 'test';

			await run('doc-command', command);

			expect(generateCommandDocumentation).toHaveBeenCalledWith(command);
			expect(mockStdout).toHaveBeenCalledWith('generateCommandDocumentation');
		});
	});

	describe('doc-toc command', () => {
		it('should insert doc-toc', async () => {
			const readme = rootDir + 'README.md';
			const heading = '## heading';

			await run('doc-toc', readme, heading);

			expect(existsSync).toHaveBeenCalledWith(readme);
			expect(readFileSync).toHaveBeenCalledWith(readme, 'utf8');
			expect(writeFileSync).toHaveBeenCalledWith(readme, 'updateTOC');
		});
	});

	async function run(...args: string[]): Promise<void> {
		console.log({ args });
		const moduleUrl = './index.js?t=' + Math.random().toString(16).slice(2);
		console.log(`Importing module from ${moduleUrl}`);
		const module = await import(moduleUrl);

		const program = (module.program) as Command;
		await program.parseAsync(['node', 'vrt', ...args]);
	}
});
