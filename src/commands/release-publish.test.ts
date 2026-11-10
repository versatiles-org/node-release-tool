import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/log.js', () => ({
	check: vi.fn(async (_message: string, promise: Promise<unknown>) => promise),
	info: vi.fn(),
}));

/** Answers of the fake shell, keyed by the command line. */
let answers: Record<string, { code?: number; stdout?: string; stderr?: string }>;
const exec = vi.fn(async (command: string, args: string[]) => {
	const answer = answers[[command, ...args].join(' ')] ?? {};
	return { code: 0, signal: null, stdout: '', stderr: '', ...answer };
});
const stdout = vi.fn(async (command: string) => (command === 'npm --version' ? npmVersion : ''));
let npmVersion = '11.6.0';
vi.mock('../lib/shell.js', () => ({
	Shell: vi.fn(function () {
		return { exec, stdout };
	}),
}));

const { info } = await import('../lib/log.js');
const { releasePublish } = await import('./release-publish.js');

describe('releasePublish', () => {
	let directory: string;
	let notes: string;

	beforeEach(() => {
		vi.clearAllMocks();
		npmVersion = '11.6.0';
		directory = mkdtempSync(join(tmpdir(), 'vrt-release-publish-'));
		notes = join(directory, 'notes.md');
		writeFileSync(notes, '- notes\n');
		writeRelease('1.2.0', ['core', 'cli']);
		answers = {
			'npm view core@1.2.0 version --prefer-online': { code: 1, stderr: 'E404' },
			'npm view cli@1.2.0 version --prefer-online': { code: 1, stderr: 'E404' },
			'gh release view v1.2.0 --json isDraft': { code: 1, stderr: 'release not found' },
		};
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	function writeRelease(version: string, names: string[]): void {
		const packages = names.map((name) => ({ name, file: `${name}-${version}.tgz` }));
		writeFileSync(join(directory, 'packages.json'), JSON.stringify({ version, packages }));
	}

	const commands = () =>
		exec.mock.calls.map((call) => [call[0], ...call[1]].join(' ')).filter((line) => !line.startsWith('npm view'));

	it('publishes the packages in order, then creates the GitHub release', async () => {
		await releasePublish(directory, 'v1.2.0');
		expect(commands()).toStrictEqual([
			'npm publish ./core-1.2.0.tgz --access public --tag latest --provenance',
			'npm publish ./cli-1.2.0.tgz --access public --tag latest --provenance',
			'gh release view v1.2.0 --json isDraft',
			`gh release create v1.2.0 --verify-tag --title v1.2.0 --notes-file ${notes} --latest`,
		]);
	});

	it('skips versions that are on npm and keeps a published GitHub release', async () => {
		answers['npm view core@1.2.0 version --prefer-online'] = { stdout: '1.2.0\n' };
		answers['gh release view v1.2.0 --json isDraft'] = { stdout: '{"isDraft":false}' };
		await releasePublish(directory, 'v1.2.0');
		expect(commands()).toStrictEqual([
			'npm publish ./cli-1.2.0.tgz --access public --tag latest --provenance',
			'gh release view v1.2.0 --json isDraft',
		]);
		expect(info).toHaveBeenCalledWith('core@1.2.0 is already on npm, skipping it');
		expect(info).toHaveBeenCalledWith('the GitHub release v1.2.0 is already published, leaving it unchanged');
	});

	it('publishes prereleases with the dist-tag "next" and publishes a draft release', async () => {
		writeRelease('2.0.0-rc.0', ['core']);
		answers = {
			'npm view core@2.0.0-rc.0 version --prefer-online': { code: 1 },
			'gh release view v2.0.0-rc.0 --json isDraft': { stdout: '{"isDraft":true}' },
		};
		await releasePublish(directory, 'v2.0.0-rc.0');
		expect(commands()).toStrictEqual([
			'npm publish ./core-2.0.0-rc.0.tgz --access public --tag next --provenance',
			'gh release view v2.0.0-rc.0 --json isDraft',
			`gh release edit v2.0.0-rc.0 --draft=false --notes-file ${notes} --prerelease`,
		]);
	});

	it('only creates the GitHub release if every package is private', async () => {
		writeRelease('1.2.0', []);
		await releasePublish(directory, 'v1.2.0');
		expect(stdout).not.toHaveBeenCalled();
		expect(commands()).toStrictEqual([
			'gh release view v1.2.0 --json isDraft',
			`gh release create v1.2.0 --verify-tag --title v1.2.0 --notes-file ${notes} --latest`,
		]);
	});

	it('refuses a tag that does not match the packages', async () => {
		await expect(releasePublish(directory, 'v1.3.0')).rejects.toThrow(
			'the packages have version 1.2.0, but the tag is v1.3.0',
		);
		expect(exec).not.toHaveBeenCalled();
	});

	it('refuses an npm that is too old for trusted publishing', async () => {
		npmVersion = '10.9.2';
		await expect(releasePublish(directory, 'v1.2.0')).rejects.toThrow(
			'npm 10.9.2 is too old for trusted publishing, it needs 11.5.1 or later',
		);
		expect(exec).not.toHaveBeenCalled();
	});
});
