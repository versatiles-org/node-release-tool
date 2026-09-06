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
	mkdtempSync: vi.fn(() => '/tmp/vrt-deps-upgrade-test'),
	readFileSync: vi.fn(() => ''),
	renameSync: vi.fn(),
	rmSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock('os', () => ({ tmpdir: vi.fn(() => '/tmp') }));

const mockedShellInstance = {
	run: vi.fn(async () => ({ code: 0, signal: null, stdout: '', stderr: '' })),
	stdout: vi.fn(async (_command: string) => ''),
	ok: vi.fn(async () => true),
};
vi.mock('../lib/shell.js', () => ({
	Shell: vi.fn(function () {
		return mockedShellInstance;
	}),
}));

const ncu = (await import('npm-check-updates')).default;
const { check, info, panic, warn } = await import('../lib/log.js');
const { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = await import('fs');
const { Shell } = await import('../lib/shell.js');
const { parseIgnoreRules, upgradeDependencies } = await import('./deps-upgrade.js');

const PACKAGE_JSON = '/test/directory/package.json';
const LOCK_FILE = '/test/directory/package-lock.json';
const MODULES = '/test/directory/node_modules';
const RESCUE_DIR = '/tmp/vrt-deps-upgrade-test';
const RESCUED_MODULES = '/tmp/vrt-deps-upgrade-test/node_modules';

const RESOLVE = 'npm install --package-lock-only --ignore-scripts';
const VERIFY = 'npm ci --dry-run --ignore-scripts';
const INSTALL = 'npm ci';

/** Lets every step succeed except the given command. */
function failCommand(command: string): void {
	vi.mocked(mockedShellInstance.stdout).mockImplementation(async (cmd: string) => {
		if (cmd === command) throw new Error(`${command} failed`);
		return '';
	});
}

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
		// clearAllMocks keeps implementations, so the ones set per test have to be reset here
		vi.mocked(mockedShellInstance.stdout).mockImplementation(async () => '');
		vi.mocked(renameSync).mockImplementation(() => undefined);

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
			'Resolve the new dependencies',
			'Verify the new dependencies',
			'Install all dependencies',
		]);

		// Verify shell commands were executed
		expect(vi.mocked(mockedShellInstance.run)).not.toHaveBeenCalled();
		expect(vi.mocked(mockedShellInstance.stdout).mock.calls).toStrictEqual([[RESOLVE], [VERIFY], [INSTALL]]);

		// The modules are parked outside the project, so they never appear in the project directory
		expect(vi.mocked(mkdtempSync)).toHaveBeenCalledWith('/tmp/vrt-deps-upgrade-');

		// The modules are parked, not deleted, and the parked copy is dropped after the install
		expect(vi.mocked(renameSync).mock.calls).toStrictEqual([[MODULES, RESCUED_MODULES]]);
		expect(vi.mocked(rmSync).mock.calls).toStrictEqual([
			[LOCK_FILE, { force: true }],
			[RESCUE_DIR, { recursive: true, force: true }],
		]);

		// Verify nothing was rolled back
		expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();

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

	it('should restore both files without touching the modules when resolving fails', async () => {
		failCommand(RESOLVE);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${RESOLVE} failed`);

		expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([
			[PACKAGE_JSON, PACKAGE_CONTENT],
			[LOCK_FILE, 'old package-lock.json'],
		]);
		// the modules were never given up, so nothing has to be moved back or reinstalled
		expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
		expect(vi.mocked(mockedShellInstance.ok)).not.toHaveBeenCalled();
		expect(vi.mocked(info)).toHaveBeenCalledWith('Restored package.json and package-lock.json');
		expect(vi.mocked(info)).not.toHaveBeenCalledWith('All dependencies are up to date');
	});

	it('should stop before the modules are given up when the verification fails', async () => {
		failCommand(VERIFY);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${VERIFY} failed`);

		expect(vi.mocked(mockedShellInstance.stdout).mock.calls).toStrictEqual([[RESOLVE], [VERIFY]]);
		expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
		expect(vi.mocked(mockedShellInstance.ok)).not.toHaveBeenCalled();
	});

	it('should move the modules back when the install fails', async () => {
		failCommand(INSTALL);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${INSTALL} failed`);

		expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([
			[PACKAGE_JSON, PACKAGE_CONTENT],
			[LOCK_FILE, 'old package-lock.json'],
		]);
		// moved aside before the install, then back again, instead of being downloaded anew
		expect(vi.mocked(renameSync).mock.calls).toStrictEqual([
			[MODULES, RESCUED_MODULES],
			[RESCUED_MODULES, MODULES],
		]);
		expect(vi.mocked(rmSync)).toHaveBeenCalledWith(MODULES, { recursive: true, force: true });
		expect(vi.mocked(mockedShellInstance.ok)).not.toHaveBeenCalled();
		expect(vi.mocked(info)).toHaveBeenCalledWith('Restored the previously installed dependencies');
		expect(vi.mocked(info)).not.toHaveBeenCalledWith('All dependencies are up to date');
	});

	it('should delete the lock file on rollback if there was none before', async () => {
		// nothing exists: no lock file to back up and no modules to park
		vi.mocked(existsSync).mockReturnValue(false);
		failCommand(INSTALL);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${INSTALL} failed`);

		expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([[PACKAGE_JSON, PACKAGE_CONTENT]]);
		expect(vi.mocked(rmSync).mock.calls).toStrictEqual([
			[LOCK_FILE, { force: true }],
			[LOCK_FILE, { force: true }],
			[RESCUE_DIR, { recursive: true, force: true }],
		]);
		expect(vi.mocked(mockedShellInstance.ok)).not.toHaveBeenCalled();
		expect(vi.mocked(info)).toHaveBeenCalledWith('Restored package.json');
	});

	describe('modules on another filesystem', () => {
		/** Makes the move into the temporary directory fail the way a cross-device rename does. */
		function failRenameWith(code: string): void {
			vi.mocked(renameSync).mockImplementationOnce(() => {
				throw Object.assign(new Error('rename failed'), { code });
			});
		}

		it('should delete and reinstall the modules when they cannot be moved', async () => {
			failRenameWith('EXDEV');
			failCommand(INSTALL);

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${INSTALL} failed`);

			// copying a whole tree would cost more than the reinstall, so it is deleted instead
			expect(vi.mocked(rmSync)).toHaveBeenCalledWith(MODULES, { recursive: true, force: true });
			expect(vi.mocked(mockedShellInstance.ok).mock.calls).toStrictEqual([['npm ci']]);
			expect(vi.mocked(info)).toHaveBeenCalledWith('Reinstalled the previous dependencies');
		});

		it('should warn if the previous dependencies cannot be reinstalled', async () => {
			failRenameWith('EXDEV');
			failCommand(INSTALL);
			vi.mocked(mockedShellInstance.ok).mockResolvedValueOnce(false);

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${INSTALL} failed`);

			expect(vi.mocked(warn)).toHaveBeenCalledWith(
				'Could not reinstall the previous dependencies, please run "npm install" manually',
			);
		});

		it('should propagate rename errors other than EXDEV', async () => {
			failRenameWith('EACCES');

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow('rename failed');
		});
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
