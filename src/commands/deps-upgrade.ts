import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import ncu from 'npm-check-updates';
import { join } from 'path';
import { check, info, warn } from '../lib/log.js';
import { Shell } from '../lib/shell.js';

/**
 * Upgrades the dependencies in a package.json file to their latest versions, removes existing
 * installed modules, and reinstalls them in the specified directory.
 *
 * This function performs the following steps:
 * 1. Backs up `package.json` and `package-lock.json` so a failed upgrade can be rolled back.
 * 2. Reads the project's package.json file and updates any existing dependencies to their latest versions.
 * 3. Removes all installed modules (`node_modules`) and the lock file (`package-lock.json`).
 * 4. Reinstalls and updates all dependencies.
 * 5. Logs a message indicating that all dependencies are up to date.
 *
 * If any step fails, `package.json` and `package-lock.json` are restored to their previous state
 * and the previously installed dependencies are reinstalled, so that a failed upgrade does not
 * leave the project half-upgraded.
 *
 * @param directory - The path to the directory containing the Node.js project.
 * @returns A promise that resolves when the process is complete.
 */
export async function upgradeDependencies(directory: string): Promise<void> {
	const shell = new Shell(directory);
	const packageFilename = join(directory, 'package.json');
	const lockFilename = join(directory, 'package-lock.json');

	// Snapshot the current state before anything is modified, so a failed upgrade can be undone.
	const packageBackup = readFileSync(packageFilename, 'utf8');
	const lockBackup = existsSync(lockFilename) ? readFileSync(lockFilename, 'utf8') : null;
	let modulesRemoved = false;

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
