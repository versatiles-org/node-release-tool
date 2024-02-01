/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/require-await */

import { jest } from '@jest/globals';
import type { Shell } from '../lib/shell.js';
import type { Git } from '../lib/git.js';

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
	panic: jest.fn((message: string) => {
		throw Error(message);
	}),
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
	let mockGit: {
		getCommitsBetween: jest.Mock<Git['getCommitsBetween']>;
		getCurrentGitHubCommit: jest.Mock<Git['getCurrentGitHubCommit']>;
		getLastGitHubTag: jest.Mock<Git['getLastGitHubTag']>;
	};
	let mockShell: {
		run: jest.Mock<Shell['run']>;
		stdout: jest.Mock<Shell['stdout']>;
		stderr: jest.Mock<Shell['stderr']>;
		ok: jest.Mock<Shell['ok']>;
	};

	beforeEach(() => {
		mockShell = {
			run: jest.fn(async (command: string, _errorOnCodeNonZero?: boolean) => {
				return { code: 0, signal: '', stdout: '', stderr: '' };
			}),
			stdout: jest.fn(async (command: string, errorOnCodeZero?: boolean): Promise<string> => {
				switch (command) {
					case 'git rev-parse --abbrev-ref HEAD': return 'main'; // get current branch
					case 'git status --porcelain': return ''; // no changes to commit
				}
				console.log('stdout:', command);
				throw Error();
			}),
			stderr: jest.fn(async (command: string, errorOnCodeZero?: boolean): Promise<string> => {
				throw Error();
			}),
			ok: jest.fn(async (command: string): Promise<boolean> => true),
		};
		jest.mocked(getShell).mockClear().mockReturnValue(mockShell);

		mockGit = {
			getCommitsBetween: jest.fn(async () => [
				{ sha: 'cccccccccccccccccccccccccccccccccccccccc', message: 'commit message 3', tag: undefined },
				{ sha: 'dddddddddddddddddddddddddddddddddddddddd', message: 'commit message 2', tag: undefined },
			]),
			getCurrentGitHubCommit: jest.fn(async () => ({
				sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', message: 'commit message 1', tag: undefined,
			})),
			getLastGitHubTag: jest.fn(async () => ({
				sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: '1.0.1',
			})),
		};
		jest.mocked(getGit).mockClear().mockReturnValue(mockGit);

		jest.mocked(readFileSync).mockClear().mockReturnValue(JSON.stringify({ version: '1.0.0', scripts: { check: '' } }));

		jest.mocked(inquirer.prompt).mockClear().mockResolvedValue({ versionNew: '1.1.0' });

		jest.mocked(check).mockClear().mockImplementation(async function <T>(message: string, promise: Promise<T>): Promise<T> {
			return promise;
		});
	});

	it('should execute the release process', async () => {
		await release('/test/directory', 'main');

		expect(jest.mocked(info).mock.calls).toStrictEqual([['starting release process'], ['Finished']]);
		expect(jest.mocked(warn).mock.calls).toStrictEqual([['versions differ in package.json (1.0.0) and last GitHub tag (1.0.1)']]);
		expect(jest.mocked(panic).mock.calls).toStrictEqual([]);
		expect(jest.mocked(check).mock.calls.map(v => v[0])).toStrictEqual([
			'get branch name',
			'are all changes committed?',
			'git pull',
			'get last github tag',
			'get current github commit',
			'prepare release notes',
			'update version',
			'run checks',
			'npm publish',
			'git add',
			'git commit',
			'git tag',
			'git push',
			'check github release',
			'edit release',
		]);

		expect(jest.mocked(readFileSync).mock.calls)
			.toStrictEqual([
				['/test/directory/package.json', 'utf8'],
				['/test/directory/package.json', 'utf8'],
			]);
		expect(jest.mocked(writeFileSync).mock.calls.map(v => [v[0], JSON.parse(v[1] as string) as unknown]))
			.toStrictEqual([
				['/test/directory/package.json', { version: '1.1.0', scripts: { check: '' } }],
			]);

		expect(jest.mocked(inquirer.prompt).mock.calls).toStrictEqual([[{
			choices: [
				'1.0.0',
				{ name: '1.0.\x1b[1m1\x1b[22m', value: '1.0.1' },
				{ name: '1.\x1b[1m1.0\x1b[22m', value: '1.1.0' },
				{ name: '\x1b[1m2.0.0\x1b[22m', value: '2.0.0' },
			],
			default: 1,
			message: 'What should be the new version?',
			name: 'versionNew',
			type: 'list',
		}]]);

		expect(jest.mocked(mockGit.getCommitsBetween).mock.calls).toStrictEqual([[
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
		]]);
		expect(jest.mocked(mockGit.getCurrentGitHubCommit).mock.calls).toStrictEqual([[]]);
		expect(jest.mocked(mockGit.getLastGitHubTag).mock.calls).toStrictEqual([[]]);

		expect(jest.mocked(mockShell.ok).mock.calls).toStrictEqual([['gh release view v1.1.0']]);
		expect(jest.mocked(mockShell.run).mock.calls).toStrictEqual([
			['git pull -t'],
			['npm i --package-lock-only'],
			['npm run check'],
			['npm publish --access public'],
			['git add .'],
			['git commit -m "v1.1.0"', false],
			['git tag -f -a "v1.1.0" -m "new release: v1.1.0"'],
			['git push --no-verify --follow-tags'],
			['echo -e \'\\x23 Release v1.1.0\\x0a\\x0achanges: \\x0a- commit message 2\\x0a- commit message 3\\x0a\\x0a\' | gh release edit "v1.1.0" -F -'],
		]);
		expect(jest.mocked(mockShell.stderr).mock.calls).toStrictEqual([]);
		expect(jest.mocked(mockShell.stdout).mock.calls).toStrictEqual([
			['git rev-parse --abbrev-ref HEAD'],
			['git status --porcelain'],
		]);
	});

	it('should error on wrong branch', async () => {
		await expect(release('/test/directory', 'dev')).rejects.toThrow('current branch is "main" but should be "dev"');
	});

	it('should error on missing scripts in package', async () => {
		jest.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '1.0.0', scripts: {  } }));
		await expect(release('/test/directory', 'main')).rejects.toThrow('missing npm script "check" in package.json');
	});
});
