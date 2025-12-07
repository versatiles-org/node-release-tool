#!/usr/bin/env npx tsx

import { readFileSync, writeFileSync } from 'fs';
import select from '@inquirer/select';
import { check, info, panic, warn } from '../lib/log.js';
import { Shell } from '../lib/shell.js';
import { getGit } from '../lib/git.js';
import { resolve } from 'path';

export async function release(directory: string, branch = 'main'): Promise<void> {

	const shell = new Shell(directory);
	const { getCommitsBetween, getCurrentGitHubCommit, getLastGitHubTag } = getGit(directory);

	info('starting release process');

	// git: check if in the correct branch
	const currentBranch = await check('get branch name', shell.stdout('git rev-parse --abbrev-ref HEAD'));
	if (currentBranch !== branch) panic(`current branch is "${currentBranch}" but should be "${branch}"`);

	// git: check if no changes
	await check('are all changes committed?', checkThatNoUncommittedChanges());

	// git: pull
	await check('git pull', shell.run('git pull -t'));

	// check package.json
	const pkg: unknown = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
	if (typeof pkg !== 'object' || pkg === null) panic('package.json is not valid');
	if (!('version' in pkg) || (typeof pkg.version !== 'string')) panic('package.json is missing "version"');
	if (!('scripts' in pkg) || (typeof pkg.scripts !== 'object') || (pkg.scripts == null)) panic('package.json is missing "scripts"');
	if (!('check' in pkg.scripts)) panic('missing npm script "check" in package.json');
	if (!('prepack' in pkg.scripts)) panic('missing npm script "prepack" in package.json');

	// get last version
	const tag = await check('get last github tag', getLastGitHubTag());
	const shaLast = tag?.sha;
	const versionLastGithub = tag?.version;

	const versionLastPackage = String(pkg.version);
	if (versionLastPackage !== versionLastGithub) warn(`versions differ in package.json (${versionLastPackage}) and last GitHub tag (${versionLastGithub})`);

	// get current sha
	const { sha: shaCurrent } = await check('get current github commit', getCurrentGitHubCommit());

	// handle version
	const nextVersion = await getNewVersion(versionLastPackage);

	// test
	await check('run checks', shell.run('npm run check'));

	// update version
	await check('update version', setNextVersion(nextVersion));

	// prepare release notes
	const releaseNotes = await check('prepare release notes', getReleaseNotes(nextVersion, shaLast, shaCurrent));

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
	const releaseNotesPipe = `echo -e '${releaseNotes.replace(
		/[^a-z0-9,.?!:_<> -]/gi,
		c => '\\x' + ('00' + c.charCodeAt(0).toString(16)).slice(-2),
	)}'`;
	if (await check('check github release', shell.ok('gh release view v' + nextVersion))) {
		await check('edit release', shell.run(`${releaseNotesPipe} | gh release edit "v${nextVersion}" -F -`));
	} else {
		await check('create release', shell.run(`${releaseNotesPipe} | gh release create "v${nextVersion}" -F -`));
	}

	info('Finished');

	return;

	async function checkThatNoUncommittedChanges(): Promise<void> {
		if ((await shell.stdout('git status --porcelain')).length < 3) return;
		throw Error('please commit all changes before releasing');
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
		let notes = commits.reverse()
			.map(commit => '- ' + commit.message.replace(/\s+/g, ' '))
			.join('\n');
		notes = `# Release v${version}\n\nchanges:\n${notes}\n\n`;
		return notes;
	}

	async function getNewVersion(versionPackage: string): Promise<string> {
		// ask for new version

		const choices = [
			{ value: versionPackage },
			{ ...bump(2) },
			{ ...bump(1) },
			{ ...bump(0) }
		]

		const versionNew: string = (await select({
			message: 'What should be the new version?',
			choices,
			default: choices[1].value,
		}));
		if (!versionNew) throw Error();

		return versionNew;

		function bump(index: 0 | 1 | 2): { name: string; value: string } {
			const p = versionPackage.split('.').map(v => parseInt(v, 10));
			if (p.length !== 3) throw Error();
			switch (index) {
				case 0: p[0]++; p[1] = 0; p[2] = 0; break;
				case 1: p[1]++; p[2] = 0; break;
				case 2: p[2]++; break;
			}
			const name = p.map((n, i) => (i == index) ? `\x1b[1m${n}` : `${n}`).join('.') + '\x1b[22m';
			const value = p.join('.');
			return { name, value };
		}
	}
}

