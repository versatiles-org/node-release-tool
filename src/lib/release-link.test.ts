import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { findGitRoot, getReleaseBaseUrl, unpinReleaseLinks } from './release-link.js';

describe('release links', () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), 'vrt-release-link-'));
		mkdirSync(join(root, '.git'));
		mkdirSync(join(root, 'packages', 'foo'), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	describe('findGitRoot', () => {
		it('finds the repository root from a subdirectory', () => {
			expect(findGitRoot(join(root, 'packages', 'foo'))).toBe(root);
			expect(findGitRoot(root)).toBe(root);
		});

		it('returns the directory itself outside of a repository', () => {
			const outside = mkdtempSync(join(tmpdir(), 'vrt-no-git-'));
			try {
				expect(findGitRoot(outside)).toBe(outside);
			} finally {
				rmSync(outside, { recursive: true, force: true });
			}
		});
	});

	describe('getReleaseBaseUrl', () => {
		it('points to the release tag at the repository root', () => {
			expect(getReleaseBaseUrl('https://github.com/owner/repo', '1.2.3', root)).toBe(
				'https://raw.githubusercontent.com/owner/repo/v1.2.3/',
			);
		});

		it('includes the path of a package in a monorepo', () => {
			expect(getReleaseBaseUrl('https://github.com/owner/repo', '1.2.3', join(root, 'packages', 'foo'))).toBe(
				'https://raw.githubusercontent.com/owner/repo/v1.2.3/packages/foo/',
			);
		});
	});

	describe('unpinReleaseLinks', () => {
		const base = 'https://raw.githubusercontent.com/owner/repo/v1.2.3/';

		it('turns links at the release tag into relative links', () => {
			const markdown = `![graph](${base}docs/graph.svg)\n[doc](${base}docs/a.md) and [again](${base}b.md)`;
			expect(unpinReleaseLinks(markdown, base)).toBe('![graph](docs/graph.svg)\n[doc](docs/a.md) and [again](b.md)');
		});

		it('keeps links to other versions and plain text mentions', () => {
			const markdown = `[old](https://raw.githubusercontent.com/owner/repo/v1.2.2/a.md) ${base}a.md`;
			expect(unpinReleaseLinks(markdown, base)).toBe(markdown);
		});
	});
});
