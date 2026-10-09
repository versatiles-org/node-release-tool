import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
	run: vi.fn(async (_command: string, _errorOnCodeNonZero?: boolean) => ({
		code: 0 as number | null,
		signal: null,
		stdout: '',
		stderr: '',
	})),
	stdout: vi.fn(async (_command: string) => ''),
	kill: vi.fn((_signal?: NodeJS.Signals) => 0),
};
vi.mock('../lib/shell.js', () => ({
	Shell: vi.fn(function () {
		return mockedShellInstance;
	}),
}));

vi.mock('./deps-graph-workspace.js', () => ({
	readWorkspaceDirectories: vi.fn((): string[] => []),
}));

const ncu = (await import('npm-check-updates')).default;
const { check, info, panic, warn } = await import('../lib/log.js');
const { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } = await import('fs');
const { Shell } = await import('../lib/shell.js');
const { readWorkspaceDirectories } = await import('./deps-graph-workspace.js');
const { parseIgnoreRules, upgradeDependencies } = await import('./deps-upgrade.js');

const PACKAGE_JSON = '/test/directory/package.json';
const LOCK_FILE = '/test/directory/package-lock.json';
const MODULES = '/test/directory/node_modules';
const RESCUE_DIR = '/tmp/vrt-deps-upgrade-test';
const RESCUED_MODULES = '/tmp/vrt-deps-upgrade-test/0';
const SIBLING_BACKUP = '/test/directory/node_modules.vrt-backup';

/** How a whole directory tree is removed: retrying, because macOS can report a spurious ENOTEMPTY. */
const REMOVE_TREE = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };

const RESOLVE = 'npm install --package-lock-only --ignore-scripts';
const INSTALL = 'npm ci';
const AUDIT_FIX = 'npm audit fix --package-lock-only';
const AUDIT = 'npm audit --json';

/** Lets `npm audit --json` print the given output, with the exit code npm uses for it. */
function mockAudit(stdout: string, code = 0): void {
	vi.mocked(mockedShellInstance.run).mockImplementation(async (command: string) => ({
		code: command === AUDIT ? code : 0,
		signal: null,
		stdout: command === AUDIT ? stdout : '',
		stderr: '',
	}));
}

/** Builds the output of `npm audit --json` for the given number of vulnerabilities. */
function auditReport(counts: Partial<Record<'info' | 'low' | 'moderate' | 'high' | 'critical', number>> = {}): string {
	const vulnerabilities = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, ...counts };
	const total = Object.values(vulnerabilities).reduce((sum, count) => sum + count, 0);
	return JSON.stringify({ metadata: { vulnerabilities: { ...vulnerabilities, total } } });
}

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
		vi.mocked(mockedShellInstance.kill).mockReturnValue(0);
		vi.mocked(readWorkspaceDirectories).mockReturnValue([]);
		// clearAllMocks keeps implementations, so the ones set per test have to be reset here
		vi.mocked(mockedShellInstance.stdout).mockImplementation(async () => '');
		mockAudit(auditReport());
		vi.mocked(renameSync).mockImplementation(() => undefined);
		vi.mocked(rmSync).mockImplementation(() => undefined);

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
			'Set the installed dependencies aside',
			'Resolve the new dependencies',
			'Fix known vulnerabilities',
			'Install all dependencies',
		]);

		// Verify shell commands were executed
		expect(vi.mocked(mockedShellInstance.run).mock.calls).toStrictEqual([
			[AUDIT_FIX, false],
			[AUDIT, false],
		]);
		expect(vi.mocked(mockedShellInstance.stdout).mock.calls).toStrictEqual([[RESOLVE], [INSTALL]]);

		// The modules are parked outside the project, so they never appear in the project directory
		expect(vi.mocked(mkdtempSync)).toHaveBeenCalledWith('/tmp/vrt-deps-upgrade-');

		// The modules are parked, not deleted, and the parked copy is dropped after the install
		expect(vi.mocked(renameSync).mock.calls).toStrictEqual([[MODULES, RESCUED_MODULES]]);
		expect(vi.mocked(rmSync).mock.calls).toStrictEqual([
			[LOCK_FILE, { force: true }],
			[RESCUE_DIR, REMOVE_TREE],
		]);

		// Verify nothing was rolled back
		expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();

		// Verify info was called at the end
		expect(vi.mocked(info)).toHaveBeenCalledWith('All dependencies are up to date');
	});

	it('should resolve the new dependencies without the installed modules', async () => {
		// npm reuses installed modules for the lock file, which keeps stale versions of indirect
		// dependencies and drops their "resolved" and "integrity" fields
		const order: string[] = [];
		vi.mocked(renameSync).mockImplementation(() => void order.push('park'));
		vi.mocked(mockedShellInstance.stdout).mockImplementation(async (command: string) => {
			order.push(command);
			return '';
		});

		await upgradeDependencies('/test/directory', { audit: false });

		expect(order).toStrictEqual(['park', RESOLVE, INSTALL]);
	});

	it('should finish upgrading package.json before the modules are moved away', async () => {
		// the tool runs from the modules it moves away, and ncu loads parts of itself while running
		let parkedDuringNcu = false;
		vi.mocked(ncu).mockImplementationOnce(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			parkedDuringNcu = vi.mocked(renameSync).mock.calls.length > 0;
			return undefined;
		});

		await upgradeDependencies('/test/directory');

		expect(parkedDuringNcu).toBe(false);
		expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1);
	});

	it('should only warn if the temporary directory cannot be removed', async () => {
		// the upgrade is done at this point, so a leftover directory in the OS temp directory
		// must not turn a successful upgrade into a crash
		vi.mocked(rmSync).mockImplementation((path) => {
			if (path === RESCUE_DIR) throw Object.assign(new Error('Directory not empty'), { code: 'ENOTEMPTY' });
		});

		await expect(upgradeDependencies('/test/directory')).resolves.toBeUndefined();

		expect(vi.mocked(warn)).toHaveBeenCalledWith(
			expect.stringContaining(`Could not remove the temporary directory ${RESCUE_DIR}`),
		);
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

	it('should restore package.json when ncu fails, without touching the modules', async () => {
		vi.mocked(ncu).mockRejectedValueOnce(new Error('ncu failed'));

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow('ncu failed');

		expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([
			[PACKAGE_JSON, PACKAGE_CONTENT],
			[LOCK_FILE, 'old package-lock.json'],
		]);
		expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
		expect(vi.mocked(info)).not.toHaveBeenCalledWith('Restored the previously installed dependencies');
	});

	it('should propagate errors from shell commands', async () => {
		const error = new Error('shell command failed');
		vi.mocked(mockedShellInstance.stdout).mockRejectedValueOnce(error);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow('shell command failed');
	});

	it.each([RESOLVE, INSTALL])(
		'should restore the files and move the modules back when "%s" fails',
		async (command) => {
			failCommand(command);

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${command} failed`);

			expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([
				[PACKAGE_JSON, PACKAGE_CONTENT],
				[LOCK_FILE, 'old package-lock.json'],
			]);
			// moved aside, then back again, instead of being downloaded anew
			expect(vi.mocked(renameSync).mock.calls).toStrictEqual([
				[MODULES, RESCUED_MODULES],
				[RESCUED_MODULES, MODULES],
			]);
			// a failed install leaves a partial tree behind, which has to make room first
			expect(vi.mocked(rmSync)).toHaveBeenCalledWith(MODULES, REMOVE_TREE);
			expect(vi.mocked(info)).toHaveBeenCalledWith('Restored package.json and package-lock.json');
			expect(vi.mocked(info)).toHaveBeenCalledWith('Restored the previously installed dependencies');
			expect(vi.mocked(info)).not.toHaveBeenCalledWith('All dependencies are up to date');
		},
	);

	it('should delete the lock file on rollback if there was none before', async () => {
		// nothing exists: no lock file to back up and no modules to park
		vi.mocked(existsSync).mockReturnValue(false);
		failCommand(INSTALL);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${INSTALL} failed`);

		expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([[PACKAGE_JSON, PACKAGE_CONTENT]]);
		expect(vi.mocked(rmSync).mock.calls).toStrictEqual([
			[LOCK_FILE, { force: true }],
			[LOCK_FILE, { force: true }],
			[RESCUE_DIR, REMOVE_TREE],
		]);
		expect(vi.mocked(renameSync)).not.toHaveBeenCalled();
		expect(vi.mocked(info)).toHaveBeenCalledWith('Restored package.json');
	});

	describe('rollback problems', () => {
		it('should restore the modules even if a file cannot be restored', async () => {
			failCommand(INSTALL);
			vi.mocked(writeFileSync).mockImplementationOnce(() => {
				throw new Error('disk full');
			});

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${INSTALL} failed`);

			expect(vi.mocked(warn)).toHaveBeenCalledWith('Could not restore package.json: disk full');
			expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(LOCK_FILE, 'old package-lock.json');
			expect(vi.mocked(renameSync)).toHaveBeenCalledWith(RESCUED_MODULES, MODULES);
		});

		it('should keep the parked modules and say where they are if they cannot be moved back', async () => {
			failCommand(INSTALL);
			vi.mocked(renameSync).mockImplementation((from) => {
				if (from === RESCUED_MODULES) throw new Error('permission denied');
			});

			// the error of the failed step is reported, not the one of the rollback
			await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${INSTALL} failed`);

			expect(vi.mocked(warn).mock.calls.map((c) => c[0])).toStrictEqual([
				'Ignoring peer dependency ranges, the upgraded dependencies may fail to install',
				`Could not restore ${MODULES}: permission denied`,
				`The previous content of ${MODULES} is kept in ${RESCUED_MODULES}`,
				'Move it back, or restore package.json and package-lock.json and run "npm ci"',
			]);
			// the only copy of the previous modules must not be deleted
			expect(vi.mocked(rmSync)).not.toHaveBeenCalledWith(RESCUE_DIR, REMOVE_TREE);
		});
	});

	describe('modules that cannot be moved away', () => {
		/** Makes the move into the temporary directory fail, e.g. the way a cross-device rename does. */
		function failRenameWith(code: string): void {
			vi.mocked(renameSync).mockImplementationOnce(() => {
				throw Object.assign(new Error('rename failed'), { code });
			});
		}

		/** Nothing is left over from an earlier run. */
		function withoutLeftovers(): void {
			vi.mocked(existsSync).mockImplementation((path) => path !== SIBLING_BACKUP);
		}

		it('should rename them in place if the temporary directory is on another filesystem', async () => {
			withoutLeftovers();
			failRenameWith('EXDEV');

			await upgradeDependencies('/test/directory');

			expect(vi.mocked(renameSync).mock.calls).toStrictEqual([
				[MODULES, RESCUED_MODULES],
				[MODULES, SIBLING_BACKUP],
			]);
			// nothing is deleted before the new modules are installed
			expect(vi.mocked(rmSync).mock.calls).toStrictEqual([
				[LOCK_FILE, { force: true }],
				[SIBLING_BACKUP, REMOVE_TREE],
				[RESCUE_DIR, REMOVE_TREE],
			]);
		});

		it('should move them back from there when the upgrade fails', async () => {
			withoutLeftovers();
			failRenameWith('EXDEV');
			failCommand(RESOLVE);

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${RESOLVE} failed`);

			expect(vi.mocked(renameSync)).toHaveBeenLastCalledWith(SIBLING_BACKUP, MODULES);
			expect(vi.mocked(info)).toHaveBeenCalledWith('Restored the previously installed dependencies');
		});

		it('should not overwrite modules left over from an interrupted upgrade', async () => {
			failRenameWith('EXDEV');

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow(
				`"${SIBLING_BACKUP}" is left over from an interrupted upgrade`,
			);

			expect(vi.mocked(renameSync)).toHaveBeenCalledTimes(1);
			expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(PACKAGE_JSON, PACKAGE_CONTENT);
		});

		it('should roll back on any other error', async () => {
			failRenameWith('EACCES');

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow('rename failed');

			expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([
				[PACKAGE_JSON, PACKAGE_CONTENT],
				[LOCK_FILE, 'old package-lock.json'],
			]);
			expect(vi.mocked(mockedShellInstance.stdout)).not.toHaveBeenCalled();
		});
	});

	describe('workspaces', () => {
		const WORKSPACE_MODULES = '/test/directory/packages/core/node_modules';

		beforeEach(() => {
			vi.mocked(readWorkspaceDirectories).mockReturnValue(['packages/core', 'packages/cli']);
			// only one of the two packages has modules of its own
			vi.mocked(existsSync).mockImplementation((path) => path !== '/test/directory/packages/cli/node_modules');
		});

		it('should also move the modules of workspace packages away', async () => {
			await upgradeDependencies('/test/directory');

			expect(vi.mocked(readWorkspaceDirectories)).toHaveBeenCalledWith('/test/directory');
			expect(vi.mocked(renameSync).mock.calls).toStrictEqual([
				[MODULES, RESCUED_MODULES],
				[WORKSPACE_MODULES, `${RESCUE_DIR}/1`],
			]);
		});

		it('should move all of them back when the upgrade fails', async () => {
			failCommand(INSTALL);

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${INSTALL} failed`);

			expect(vi.mocked(renameSync).mock.calls.slice(2)).toStrictEqual([
				[RESCUED_MODULES, MODULES],
				[`${RESCUE_DIR}/1`, WORKSPACE_MODULES],
			]);
		});

		it('should move the first ones back if a later one cannot be moved away', async () => {
			vi.mocked(renameSync).mockImplementation((from) => {
				if (from === WORKSPACE_MODULES) throw Object.assign(new Error('rename failed'), { code: 'EACCES' });
			});

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow('rename failed');

			expect(vi.mocked(renameSync)).toHaveBeenLastCalledWith(RESCUED_MODULES, MODULES);
		});
	});

	describe('interruption', () => {
		/** Returns the handler the upgrade has registered for the given signal. */
		function handlerFor(signal: NodeJS.Signals): (signal: NodeJS.Signals) => void {
			const call = vi.mocked(process.on).mock.calls.find(([event]) => event === signal);
			return call?.[1] as (signal: NodeJS.Signals) => void;
		}

		beforeEach(() => {
			vi.spyOn(process, 'on').mockImplementation(() => process);
			vi.spyOn(process, 'off').mockImplementation(() => process);
			vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
			vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		});

		afterEach(() => {
			vi.restoreAllMocks();
		});

		it('should roll back and exit if no command is running', async () => {
			vi.mocked(ncu).mockImplementationOnce(async () => {
				handlerFor('SIGINT')('SIGINT');
				// the process has exited at this point, so what follows is of no interest
				expect(vi.mocked(process.exit)).toHaveBeenCalledWith(130);
				expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([
					[PACKAGE_JSON, PACKAGE_CONTENT],
					[LOCK_FILE, 'old package-lock.json'],
				]);
				return undefined;
			});

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow('interrupted by SIGINT');
			expect.assertions(3);
		});

		it('should stop a running command and roll back once it is gone', async () => {
			vi.mocked(mockedShellInstance.kill).mockReturnValue(1);
			let restoredWhileRunning = true;
			vi.mocked(mockedShellInstance.run).mockImplementation(async (command: string) => {
				if (command === AUDIT_FIX) {
					handlerFor('SIGTERM')('SIGTERM');
					restoredWhileRunning = vi.mocked(writeFileSync).mock.calls.length > 0;
				}
				// a stopped "npm audit fix" is not reported as a failure, the step has to notice itself
				return { code: null, signal: 'SIGTERM', stdout: '', stderr: '' };
			});

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow('interrupted by SIGTERM');

			expect(vi.mocked(mockedShellInstance.kill)).toHaveBeenCalledWith('SIGTERM');
			expect(restoredWhileRunning).toBe(false);
			expect(vi.mocked(process.exit)).not.toHaveBeenCalled();
			expect(vi.mocked(renameSync)).toHaveBeenLastCalledWith(RESCUED_MODULES, MODULES);
			expect(vi.mocked(mockedShellInstance.stdout)).not.toHaveBeenCalledWith(INSTALL);
		});

		it('should stop listening for signals when the upgrade is done', async () => {
			await upgradeDependencies('/test/directory');

			expect(vi.mocked(process.off)).toHaveBeenCalledWith('SIGINT', handlerFor('SIGINT'));
			expect(vi.mocked(process.off)).toHaveBeenCalledWith('SIGTERM', handlerFor('SIGTERM'));
		});
	});

	describe('known vulnerabilities', () => {
		it('should fix them in the lock file before it is installed', async () => {
			const commands: string[] = [];
			vi.mocked(mockedShellInstance.stdout).mockImplementation(async (command: string) => {
				commands.push(command);
				return '';
			});
			vi.mocked(mockedShellInstance.run).mockImplementation(async (command: string) => {
				commands.push(command);
				return { code: 0, signal: null, stdout: auditReport(), stderr: '' };
			});

			await upgradeDependencies('/test/directory', { peer: true });

			expect(commands).toStrictEqual([RESOLVE, AUDIT_FIX, AUDIT, INSTALL]);
			expect(vi.mocked(warn)).not.toHaveBeenCalled();
		});

		it('should report the vulnerabilities that remain without failing', async () => {
			// npm exits with a non-zero code as long as a vulnerability is left
			mockAudit(auditReport({ moderate: 1, critical: 2 }), 1);

			await upgradeDependencies('/test/directory', { peer: true });

			expect(vi.mocked(warn).mock.calls).toStrictEqual([
				['Known vulnerabilities remaining: 2 critical, 1 moderate - run "npm audit" for details'],
			]);
			expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
			expect(vi.mocked(mockedShellInstance.stdout)).toHaveBeenCalledWith(INSTALL);
		});

		it.each([
			['is not JSON', 'npm error audit endpoint returned an error'],
			['has no counts', '{"error":{"code":"ENOAUDIT"}}'],
		])('should only warn if the audit output %s', async (_case, stdout) => {
			mockAudit(stdout, 1);

			await upgradeDependencies('/test/directory', { peer: true });

			expect(vi.mocked(warn).mock.calls).toStrictEqual([
				['Could not check for known vulnerabilities, please run "npm audit" manually'],
			]);
			expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
		});

		it('should roll back if the fixed lock file cannot be installed', async () => {
			failCommand(INSTALL);

			await expect(upgradeDependencies('/test/directory')).rejects.toThrow(`${INSTALL} failed`);

			expect(vi.mocked(mockedShellInstance.run)).toHaveBeenCalledWith(AUDIT_FIX, false);
			expect(vi.mocked(writeFileSync)).toHaveBeenCalledWith(LOCK_FILE, 'old package-lock.json');
		});

		it('should leave them alone when the option is disabled', async () => {
			await upgradeDependencies('/test/directory', { peer: true, audit: false });

			expect(vi.mocked(mockedShellInstance.run)).not.toHaveBeenCalled();
			expect(vi.mocked(check).mock.calls.map((c) => c[0])).not.toContain('Fix known vulnerabilities');
			expect(vi.mocked(warn)).not.toHaveBeenCalled();
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
