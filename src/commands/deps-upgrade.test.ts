import { vi, describe, beforeEach, it, expect, Mocked } from 'vitest';
import { type Shell } from '../lib/shell.js';

// 1. Mock the modules that deps-upgrade.ts uses:
vi.mock('fs', () => ({
	readFileSync: vi.fn(),
	writeFileSync: vi.fn(),
}));

vi.mock('../lib/log.js', () => ({
	check: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	panic: vi.fn((message: string) => {
		throw new Error(message);
	}),
}));

vi.mock('../lib/shell.js', () => ({
	getShell: vi.fn(),
}));

// 2. Import the mocked modules and the function under test:
const { readFileSync, writeFileSync } = await import('fs');
const { check, info } = await import('../lib/log.js');
const { getShell } = await import('../lib/shell.js');
const { upgradeDependencies } = await import('./deps-upgrade.js');

describe('upgradeDependencies()', () => {
	// We'll create mock implementations for the shell returned by getShell:
	let mockShell: Mocked<Shell>;

	beforeEach(() => {
		// Reset and clear any existing mocks so each test starts clean:
		vi.clearAllMocks();
		vi.resetAllMocks();

		mockShell = {
			// The run() mock will handle different commands you might invoke,
			// such as "npm outdated", "rm -rf node_modules", "rm -f package-lock.json",
			// and so forth. You can customize the returned stdout if needed.
			run: vi.fn(async (command: string, _errorOnCodeNonZero?: boolean) => {
				// For npm outdated, return a mock JSON of outdated packages:
				if (command === 'npm outdated --all --json') {
					return {
						code: 0,
						signal: '',
						stdout: JSON.stringify({
							// This is just an example. You can adjust according to your test scenario.
							'lodash': { latest: '4.17.21' },
							'typescript': [
								{ latest: '4.5.5' },
								{ latest: '4.6.2' }, // multiple array entries show multiple dist-tags
							],
						}),
						stderr: '',
					};
				}
				// Default mock return for other commands:
				return { code: 0, signal: '', stdout: '', stderr: '' };
			}),
			// The stdout() mock is used when shell.stdout('some command') is called:
			stdout: vi.fn(async (_command: string) => {
				// For demonstration, if "npm update" is run via `shell.stdout`, you can just return empty.
				return '';
			}),
			// The stderr() mock is used if shell.stderr('some command') is called:
			stderr: vi.fn(async (_command: string) => ''),
			ok: vi.fn(async (_command: string) => true),
		};

		// When getShell() is called, it will return our mockShell above:
		vi.mocked(getShell).mockReturnValue(mockShell);

		// By default, readFileSync returns a basic package.json with some dependencies:
		vi.mocked(readFileSync).mockReturnValue(
			JSON.stringify({
				dependencies: {
					lodash: '4.17.0',
					typescript: '^4.4.3',
				},
				devDependencies: {
					vi: '^27.0.0',
				},
			})
		);

		// We want check() to simply run the callback without throwing:
		vi.mocked(check).mockImplementation(async (msg, fnOrPromise) =>
			typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise
		);
	});

	it('upgrades dependencies and removes/reinstalls them', async () => {
		await upgradeDependencies('/fake/path');

		// 1) Verify that npm outdated was called once:
		expect(mockShell.run).toHaveBeenCalledWith('npm outdated --all --json', false);

		// 2) Verify we read the package.json from the default location. 
		//    The code reads "package.json" in the current directory (no path join).
		expect(readFileSync).toHaveBeenCalledWith('package.json', 'utf8');

		// 3) Check that we wrote the updated package.json back:
		expect(writeFileSync).toHaveBeenCalledTimes(1);
		const [[writePath, newPackageContents]] = vi.mocked(writeFileSync).mock.calls;
		expect(writePath).toBe('package.json');

		// Convert the new package file contents back to an object for inspection:
		const updatedPkg = JSON.parse(newPackageContents as string);
		expect(updatedPkg).toMatchObject({
			dependencies: {
				lodash: '^4.17.21',   // updated from the latest in the mock data
				typescript: '^4.6.2', // updated from array of versions, the code picks the greatest
			},
			devDependencies: {
				vi: '^27.0.0', // remains unchanged because it wasn't listed in the outdated mock
			},
		});

		// 4) Verify the shell calls to remove node_modules and lock files:
		expect(mockShell.run).toHaveBeenCalledWith('rm -f package-lock.json');

		// 5) Check that "npm update --save" was called via shell.stdout:
		expect(mockShell.stdout).toHaveBeenCalledWith('npm update --save');

		// 6) Finally, we expect a log message saying "All dependencies are up to date":
		expect(info).toHaveBeenCalledWith('All dependencies are up to date');
	});

	it('handles case when no dependencies are outdated', async () => {
		// Make "npm outdated" return an empty JSON:
		mockShell.run.mockImplementationOnce(async (command: string) => {
			if (command === 'npm outdated --all --json') {
				return { code: 0, signal: '', stdout: '{}', stderr: '' };
			}
			return { code: 0, signal: '', stdout: '', stderr: '' };
		});

		await upgradeDependencies('/fake/path');

		// Because it's empty, the package.json should remain unchanged:
		const [[, newPackageContents]] = vi.mocked(writeFileSync).mock.calls;
		expect(JSON.parse(newPackageContents as string)).toMatchObject({
			dependencies: {
				lodash: '4.17.0',
				typescript: '^4.4.3',
			},
			devDependencies: {
				vi: '^27.0.0',
			},
		});
	});

	it('throws if npm outdated returns invalid JSON', async () => {
		// Make "npm outdated" return invalid JSON string:
		mockShell.run.mockImplementationOnce(async (command: string) => {
			if (command === 'npm outdated --all --json') {
				return { code: 0, signal: '', stdout: 'NOT_JSON', stderr: '' };
			}
			return { code: 0, signal: '', stdout: '', stderr: '' };
		});

		// We expect the JSON.parse to fail, which should bubble up:
		await expect(() => upgradeDependencies('/fake/path')).rejects.toThrow();
	});
});