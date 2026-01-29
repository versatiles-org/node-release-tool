#!/usr/bin/env npx tsx

import { readFileSync, writeFileSync } from 'fs';
import select from '@inquirer/select';
import { releaseError, validationError } from '../lib/errors.js';
import { check, info, panic, warn } from '../lib/log.js';
import { Shell } from '../lib/shell.js';
import { getGit } from '../lib/git.js';
import { resolve } from 'path';

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

	// git: pull
	await check('git pull', shell.run('git pull -t'));

	// check package.json
	const pkgRaw: unknown = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
	if (!isValidPackageJson(pkgRaw)) panic('package.json is not valid');
	if (!('check' in pkgRaw.scripts)) panic('missing npm script "check" in package.json');
	if (!('prepack' in pkgRaw.scripts)) panic('missing npm script "prepack" in package.json');

	const pkg = pkgRaw;

	// get last version
	const tag = await check('get last github tag', getLastGitHubTag());
	const shaLast = tag?.sha;
	const versionLastGithub = tag?.version;

	const versionLastPackage = String(pkg.version);
	if (versionLastPackage !== versionLastGithub)
		warn(`versions differ in package.json (${versionLastPackage}) and last GitHub tag (${versionLastGithub})`);

	// get current sha
	const { sha: shaCurrent } = await check('get current github commit', getCurrentGitHubCommit());

	// handle version
	const nextVersion = await getNewVersion(versionLastPackage);

	// prepare release notes
	const releaseNotes = await check('prepare release notes', getReleaseNotes(nextVersion, shaLast, shaCurrent));

	if (dryRun) {
		info('Dry-run mode - the following actions would be performed:');
		info(`  Version: ${versionLastPackage} -> ${nextVersion}`);
		info('  Release notes:');
		releaseNotes.split('\n').forEach((line) => info(`    ${line}`));
		info('  Commands that would be executed:');
		info('    npm run check');
		info('    npm i --package-lock-only');
		if (!('private' in pkg) || !pkg.private) {
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

	if (!('private' in pkg) || !pkg.private) {
		// npm publish
		await check('npm publish', shell.runInteractive('npm publish --access public'));
	}

	// git push
	await check('git add', shell.run('git add .'));
	await check('git commit', shell.run(`git commit -m "v${nextVersion}"`, false));
	await check('git tag', shell.run(`git tag -f -a "v${nextVersion}" -m "new release: v${nextVersion}"`));
	await check('git push', shell.run('git push --no-verify --follow-tags'));

	// github release
	const releaseTag = `v${nextVersion}`;
	if (await check('check github release', shell.ok(`gh release view ${releaseTag}`))) {
		await check('edit release', shell.exec('gh', ['release', 'edit', releaseTag, '--notes', releaseNotes]));
	} else {
		await check('create release', shell.exec('gh', ['release', 'create', releaseTag, '--notes', releaseNotes]));
	}

	info('Finished');

	return;

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

	async function getReleaseNotes(version: string, hashLast: string | undefined, hashCurrent: string): Promise<string> {
		const commits = await getCommitsBetween(hashLast, hashCurrent);
		let notes = commits
			.reverse()
			.map((commit) => '- ' + commit.message.replace(/\s+/g, ' '))
			.join('\n');
		notes = `# Release v${version}\n\nchanges:\n${notes}\n\n`;
		return notes;
	}

	async function getNewVersion(versionPackage: string): Promise<string> {
		// ask for new version

		const choices = [{ value: versionPackage }, { ...bump(2) }, { ...bump(1) }, { ...bump(0) }];

		const versionNew: string = await select({
			message: 'What should be the new version?',
			choices,
			default: choices[1].value,
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
