import type { Shell } from '../lib/shell.js';
import type { Git } from '../lib/git.js';
import { beforeEach, describe, expect, it,  vi } from 'vitest';

vi.mock('@inquirer/select', () => ({
	default: vi.fn(),
}));
vi.mock('fs', () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));
vi.mock('../lib/log.js', () => ({
	check: vi.fn(),
	info: vi.fn(),
	panic: vi.fn((message: string) => {
		throw Error(message);
	}),
	warn: vi.fn(),
}));
vi.mock('../lib/shell.js', () => ({
	getShell: vi.fn(),
}));
vi.mock('../lib/git.js', () => ({
	getGit: vi.fn(),
}));

const select = (await import('@inquirer/select')).default;
const { readFileSync, writeFileSync } = await import('fs');
const { check, info, panic, warn } = await import('../lib/log.js');
const { getShell } = await import('../lib/shell.js');
const { getGit } = await import('../lib/git.js');
const { release } = await import('./release-npm.js');

describe('release function', () => {
	let mockGit: {
		getCommitsBetween: Git['getCommitsBetween'];
		getCurrentGitHubCommit: Git['getCurrentGitHubCommit'];
		getLastGitHubTag: Git['getLastGitHubTag'];
	};
	let mockShell: {
		run: Shell['run'];
		stdout: Shell['stdout'];
		stderr: Shell['stderr'];
		ok: Shell['ok'];
	};

	beforeEach(() => {
		mockShell = {
			run: vi.fn(async (_command: string, _errorOnCodeNonZero?: boolean) => {
				return { code: 0, signal: '', stdout: '', stderr: '' };
			}),
			stdout: vi.fn(async (command: string, _errorOnCodeZero?: boolean): Promise<string> => {
				switch (command) {
					case 'git rev-parse --abbrev-ref HEAD': return 'main'; // get current branch
					case 'git status --porcelain': return ''; // no changes to commit
				}
				console.log('stdout:', command);
				throw Error();
			}),
			stderr: vi.fn(async (_command: string, _errorOnCodeZero?: boolean): Promise<string> => {
				throw Error();
			}),
			ok: vi.fn(async (_command: string): Promise<boolean> => true),
		};
		vi.mocked(getShell).mockClear().mockReturnValue(mockShell);

		mockGit = {
			getCommitsBetween: vi.fn(async () => [
				{ sha: 'cccccccccccccccccccccccccccccccccccccccc', message: 'commit message 3', tag: undefined },
				{ sha: 'dddddddddddddddddddddddddddddddddddddddd', message: 'commit message 2', tag: undefined },
			]),
			getCurrentGitHubCommit: vi.fn(async () => ({
				sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', message: 'commit message 1', tag: undefined,
			})),
			getLastGitHubTag: vi.fn(async () => ({
				sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', version: '1.0.1',
			})),
		};
		vi.mocked(getGit).mockClear().mockReturnValue(mockGit);

		vi.mocked(readFileSync).mockClear().mockReturnValue(JSON.stringify({ version: '1.0.0', scripts: { check: '', prepack: '' } }));

		vi.mocked(select).mockClear().mockResolvedValue('1.1.0');

		vi.mocked(check).mockClear().mockImplementation(async function <T>(message: string, promise: Promise<T> | (() => Promise<T>)): Promise<T> {
			return (typeof promise == 'function' ? promise() : promise);
		});
	});

	it('should execute the release process', async () => {
		await release('/test/directory', 'main');

		expect(vi.mocked(info).mock.calls).toStrictEqual([['starting release process'], ['Finished']]);
		expect(vi.mocked(warn).mock.calls).toStrictEqual([['versions differ in package.json (1.0.0) and last GitHub tag (1.0.1)']]);
		expect(vi.mocked(panic).mock.calls).toStrictEqual([]);
		expect(vi.mocked(check).mock.calls.map(v => v[0])).toStrictEqual([
			'get branch name',
			'are all changes committed?',
			'git pull',
			'get last github tag',
			'get current github commit',
			'run checks',
			'update version',
			'prepare release notes',
			'npm publish',
			'git add',
			'git commit',
			'git tag',
			'git push',
			'check github release',
			'edit release',
		]);

		expect(vi.mocked(readFileSync).mock.calls)
			.toStrictEqual([
				['/test/directory/package.json', 'utf8'],
				['/test/directory/package.json', 'utf8'],
			]);
		expect(vi.mocked(writeFileSync).mock.calls.map(v => [v[0], JSON.parse(v[1] as string) as unknown]))
			.toStrictEqual([
				['/test/directory/package.json', { version: '1.1.0', scripts: { check: '', prepack: '' } }],
			]);

		expect(vi.mocked(select).mock.calls).toStrictEqual([[{
			choices: [
				{ value: '1.0.0' },
				{ name: '1.0.\x1b[1m1\x1b[22m', value: '1.0.1' },
				{ name: '1.\x1b[1m1.0\x1b[22m', value: '1.1.0' },
				{ name: '\x1b[1m2.0.0\x1b[22m', value: '2.0.0' },
			],
			default: '1.0.1',
			message: 'What should be the new version?',
		}]]);

		expect(vi.mocked(mockGit.getCommitsBetween).mock.calls).toStrictEqual([[
			'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
			'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
		]]);
		expect(vi.mocked(mockGit.getCurrentGitHubCommit).mock.calls).toStrictEqual([[]]);
		expect(vi.mocked(mockGit.getLastGitHubTag).mock.calls).toStrictEqual([[]]);

		expect(vi.mocked(mockShell.ok).mock.calls).toStrictEqual([['gh release view v1.1.0']]);
		expect(vi.mocked(mockShell.run).mock.calls).toStrictEqual([
			['git pull -t'],
			['npm run check'],
			['npm i --package-lock-only'],
			['npm publish --access public'],
			['git add .'],
			['git commit -m "v1.1.0"', false],
			['git tag -f -a "v1.1.0" -m "new release: v1.1.0"'],
			['git push --no-verify --follow-tags'],
			['echo -e \'\\x23 Release v1.1.0\\x0a\\x0achanges:\\x0a- commit message 2\\x0a- commit message 3\\x0a\\x0a\' | gh release edit "v1.1.0" -F -'],
		]);
		expect(vi.mocked(mockShell.stderr).mock.calls).toStrictEqual([]);
		expect(vi.mocked(mockShell.stdout).mock.calls).toStrictEqual([
			['git rev-parse --abbrev-ref HEAD'],
			['git status --porcelain'],
		]);
	});

	it('should error on wrong branch', async () => {
		await expect(release('/test/directory', 'dev')).rejects.toThrow('current branch is "main" but should be "dev"');
	});

	it('should error on missing scripts in package', async () => {
		vi.mocked(readFileSync).mockReturnValue(JSON.stringify({ version: '1.0.0', scripts: {} }));
		await expect(release('/test/directory', 'main')).rejects.toThrow('missing npm script "check" in package.json');
	});
});
