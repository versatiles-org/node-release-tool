import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Shell, ShellResult } from './shell.js';
import { formatDuration, isAvailableOnNpm, waitForNpmRelease } from './npm-registry.js';

const TARBALL = 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.2.3.tgz';

function result(code: number, stdout = ''): ShellResult {
	return { code, signal: null, stdout, stderr: '' };
}

function mockShell(...results: ShellResult[]): { shell: Shell; exec: ReturnType<typeof vi.fn> } {
	const exec = vi.fn<(...args: unknown[]) => Promise<ShellResult>>();
	for (const r of results) exec.mockResolvedValueOnce(r);
	exec.mockResolvedValue(results[results.length - 1]);
	return { shell: { exec } as unknown as Shell, exec };
}

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
	fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 200 }));
	vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('isAvailableOnNpm', () => {
	it('should ask npm for the tarball and check that it can be downloaded', async () => {
		const { shell, exec } = mockShell(result(0, JSON.stringify([TARBALL])));

		expect(await isAvailableOnNpm(shell, '@scope/pkg', '1.2.3')).toBe(true);
		expect(exec.mock.calls).toStrictEqual([
			['npm', ['view', '@scope/pkg@1.2.3', 'dist.tarball', '--json', '--prefer-online'], false],
		]);
		expect(fetchMock.mock.calls).toStrictEqual([[TARBALL, { method: 'HEAD', cache: 'no-store' }]]);
	});

	it('should accept the tarball as a plain JSON string, as older npm versions print it', async () => {
		const { shell } = mockShell(result(0, JSON.stringify(TARBALL)));
		expect(await isAvailableOnNpm(shell, '@scope/pkg', '1.2.3')).toBe(true);
	});

	it('should be false while npm does not know the version', async () => {
		const { shell } = mockShell(result(1, '{"error":{"code":"E404"}}'));
		expect(await isAvailableOnNpm(shell, '@scope/pkg', '1.2.3')).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('should be false when npm prints no tarball', async () => {
		const { shell } = mockShell(result(0, ''));
		expect(await isAvailableOnNpm(shell, '@scope/pkg', '1.2.3')).toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('should be false while the tarball cannot be downloaded', async () => {
		const { shell } = mockShell(result(0, JSON.stringify([TARBALL])));
		fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
		expect(await isAvailableOnNpm(shell, '@scope/pkg', '1.2.3')).toBe(false);
	});

	it('should be false when the download fails', async () => {
		const { shell } = mockShell(result(0, JSON.stringify([TARBALL])));
		fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
		expect(await isAvailableOnNpm(shell, '@scope/pkg', '1.2.3')).toBe(false);
	});
});

describe('waitForNpmRelease', () => {
	function clock(): { now: () => number; sleep: (ms: number) => Promise<void> } {
		let time = 0;
		return {
			now: () => time,
			sleep: async (ms: number) => {
				time += ms;
			},
		};
	}

	it('should return at once when the version is available', async () => {
		const { shell, exec } = mockShell(result(0, JSON.stringify([TARBALL])));
		const onPending = vi.fn();

		expect(await waitForNpmRelease(shell, '@scope/pkg', '1.2.3', { ...clock(), onPending })).toBe(0);
		expect(exec).toHaveBeenCalledTimes(1);
		expect(onPending).not.toHaveBeenCalled();
	});

	it('should probe until the version is available', async () => {
		const { shell, exec } = mockShell(result(1), result(1), result(0, JSON.stringify([TARBALL])));
		const onPending = vi.fn();

		const elapsed = await waitForNpmRelease(shell, '@scope/pkg', '1.2.3', {
			...clock(),
			intervalMs: 10_000,
			onPending,
		});

		expect(elapsed).toBe(20_000);
		expect(exec).toHaveBeenCalledTimes(3);
		expect(onPending.mock.calls).toStrictEqual([[0], [10_000]]);
	});

	it('should give up after the timeout', async () => {
		const { shell, exec } = mockShell(result(1));

		const elapsed = await waitForNpmRelease(shell, '@scope/pkg', '1.2.3', {
			...clock(),
			intervalMs: 10_000,
			timeoutMs: 30_000,
		});

		expect(elapsed).toBeUndefined();
		expect(exec).toHaveBeenCalledTimes(4);
	});
});

describe('formatDuration', () => {
	it('should format seconds and minutes', () => {
		expect(formatDuration(0)).toBe('0s');
		expect(formatDuration(40_400)).toBe('40s');
		expect(formatDuration(60_000)).toBe('1m 00s');
		expect(formatDuration(125_000)).toBe('2m 05s');
	});
});
