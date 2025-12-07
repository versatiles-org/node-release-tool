import ncu from 'npm-check-updates'
import { check, info } from '../lib/log.js';
import { Shell } from '../lib/shell.js';

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
	await check('Upgrade all dependencies', async () => {
		await ncu.run({
			cwd: directory,
			packageFile: 'package.json',
			upgrade: true,
		});
	});

	const shell = new Shell(directory);
	
	await check('Remove lock file and node_modules', shell.stdout('rm -f package-lock.json && rm -rf node_modules'));

	await check('Reinstall all dependencies', shell.stdout('npm i'));

	// Final log message
	info('All dependencies are up to date');
}
