#!/usr/bin/env npx tsx

import { readFileSync, writeFileSync } from 'node:fs';
import inquirer from 'inquirer';
import { check, info, panic, warn } from '../lib/log.js';
import { Run } from '../lib/shell.js';
import { Git } from '../lib/git.js';

export async function release(directory: string, branch: string = 'main'): Promise<void> {

	const run = Run(directory);
	const { getCommitsBetween, getCurrentGitHubCommit, getLastGitHubTag } = Git(directory);

	info('starting release process');

	// git: check if in the correct branch
	const currentBranch = await check('get branch name', run.stdout('git rev-parse --abbrev-ref HEAD'));
	if (currentBranch !== branch) panic(`branch name "${currentBranch}" is not "${branch}"`);

	// git: check if no changes
	await check('are all changes committed?', checkThatNoUncommittedChanges());

	// git: pull
	await check('git pull', run('git pull -t'));

	// get last version
	const { sha: shaLast, version: versionLastGithub } = await check('get last github tag', getLastGitHubTag());
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
	const versionLastPackage: string = JSON.parse(readFileSync('./package.json', 'utf8'))?.version;
	if (versionLastPackage !== versionLastGithub) warn(`versions differ in package.json (${versionLastPackage}) and last GitHub tag (${versionLastGithub})`);

	// get current sha
	const { sha: shaCurrent } = await check('get current github commit', getCurrentGitHubCommit());

	// handle version
	const nextVersion = await editVersion(versionLastPackage);

	// prepare release notes
	const releaseNotes = await check('prepare release notes', getReleaseNotes(nextVersion, shaLast, shaCurrent));

	// update version
	await check('update version', setNextVersion(nextVersion));

	// lint
	await check('lint', run('npm run lint'));

	// build
	await check('build styles', run('npm run build-styles'));
	await check('build node version', run('npm run build-node'));
	await check('build browser version', run('npm run build-browser'));

	// test
	await check('run tests', run('npm run test'));

	// test
	await check('update doc', run('npm run doc'));

	// npm publish
	await check('npm publish', run('npm publish --access public'));

	// git push
	await check('git add', run('git add .'));
	await check('git commit', run(`git commit -m "v${nextVersion}"`, false));
	await check('git tag', run(`git tag -f -a "v${nextVersion}" -m "new release: v${nextVersion}"`));
	await check('git push', run('git push --no-verify --follow-tags'));

	// github release
	const releaseNotesPipe = `echo -e '${releaseNotes.replace(
		/[^a-z0-9,.?!:_<> -]/gi,
		c => '\\x' + ('00' + c.charCodeAt(0).toString(16)).slice(-2),
	)}'`;
	if (await check('check github release', run.ok('gh release view v' + nextVersion))) {
		await check('edit release', run(`${releaseNotesPipe} | gh release edit "v${nextVersion}" -F -`));
	} else {
		await check('create release', run(`${releaseNotesPipe} | gh release create "v${nextVersion}" --draft --prerelease -F -`));
	}

	info('Finished');

	return

	async function checkThatNoUncommittedChanges(): Promise<void> {
		if ((await run('git status --porcelain')).stdout.length < 3) return;
		throw Error('please commit all changes before releasing');
	}

	async function setNextVersion(version: string): Promise<void> {
		// set new version in package.json
		// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
		const packageJSON: { version: string } = JSON.parse(readFileSync('./package.json', 'utf8'));
		packageJSON.version = version;
		writeFileSync('./package.json', JSON.stringify(packageJSON, null, '  ') + '\n');

		// rebuild package.json
		await run('npm i --package-lock-only');
	}

	async function getReleaseNotes(version: string, hashLast: string, hashCurrent: string): Promise<string> {
		const commits = await getCommitsBetween(hashLast, hashCurrent);
		let notes = commits.reverse()
			.map(commit => '- ' + commit.message.replace(/\s+/g, ' '))
			.join('\n');
		notes = `# Release v${version}\n\nchanges: \n${notes}\n\n`;
		return notes;
	}
}


async function editVersion(versionPackage: string): Promise<string> {
	// ask for new version
	// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
	const versionNew: string = (await inquirer.prompt({
		message: 'What should be the new version?',
		name: 'versionNew',
		type: 'list',
		choices: [versionPackage, bump(2), bump(1), bump(0)],
		default: 1,
		// eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
	})).versionNew;
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
