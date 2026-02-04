#!/usr/bin/env npx tsx

import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import select from '@inquirer/select';
import { updateChangelog } from '../lib/changelog.js';
import { releaseError, validationError } from '../lib/errors.js';
import {
	COMMIT_TYPES,
	getGit,
	getSuggestedBump,
	groupCommitsByType,
	parseConventionalCommit,
	type ParsedCommit,
} from '../lib/git.js';
import { check, info, panic, warn } from '../lib/log.js';
import { withRetry } from '../lib/retry.js';
import { Shell } from '../lib/shell.js';

interface PackageJson {
	version: string;
	scripts: {
		check?: string;
		prepack?: string;
	};
	private?: boolean;
}

function isValidPackageJson(pkg: unknown): pkg is PackageJson {
	if (typeof pkg !== 'object' || pkg === null) return false;
	if (!('version' in pkg) || typeof pkg.version !== 'string') return false;
	if (!('scripts' in pkg) || typeof pkg.scripts !== 'object' || pkg.scripts === null) return false;
	return true;
}

export async function release(directory: string, branch = 'main', dryRun = false): Promise<void> {
	const shell = new Shell(directory);
	const { getCommitsBetween, getCurrentGitHubCommit, getLastGitHubTag } = getGit(directory);

	info(dryRun ? 'starting release process (dry-run)' : 'starting release process');

	// git: check if in the correct branch
	const currentBranch = await check('get branch name', shell.stdout('git rev-parse --abbrev-ref HEAD'));
	if (currentBranch !== branch) panic(`current branch is "${currentBranch}" but should be "${branch}"`);

	// git: check if no changes
	await check('are all changes committed?', checkThatNoUncommittedChanges());

	// git: pull (with retry for transient network failures)
	await check(
		'git pull',
		withRetry(() => shell.run('git pull -t'), {
			onRetry: (attempt, error) => warn(`git pull failed (attempt ${attempt}): ${error.message}, retrying...`),
		}),
	);

	// check package.json
	const pkgRaw: unknown = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
	if (!isValidPackageJson(pkgRaw)) panic('package.json is not valid');
	if (!('check' in pkgRaw.scripts)) panic('missing npm script "check" in package.json');
	if (!('prepack' in pkgRaw.scripts)) panic('missing npm script "prepack" in package.json');

	const pkg = pkgRaw;
	const isPrivatePackage = pkg.private === true;

	// npm: verify authentication (skip for private packages)
	if (!isPrivatePackage) {
		await check('verify npm authentication', verifyNpmAuth());
	}

	// get last version
	const tag = await check('get last github tag', getLastGitHubTag());
	const shaLast = tag?.sha;
	const versionLastGithub = tag?.version;

	const versionLastPackage = String(pkg.version);
	if (versionLastPackage !== versionLastGithub)
		warn(`versions differ in package.json (${versionLastPackage}) and last GitHub tag (${versionLastGithub})`);

	// get current sha
	const { sha: shaCurrent } = await check('get current github commit', getCurrentGitHubCommit());

	// get and parse commits for conventional commit support
	const commits = await check('get commits since last release', getCommitsBetween(shaLast, shaCurrent));
	const parsedCommits = commits.map(parseConventionalCommit);

	// handle version (with suggested bump based on conventional commits)
	const nextVersion = await getNewVersion(versionLastPackage, parsedCommits);

	// prepare release notes (grouped by conventional commit type)
	const releaseNotes = getReleaseNotes(nextVersion, parsedCommits);
	info('prepared release notes');

	if (dryRun) {
		info('Dry-run mode - the following actions would be performed:');
		info(`  Version: ${versionLastPackage} -> ${nextVersion}`);
		info('  Release notes:');
		releaseNotes.split('\n').forEach((line) => info(`    ${line}`));
		info('  Commands that would be executed:');
		info('    npm run check');
		info('    npm i --package-lock-only');
		info('    Update CHANGELOG.md');
		if (!isPrivatePackage) {
			info('    npm publish --access public');
		}
		info('    git add .');
		info(`    git commit -m "v${nextVersion}"`);
		info(`    git tag -f -a "v${nextVersion}" -m "new release: v${nextVersion}"`);
		info('    git push --no-verify --follow-tags');
		info(`    gh release create/edit "v${nextVersion}"`);
		info('Dry-run complete - no changes were made');
		return;
	}

	// test
	await check('run checks', shell.run('npm run check'));

	// update version
	await check('update version', setNextVersion(nextVersion));

	// update changelog
	const changelogResult = updateChangelog(directory, nextVersion, parsedCommits);
	if (changelogResult.created) {
		info('created CHANGELOG.md');
	} else {
		info('updated CHANGELOG.md');
	}

	if (!isPrivatePackage) {
		// npm publish (with retry for transient network failures)
		await check(
			'npm publish',
			withRetry(() => shell.runInteractive('npm publish --access public'), {
				onRetry: (attempt, error) => warn(`npm publish failed (attempt ${attempt}): ${error.message}, retrying...`),
			}),
		);
	}

	// git push
	await check('git add', shell.run('git add .'));
	await check('git commit', shell.run(`git commit -m "v${nextVersion}"`, false));
	await check('git tag', shell.run(`git tag -f -a "v${nextVersion}" -m "new release: v${nextVersion}"`));
	await check(
		'git push',
		withRetry(() => shell.run('git push --no-verify --follow-tags'), {
			onRetry: (attempt, error) => warn(`git push failed (attempt ${attempt}): ${error.message}, retrying...`),
		}),
	);

	// github release (with retry for transient network failures)
	const releaseTag = `v${nextVersion}`;
	if (await check('check github release', shell.ok(`gh release view ${releaseTag}`))) {
		await check(
			'edit release',
			withRetry(() => shell.exec('gh', ['release', 'edit', releaseTag, '--notes', releaseNotes]), {
				onRetry: (attempt, error) =>
					warn(`gh release edit failed (attempt ${attempt}): ${error.message}, retrying...`),
			}),
		);
	} else {
		await check(
			'create release',
			withRetry(() => shell.exec('gh', ['release', 'create', releaseTag, '--notes', releaseNotes]), {
				onRetry: (attempt, error) =>
					warn(`gh release create failed (attempt ${attempt}): ${error.message}, retrying...`),
			}),
		);
	}

	info('Finished');

	return;

	async function verifyNpmAuth(): Promise<void> {
		try {
			const username = await shell.stdout('npm whoami');
			if (!username || username.trim().length === 0) {
				throw releaseError('npm authentication failed: no username returned');
			}
			info(`authenticated as npm user: ${username.trim()}`);
		} catch {
			throw releaseError(
				'npm authentication required. Please run "npm login" first.\n' +
					'If you are using a CI environment, ensure NPM_TOKEN is set.',
			);
		}
	}

	async function checkThatNoUncommittedChanges(): Promise<void> {
		if ((await shell.stdout('git status --porcelain')).length < 3) return;
		throw releaseError('please commit all changes before releasing');
	}

	async function setNextVersion(version: string): Promise<void> {
		// set new version in package.json

		const packageJSON: { version: string } = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
		packageJSON.version = version;
		writeFileSync(resolve(directory, 'package.json'), JSON.stringify(packageJSON, null, '  ') + '\n');

		// rebuild package.json
		await shell.run('npm i --package-lock-only');
	}

	function getReleaseNotes(version: string, commits: ParsedCommit[]): string {
		const reversed = [...commits].reverse();
		const grouped = groupCommitsByType(reversed);

		let notes = `# Release v${version}\n\n`;

		// Order: breaking changes first, then features, fixes, and others
		const typeOrder: (keyof typeof COMMIT_TYPES | 'other')[] = [
			'feat',
			'fix',
			'perf',
			'refactor',
			'docs',
			'test',
			'build',
			'ci',
			'chore',
			'style',
			'revert',
			'other',
		];

		// Add breaking changes section if any
		const breakingCommits = reversed.filter((c) => c.breaking);
		if (breakingCommits.length > 0) {
			notes += '## Breaking Changes\n\n';
			for (const commit of breakingCommits) {
				notes += `- ${commit.description.replace(/\s+/g, ' ')}\n`;
			}
			notes += '\n';
		}

		// Add grouped commits
		for (const type of typeOrder) {
			const typeCommits = grouped.get(type);
			if (!typeCommits || typeCommits.length === 0) continue;

			// Skip commits already shown in breaking changes
			const nonBreaking = typeCommits.filter((c) => !c.breaking);
			if (nonBreaking.length === 0) continue;

			const label = type === 'other' ? 'Other Changes' : COMMIT_TYPES[type];
			notes += `## ${label}\n\n`;
			for (const commit of nonBreaking) {
				const scope = commit.scope ? `**${commit.scope}:** ` : '';
				notes += `- ${scope}${commit.description.replace(/\s+/g, ' ')}\n`;
			}
			notes += '\n';
		}

		return notes;
	}

	async function getNewVersion(versionPackage: string, commits: ParsedCommit[]): Promise<string> {
		// Determine suggested bump based on conventional commits
		const suggestedBump = getSuggestedBump(commits);
		// choices: [current, patch, minor, major] -> indices [0, 1, 2, 3]
		const suggestedIndex = suggestedBump === 'major' ? 3 : suggestedBump === 'minor' ? 2 : 1;

		const choices = [{ value: versionPackage }, { ...bump(2) }, { ...bump(1) }, { ...bump(0) }];

		// Add recommendation label to suggested version
		const suggestedChoice = choices[suggestedIndex];
		if (suggestedChoice && 'name' in suggestedChoice) {
			suggestedChoice.name += ' (recommended)';
		}

		const versionNew: string = await select({
			message: 'What should be the new version?',
			choices,
			default: suggestedChoice?.value ?? choices[1].value,
		});
		if (!versionNew) throw releaseError('no version selected');

		return versionNew;

		function bump(index: 0 | 1 | 2): { name: string; value: string } {
			const p = versionPackage.split('.').map((v) => parseInt(v, 10));
			if (p.length !== 3) throw validationError('invalid version format, expected x.y.z');
			switch (index) {
				case 0:
					p[0]++;
					p[1] = 0;
					p[2] = 0;
					break;
				case 1:
					p[1]++;
					p[2] = 0;
					break;
				case 2:
					p[2]++;
					break;
			}
			const name = p.map((n, i) => (i == index ? `\x1b[1m${n}` : `${n}`)).join('.') + '\x1b[22m';
			const value = p.join('.');
			return { name, value };
		}
	}
}
