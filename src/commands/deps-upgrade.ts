import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import ncu from 'npm-check-updates';
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
}

/**
 * Upgrades the dependencies in a package.json file to their latest versions, removes existing
 * installed modules, and reinstalls them in the specified directory.
 *
 * This function performs the following steps:
 * 1. Backs up `package.json` and `package-lock.json` so a failed upgrade can be rolled back.
 * 2. Reads the project's package.json file and updates any existing dependencies to their latest
 *    versions, skipping the dependencies that are ignored (see {@link parseIgnoreRules}).
 * 3. Removes all installed modules (`node_modules`) and the lock file (`package-lock.json`).
 * 4. Reinstalls and updates all dependencies.
 * 5. Logs a message indicating that all dependencies are up to date.
 *
 * If any step fails, `package.json` and `package-lock.json` are restored to their previous state
 * and the previously installed dependencies are reinstalled, so that a failed upgrade does not
 * leave the project half-upgraded.
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
	const packageBackup = readFileSync(packageFilename, 'utf8');
	const lockBackup = existsSync(lockFilename) ? readFileSync(lockFilename, 'utf8') : null;
	let modulesRemoved = false;

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

	// Packages that must not be touched at all.
	const rejected = Array.from(rules)
		.filter(([, rule]) => rule === true)
		.map(([name]) => name);

	// Packages that may only be upgraded within a given range.
	const limited = new Map(
		Array.from(rules).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
	);

	/**
	 * Restores the backed up files and, if they were already deleted, the installed modules.
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

		if (!modulesRemoved) return;

		// node_modules was deleted before the failing install, so rebuild the previous state.
		const reinstalled = await shell.ok(lockBackup === null ? 'npm install' : 'npm ci');
		if (reinstalled) {
			info('Reinstalled the previous dependencies');
		} else {
			warn('Could not reinstall the previous dependencies, please run "npm install" manually');
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

	await shell.run('rm -f package-lock.json && rm -rf node_modules', false);
	modulesRemoved = true;

	await check('Reinstall all dependencies', shell.stdout('npm i'), rollback);

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
