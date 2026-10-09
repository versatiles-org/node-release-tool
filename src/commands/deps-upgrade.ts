import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import ncu from 'npm-check-updates';
import { tmpdir } from 'os';
import { join } from 'path';
import { satisfies, validRange } from 'semver';
import { formatError, validationError } from '../lib/errors.js';
import { check, info, panic, warn } from '../lib/log.js';
import { Shell } from '../lib/shell.js';
import { readWorkspaceDirectories } from './deps-graph-workspace.js';

/**
 * Rules describing which dependencies must not be upgraded.
 * The key is the package name, the value is either `true` (never upgrade this package)
 * or a semver range that the upgraded version must satisfy.
 */
export type IgnoreRules = Map<string, true | string>;

/**
 * Options for {@link upgradeDependencies}.
 */
export interface UpgradeOptions {
	/**
	 * Dependencies that must not be upgraded, as `"package"` or `"package@range"`,
	 * e.g. `"path-to-regexp@<7.0.0"`. Merged with the rules from package.json.
	 */
	ignore?: string[];

	/**
	 * Whether upgrades must stay within the peer dependency ranges declared by the other
	 * dependencies (default: `false`).
	 *
	 * Without this, a package is always bumped to its latest release, even when another
	 * dependency does not accept that version yet. Upgrading `typescript` to a major that
	 * `typedoc` does not list as a peer, for example, makes the following `npm install`
	 * fail with `ERESOLVE` and rolls the whole upgrade back. With it, such a package is
	 * bumped to the highest version that every peer range still allows, so the rest of the
	 * upgrade succeeds.
	 *
	 * The `vrt deps-upgrade` command enables this by default and exposes `--no-peer` to
	 * switch it off, so the safe behaviour is the one users get.
	 */
	peer?: boolean;

	/**
	 * Whether known vulnerabilities are fixed as part of the upgrade (default: `true`).
	 *
	 * The new lock file already holds the latest versions the declared ranges allow, so there is
	 * rarely anything left to fix. Where there is, `npm audit fix` raises the affected packages
	 * within those ranges, and the vulnerabilities that cannot be fixed that way are reported at
	 * the end.
	 *
	 * The `vrt deps-upgrade` command exposes `--no-audit` to switch it off.
	 */
	audit?: boolean;
}

/**
 * Number of known vulnerabilities per severity, as reported by `npm audit`.
 */
interface VulnerabilityCounts {
	info: number;
	low: number;
	moderate: number;
	high: number;
	critical: number;
	total: number;
}

/** Severities of vulnerabilities, from the most to the least severe. */
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'] as const;

/**
 * Options for deleting a whole directory tree.
 *
 * A `node_modules` tree is large enough that something can change inside it while it is being
 * walked - on macOS, Finder and Spotlight write a `.DS_Store` into a directory that was just
 * emptied - which makes the final `rmdir` fail with `ENOTEMPTY`. `force` does not cover that,
 * it only suppresses `ENOENT`, so the removal is retried instead.
 */
const REMOVE_TREE = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 } as const;

/**
 * Name of the directory the installed modules are moved to, next to their `node_modules`, if
 * they cannot be moved into the temporary directory.
 */
const SIBLING_BACKUP = 'node_modules.vrt-backup';

/**
 * Upgrades the dependencies in a package.json file to their latest versions and installs them
 * in the specified directory.
 *
 * This function performs the following steps:
 * 1. Backs up `package.json` and `package-lock.json` so a failed upgrade can be rolled back.
 * 2. Reads the project's package.json file and updates any existing dependencies to their latest
 *    versions, skipping the dependencies that are ignored (see {@link parseIgnoreRules}) and,
 *    if {@link UpgradeOptions.peer} is set, capping the rest at the versions the declared peer
 *    dependencies still accept.
 * 3. Moves the installed modules, including those of workspace packages, into a temporary
 *    directory.
 * 4. Rebuilds the lock file from scratch. With the installed modules out of the way npm cannot
 *    reuse them, so indirect dependencies are brought up to date as well, every package is
 *    recorded with its `resolved` and `integrity` fields, and a conflict fails right here.
 * 5. Fixes known vulnerabilities in the lock file unless {@link UpgradeOptions.audit} is disabled.
 * 6. Installs the new modules.
 * 7. Discards the moved modules and logs that all dependencies are up to date, or which
 *    vulnerabilities remain.
 *
 * If any step fails, or the process is interrupted, `package.json` and `package-lock.json` are
 * restored to their previous state and the previously installed modules are moved back, so that
 * a failed upgrade does not leave the project half-upgraded and nothing has to be downloaded
 * again.
 *
 * @param directory - The path to the directory containing the Node.js project.
 * @param options - Additional options, e.g. dependencies to ignore.
 * @returns A promise that resolves when the process is complete.
 */
export async function upgradeDependencies(directory: string, options: UpgradeOptions = {}): Promise<void> {
	const shell = new Shell(directory);
	const packageFilename = join(directory, 'package.json');
	const lockFilename = join(directory, 'package-lock.json');

	// Snapshot the current state before anything is modified, so a failed upgrade can be undone.
	// Both files are small enough to keep in memory; the installed modules are not, so they are
	// parked in a temporary directory (see below) instead.
	const packageBackup = readFileSync(packageFilename, 'utf8');
	const lockBackup = existsSync(lockFilename) ? readFileSync(lockFilename, 'utf8') : null;

	let rules: IgnoreRules;
	try {
		rules = parseIgnoreRules(packageBackup, options.ignore);
	} catch (error) {
		// nothing has been modified yet, so report the misconfiguration and stop
		panic(formatError(error));
	}

	for (const [name, rule] of rules) {
		info(rule === true ? `Ignoring dependency "${name}"` : `Ignoring versions of "${name}" outside of "${rule}"`);
	}

	// Ignoring peer ranges produces upgrades that cannot be installed, so the CLI turns this
	// on by default; as a library option it stays opt-in.
	const peer = options.peer ?? false;
	if (!peer) warn('Ignoring peer dependency ranges, the upgraded dependencies may fail to install');

	// Packages that must not be touched at all.
	const rejected = Array.from(rules)
		.filter(([, rule]) => rule === true)
		.map(([name]) => name);

	// Packages that may only be upgraded within a given range.
	const limited = new Map(
		Array.from(rules).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
	);

	// The installed modules are moved here instead of being deleted, so that a failed upgrade is
	// undone by moving them back rather than by downloading everything again.
	const rescueDirectory = mkdtempSync(join(tmpdir(), 'vrt-deps-upgrade-'));

	/** The module directories that were moved away, and where each of them is now. */
	const parked: { from: string; to: string }[] = [];

	/** The signal that asked the process to stop, if any. */
	let interrupted: NodeJS.Signals | null = null;

	/**
	 * Moves the installed modules of the project and of its workspace packages out of the way.
	 *
	 * Workspace packages are included because npm keeps the modules it could not hoist in their
	 * own `node_modules`, and would reuse those just like the ones of the project itself.
	 */
	function parkModules(): void {
		const directories = [directory, ...readWorkspaceDirectories(directory).map((path) => join(directory, path))];
		directories.forEach((path, index) => {
			const from = join(path, 'node_modules');
			if (!existsSync(from)) return;

			let to = join(rescueDirectory, String(index));
			try {
				renameSync(from, to);
			} catch (error) {
				// EXDEV: the temporary directory is on another filesystem, so the modules cannot be
				// renamed into it. Copying a whole node_modules tree is too slow and deleting it would
				// give up the rollback, so the modules are renamed in place instead.
				if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
				to = join(path, SIBLING_BACKUP);
				if (existsSync(to)) {
					throw validationError(
						`"${to}" is left over from an interrupted upgrade, rename it to "node_modules" or delete it`,
					);
				}
				renameSync(from, to);
			}
			parked.push({ from, to });
		});
	}

	/**
	 * Restores the backed up files and the installed modules.
	 *
	 * Never throws, and does not stop at the first problem: every part is restored on its own, so
	 * that one failure does not keep the others from being undone, and whatever could not be
	 * restored is reported together with the place the previous modules are kept in.
	 */
	function rollback(): void {
		const attempt = (description: string, action: () => void): boolean => {
			try {
				action();
				return true;
			} catch (error) {
				warn(`Could not ${description}: ${formatError(error)}`);
				return false;
			}
		};

		const restoredPackage = attempt('restore package.json', () => writeFileSync(packageFilename, packageBackup));
		const restoredLock = attempt('restore package-lock.json', () => {
			if (lockBackup === null) {
				rmSync(lockFilename, { force: true });
			} else {
				writeFileSync(lockFilename, lockBackup);
			}
		});
		if (restoredPackage && restoredLock) {
			info(lockBackup === null ? 'Restored package.json' : 'Restored package.json and package-lock.json');
		}

		const restoredModules = parked.length > 0;
		const stranded = parked.splice(0).filter(
			({ from, to }) =>
				!attempt(`restore ${from}`, () => {
					// A failed install leaves a partial tree behind, so drop it before moving the old one back.
					rmSync(from, REMOVE_TREE);
					renameSync(to, from);
				}),
		);

		if (stranded.length > 0) {
			// the parked modules are the only copy left, so they must survive for a manual recovery
			for (const { from, to } of stranded) warn(`The previous content of ${from} is kept in ${to}`);
			warn('Move it back, or restore package.json and package-lock.json and run "npm ci"');
			return;
		}
		if (restoredModules) info('Restored the previously installed dependencies');
		discard(rescueDirectory);
	}

	/**
	 * Removes a directory the modules were parked in.
	 *
	 * Never throws: this runs when the upgrade is already done, or after a rollback has restored
	 * everything, so a directory that is no longer needed must not fail the command or mask the
	 * error that caused the rollback.
	 */
	function discard(path: string): void {
		try {
			rmSync(path, REMOVE_TREE);
		} catch (error) {
			warn(`Could not remove the temporary directory ${path}: ${formatError(error)}`);
		}
	}

	/**
	 * Runs one step of the upgrade, which is rolled back if the step fails.
	 *
	 * A step also fails if the process was asked to stop while it ran, even if the step itself
	 * came to an end, because a stopped command does not always report that as a failure.
	 */
	async function step<T>(message: string, action: () => Promise<T> | T): Promise<T> {
		return check(
			message,
			async () => {
				const result = await action();
				if (interrupted !== null) throw new Error(`interrupted by ${interrupted}`);
				return result;
			},
			rollback,
		);
	}

	/**
	 * Undoes the upgrade when the process is asked to stop, e.g. with Ctrl+C, instead of leaving
	 * the project without its modules.
	 */
	function onSignal(signal: NodeJS.Signals): void {
		interrupted = signal;
		// A running command has to be gone before its files can be restored. It is stopped here,
		// which fails the current step and thereby rolls back as soon as the command has exited.
		if (shell.kill(signal) > 0) return;
		process.stderr.write('\n');
		rollback();
		process.exit(signal === 'SIGINT' ? 130 : 143);
	}

	process.on('SIGINT', onSignal);
	process.on('SIGTERM', onSignal);

	try {
		// This has to be the first step: the tool usually runs from the very modules that are moved
		// away next, and ncu still loads parts of itself while it runs. Everything after it only
		// uses code that is already loaded.
		await step('Upgrade all dependencies', async () => {
			await ncu({
				cwd: directory,
				// must be absolute: ncu resolves a relative packageFile against process.cwd(), not `cwd`
				packageFile: packageFilename,
				upgrade: true,
				peer,
				...(rejected.length > 0 ? { reject: rejected } : {}),
				...(limited.size > 0
					? {
							// limited packages stay inside the range declared in package.json, so that
							// patches keep coming in instead of being blocked by a rejected major version
							target: (name: string): 'latest' | 'semver' => (limited.has(name) ? 'semver' : 'latest'),
							filterResults: (name: string, { upgradedVersion }: { upgradedVersion: string }): boolean => {
								const range = limited.get(name);
								return range === undefined || satisfies(upgradedVersion, range);
							},
						}
					: {}),
			});
		});

		// As long as the installed modules are in place, npm builds the new lock file on top of
		// them: indirect dependencies keep their installed versions, their "resolved" and
		// "integrity" fields are dropped, and conflicts that a clean install runs into stay hidden.
		await step('Set the installed dependencies aside', parkModules);

		// The lock file is rebuilt from scratch, because resolving the new versions on top of the
		// previous resolution hides conflicts that a fresh install would run into.
		await step('Resolve the new dependencies', () => {
			rmSync(lockFilename, { force: true });
			return shell.stdout('npm install --package-lock-only --ignore-scripts');
		});

		// Vulnerabilities are fixed in the lock file only, before it is installed, so the fixed
		// versions are covered by the same rollback as the rest of the upgrade.
		const audit = options.audit ?? true;
		const vulnerabilities = audit
			? await step('Fix known vulnerabilities', () => fixVulnerabilities(shell))
			: undefined;

		await step('Install all dependencies', () => shell.stdout('npm ci'));

		// The upgrade is complete, so the previous modules are no longer needed.
		for (const { to } of parked) if (!to.startsWith(rescueDirectory)) discard(to);
		discard(rescueDirectory);

		// Final log message
		info('All dependencies are up to date');

		if (vulnerabilities === null) {
			warn('Could not check for known vulnerabilities, please run "npm audit" manually');
		} else if (vulnerabilities && vulnerabilities.total > 0) {
			const severities = SEVERITIES.filter((severity) => vulnerabilities[severity] > 0)
				.map((severity) => `${vulnerabilities[severity]} ${severity}`)
				.join(', ');
			warn(`Known vulnerabilities remaining: ${severities} - run "npm audit" for details`);
		}
	} finally {
		process.off('SIGINT', onSignal);
		process.off('SIGTERM', onSignal);
	}
}

/**
 * Fixes known vulnerabilities in the lock file, as far as the declared version ranges allow.
 *
 * Never uses `--force`, which would install breaking versions and thereby override both the
 * upgrade that just happened and the dependencies that are held back.
 *
 * Does not fail if vulnerabilities remain or cannot be looked up, e.g. because the registry has
 * no audit endpoint: neither is a reason to roll back an upgrade that is fine otherwise.
 *
 * @param shell - A shell in the project directory.
 * @returns The vulnerabilities that remain, or `null` if they could not be determined.
 */
async function fixVulnerabilities(shell: Shell): Promise<VulnerabilityCounts | null> {
	// exits with a non-zero code whenever a vulnerability is left, so the code says nothing here
	await shell.run('npm audit fix --package-lock-only', false);

	const { stdout } = await shell.run('npm audit --json', false);
	try {
		const report = JSON.parse(stdout) as { metadata?: { vulnerabilities?: VulnerabilityCounts } };
		const counts = report.metadata?.vulnerabilities;
		return typeof counts?.total === 'number' ? counts : null;
	} catch {
		return null;
	}
}

/**
 * Collects the dependencies that must not be upgraded, from the `vrt.depsUpgrade.ignore` field
 * of the given package.json and from additional entries, e.g. `--ignore` command line options.
 *
 * The package.json field accepts a list of entries or an object:
 * ```jsonc
 * "vrt": { "depsUpgrade": { "ignore": ["path-to-regexp"] } }
 * "vrt": { "depsUpgrade": { "ignore": ["path-to-regexp@<7.0.0"] } }
 * "vrt": { "depsUpgrade": { "ignore": { "path-to-regexp": "<7.0.0", "typescript": true } } }
 * ```
 *
 * An entry without a range blocks every upgrade of that package. An entry with a semver range
 * limits upgrades to versions satisfying that range, so patches and minor releases keep coming in.
 *
 * @param packageContent - The content of the package.json file.
 * @param additionalEntries - Additional entries as `"package"` or `"package@range"`.
 * @returns The ignore rules, keyed by package name.
 * @throws A validation error if the configuration is malformed.
 */
export function parseIgnoreRules(packageContent: string, additionalEntries: string[] = []): IgnoreRules {
	const packageData = JSON.parse(packageContent) as {
		vrt?: { depsUpgrade?: { ignore?: unknown } };
	};
	const ignore = packageData.vrt?.depsUpgrade?.ignore;
	const rules: IgnoreRules = new Map();

	if (Array.isArray(ignore)) {
		for (const entry of ignore) {
			if (typeof entry !== 'string') {
				throw validationError(`vrt.depsUpgrade.ignore must only contain strings, but found ${typeof entry}`);
			}
			addIgnoreEntry(rules, entry);
		}
	} else if (typeof ignore === 'object' && ignore !== null) {
		for (const [name, range] of Object.entries(ignore)) {
			if (range === true) {
				rules.set(name, true);
			} else if (typeof range === 'string') {
				rules.set(name, checkRange(name, range));
			} else {
				throw validationError(
					`vrt.depsUpgrade.ignore["${name}"] must be true or a semver range, but is ${JSON.stringify(range)}`,
				);
			}
		}
	} else if (ignore !== undefined) {
		throw validationError('vrt.depsUpgrade.ignore must be a list or an object');
	}

	for (const entry of additionalEntries) addIgnoreEntry(rules, entry);

	return rules;
}

/**
 * Parses a single `"package"` or `"package@range"` entry and adds it to the given rules.
 */
function addIgnoreEntry(rules: IgnoreRules, entry: string): void {
	const text = entry.trim();
	// a leading "@" belongs to the scope, so only a later "@" separates name and range
	const separator = text.lastIndexOf('@');
	const name = separator > 0 ? text.slice(0, separator) : text;
	const range = separator > 0 ? text.slice(separator + 1) : null;

	// a scoped name must contain a slash, otherwise "@<7.0.0" would pass as a package name
	if (name === '' || (name.startsWith('@') && !name.includes('/'))) {
		throw validationError(`invalid package name in ignored dependency "${entry}"`);
	}

	rules.set(name, range === null ? true : checkRange(name, range));
}

/**
 * Ensures that the given string is a valid semver range.
 */
function checkRange(name: string, range: string): string {
	// an empty range is a valid semver range matching everything, but as a rule it is pointless
	if (range.trim() === '' || validRange(range) === null) {
		throw validationError(`invalid version range "${range}" for ignored dependency "${name}"`);
	}
	return range;
}
