import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { createInterface } from 'readline/promises';
import { generateChangelogEntry, updateChangelog } from '../lib/changelog.js';
import { extractGitHubRepoUrl, parseConventionalCommit, type ParsedCommit } from '../lib/git.js';
import {
	getGitHubReleaseState,
	type GitHubReleaseState,
	isPassing,
	listPushRuns,
	type WorkflowRun,
} from '../lib/github.js';
import { info, markdown, panic, success, warn } from '../core/log.js';
import { formatDuration, waitForNpmRelease } from '../lib/npm-registry.js';
import {
	isPrerelease,
	publishOrder,
	readManifests,
	recommendVersion,
	resolveReleaseVersion,
	setManifestVersion,
} from '../lib/release-plan.js';
import { Shell } from '../core/shell.js';
import { getErrorMessage } from '../lib/utils.js';

/**
 * Options for {@link startRelease}.
 */
export interface StartReleaseOptions {
	/** `patch`, `minor`, `major` or a version; without it, a version is recommended and asked for. */
	version?: string;
	/** Run the checks and show what would happen, but change nothing. */
	dryRun?: boolean;
	/** Ask nothing: take the recommended version and confirm everything. */
	yes?: boolean;
	/** Do not require passing CI runs on the released commit (emergencies only). */
	skipCiCheck?: boolean;
	/** Finish the unfinished release without asking whether to. */
	resume?: boolean;
	/** The branch to release from (default: `main`). */
	branch?: string;
	/** Name of the workflow that the release tag starts (default: `Release`). */
	workflow?: string;
	/** Asks a question and returns the answer, replaceable in tests. */
	ask?: (question: string) => Promise<string>;
	/** Waits between two polls of GitHub, replaceable in tests. */
	sleep?: (ms: number) => Promise<void>;
	/** Returns the current time in milliseconds, replaceable in tests. */
	now?: () => number;
	/** The date of the release in CHANGELOG.md (default: today). */
	date?: Date;
}

/** Delay between two polls of GitHub. */
const POLL_INTERVAL_MS = 10_000;

/** How long to wait for GitHub to start a workflow run after a push. */
const START_TIMEOUT_MS = 3 * 60_000;

/**
 * Prepares a release and hands it to the release workflow. It never publishes anything itself.
 *
 * 1. Checks that the release can start: on the release branch, nothing uncommitted, not behind
 *    origin, and CI has not failed on this commit.
 * 2. Recommends a version from the conventional commits since the last release, unless one is
 *    given, and asks for it.
 * 3. Shows the version and the release notes generated from the commits, and asks once for
 *    confirmation.
 * 4. Pushes the commits that origin lacks and waits until CI has passed on them.
 * 5. Writes the version into every `package.json` (all workspaces share one version), adds the
 *    dated section to CHANGELOG.md, commits `release: vX.Y.Z`, tags it, and pushes commit and tag
 *    atomically. If anything fails before the push, the commit and the tag are undone.
 * 6. Watches the release workflow that the tag starts, says when it waits for approval, and
 *    confirms at the end that the packages are on npm and the GitHub release is published.
 *
 * If the release workflow of the current version did not finish, it offers to finish that
 * release instead: on the tagged commit it runs the failed jobs again, e.g. after an npm outage.
 * If commits were added since, e.g. to fix the code, it moves the tag to HEAD and releases that,
 * with the same version and changelog section, but only while nothing of the version is on npm.
 *
 * @param directory - The repository root.
 * @param options - See {@link StartReleaseOptions}.
 */
export async function startRelease(directory: string, options: StartReleaseOptions = {}): Promise<void> {
	const { dryRun, yes, skipCiCheck, resume, branch, workflow, ask, sleep, now, date, interactive } =
		withDefaults(options);

	const shell = new Shell(directory);
	const git = async (...args: string[]): Promise<string> => (await shell.exec('git', args, true, true)).stdout.trim();

	const manifests = readManifests(directory);
	const current = manifests[0].version;
	const currentTag = `v${current}`;
	const packageNames = publishOrder(manifests).map((manifest) => manifest.name as string);
	const rootPackage = JSON.parse(readFileSync(manifests[0].path, 'utf8')) as { repository?: unknown };
	const repoUrl = extractGitHubRepoUrl(rootPackage.repository);

	// a wrong version is reported before anything else happens
	if (options.version !== undefined) resolveReleaseVersion(current, options.version);

	const problems: string[] = [];
	let unpushed = 0;

	if (await finishedUnfinishedRelease()) return;

	const sha = await git('rev-parse', 'HEAD');
	await checkHead(sha);

	// commits since the last release
	const lastTag = await findLastTag();
	const commits = await getCommits(lastTag);
	if (commits.length === 0)
		panic(`there are no commits since ${lastTag ?? 'the start'}, so there is nothing to release`);

	const version = await chooseVersion(commits);
	const tag = `v${version}`;
	if ((await git('tag', '--list', tag)) !== '') problems.push(`tag ${tag} exists already`);

	// summary
	const notes = generateChangelogEntry(version, commits, date, { repoUrl });
	const prerelease = isPrerelease(version) ? ' (prerelease: npm dist-tag "next")' : '';
	process.stderr.write('\n');
	markdown(notes.trimEnd(), `${current} → ${version}${prerelease}`);
	if (unpushed > 0) info(`${unpushed} commit(s) are pushed to origin first, and CI has to pass on them`);

	panicOnProblems();
	if (dryRun) {
		success('dry run: all checks pass, nothing was changed');
		return;
	}
	if (!(await confirm(`Release ${tag} and push it to origin?`))) panic('aborted, nothing was changed');

	await pushAndAwaitCi(sha);
	const releaseSha = await createReleaseCommit(sha, version, commits);
	success(`pushed ${tag}`);
	await watchRelease(tag, releaseSha);

	/**
	 * Offers to finish the unfinished release of the current version.
	 *
	 * @returns Whether it was finished, so that no new release is started.
	 */
	async function finishedUnfinishedRelease(): Promise<boolean> {
		const unfinished = await findUnfinishedRelease();
		if (!unfinished) {
			if (resume) panic(`the release of ${currentTag} is finished, there is nothing to resume`);
			return false;
		}
		info(`the release of ${currentTag} is not finished`);
		const offer = interactive && options.version === undefined;
		if (resume || (offer && (await confirm(`Finish ${currentTag}?`, true)))) {
			await finishRelease(unfinished.commit, unfinished.run);
			return true;
		}
		info(`leaving it unfinished; "vrt release --resume" finishes it`);
		return false;
	}

	/**
	 * Returns the requested version, or recommends one from the commits and asks for it.
	 */
	async function chooseVersion(commits: ParsedCommit[]): Promise<string> {
		if (options.version !== undefined) return resolveReleaseVersion(current, options.version);
		const recommendation = recommendVersion(current, commits);
		info(`recommended version: ${recommendation.version} (${recommendation.reason})`);
		while (interactive) {
			const answer = (await ask(`Version to release [${recommendation.version}]: `)).trim();
			if (answer === '') break;
			try {
				return resolveReleaseVersion(current, answer);
			} catch (error) {
				warn(getErrorMessage(error));
			}
		}
		return recommendation.version;
	}

	/**
	 * Stops with all problems that the checks have found, if any.
	 */
	function panicOnProblems(): void {
		if (problems.length === 0) return;
		const prefix = dryRun ? 'dry run: ' : '';
		panic(`${prefix}${problems.length} check(s) failed, nothing was changed:\n  ${problems.join('\n  ')}`);
	}

	/**
	 * Asks a yes/no question. Without a terminal, `--yes` must be given.
	 */
	async function confirm(question: string, defaultYes = false): Promise<boolean> {
		if (yes) return true;
		if (!interactive) panic(`${question} Give --yes to confirm it without a terminal.`);
		const answer = (await ask(`${question} ${defaultYes ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
		return answer === '' ? defaultYes : answer === 'y' || answer === 'yes';
	}

	/**
	 * Checks that HEAD can be released and collects the problems. Also counts the commits that
	 * origin lacks.
	 */
	async function checkHead(sha: string): Promise<void> {
		const mismatched = manifests.filter((manifest) => manifest.version !== current);
		if (mismatched.length > 0) {
			problems.push(
				`all package.json files must share one version, but ${mismatched.map((m) => `${m.relative}/package.json`).join(', ')} differ from ${current}`,
			);
		}

		// not trimmed: the status columns start with a space
		const status = (await shell.exec('git', ['status', '--porcelain'], true, true)).stdout.trimEnd();
		if (status !== '') problems.push(`commit or stash the changes first:\n    ${status.split('\n').join('\n    ')}`);

		const currentBranch = await git('branch', '--show-current');
		if (currentBranch !== branch) problems.push(`on branch "${currentBranch}", but releases are made on "${branch}"`);

		await git('fetch', '--quiet', '--tags', 'origin', branch);
		const [behind, ahead] = (await git('rev-list', '--left-right', '--count', `origin/${branch}...HEAD`))
			.split(/\s+/)
			.map(Number);
		unpushed = ahead;
		if (behind > 0) problems.push(`origin has ${behind} commit(s) more, pull first`);

		if (!skipCiCheck && unpushed === 0) {
			const failed = (await listPushRuns(shell, branch, sha)).filter(
				(run) => run.status === 'completed' && !isPassing(run),
			);
			for (const run of failed)
				problems.push(`${run.workflowName} ended with "${run.conclusion}" on this commit: ${run.url}`);
		}
	}

	async function findLastTag(): Promise<string | undefined> {
		const result = await shell.exec('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'], false, true);
		return result.code === 0 ? result.stdout.trim() : undefined;
	}

	async function getCommits(since: string | undefined): Promise<ParsedCommit[]> {
		const log = await git('log', '--format=%H%x1f%s%x1e', since ? `${since}..HEAD` : 'HEAD');
		return log
			.split('\x1e')
			.map((entry) => entry.trim())
			.filter((entry) => entry !== '')
			.map((entry) => {
				const [commitSha, message] = entry.split('\x1f');
				return parseConventionalCommit({ sha: commitSha, message });
			});
	}

	/**
	 * Pushes the commits that origin lacks, and waits until CI has passed on HEAD.
	 */
	async function pushAndAwaitCi(sha: string): Promise<void> {
		if (unpushed > 0) {
			await git('push', 'origin', branch);
			success(`pushed ${unpushed} commit(s) to origin`);
		}
		if (skipCiCheck) return;

		const started = now();
		let reported = '';
		for (;;) {
			const runs = await listPushRuns(shell, branch, sha);
			const running = runs.filter((run) => run.status !== 'completed');
			if (runs.length > 0 && running.length === 0) {
				const failed = runs.filter((run) => !isPassing(run));
				if (failed.length > 0) {
					panic(
						`CI failed, nothing was released:\n  ${failed.map((run) => `${run.workflowName}: ${run.url}`).join('\n  ')}`,
					);
				}
				success('CI passed on this commit');
				return;
			}
			if (runs.length === 0 && now() - started > START_TIMEOUT_MS) {
				panic(`GitHub started no CI run for ${sha.slice(0, 9)}. Give --skip-ci-check to release without one.`);
			}
			const state =
				runs.length === 0
					? 'CI has not started yet'
					: `waiting for ${running.map((run) => run.workflowName).join(', ')}`;
			if (state !== reported) {
				info(state);
				reported = state;
			}
			await sleep(POLL_INTERVAL_MS);
		}
	}

	/**
	 * Writes the version and the changelog, commits, tags and pushes atomically. Until the push,
	 * nothing has left this machine, so a failure is undone and the release can start again.
	 *
	 * @returns The SHA of the release commit.
	 */
	async function createReleaseCommit(sha: string, version: string, commits: ParsedCommit[]): Promise<string> {
		const tag = `v${version}`;
		const changelogPath = resolve(directory, 'CHANGELOG.md');
		const changelogExisted = existsSync(changelogPath);
		const files = [
			'CHANGELOG.md',
			...manifests.map((manifest) => manifest.path),
			...(existsSync(resolve(directory, 'package-lock.json')) ? ['package-lock.json'] : []),
		];
		let committed = false;
		let tagged = false;
		try {
			for (const manifest of manifests) {
				writeFileSync(manifest.path, setManifestVersion(readFileSync(manifest.path, 'utf8'), version));
			}
			await shell.exec('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund']);
			updateChangelog(directory, version, commits, date, { repoUrl });

			await git('add', '--', ...files);
			await git('commit', '--quiet', '-m', `release: ${tag}`);
			committed = true;
			await git('tag', '--annotate', tag, '-m', `Release ${tag}`);
			tagged = true;
			await git('push', '--atomic', '--no-verify', 'origin', branch, tag);
		} catch (error) {
			if (tagged) await git('tag', '--delete', tag);
			if (committed) await git('reset', '--quiet', '--soft', sha);
			const tracked = changelogExisted ? files : files.filter((file) => file !== 'CHANGELOG.md');
			await git('checkout', '--quiet', 'HEAD', '--', ...tracked);
			if (!changelogExisted) {
				await git('reset', '--quiet', '--', 'CHANGELOG.md');
				rmSync(changelogPath, { force: true });
			}
			panic(`${getErrorMessage(error)}\nThe release commit and its tag were undone, nothing was released.`);
		}
		return git('rev-parse', 'HEAD');
	}

	/**
	 * Returns the latest run of the release workflow for a tag.
	 */
	async function findReleaseRun(tag: string): Promise<WorkflowRun | undefined> {
		return (await listPushRuns(shell, tag)).find((run) => run.workflowName === workflow);
	}

	/**
	 * Watches the release workflow until it has finished, and confirms that the packages are on
	 * npm and the GitHub release is published.
	 *
	 * @param restarted - Whether failed jobs were just started again, so that the run may still
	 *   show the result of its previous attempt for a moment.
	 */
	async function watchRelease(tag: string, commit: string, restarted = false): Promise<void> {
		info('watching the release workflow. It goes on without this command: Ctrl-C only stops watching.');
		const run = await awaitReleaseRun(tag, commit, restarted);
		if (!isPassing(run)) {
			panic(
				`the release workflow ended with "${run.conclusion}": ${run.url}\n` +
					`  gh run view ${run.databaseId} --log-failed\n` +
					`Then run "vrt release" again: it offers to finish ${tag}.`,
			);
		}
		if ((await getGitHubReleaseState(shell, tag)) !== 'published') {
			panic(`the release workflow succeeded, but the GitHub release ${tag} is missing or still a draft`);
		}
		success(`the GitHub release ${tag} is published`);

		// npm has accepted the packages, but serves a new version only after a few minutes
		const version = tag.slice(1);
		for (const name of packageNames) {
			const spec = `${name}@${version}`;
			const elapsed = await waitForNpmRelease(shell, name, version, { sleep, now });
			if (elapsed === undefined) {
				warn(`npm does not serve ${spec} yet, check it later with "npm view ${spec}"`);
			} else {
				success(`${spec} is on npm${elapsed > 0 ? ` after ${formatDuration(elapsed)}` : ''}`);
			}
		}

		success(`released ${tag}${repoUrl ? `: ${repoUrl}/releases/tag/${tag}` : ''}`);
	}

	/**
	 * Polls the release workflow of a tag on a commit until it has completed, reporting its
	 * progress, and says when it waits for the approval of the npm environment.
	 */
	async function awaitReleaseRun(tag: string, commit: string, restarted: boolean): Promise<WorkflowRun> {
		const started = now();
		let reported = '';
		for (;;) {
			const latest = await findReleaseRun(tag);
			const run = latest?.headSha === commit ? latest : undefined;
			const stale = restarted && run?.status === 'completed' && now() - started < 60_000;
			if (run?.status === 'completed' && !stale) return run;
			if (!run && now() - started > START_TIMEOUT_MS) {
				panic(
					`GitHub started no "${workflow}" workflow for ${tag}. Is the release workflow set up in this repository?`,
				);
			}
			const state = stale ? 'starting again' : (run?.status ?? 'not started yet').replace('_', ' ');
			if (state !== reported) {
				info(`the release workflow is ${state}${run ? `: ${run.url}` : ''}`);
				if (state === 'waiting') info('approve the deployment to the "npm" environment there');
				reported = state;
			}
			await sleep(POLL_INTERVAL_MS);
		}
	}

	/**
	 * The release of the current version is unfinished if its tag exists but its GitHub release
	 * is not published, which the release workflow does last.
	 */
	async function findUnfinishedRelease(): Promise<{ commit: string; run?: WorkflowRun } | undefined> {
		if ((await git('tag', '--list', currentTag)) === '') return undefined;
		const state: GitHubReleaseState = await getGitHubReleaseState(shell, currentTag);
		if (state === 'published') return undefined;
		const commit = await git('rev-list', '-n', '1', currentTag);
		return { commit, run: await findReleaseRun(currentTag) };
	}

	/**
	 * Finishes the release of the current version: runs the failed jobs again on the tagged
	 * commit, or moves the tag to HEAD if commits were added since.
	 */
	async function finishRelease(commit: string, run: WorkflowRun | undefined): Promise<void> {
		if (run && run.status !== 'completed') {
			info(`the release workflow of ${currentTag} is still running`);
			return watchRelease(currentTag, commit);
		}
		if (run) info(`the release workflow ended with "${run.conclusion}": ${run.url}`);

		const published: string[] = [];
		for (const name of packageNames) {
			const result = await shell.exec(
				'npm',
				['view', `${name}@${current}`, 'version', '--prefer-online'],
				false,
				true,
			);
			if (result.code === 0 && result.stdout.trim() === current) published.push(name);
		}
		info(published.length > 0 ? `on npm: ${published.join(', ')}` : 'nothing is on npm yet');

		const fixes = (await git('log', '--format=%h %s', `${commit}..HEAD`)).split('\n').filter((line) => line !== '');

		if (run && fixes.length === 0) {
			if (dryRun) {
				info(`dry run: would run the failed jobs of ${currentTag} again`);
				return;
			}
			if (!(await confirm(`Run the failed jobs of ${currentTag} again?`))) panic('aborted');
			await shell.exec('gh', ['run', 'rerun', String(run.databaseId), '--failed']);
			return watchRelease(currentTag, commit, true);
		}

		if (published.length > 0) {
			panic(
				`${currentTag} is partly published from ${commit.slice(0, 9)}, so its tag cannot move to another commit.\n` +
					(run ? `  To finish ${currentTag} as it is tagged: gh run rerun ${run.databaseId} --failed\n` : '') +
					'  To release the commits since then, release the next version: vrt release patch',
			);
		}
		const isAncestor = await shell.exec('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], false, true);
		if (isAncestor.code !== 0) panic(`${currentTag} (${commit.slice(0, 9)}) is not part of this branch`);

		const sha = await git('rev-parse', 'HEAD');
		await checkHead(sha);
		if (fixes.length > 0) {
			info(`${currentTag} moves from ${commit.slice(0, 9)} to HEAD, taking in:`);
			for (const fix of fixes) info(`  ${fix}`);
		}
		panicOnProblems();
		if (dryRun) {
			info(`dry run: would tag HEAD as ${currentTag} and release it`);
			return;
		}
		if (!(await confirm(`Tag HEAD as ${currentTag} and release it?`))) panic('aborted');

		await pushAndAwaitCi(sha);
		await git('tag', '--annotate', '--force', currentTag, '-m', `Release ${currentTag}`);
		// a tag pushed again to the commit it already points to starts no workflow, so it is
		// deleted on origin first; that fails if origin does not have it
		await shell.exec('git', ['push', '--no-verify', 'origin', `:refs/tags/${currentTag}`], false, true);
		await git('push', '--force', '--no-verify', 'origin', `refs/tags/${currentTag}`);
		success(`pushed ${currentTag}`);
		return watchRelease(currentTag, sha);
	}
}

/**
 * Fills in the defaults of {@link StartReleaseOptions}, and decides whether questions can be asked:
 * only without `--yes` and `--dry-run`, and on a terminal or with an `ask` function.
 */
function withDefaults(options: StartReleaseOptions) {
	const yes = options.yes ?? false;
	const dryRun = options.dryRun ?? false;
	return {
		dryRun,
		yes,
		skipCiCheck: options.skipCiCheck ?? false,
		resume: options.resume ?? false,
		branch: options.branch ?? 'main',
		workflow: options.workflow ?? 'Release',
		ask: options.ask ?? askOnTerminal,
		sleep: options.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms))),
		now: options.now ?? Date.now,
		date: options.date ?? new Date(),
		interactive: !yes && !dryRun && (options.ask !== undefined || process.stdin.isTTY === true),
	};
}

/**
 * Asks a question on the terminal. The question goes to stderr, like all other messages.
 */
async function askOnTerminal(question: string): Promise<string> {
	const rl = createInterface({ input: process.stdin, output: process.stderr });
	try {
		return await rl.question(question);
	} finally {
		rl.close();
	}
}
