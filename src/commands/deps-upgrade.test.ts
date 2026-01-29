import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('npm-check-updates', () => ({
	default: {
		run: vi.fn(),
	},
}));

vi.mock('../lib/log.js', () => ({
	check: vi.fn(),
	info: vi.fn(),
}));

const mockedShellInstance = {
	stdout: vi.fn(async () => ''),
};
vi.mock('../lib/shell.js', () => ({
	Shell: vi.fn(function () { return mockedShellInstance; }),
}));

const ncu = (await import('npm-check-updates')).default;
const { check, info } = await import('../lib/log.js');
const { Shell } = await import('../lib/shell.js');
const { upgradeDependencies } = await import('./deps-upgrade.js');

describe('upgradeDependencies', () => {
	beforeEach(() => {
		vi.clearAllMocks();

		vi.mocked(check).mockImplementation(async <T>(_message: string, promise: Promise<T> | (() => Promise<T>)): Promise<T> => {
			return typeof promise === 'function' ? promise() : promise;
		});
	});

	it('should upgrade dependencies successfully', async () => {
		await upgradeDependencies('/test/directory');

		// Verify Shell was instantiated with correct directory
		expect(vi.mocked(Shell)).toHaveBeenCalledWith('/test/directory');

		// Verify ncu.run was called with correct options
		expect(vi.mocked(ncu.run)).toHaveBeenCalledWith({
			cwd: '/test/directory',
			packageFile: 'package.json',
			upgrade: true,
		});

		// Verify check was called for each step
		expect(vi.mocked(check).mock.calls.map(c => c[0])).toStrictEqual([
			'Upgrade all dependencies',
			'Remove lock file and node_modules',
			'Reinstall all dependencies',
		]);

		// Verify shell commands were executed
		expect(vi.mocked(mockedShellInstance.stdout).mock.calls).toStrictEqual([
			['rm -f package-lock.json && rm -rf node_modules'],
			['npm i'],
		]);

		// Verify info was called at the end
		expect(vi.mocked(info)).toHaveBeenCalledWith('All dependencies are up to date');
	});

	it('should propagate errors from ncu.run', async () => {
		const error = new Error('ncu failed');
		vi.mocked(ncu.run).mockRejectedValueOnce(error);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow('ncu failed');
	});

	it('should propagate errors from shell commands', async () => {
		const error = new Error('shell command failed');
		vi.mocked(mockedShellInstance.stdout).mockRejectedValueOnce(error);

		await expect(upgradeDependencies('/test/directory')).rejects.toThrow('shell command failed');
	});
});
