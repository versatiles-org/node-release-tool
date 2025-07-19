import { jest } from '@jest/globals';
import type { Command } from 'commander';
import type { injectMarkdown, updateTOC } from './commands/markdown.js';

jest.unstable_mockModule('./commands/doc-command.js', () => ({
	generateCommandDocumentation: jest.fn<typeof generateCommandDocumentation>().mockResolvedValue('generateCommandDocumentation'),
}));
const { generateCommandDocumentation } = await import('./commands/doc-command.js');

jest.unstable_mockModule('./commands/markdown.js', () => ({
	injectMarkdown: jest.fn<typeof injectMarkdown>().mockReturnValue('injectMarkdown'),
	updateTOC: jest.fn<typeof updateTOC>().mockReturnValue('updateTOC'),
}));

const fs = await import('fs');
jest.unstable_mockModule('fs', () => ({
	...fs,
	existsSync: jest.fn(fs.existsSync),
	readFileSync: jest.fn(fs.readFileSync),
	writeFileSync: jest.fn<typeof writeFileSync>().mockReturnValue(),
}));
const { existsSync, readFileSync, writeFileSync } = await import('fs');

const mockStdout = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);

const rootDir = new URL('../', import.meta.url).pathname;

describe('release-tool CLI', () => {
	beforeEach(() => {
		jest.clearAllMocks();
	});

	afterAll(() => {
		jest.restoreAllMocks();
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
		const moduleUrl = './index.js?t=' + Math.random();
		console.log(`Importing module from ${moduleUrl}`);
		const module = await import(moduleUrl);

		const program = (module.program) as Command;
		await program.parseAsync(['node', 'vrt', ...args]);
	}
});
