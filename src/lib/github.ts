import { releaseError } from '../core/errors.js';
import type { Shell } from '../core/shell.js';

/**
 * A GitHub Actions workflow run, as `gh run list --json` describes it.
 */
export interface WorkflowRun {
	databaseId: number;
	/** `queued`, `in_progress`, `waiting` (for an approval), `completed`, … */
	status: string;
	/** `success`, `failure`, `cancelled`, `skipped`, …, or `''` while the run is not completed. */
	conclusion: string;
	url: string;
	workflowName: string;
	event: string;
	/** The branch or, for a pushed tag, the tag the run was started for. */
	headBranch: string;
	headSha: string;
}

const RUN_FIELDS = 'databaseId,status,conclusion,url,workflowName,event,headBranch,headSha';

/** Conclusions of completed runs that do not stand in the way of a release. */
const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/**
 * Whether a completed run has passed.
 */
export function isPassing(run: WorkflowRun): boolean {
	return PASSING_CONCLUSIONS.has(run.conclusion);
}

/**
 * Lists the workflow runs started by pushes to a branch or of a tag, newest first.
 *
 * @param shell - Shell in the repository.
 * @param ref - The branch or tag name.
 * @param commit - If given, only runs of this commit.
 * @returns The runs; for each workflow only its latest run.
 */
export async function listPushRuns(shell: Shell, ref: string, commit?: string): Promise<WorkflowRun[]> {
	const args = ['run', 'list', '--branch', ref, '--event', 'push', '--json', RUN_FIELDS, '--limit', '50'];
	if (commit !== undefined) args.push('--commit', commit);
	const { stdout } = await shell.exec('gh', args, true, true);
	const runs = JSON.parse(stdout) as WorkflowRun[];
	// gh lists newest first, so the first run of each workflow is its latest
	const latest = new Map<string, WorkflowRun>();
	for (const run of runs) if (!latest.has(run.workflowName)) latest.set(run.workflowName, run);
	return [...latest.values()];
}

/**
 * The state of the GitHub release of a tag.
 */
export type GitHubReleaseState = 'missing' | 'draft' | 'published';

/**
 * Looks up whether the GitHub release of a tag exists and is published.
 *
 * @param shell - Shell in the repository.
 * @param tag - The tag, e.g. `v1.2.3`.
 */
export async function getGitHubReleaseState(shell: Shell, tag: string): Promise<GitHubReleaseState> {
	const result = await shell.exec('gh', ['release', 'view', tag, '--json', 'isDraft'], false, true);
	if (result.code !== 0) {
		if (/not found/i.test(result.stderr)) return 'missing';
		throw releaseError(`could not look up the GitHub release ${tag}: ${result.stderr.trim()}`);
	}
	return (JSON.parse(result.stdout) as { isDraft: boolean }).isDraft ? 'draft' : 'published';
}
