import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkflowRun } from '../lib/github.js';

vi.mock('../core/log.js', () => ({
	info: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
	panic: vi.fn((message: string) => {
		throw new Error(message);
	}),
}));

vi.mock('../lib/npm-registry.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../lib/npm-registry.js')>()),
	waitForNpmRelease: vi.fn(async () => 0),
}));

/**
 * The state of the repository and of GitHub as the fake shell answers it.
 */
interface FakeState {
	head: string;
	status: string;
	branch: string;
	/** `git rev-list --left-right --count origin/main...HEAD`: behind and ahead */
	revCount: string;
	tags: Map<string, string>;
	lastTag?: string;
	/** Subjects of the commits since the last tag, newest first */
	commits: string[];
	/** `git log --format=%h %s <tag>..HEAD` */
	fixes: string;
	ciRuns: () => WorkflowRun[];
	releaseRuns: (tag: string) => WorkflowRun[];
	githubReleases: Map<string, 'draft' | 'published'>;
	npm: Set<string>;
	failPush: boolean;
}

let state: FakeState;
async function fakeExec(command: string, args: string[], errorOnCodeNonZero = true) {
	const result = answer(command, args);
	const full = { code: 0, signal: null, stdout: '', stderr: '', ...result };
	if (full.code !== 0 && errorOnCodeNonZero) throw new Error(`${command} ${args.join(' ')} failed: ${full.stderr}`);
	return full;
}
const exec = vi.fn(fakeExec);
vi.mock('../core/shell.js', () => ({
	Shell: vi.fn(function () {
		return { exec };
	}),
}));

type Answer = { code?: number; stdout?: string; stderr?: string };

function answer(command: string, args: string[]): Answer {
	if (command === 'git') return answerGit(args);
	if (command === 'npm') return answerNpm(args);
	if (command === 'gh') return answerGh(args);
	throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
}

function answerGit(args: string[]): Answer {
	const line = args.join(' ');
	if (line === 'rev-parse HEAD') return { stdout: state.head };
	if (line === 'status --porcelain') return { stdout: state.status };
	if (line === 'branch --show-current') return { stdout: state.branch };
	if (line.startsWith('rev-list --left-right')) return { stdout: state.revCount };
	if (line.startsWith('describe'))
		return state.lastTag ? { stdout: state.lastTag } : { code: 128, stderr: 'No names found' };
	if (line.startsWith('log --format=%H')) {
		return { stdout: state.commits.map((subject, i) => `${String(i).repeat(40)}\x1f${subject}\x1e`).join('\n') };
	}
	if (line.startsWith('log --format=%h')) return { stdout: state.fixes };
	if (line.startsWith('tag --list')) return { stdout: state.tags.has(args[2]) ? args[2] : '' };
	if (line.startsWith('rev-list -n')) return { stdout: state.tags.get(args[3]) ?? '' };
	if (args[0] === 'commit') state.head = 'release-sha';
	if (line.startsWith('push --atomic') && state.failPush) return { code: 1, stderr: 'rejected' };
	return {};
}

function answerNpm(args: string[]): Answer {
	if (args[0] !== 'view') return {};
	const spec = args[1];
	return state.npm.has(spec) ? { stdout: spec.split('@').at(-1) } : { code: 1, stderr: 'E404' };
}

function answerGh(args: string[]): Answer {
	if (args[0] === 'run' && args[1] === 'list') {
		const ref = args[args.indexOf('--branch') + 1];
		return { stdout: JSON.stringify(ref === 'main' ? state.ciRuns() : state.releaseRuns(ref)) };
	}
	if (args[0] === 'release' && args[1] === 'view') {
		const release = state.githubReleases.get(args[2]);
		if (!release) return { code: 1, stderr: 'release not found' };
		return { stdout: JSON.stringify({ isDraft: release === 'draft' }) };
	}
	return {};
}

const run = (workflowName: string, headSha: string, fields: Partial<WorkflowRun> = {}): WorkflowRun => ({
	databaseId: 42,
	status: 'completed',
	conclusion: 'success',
	url: `https://github.com/o/r/actions/runs/42`,
	workflowName,
	event: 'push',
	headBranch: 'main',
	headSha,
	...fields,
});

const { info, warn } = await import('../core/log.js');
const { startRelease } = await import('./release.js');

describe('startRelease', () => {
	let directory: string;
	const sleep = vi.fn(async () => undefined);
	let clock: number;
	const now = () => (clock += 10_000);
	const date = new Date('2026-11-10T12:00:00Z');

	beforeEach(() => {
		vi.clearAllMocks();
		// clearAllMocks keeps implementations that a test replaced
		exec.mockImplementation(fakeExec);
		vi.spyOn(process.stderr, 'write').mockReturnValue(true);
		clock = 0;
		directory = mkdtempSync(join(tmpdir(), 'vrt-release-'));
		writeFileSync(
			join(directory, 'package.json'),
			JSON.stringify({ name: '@x/pkg', version: '1.0.0', repository: 'github:o/r' }, null, '\t') + '\n',
		);
		writeFileSync(join(directory, 'CHANGELOG.md'), '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n- first\n');
		state = {
			head: 'head-sha',
			status: '',
			branch: 'main',
			revCount: '0\t0',
			tags: new Map([['v1.0.0', 'old-sha']]),
			lastTag: 'v1.0.0',
			commits: ['feat: add a thing', 'chore: tidy up'],
			fixes: '',
			ciRuns: () => [run('CI', 'head-sha')],
			// every new tag gets a successful release run on the release commit
			releaseRuns: (tag) => (tag === 'v1.0.0' ? [] : [run('Release', 'release-sha', { headBranch: tag })]),
			githubReleases: new Map([['v1.0.0', 'published']]),
			npm: new Set(['@x/pkg@1.0.0']),
			failPush: false,
		};
		// the release workflow publishes the GitHub release once the tag is pushed
		const original = state.releaseRuns;
		state.releaseRuns = (tag) => {
			const runs = original(tag);
			if (runs.length > 0) state.githubReleases.set(tag, 'published');
			return runs;
		};
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	const gitCommands = () =>
		exec.mock.calls.filter((call) => call[0] === 'git').map((call) => (call[1] as string[]).join(' '));
	const messages = () => vi.mocked(info).mock.calls.map((call) => call[0]);
	const version = () =>
		(JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as { version: string }).version;

	it('releases the recommended version', async () => {
		await startRelease(directory, { yes: true, sleep, now, date });

		expect(version()).toBe('1.1.0');
		expect(readFileSync(join(directory, 'package.json'), 'utf8')).toContain('\t"version": "1.1.0"');
		const changelog = readFileSync(join(directory, 'CHANGELOG.md'), 'utf8');
		expect(changelog).toContain('## [1.1.0] - 2026-11-10\n\n### Features\n\n- add a thing');
		expect(changelog.indexOf('## [1.1.0]')).toBeLessThan(changelog.indexOf('## [1.0.0]'));

		expect(gitCommands()).toEqual(
			expect.arrayContaining([
				'commit --quiet -m release: v1.1.0',
				'tag --annotate v1.1.0 -m Release v1.1.0',
				'push --atomic --no-verify origin main v1.1.0',
			]),
		);
		expect(exec).toHaveBeenCalledWith('npm', [
			'install',
			'--package-lock-only',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
		]);
		expect(messages()).toContain('recommended version: 1.1.0 (a minor release)');
		expect(messages()).toContain('the GitHub release v1.1.0 is published');
		expect(messages()).toContain('@x/pkg@1.1.0 is on npm');
		expect(messages()).toContain('released v1.1.0: https://github.com/o/r/releases/tag/v1.1.0');
	});

	it('asks for the version and the confirmation', async () => {
		const ask = vi.fn(async (question: string) => (question.startsWith('Version') ? '2.0.0' : 'y'));
		await startRelease(directory, { ask, sleep, now, date });
		expect(ask.mock.calls.map((call) => call[0])).toStrictEqual([
			'Version to release [1.1.0]: ',
			'Release v2.0.0 and push it to origin? [y/N] ',
		]);
		expect(version()).toBe('2.0.0');
	});

	it('changes nothing in a dry run', async () => {
		await startRelease(directory, { dryRun: true, version: 'patch', sleep, now, date });
		expect(version()).toBe('1.0.0');
		expect(gitCommands().filter((command) => /^(commit|tag --annotate|push)/.test(command))).toStrictEqual([]);
		expect(messages()).toContain('dry run: all checks pass, nothing was changed');
	});

	it('requires --yes without a terminal', async () => {
		await expect(startRelease(directory, { version: 'patch', sleep, now, date })).rejects.toThrow(
			'Release v1.0.1 and push it to origin? Give --yes to confirm it without a terminal.',
		);
	});

	it('rejects an invalid version before anything else', async () => {
		await expect(startRelease(directory, { version: '0.9.0', yes: true })).rejects.toThrow('0.9.0 is not higher');
		expect(exec).not.toHaveBeenCalled();
	});

	it('reports every failed check and changes nothing', async () => {
		state.status = ' M src/index.ts';
		state.branch = 'feature';
		state.revCount = '2\t0';
		state.ciRuns = () => [run('CI', 'head-sha', { conclusion: 'failure' })];
		state.tags.set('v1.1.0', 'other-sha');
		state.githubReleases.set('v1.1.0', 'published');

		const error = await startRelease(directory, { yes: true, version: 'minor', sleep, now, date }).catch(
			(e: Error) => e,
		);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain('5 check(s) failed, nothing was changed');
		expect(message).toContain('commit or stash the changes first');
		expect(message).toContain('on branch "feature", but releases are made on "main"');
		expect(message).toContain('origin has 2 commit(s) more, pull first');
		expect(message).toContain('CI ended with "failure" on this commit');
		expect(message).toContain('tag v1.1.0 exists already');
		expect(version()).toBe('1.0.0');
	});

	it('refuses to release without commits', async () => {
		state.commits = [];
		await expect(startRelease(directory, { yes: true, sleep, now, date })).rejects.toThrow(
			'there are no commits since v1.0.0, so there is nothing to release',
		);
	});

	it('pushes unpushed commits and waits for CI first', async () => {
		state.revCount = '0\t2';
		let polls = 0;
		state.ciRuns = () => [run('CI', 'head-sha', polls++ < 2 ? { status: 'in_progress', conclusion: '' } : {})];
		await startRelease(directory, { yes: true, sleep, now, date });

		const commands = gitCommands();
		expect(commands.indexOf('push origin main')).toBeLessThan(commands.indexOf('commit --quiet -m release: v1.1.0'));
		expect(messages()).toContain('pushed 2 commit(s) to origin');
		expect(messages()).toContain('waiting for CI');
		expect(messages()).toContain('CI passed on this commit');
	});

	it('stops if CI fails on the pushed commits', async () => {
		state.revCount = '0\t1';
		state.ciRuns = () => [run('CI', 'head-sha', { conclusion: 'failure' })];
		await expect(startRelease(directory, { yes: true, sleep, now, date })).rejects.toThrow(
			'CI failed, nothing was released:\n  CI: https://github.com/o/r/actions/runs/42',
		);
		expect(version()).toBe('1.0.0');
	});

	it('undoes the release commit and the tag if the push fails', async () => {
		state.failPush = true;
		await expect(startRelease(directory, { yes: true, sleep, now, date })).rejects.toThrow(
			'The release commit and its tag were undone, nothing was released.',
		);
		expect(gitCommands().slice(-3)).toStrictEqual([
			'tag --delete v1.1.0',
			'reset --quiet --soft head-sha',
			`checkout --quiet HEAD -- CHANGELOG.md ${join(directory, 'package.json')}`,
		]);
	});

	it('reports a failed release workflow', async () => {
		state.releaseRuns = (tag) => (tag === 'v1.1.0' ? [run('Release', 'release-sha', { conclusion: 'failure' })] : []);
		await expect(startRelease(directory, { yes: true, sleep, now, date })).rejects.toThrow(
			'the release workflow ended with "failure"',
		);
	});

	it('says when the release workflow waits for approval', async () => {
		let polls = 0;
		state.releaseRuns = (tag) => {
			if (tag !== 'v1.1.0') return [];
			if (polls++ < 2) return [run('Release', 'release-sha', { status: 'waiting', conclusion: '' })];
			state.githubReleases.set(tag, 'published');
			return [run('Release', 'release-sha')];
		};
		await startRelease(directory, { yes: true, sleep, now, date });
		expect(messages()).toContain('approve the deployment to the "npm" environment there');
	});

	it('warns if npm does not serve the version in time', async () => {
		const { waitForNpmRelease } = await import('../lib/npm-registry.js');
		vi.mocked(waitForNpmRelease).mockResolvedValueOnce(undefined);
		await startRelease(directory, { yes: true, sleep, now, date });
		expect(warn).toHaveBeenCalledWith(
			'npm does not serve @x/pkg@1.1.0 yet, check it later with "npm view @x/pkg@1.1.0"',
		);
	});

	describe('an unfinished release', () => {
		beforeEach(() => {
			// v1.0.0 was tagged and pushed, but its workflow failed before publishing
			state.githubReleases.delete('v1.0.0');
			state.npm.clear();
			state.releaseRuns = (tag) =>
				tag === 'v1.0.0' ? [run('Release', 'old-sha', { conclusion: 'failure', headBranch: tag })] : [];
		});

		it('runs the failed jobs again', async () => {
			let rerun = false;
			exec.mockImplementation(async (command: string, args: string[], errorOnCodeNonZero = true) => {
				if (command === 'gh' && args[0] === 'run' && args[1] === 'rerun') rerun = true;
				if (rerun && command === 'gh' && args[1] === 'list') {
					state.githubReleases.set('v1.0.0', 'published');
					// the run shows its previous result for a moment after the restart
					return { code: 0, signal: null, stdout: JSON.stringify([run('Release', 'old-sha')]), stderr: '' };
				}
				const full = { code: 0, signal: null, stdout: '', stderr: '', ...answer(command, args) };
				if (full.code !== 0 && errorOnCodeNonZero) throw new Error(full.stderr);
				return full;
			});

			await startRelease(directory, { resume: true, yes: true, sleep, now, date });
			expect(exec).toHaveBeenCalledWith('gh', ['run', 'rerun', '42', '--failed']);
			expect(messages()).toContain('the release of v1.0.0 is not finished');
			expect(messages()).toContain('released v1.0.0: https://github.com/o/r/releases/tag/v1.0.0');
			expect(sleep).toHaveBeenCalled();
		});

		it('moves the tag to HEAD to release fixes', async () => {
			state.fixes = 'abc1234 fix: the build';
			state.releaseRuns = (tag) => {
				if (tag !== 'v1.0.0') return [];
				const moved = gitCommands().includes('push --force --no-verify origin refs/tags/v1.0.0');
				if (!moved) return [run('Release', 'old-sha', { conclusion: 'failure' })];
				state.githubReleases.set(tag, 'published');
				return [run('Release', 'head-sha')];
			};

			await startRelease(directory, { resume: true, yes: true, sleep, now, date });
			expect(gitCommands()).toEqual(
				expect.arrayContaining([
					'tag --annotate --force v1.0.0 -m Release v1.0.0',
					'push --no-verify origin :refs/tags/v1.0.0',
					'push --force --no-verify origin refs/tags/v1.0.0',
				]),
			);
			expect(messages()).toContain('  abc1234 fix: the build');
		});

		it('does not move the tag of a partly published version', async () => {
			state.fixes = 'abc1234 fix: the build';
			state.npm.add('@x/pkg@1.0.0');
			await expect(startRelease(directory, { resume: true, yes: true, sleep, now, date })).rejects.toThrow(
				'v1.0.0 is partly published from old-sha, so its tag cannot move to another commit.',
			);
			expect(gitCommands().some((command) => command.includes('--force'))).toBe(false);
		});

		it('can be left unfinished to release the next version', async () => {
			const ask = vi.fn(async (question: string) =>
				question.startsWith('Finish') ? 'n' : question.startsWith('Version') ? '' : 'y',
			);
			state.releaseRuns = (tag) => {
				if (tag === 'v1.0.0') return [run('Release', 'old-sha', { conclusion: 'failure' })];
				state.githubReleases.set(tag, 'published');
				return [run('Release', 'release-sha')];
			};
			await startRelease(directory, { ask, sleep, now, date });
			expect(ask.mock.calls[0][0]).toBe('Finish v1.0.0? [Y/n] ');
			expect(version()).toBe('1.1.0');
		});
	});

	it('treats a release with a published GitHub release as finished', async () => {
		await expect(startRelease(directory, { resume: true, yes: true, sleep, now, date })).rejects.toThrow(
			'the release of v1.0.0 is finished, there is nothing to resume',
		);
	});
});
