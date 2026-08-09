import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('npm-check-updates', () => ({
	default: vi.fn(),
}));

vi.mock('../lib/log.js', () => ({
	check: vi.fn(),
	info: vi.fn(),
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
const { check, info, warn } = await import('../lib/log.js');
const { existsSync, readFileSync, rmSync, writeFileSync } = await import('fs');
const { Shell } = await import('../lib/shell.js');
const { upgradeDependencies } = await import('./deps-upgrade.js');

const PACKAGE_JSON = '/test/directory/package.json';
const LOCK_FILE = '/test/directory/package-lock.json';

describe('upgradeDependencies', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((filename) =>
			filename === PACKAGE_JSON ? 'old package.json' : 'old package-lock.json',
		);
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
			[PACKAGE_JSON, 'old package.json'],
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
			[PACKAGE_JSON, 'old package.json'],
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

		expect(vi.mocked(writeFileSync).mock.calls).toStrictEqual([[PACKAGE_JSON, 'old package.json']]);
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
});
