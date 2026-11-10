import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../core/log.js', () => ({ info: vi.fn() }));

const { getToolVersion, releaseCheck } = await import('./release-check.js');

describe('releaseCheck', () => {
	let directory: string;
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), 'vrt-release-check-'));
		writePackage('.', { name: 'root', version: '1.2.0', workspaces: ['packages/*'] });
		writePackage('packages/a', { name: 'a', version: '1.2.0' });
		writeFileSync(
			join(directory, 'CHANGELOG.md'),
			'# Changelog\n\n## [1.2.0] - 2026-11-10\n\n- notes\n\n## [1.1.0]\n\n- old\n',
		);
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	function writePackage(path: string, pkg: object): void {
		mkdirSync(join(directory, path), { recursive: true });
		writeFileSync(join(directory, path, 'package.json'), JSON.stringify(pkg));
	}

	it('accepts a matching tag and writes notes and outputs', () => {
		const output = join(directory, 'output.txt');
		const result = releaseCheck(directory, 'v1.2.0', { notesFile: 'release/notes.md', outputFile: output });
		expect(result).toStrictEqual({
			version: '1.2.0',
			prerelease: false,
			distTag: 'latest',
			toolVersion: getToolVersion(),
			notes: '- notes',
		});
		expect(readFileSync(join(directory, 'release/notes.md'), 'utf8')).toBe('- notes\n');
		expect(readFileSync(output, 'utf8')).toBe(
			`version=1.2.0\nprerelease=false\ndist-tag=latest\ntool-version=${getToolVersion()}\n`,
		);
	});

	it('gives prereleases the dist-tag "next"', () => {
		writePackage('.', { name: 'root', version: '2.0.0-rc.0' });
		writeFileSync(join(directory, 'CHANGELOG.md'), '## [2.0.0-rc.0]\n\n- rc\n');
		expect(releaseCheck(directory, 'v2.0.0-rc.0', { outputFile: '' })).toMatchObject({
			prerelease: true,
			distTag: 'next',
		});
	});

	it('rejects a tag that is no version', () => {
		expect(() => releaseCheck(directory, '1.2.0')).toThrow('expected a tag like v1.2.3, got "1.2.0"');
		expect(() => releaseCheck(directory, 'v1.2')).toThrow('expected a tag like v1.2.3');
	});

	it('rejects a tag that does not match a workspace', () => {
		writePackage('packages/a', { name: 'a', version: '1.1.0' });
		expect(() => releaseCheck(directory, 'v1.2.0', { outputFile: '' })).toThrow(
			'packages/a/package.json has version 1.1.0, but the tag is v1.2.0',
		);
	});

	it('rejects a version without release notes', () => {
		writeFileSync(join(directory, 'CHANGELOG.md'), '## [1.1.0]\n\n- old\n');
		expect(() => releaseCheck(directory, 'v1.2.0', { outputFile: '' })).toThrow(
			'CHANGELOG.md has no section for 1.2.0',
		);
	});
});

describe('getToolVersion', () => {
	it('reads the version of this package', () => {
		const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
			version: string;
		};
		expect(getToolVersion()).toBe(pkg.version);
	});
});
