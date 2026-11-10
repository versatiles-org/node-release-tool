import { debug } from '../core/log.js';
import type { Shell } from './shell.js';

/**
 * Options for {@link waitForNpmRelease}.
 */
export interface WaitForNpmReleaseOptions {
	/** Delay between two probes in milliseconds (default: 10 seconds) */
	intervalMs?: number;
	/** How long to keep probing in milliseconds (default: 15 minutes) */
	timeoutMs?: number;
	/** Called after each probe that found the release not yet available */
	onPending?: (elapsedMs: number) => void;
	/** Waits between probes, replaceable in tests */
	sleep?: (ms: number) => Promise<void>;
	/** Returns the current time in milliseconds, replaceable in tests */
	now?: () => number;
}

/**
 * Checks whether a version of a package can be installed from the registry: npm must list the
 * version, and its tarball must be downloadable.
 *
 * `npm view` asks the registry configured for the package, including scoped registries, as
 * `npm install` does.
 *
 * @param shell - Shell in the package directory.
 * @param name - The package name, e.g. `@versatiles/release-tool`.
 * @param version - The version to look for, e.g. `2.20.0`.
 * @returns Whether the version is available.
 */
export async function isAvailableOnNpm(shell: Shell, name: string, version: string): Promise<boolean> {
	const result = await shell.exec(
		'npm',
		['view', `${name}@${version}`, 'dist.tarball', '--json', '--prefer-online'],
		false,
	);
	// npm exits with E404 while the registry does not know the version yet
	if (result.code !== 0) return false;

	const tarball = parseTarballUrl(result.stdout);
	if (!tarball) {
		debug(`npm view returned no tarball for ${name}@${version}`);
		return false;
	}

	try {
		const response = await fetch(tarball, { method: 'HEAD', cache: 'no-store' });
		debug(`HEAD ${tarball}: ${response.status}`);
		return response.ok;
	} catch (error) {
		debug(`HEAD ${tarball} failed: ${String(error)}`);
		return false;
	}
}

/**
 * Probes the registry until a freshly published version is available, because npm may take a few
 * minutes, e.g. for security scans, before it serves a new version.
 *
 * @param shell - Shell in the package directory.
 * @param name - The package name.
 * @param version - The published version.
 * @param options - Probe interval, timeout and test hooks.
 * @returns The milliseconds it took until the version was available, or `undefined` on timeout.
 */
export async function waitForNpmRelease(
	shell: Shell,
	name: string,
	version: string,
	options: WaitForNpmReleaseOptions = {},
): Promise<number | undefined> {
	const {
		intervalMs = 10_000,
		timeoutMs = 15 * 60_000,
		onPending,
		sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
		now = Date.now,
	} = options;

	const start = now();
	for (;;) {
		if (await isAvailableOnNpm(shell, name, version)) return now() - start;
		const elapsed = now() - start;
		if (elapsed + intervalMs > timeoutMs) return undefined;
		onPending?.(elapsed);
		await sleep(intervalMs);
	}
}

/**
 * Formats a duration as e.g. `2m 05s` or `40s`.
 *
 * @param ms - The duration in milliseconds.
 * @returns The formatted duration.
 */
export function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	const minutes = Math.floor(seconds / 60);
	if (minutes === 0) return `${seconds}s`;
	return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/**
 * Reads the tarball URL from the JSON output of `npm view … dist.tarball --json`, which is a string
 * or, in newer npm versions, an array with one string.
 */
function parseTarballUrl(stdout: string): string | undefined {
	try {
		const value: unknown = JSON.parse(stdout);
		const url = Array.isArray(value) ? value[0] : value;
		return typeof url === 'string' && url.length > 0 ? url : undefined;
	} catch {
		return undefined;
	}
}
