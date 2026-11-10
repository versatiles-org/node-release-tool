import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConventionalCommit } from './git.js';
import {
	changelogSection,
	distTag,
	isPrerelease,
	type Manifest,
	publishOrder,
	readManifests,
	recommendVersion,
	resolveReleaseVersion,
	setManifestVersion,
} from './release-plan.js';

const commits = (...messages: string[]) =>
	messages.map((message, index) => parseConventionalCommit({ sha: String(index), message }));

describe('readManifests', () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'vrt-release-plan-'));
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	function writePackage(path: string, pkg: object): void {
		mkdirSync(join(directory, path), { recursive: true });
		writeFileSync(join(directory, path, 'package.json'), JSON.stringify(pkg));
	}

	it('reads the root package', () => {
		writePackage('.', { name: 'root', version: '1.2.3', dependencies: { a: '1' }, peerDependencies: { b: '2' } });
		expect(readManifests(directory)).toStrictEqual([
			{
				path: join(directory, 'package.json'),
				directory,
				relative: '',
				name: 'root',
				version: '1.2.3',
				private: false,
				dependencies: ['a', 'b'],
			},
		]);
	});

	it('reads the workspaces after the root', () => {
		writePackage('.', { name: 'root', version: '1.0.0', private: true, workspaces: ['packages/*'] });
		writePackage('packages/core', { name: '@x/core', version: '1.0.0' });
		writePackage('packages/cli', { name: '@x/cli', version: '1.0.0', dependencies: { '@x/core': '^1.0.0' } });
		mkdirSync(join(directory, 'packages/empty'));

		const manifests = readManifests(directory);
		expect(manifests.map((m) => [m.relative, m.name, m.private])).toStrictEqual([
			['', 'root', true],
			['packages/cli', '@x/cli', false],
			['packages/core', '@x/core', false],
		]);
	});

	it('fails on a package without version', () => {
		writePackage('.', { name: 'root', workspaces: ['packages/*'], version: '1.0.0' });
		writePackage('packages/core', { name: 'core' });
		expect(() => readManifests(directory)).toThrow('packages/core/package.json has no version');
	});
});

describe('publishOrder', () => {
	const manifest = (name: string, dependencies: string[] = [], isPrivate = false): Manifest => ({
		path: '',
		directory: '',
		relative: name,
		name,
		version: '1.0.0',
		private: isPrivate,
		dependencies,
	});

	it('puts dependencies first and drops private packages', () => {
		const order = publishOrder([
			manifest('root', [], true),
			manifest('cli', ['core', 'lodash']),
			manifest('core'),
			manifest('plugin', ['cli']),
		]);
		expect(order.map((m) => m.name)).toStrictEqual(['core', 'cli', 'plugin']);
	});

	it('keeps the order of a cycle', () => {
		expect(publishOrder([manifest('a', ['b']), manifest('b', ['a'])]).map((m) => m.name)).toStrictEqual(['a', 'b']);
	});
});

describe('resolveReleaseVersion', () => {
	it('applies bump levels', () => {
		expect(resolveReleaseVersion('2.9.1', 'patch')).toBe('2.9.2');
		expect(resolveReleaseVersion('2.9.1', 'minor')).toBe('2.10.0');
		expect(resolveReleaseVersion('2.9.1', 'major')).toBe('3.0.0');
	});

	it('accepts higher explicit versions and prereleases', () => {
		expect(resolveReleaseVersion('2.9.1', '2.10.0')).toBe('2.10.0');
		expect(resolveReleaseVersion('2.9.1', 'v3.0.0-rc.0')).toBe('3.0.0-rc.0');
		expect(resolveReleaseVersion('3.0.0-rc.0', '3.0.0')).toBe('3.0.0');
	});

	it('rejects invalid and lower versions', () => {
		expect(() => resolveReleaseVersion('2.9.1', 'next')).toThrow('invalid version "next"');
		expect(() => resolveReleaseVersion('2.9.1', '2.9.1')).toThrow(
			'2.9.1 is not higher than the current version 2.9.1',
		);
		expect(() => resolveReleaseVersion('2.9.1', '2.0.0')).toThrow('is not higher');
	});
});

describe('recommendVersion', () => {
	it('recommends the bump the commits ask for', () => {
		expect(recommendVersion('1.2.3', commits('fix: a', 'chore: b'))).toStrictEqual({
			version: '1.2.4',
			reason: 'a patch release',
		});
		expect(recommendVersion('1.2.3', commits('fix: a', 'feat: b')).version).toBe('1.3.0');
		expect(recommendVersion('1.2.3', commits('feat!: a')).version).toBe('2.0.0');
	});

	it('recommends the next prerelease after a prerelease', () => {
		expect(recommendVersion('2.0.0-rc.0', commits('feat!: a'))).toStrictEqual({
			version: '2.0.0-rc.1',
			reason: 'the next prerelease',
		});
	});
});

describe('isPrerelease and distTag', () => {
	it('tells prereleases apart', () => {
		expect(isPrerelease('2.0.0-rc.0')).toBe(true);
		expect(isPrerelease('2.0.0')).toBe(false);
		expect(distTag('2.0.0-rc.0')).toBe('next');
		expect(distTag('2.0.0')).toBe('latest');
	});
});

describe('setManifestVersion', () => {
	it('replaces the version and keeps the formatting', () => {
		const content = '{\n\t"name": "x",\n\t"version": "1.0.0",\n\t"dependencies": { "y": "1.0.0" }\n}\n';
		expect(setManifestVersion(content, '1.1.0')).toBe(
			'{\n\t"name": "x",\n\t"version": "1.1.0",\n\t"dependencies": { "y": "1.0.0" }\n}\n',
		);
	});

	it('fails without a version field', () => {
		expect(() => setManifestVersion('{ "name": "x" }', '1.0.0')).toThrow('package.json has no "version" field');
	});
});

describe('changelogSection', () => {
	const changelog = [
		'# Changelog',
		'',
		'## [2.0.0-rc.0] - 2026-11-02',
		'',
		'### Features',
		'',
		'- new',
		'',
		'## [1.10.0] - 2026-11-01',
		'',
		'- ten',
		'',
		'## [1.1.0] - 2026-10-01',
		'',
		'## 1.0.0',
		'',
		'- first',
	].join('\n');

	it('returns the body of a section', () => {
		expect(changelogSection(changelog, '2.0.0-rc.0')).toBe('### Features\n\n- new');
		expect(changelogSection(changelog, '1.10.0')).toBe('- ten');
		expect(changelogSection(changelog, '1.0.0')).toBe('- first');
	});

	it('does not confuse similar versions', () => {
		expect(() => changelogSection(changelog, '1.1.0')).toThrow('the CHANGELOG.md section for 1.1.0 is empty');
		expect(() => changelogSection(changelog, '1.10')).toThrow('CHANGELOG.md has no section for 1.10');
		expect(() => changelogSection(changelog, '2.0.0')).toThrow('CHANGELOG.md has no section for 2.0.0');
	});
});
