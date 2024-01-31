/* eslint-disable @typescript-eslint/no-unused-vars */
import { jest } from '@jest/globals';

jest.unstable_mockModule('inquirer', () => ({
	default: { prompt: jest.fn() },
}));
jest.unstable_mockModule('node:fs', () => ({
	readFileSync: jest.fn(),
	writeFileSync: jest.fn(),
}));
jest.unstable_mockModule('../lib/log.js', () => ({
	check: jest.fn(),
	info: jest.fn(),
	panic: jest.fn(),
	warn: jest.fn(),
}));
jest.unstable_mockModule('../lib/shell.js', () => ({
	getShell: jest.fn(),
}));
jest.unstable_mockModule('../lib/git.js', () => ({
	getGit: jest.fn(),
}));

const inquirer = (await import('inquirer')).default;
const { readFileSync, writeFileSync } = await import('node:fs');
const { check, info, panic, warn } = await import('../lib/log.js');
const { getShell } = await import('../lib/shell.js');
const { getGit } = await import('../lib/git.js');
const { release } = await import('./release.js');

describe('release function', () => {
	const directory = '/test/directory';
	const branch = 'main';
	const mockShell = {
		run: jest.fn(async (command: string, _errorOnCodeNonZero?: boolean) => {
			switch (command) {
				case 'git add .':
				case 'git pull -t':
				case 'git push --no-verify --follow-tags':
				case 'npm i --package-lock-only':
				case 'npm publish --access public':
				case 'npm run build':
				case 'npm run doc':
				case 'npm run lint':
				case 'npm run test':
					return { code: 0, signal: '', stdout: '', stderr: '' }
			}
			if (command.startsWith('git commit -m "v')) return { code: 0, signal: '', stdout: '', stderr: '' }
			if (command.startsWith('git tag -f -a "v')) return { code: 0, signal: '', stdout: '', stderr: '' }
			if (command.startsWith('echo -e')) return { code: 0, signal: '', stdout: '', stderr: '' }
			console.log('run:', command);
			throw Error()
		}),
		stdout: jest.fn(async (command: string, errorOnCodeZero?: boolean): Promise<string> => {
			switch (command) {
				case 'git rev-parse --abbrev-ref HEAD': return 'main'; // get current branch
				case 'git status --porcelain': return ''; // no changes to commit
			}
			console.log('stdout:', command);
			throw Error()
		}),
		stderr: jest.fn<ReturnType<typeof getShell>['stderr']>(),
		ok: jest.fn<ReturnType<typeof getShell>['ok']>(),
	}

	const mockGit = {
		getCommitsBetween: jest.fn(async () => [
			{ sha: 'cccccccccccccccccccccccccccccccccccccccc', message: 'commit message 3', tag: undefined, },
			{ sha: 'dddddddddddddddddddddddddddddddddddddddd', message: 'commit message 2', tag: undefined, }
		]),
		getCurrentGitHubCommit: jest.fn(async () => ({
			sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', message: 'commit message 1', tag: undefined,
		})),
		getLastGitHubTag: jest.fn(async () => ({
			sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: '1.0.1'
		})),
	};

	beforeEach(() => {
		jest.mocked(getShell).mockReturnValue(mockShell);
		jest.mocked(getGit).mockReturnValue(mockGit);
	});

	it('should execute the release process', async () => {
		jest.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '1.0.0' }));
		jest.mocked(inquirer.prompt).mockResolvedValue({ versionNew: '1.0.1' });
		jest.mocked(check).mockImplementation(async function check<T>(message: string, promise: Promise<T>): Promise<T> {
			return promise;
		});

		await release(directory, branch);

		expect(jest.mocked(info).mock.calls).toStrictEqual([['starting release process'], ['Finished']]);
		expect(jest.mocked(warn).mock.calls).toStrictEqual([['versions differ in package.json (1.0.0) and last GitHub tag (1.0.1)']]);
		expect(jest.mocked(panic).mock.calls).toStrictEqual([]);
		//expect(jest.mocked(check).mock.calls).toStrictEqual([]);

		expect(jest.mocked(readFileSync).mock.calls).toStrictEqual([
			['/test/directory/package.json', 'utf8',],
			['/test/directory/package.json', 'utf8',],
		]);
		expect(jest.mocked(writeFileSync).mock.calls).toStrictEqual([
			['/test/directory/package.json', '{\n  "version": "1.0.1"\n}\n'],
		]);

		expect(jest.mocked(inquirer.prompt).mock.calls).toStrictEqual([[{
			choices: [
				'1.0.0',
				{ name: '1.0.\x1b[1m1\x1b[22m', value: '1.0.1', },
				{ name: '1.\x1b[1m1.0\x1b[22m', value: '1.1.0', },
				{ name: '\x1b[1m2.0.0\x1b[22m', value: '2.0.0', },
			],
			default: 1,
			message: 'What should be the new version?',
			name: 'versionNew',
			type: 'list',
		}]]);

		expect(jest.mocked(mockGit.getCommitsBetween).mock.calls).toStrictEqual([
			['aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
		]);
		expect(jest.mocked(mockGit.getCurrentGitHubCommit).mock.calls).toStrictEqual([[]]);
		expect(jest.mocked(mockGit.getLastGitHubTag).mock.calls).toStrictEqual([[]]);
	});
});
