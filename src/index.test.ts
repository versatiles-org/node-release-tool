
import { jest } from '@jest/globals';
import type { Command } from 'commander';
import type { injectMarkdown } from './commands/markdown.js';

jest.unstable_mockModule('./commands/command.js', () => ({
	generateCommandDocumentation: jest.fn<typeof generateCommandDocumentation>().mockResolvedValue('generateCommandDocumentation'),
}));
const { generateCommandDocumentation } = await import('./commands/command.js');

jest.unstable_mockModule('./commands/markdown.js', () => ({
	injectMarkdown: jest.fn<typeof injectMarkdown>().mockReturnValue('injectMarkdown'),
	updateTOC: jest.fn<typeof updateTOC>().mockReturnValue('updateTOC'),
}));
const { updateTOC } = await import('./commands/markdown.js');

jest.unstable_mockModule('node:fs', () => ({
	existsSync: jest.fn<typeof existsSync>().mockReturnValue(true),
	readFileSync: jest.fn<typeof readFileSync>().mockReturnValue('readFileSync'),
	writeFileSync: jest.fn<typeof writeFileSync>().mockReturnValue(),
}));
const { existsSync, readFileSync, writeFileSync } = await import('node:fs');

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
		it('should generate markdown documentation from an executable', async () => {
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
			expect(updateTOC).toHaveBeenCalledWith('readFileSync', heading);
			expect(writeFileSync).toHaveBeenCalledWith(readme, 'updateTOC');
		});
	});

	async function run(...args: string[]): Promise<void> {
		console.log({ args });
		const moduleUrl = './index.js?t=' + Math.random();
		const module = await import(moduleUrl);

		const program = (module.program) as Command;
		await program.parseAsync(['node', 'vrt', ...args]);
	}
});
