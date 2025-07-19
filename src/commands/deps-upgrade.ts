import { readFileSync, writeFileSync } from 'fs';
import { inspect } from 'util';
import { check, info, warn } from '../lib/log.js';
import { getShell } from '../lib/shell.js';

// Represents a single version entry from the `npm outdated` command.
interface Entry {
	// The latest version of a dependency available on the npm registry.
	latest: string;
}

// Represents a mapping of dependency names to their version strings.
// For example: `{ "typescript": "^4.0.0" }`.
interface Dependency {
	[k: string]: string;
}

// Represents a Node.js package definition, including its various types of dependencies.
interface Package {
	// Standard runtime dependencies that are required for production.
	dependencies?: Dependency;
	// Development dependencies that are typically only needed during development and testing.
	devDependencies?: Dependency;
	// Optional dependencies that may or may not be installed based on the environment.
	optionalDependencies?: Dependency;
	// Peer dependencies that are required to work properly alongside other host packages.
	peerDependencies?: Dependency;
}

/**
 * Upgrades the dependencies in a package.json file to their latest versions, removes existing
 * installed modules, and reinstalls them in the specified directory.
 *
 * This function performs the following steps:
 * 1. Checks for outdated dependencies by running `npm outdated --all --json`.
 * 2. Reads the project's package.json file and updates any existing dependencies to their latest versions.
 * 3. Removes all installed modules (`node_modules`) and the lock file (`package-lock.json`).
 * 4. Reinstalls and updates all dependencies.
 * 5. Logs a message indicating that all dependencies are up to date.
 *
 * @param directory - The path to the directory containing the Node.js project.
 * @returns A promise that resolves when the process is complete.
 */
export async function upgradeDependencies(directory: string): Promise<void> {
	const shell = getShell(directory);

	// Step 1: Check and upgrade all versions
	await check('Upgrade all versions', async () => {
		const { stdout } = await shell.run('npm outdated --all --json', false);
		const outdated = JSON.parse(stdout) as Record<string, Entry | Entry[]>;
		const latestVersions = new Map<string, string>();

		// Collect the latest version for each dependency
		for (const [name, entry] of Object.entries(outdated)) {
			let version = '0.0.0';
			if (Array.isArray(entry)) {
				for (const item of entry) {
					if (isGreaterSemver(item.latest, version)) version = item.latest;
				}
			} else {
				version = entry.latest;
			}
			latestVersions.set(name, version);
		}

		// Load package.json
		const pack = JSON.parse(readFileSync('package.json', 'utf8')) as Package;

		// Update dependencies to their latest versions
		patch(pack.dependencies);
		patch(pack.devDependencies);
		patch(pack.optionalDependencies);
		patch(pack.peerDependencies);

		// Write the updated package.json
		writeFileSync('package.json', JSON.stringify(pack, null, 2) + '\n');

		/**
		 * Mutates the provided dependency object by updating
		 * each dependency to the latest known version (if available).
		 *
		 * @param dependencies - A mapping of dependency names to their currently specified versions.
		 */
		function patch(dependencies?: Dependency): void {
			if (!dependencies) return;
			for (const name of Object.keys(dependencies)) {
				const version = latestVersions.get(name);
				if (version) dependencies[name] = '^' + version;
			}
		}
	});

	// Step 2: Remove existing dependencies and lock file
	await check('Remove all dependencies', async () => {
		try {
			await shell.run('rm -f package-lock.json');
		} catch (e) {
			warn(inspect(e));
		}
	});

	// Step 3: Reinstall/upgrade all dependencies
	await check('Upgrade all dependencies', shell.stdout('npm update --save'));

	// Final log message
	info('All dependencies are up to date');
}

/**
 * Compares two semantic version strings (major.minor.patch) and checks if `a` is greater than `b`.
 *
 * @param a - A semantic version string (e.g., "1.2.3").
 * @param b - Another semantic version string (e.g., "1.2.4").
 * @returns `true` if `a` is greater than `b`, otherwise `false`.
 * @throws If either version string is invalid (i.e., not in "x.x.x" format).
 */
function isGreaterSemver(a: string, b: string): boolean {
	const pa = a.split('.');
	const pb = b.split('.');
	for (let i = 0; i < 3; i++) {
		const na = Number(pa[i]);
		const nb = Number(pb[i]);
		if (isNaN(na)) throw new Error('Invalid version number: ' + a);
		if (isNaN(nb)) throw new Error('Invalid version number: ' + b);

		if (na > nb) return true;
		if (na < nb) return false;
	}
	return false;
}