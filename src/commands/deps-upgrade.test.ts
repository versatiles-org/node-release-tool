import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('npm-check-updates', () => ({
	default: vi.fn(),
}));

vi.mock('../lib/log.js', () => ({
	check: vi.fn(),
	info: vi.fn(),
	panic: vi.fn(() => {
		throw new Error('panic');
	}),
	warn: vi.fn(),
}));

vi.mock('fs', () => ({
	existsSync: vi.fn(() => true),
	readFileSync: vi.fn(() => ''),
	rmSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

const mockedShellInstance = {
	run: vi.fn(async () => ({ code: 0, signal: null, stdout: '', stderr: '' })),
	stdout: vi.fn(async () => ''),
	ok: vi.fn(async () => true),
};
vi.mock('../lib/shell.js', () => ({
	Shell: vi.fn(function () {
		return mockedShellInstance;
	}),
}));

const ncu = (await import('npm-check-updates')).default;
const { check, info, panic, warn } = await import('../lib/log.js');
const { existsSync, readFileSync, rmSync, writeFileSync } = await import('fs');
const { Shell } = await import('../lib/shell.js');
const { parseIgnoreRules, upgradeDependencies } = await import('./deps-upgrade.js');

const PACKAGE_JSON = '/test/directory/package.json';
const LOCK_FILE = '/test/directory/package-lock.json';

/** Returns the options of the last ncu call. */
function ncuOptions(): Record<string, unknown> {
	return vi.mocked(ncu).mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

const PACKAGE_CONTENT = '{"name":"demo","dependencies":{"is-odd":"^2.0.0"}}';

/** Sets the content of the mocked package.json. */
function mockPackageContent(content: string): void {
	vi.mocked(readFileSync).mockImplementation((filename) =>
		filename === PACKAGE_JSON ? content : 'old package-lock.json',
	);
}

describe('upgradeDependencies', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(existsSync).mockReturnValue(true);
		mockPackageContent(PACKAGE_CONTENT);
		vi.mocked(mockedShellInstance.ok).mockResolvedValue(true);

		// mimics check(): on failure the cleanup callback runs, then the error is propagated
		vi.mocked(check).mockImplementation(
			async <T>(
				_message: string,
				promise: Promise<T> | (() => Promise<T>),
				onError?: (error: unknown) => Promise<void> | void,
			): Promise<T> => {
				try {
					return await (typeof promise === 'function' ? promise() : promise);
				} catch (error) {
					if (onError) await onError(error);
					throw error;
				}
			},
		);
	});

	it('should upgrade dependencies successfully', async () => {
		await upgradeDependencies('/test/directory');

		// Verify Shell was instantiated with correct directory
		expect(vi.mocked(Shell)).toHaveBeenCalledWith('/test/directory');

		// Verify ncu was called with correct options, including the absolute package file path,
		// because a relative one would be resolved against process.cwd() instead of the directory
		expect(vi.mocked(ncu)).toHaveBeenCalledWith({
			cwd: '/test/directory',
			packageFile: PACKAGE_JSON,
			upgrade: true,
			peer: false,
		});

		// Verify check was called for each step
		expect(vi.mocked(check).mock.calls.map((c) => c[0])).toStrictEqual([
			'Upgrade all dependencies',
			'Reinstall all dependencies',
		]);

		// Verify shell commands were executed
		expect(vi.mocked(mockedShellInstance.run).mock.calls).toStrictEqual([
			['rm -f package-lock.json && rm -rf node_modules', false],
		]);
		expect(vi.mocked(mockedShellInstance.stdout).mock.calls).toStrictEqual([['npm i']]);

		// Verify nothing was rolled back
		expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
		expect(vi.mocked(rmSync)).not.toHaveBeenCalled();

		// Verify info was called at the end
		expect(vi.mocked(info)).toHaveBeenCalledWith('All dependencies are up to date');
	});

	it('should back up package.json and package-lock.json before upgrading', async () => {
		await upgradeDependencies('/test/directory');

		expect(vi.mocked(readFileSync).mock.calls).toStrictEqual([
			[PACKAGE_JSON, 'utf8'],
			[LOCK_FILE, 'utf8'],
		]);
	});

	it('should propagate errors from ncu', async () => {
		const error = new Error('ncu failed');
		vi.mocked(ncu).mockRejectedValueOnce(error);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow('ncu failed');
	});

	it('should restore package.json when ncu fails, without reinstalling', async () => {
		vi.mocked(ncu).mockRejectedValueOnce(new Error('ncu failed'));

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow('ncu failed');

		expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([
			[PACKAGE_JSON, PACKAGE_CONTENT],
			[LOCK_FILE, 'old package-lock.json'],
		]);
		// node_modules is still intact at this point, so there is nothing to reinstall
		expect(vi.mocked(mockedShellInstance.ok)).not.toHaveBeenCalled();
	});

	it('should propagate errors from shell commands', async () => {
		const error = new Error('shell command failed');
		vi.mocked(mockedShellInstance.stdout).mockRejectedValueOnce(error);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow('shell command failed');
	});

	it('should restore both files and reinstall when the install fails', async () => {
		vi.mocked(mockedShellInstance.stdout).mockRejectedValueOnce(new Error('install failed'));

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow('install failed');

		expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([
			[PACKAGE_JSON, PACKAGE_CONTENT],
			[LOCK_FILE, 'old package-lock.json'],
		]);
		expect(vi.mocked(mockedShellInstance.ok).mock.calls).toStrictEqual([['npm ci']]);
		expect(vi.mocked(info)).toHaveBeenCalledWith('Restored package.json and package-lock.json');
		expect(vi.mocked(info)).toHaveBeenCalledWith('Reinstalled the previous dependencies');
		expect(vi.mocked(info)).not.toHaveBeenCalledWith('All dependencies are up to date');
	});

	it('should delete the lock file on rollback if there was none before', async () => {
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(mockedShellInstance.stdout).mockRejectedValueOnce(new Error('install failed'));

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow('install failed');

		expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([[PACKAGE_JSON, PACKAGE_CONTENT]]);
		expect(vi.mocked(rmSync).mock.calls).toStrictEqual([[LOCK_FILE, { force: true }]]);
		expect(vi.mocked(mockedShellInstance.ok).mock.calls).toStrictEqual([['npm install']]);
		expect(vi.mocked(info)).toHaveBeenCalledWith('Restored package.json');
	});

	it('should warn if the previous dependencies cannot be reinstalled', async () => {
		vi.mocked(mockedShellInstance.stdout).mockRejectedValueOnce(new Error('install failed'));
		vi.mocked(mockedShellInstance.ok).mockResolvedValueOnce(false);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow('install failed');

		expect(vi.mocked(warn)).toHaveBeenCalledWith(
			'Could not reinstall the previous dependencies, please run "npm install" manually',
		);
	});

	describe('peer dependencies', () => {
		const PEER_WARNING = 'Ignoring peer dependency ranges, the upgraded dependencies may fail to install';

		it('should respect peer ranges when enabled', async () => {
			await upgradeDependencies('/test/directory', { peer: true });

			expect(ncuOptions().peer).toBe(true);
			expect(vi.mocked(warn)).not.toHaveBeenCalled();
		});

		it('should leave the check off by default and warn', async () => {
			await upgradeDependencies('/test/directory');

			expect(ncuOptions().peer).toBe(false);
			expect(vi.mocked(warn)).toHaveBeenCalledWith(PEER_WARNING);
		});

		it('should ignore peer ranges and warn when the option is disabled', async () => {
			await upgradeDependencies('/test/directory', { peer: false });

			expect(ncuOptions().peer).toBe(false);
			expect(vi.mocked(warn)).toHaveBeenCalledWith(PEER_WARNING);
		});

		it('should combine peer ranges with ignore rules', async () => {
			mockPackageContent('{"vrt":{"depsUpgrade":{"ignore":["path-to-regexp"]}}}');

			await upgradeDependencies('/test/directory', { peer: true });

			expect(ncuOptions().peer).toBe(true);
			expect(ncuOptions().reject).toStrictEqual(['path-to-regexp']);
		});
	});

	describe('ignored dependencies', () => {
		it('should reject ignored packages without a range', async () => {
			mockPackageContent('{"vrt":{"depsUpgrade":{"ignore":["path-to-regexp","typescript"]}}}');

			await upgradeDependencies('/test/directory');

			expect(ncuOptions().reject).toStrictEqual(['path-to-regexp', 'typescript']);
			expect(ncuOptions().target).toBeUndefined();
			expect(ncuOptions().filterResults).toBeUndefined();
			expect(vi.mocked(info)).toHaveBeenCalledWith('Ignoring dependency "path-to-regexp"');
		});

		it('should limit packages with a range to their declared semver range', async () => {
			mockPackageContent('{"vrt":{"depsUpgrade":{"ignore":{"path-to-regexp":"<7.0.0"}}}}');

			await upgradeDependencies('/test/directory');

			const { target, filterResults } = ncuOptions() as {
				target: (name: string) => string;
				filterResults: (name: string, meta: { upgradedVersion: string }) => boolean;
			};

			expect(ncuOptions().reject).toBeUndefined();
			expect(target('path-to-regexp')).toBe('semver');
			expect(target('typescript')).toBe('latest');

			// versions inside the range are kept, so patches keep coming in
			expect(filterResults('path-to-regexp', { upgradedVersion: '6.4.0' })).toBe(true);
			expect(filterResults('path-to-regexp', { upgradedVersion: '8.4.2' })).toBe(false);
			expect(filterResults('typescript', { upgradedVersion: '99.0.0' })).toBe(true);

			expect(vi.mocked(info)).toHaveBeenCalledWith('Ignoring versions of "path-to-regexp" outside of "<7.0.0"');
		});

		it('should combine rules from package.json and the ignore option', async () => {
			mockPackageContent('{"vrt":{"depsUpgrade":{"ignore":["path-to-regexp"]}}}');

			await upgradeDependencies('/test/directory', { ignore: ['typescript@<7.0.0'] });

			expect(ncuOptions().reject).toStrictEqual(['path-to-regexp']);
			expect((ncuOptions().target as (name: string) => string)('typescript')).toBe('semver');
		});

		it('should let the ignore option override the configured rule', async () => {
			mockPackageContent('{"vrt":{"depsUpgrade":{"ignore":{"path-to-regexp":"<7.0.0"}}}}');

			await upgradeDependencies('/test/directory', { ignore: ['path-to-regexp'] });

			expect(ncuOptions().reject).toStrictEqual(['path-to-regexp']);
			expect(ncuOptions().target).toBeUndefined();
		});

		it('should report a misconfiguration before changing anything', async () => {
			mockPackageContent('{"vrt":{"depsUpgrade":{"ignore":["is-odd@nope"]}}}');

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow('panic');

			expect(vi.mocked(panic)).toHaveBeenCalledWith(
				'[VALIDATION_ERROR] invalid version range "nope" for ignored dependency "is-odd"',
			);
			expect(vi.mocked(ncu)).not.toHaveBeenCalled();
			expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
		});

		it('should not pass any ignore options if nothing is ignored', async () => {
			await upgradeDependencies('/test/directory');

			expect(ncuOptions()).toStrictEqual({
				cwd: '/test/directory',
				packageFile: PACKAGE_JSON,
				upgrade: true,
				peer: false,
			});
		});
	});
});

describe('parseIgnoreRules', () => {
	it('should return no rules if nothing is configured', () => {
		expect(parseIgnoreRules('{}')).toStrictEqual(new Map());
	});

	it('should parse a list of package names', () => {
		expect(parseIgnoreRules('{"vrt":{"depsUpgrade":{"ignore":["is-odd","is-even"]}}}')).toStrictEqual(
			new Map([
				['is-odd', true],
				['is-even', true],
			]),
		);
	});

	it('should parse ranges in list entries', () => {
		expect(parseIgnoreRules('{"vrt":{"depsUpgrade":{"ignore":["is-odd@<7.0.0"]}}}')).toStrictEqual(
			new Map([['is-odd', '<7.0.0']]),
		);
	});

	it('should keep the scope of scoped packages', () => {
		expect(parseIgnoreRules('{}', ['@versatiles/style', '@versatiles/container@^5'])).toStrictEqual(
			new Map<string, true | string>([
				['@versatiles/style', true],
				['@versatiles/container', '^5'],
			]),
		);
	});

	it('should parse an object of package names', () => {
		expect(parseIgnoreRules('{"vrt":{"depsUpgrade":{"ignore":{"is-odd":"<7.0.0","is-even":true}}}}')).toStrictEqual(
			new Map<string, true | string>([
				['is-odd', '<7.0.0'],
				['is-even', true],
			]),
		);
	});

	it('should trim entries', () => {
		expect(parseIgnoreRules('{}', [' is-odd '])).toStrictEqual(new Map([['is-odd', true]]));
	});

	it('should reject invalid version ranges', () => {
		expect(() => parseIgnoreRules('{}', ['is-odd@not-a-range'])).toThrow(
			'invalid version range "not-a-range" for ignored dependency "is-odd"',
		);
		expect(() => parseIgnoreRules('{"vrt":{"depsUpgrade":{"ignore":{"is-odd":"nope"}}}}')).toThrow(
			'invalid version range "nope" for ignored dependency "is-odd"',
		);
	});

	it('should reject malformed configurations', () => {
		expect(() => parseIgnoreRules('{"vrt":{"depsUpgrade":{"ignore":"is-odd"}}}')).toThrow(
			'vrt.depsUpgrade.ignore must be a list or an object',
		);
		expect(() => parseIgnoreRules('{"vrt":{"depsUpgrade":{"ignore":[42]}}}')).toThrow(
			'vrt.depsUpgrade.ignore must only contain strings, but found number',
		);
		expect(() => parseIgnoreRules('{"vrt":{"depsUpgrade":{"ignore":{"is-odd":false}}}}')).toThrow(
			'vrt.depsUpgrade.ignore["is-odd"] must be true or a semver range, but is false',
		);
		expect(() => parseIgnoreRules('{}', ['@<7.0.0'])).toThrow('invalid package name in ignored dependency "@<7.0.0"');
		expect(() => parseIgnoreRules('{}', ['is-odd@'])).toThrow(
			'invalid version range "" for ignored dependency "is-odd"',
		);
	});
});
