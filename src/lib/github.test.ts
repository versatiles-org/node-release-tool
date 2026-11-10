import { describe, expect, it, vi } from 'vitest';
import { getGitHubReleaseState, isPassing, listPushRuns, type WorkflowRun } from './github.js';
import type { Shell } from '../core/shell.js';

function fakeShell(result: { code?: number; stdout?: string; stderr?: string }) {
	const exec = vi.fn(async () => ({ code: 0, signal: null, stdout: '', stderr: '', ...result }));
	return { shell: { exec } as unknown as Shell, exec };
}

const run = (workflowName: string, databaseId: number, conclusion = 'success'): WorkflowRun => ({
	databaseId,
	status: 'completed',
	conclusion,
	url: `https://github.com/o/r/actions/runs/${databaseId}`,
	workflowName,
	event: 'push',
	headBranch: 'main',
	headSha: 'abc',
});

describe('listPushRuns', () => {
	it('keeps only the latest run of each workflow', async () => {
		const { shell, exec } = fakeShell({
			stdout: JSON.stringify([run('CI', 3, 'failure'), run('CodeQL', 2), run('CI', 1)]),
		});
		const runs = await listPushRuns(shell, 'main', 'abc');
		expect(runs.map((r) => r.databaseId)).toStrictEqual([3, 2]);
		expect(exec).toHaveBeenCalledWith(
			'gh',
			[
				'run',
				'list',
				'--branch',
				'main',
				'--event',
				'push',
				'--json',
				'databaseId,status,conclusion,url,workflowName,event,headBranch,headSha',
				'--limit',
				'50',
				'--commit',
				'abc',
			],
			true,
			true,
		);
	});
});

describe('isPassing', () => {
	it('accepts success, skipped and neutral', () => {
		expect(
			['success', 'skipped', 'neutral', 'failure', 'cancelled'].map((c) => isPassing(run('CI', 1, c))),
		).toStrictEqual([true, true, true, false, false]);
	});
});

describe('getGitHubReleaseState', () => {
	it('tells published, draft and missing releases apart', async () => {
		expect(await getGitHubReleaseState(fakeShell({ stdout: '{"isDraft":false}' }).shell, 'v1.0.0')).toBe('published');
		expect(await getGitHubReleaseState(fakeShell({ stdout: '{"isDraft":true}' }).shell, 'v1.0.0')).toBe('draft');
		expect(await getGitHubReleaseState(fakeShell({ code: 1, stderr: 'release not found' }).shell, 'v1.0.0')).toBe(
			'missing',
		);
	});

	it('fails if GitHub cannot be asked', async () => {
		await expect(getGitHubReleaseState(fakeShell({ code: 1, stderr: 'HTTP 502' }).shell, 'v1.0.0')).rejects.toThrow(
			'could not look up the GitHub release v1.0.0: HTTP 502',
		);
	});
});
