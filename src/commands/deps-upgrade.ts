import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import ncu from 'npm-check-updates';
import { tmpdir } from 'os';
import { join } from 'path';
import { satisfies, validRange } from 'semver';
import { formatError, validationError } from '../lib/errors.js';
import { check, info, panic, warn } from '../lib/log.js';
import { Shell } from '../lib/shell.js';

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
}

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
 * Upgrades the dependencies in a package.json file to their latest versions, removes existing
 * installed modules, and reinstalls them in the specified directory.
 *
 * This function performs the following steps:
 * 1. Backs up `package.json` and `package-lock.json` so a failed upgrade can be rolled back.
 * 2. Reads the project's package.json file and updates any existing dependencies to their latest
 *    versions, skipping the dependencies that are ignored (see {@link parseIgnoreRules}) and,
 *    if {@link UpgradeOptions.peer} is set, capping the rest at the versions the declared peer
 *    dependencies still accept.
 * 3. Rebuilds the lock file from scratch and verifies it with `npm ci --dry-run`, while the
 *    installed modules are still in place. An upgrade that cannot be installed therefore fails
 *    here, before anything has been given up.
 * 4. Moves the installed modules into a temporary directory and installs the new ones.
 * 5. Discards the moved modules and logs that all dependencies are up to date.
 *
 * If any step fails, `package.json` and `package-lock.json` are restored to their previous state
 * and the previously installed modules are moved back, so that a failed upgrade does not leave
 * the project half-upgraded. Up to step 4 that costs nothing, because the modules have not been
 * touched yet; afterwards they are moved back instead of being downloaded again.
 *
 * @param directory - The path to the directory containing the Node.js project.
 * @param options - Additional options, e.g. dependencies to ignore.
 * @returns A promise that resolves when the process is complete.
 */
export async function upgradeDependencies(directory: string, options: UpgradeOptions = {}): Promise<void> {
	const shell = new Shell(directory);
	const packageFilename = join(directory, 'package.json');
	const lockFilename = join(directory, 'package-lock.json');
	const modulesPath = join(directory, 'node_modules');

	// Snapshot the current state before anything is modified, so a failed upgrade can be undone.
	// Both files are small enough to keep in memory; the installed modules are not, so they are
	// parked in a temporary directory (see below) instead.
	const packageBackup = readFileSync(packageFilename, 'utf8');
	const lockBackup = existsSync(lockFilename) ? readFileSync(lockFilename, 'utf8') : null;
	let modulesRescued = false;
	let modulesDeleted = false;

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

	// The installed modules are moved here instead of being deleted, so that a failed install is
	// undone by moving them back rather than by downloading everything again.
	const rescueDirectory = mkdtempSync(join(tmpdir(), 'vrt-deps-upgrade-'));
	const rescuedModules = join(rescueDirectory, 'node_modules');

	/**
	 * Restores the backed up files and, if they were already given up, the installed modules.
	 */
	async function rollback(): Promise<void> {
		writeFileSync(packageFilename, packageBackup);
		if (lockBackup === null) {
			rmSync(lockFilename, { force: true });
			info('Restored package.json');
		} else {
			writeFileSync(lockFilename, lockBackup);
			info('Restored package.json and package-lock.json');
		}

		if (modulesRescued) {
			// A failed install leaves a partial tree behind, so drop it before moving the old one back.
			rmSync(modulesPath, REMOVE_TREE);
			renameSync(rescuedModules, modulesPath);
			modulesRescued = false;
			info('Restored the previously installed dependencies');
		} else if (modulesDeleted) {
			// The modules could not be parked, so the previous state has to be installed again.
			const reinstalled = await shell.ok(lockBackup === null ? 'npm install' : 'npm ci');
			if (reinstalled) {
				info('Reinstalled the previous dependencies');
			} else {
				warn('Could not reinstall the previous dependencies, please run "npm install" manually');
			}
		}

		discardRescueDirectory();
	}

	/**
	 * Removes the temporary directory, including any modules still parked in it.
	 *
	 * Never throws: this runs when the upgrade is already done, or after a rollback has restored
	 * everything, so a directory that the operating system cleans up anyway must not fail the
	 * command or mask the error that caused the rollback.
	 */
	function discardRescueDirectory(): void {
		try {
			rmSync(rescueDirectory, REMOVE_TREE);
		} catch (error) {
			warn(`Could not remove the temporary directory ${rescueDirectory}: ${formatError(error)}`);
		}
	}

	await check(
		'Upgrade all dependencies',
		async () => {
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
		},
		rollback,
	);

	// The lock file is rebuilt from scratch, because resolving the new versions on top of the
	// previous resolution hides conflicts that a fresh install would run into.
	rmSync(lockFilename, { force: true });

	await check(
		'Resolve the new dependencies',
		shell.stdout('npm install --package-lock-only --ignore-scripts'),
		rollback,
	);

	// Resolving alone is not conclusive while node_modules is still in place: npm then reuses the
	// installed tree and accepts versions that a clean install rejects. "npm ci --dry-run" checks
	// the new lock file strictly, and does so without touching the installed modules. Scripts are
	// skipped because verifying must not run the project's install hooks a second time.
	await check('Verify the new dependencies', shell.stdout('npm ci --dry-run --ignore-scripts'), rollback);

	// Only now, with the new tree known to be installable, are the modules given up.
	if (existsSync(modulesPath)) {
		try {
			renameSync(modulesPath, rescuedModules);
			modulesRescued = true;
		} catch (error) {
			// EXDEV: the temporary directory is on another filesystem, so the modules cannot be
			// renamed. Copying a whole node_modules tree costs more than the reinstall it saves,
			// so they are deleted and a rollback falls back to reinstalling them.
			if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
			rmSync(modulesPath, REMOVE_TREE);
		}
		modulesDeleted = true;
	}

	await check('Install all dependencies', shell.stdout('npm ci'), rollback);

	discardRescueDirectory();

	// Final log message
	info('All dependencies are up to date');
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
