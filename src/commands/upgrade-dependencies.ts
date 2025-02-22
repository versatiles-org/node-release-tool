import { check, info } from '../lib/log.js';
import { getShell } from '../lib/shell.js';

export async function upgradeDependencies(directory: string): Promise<void> {
	const shell = getShell(directory);

	await check('Remove all dependencies', async () => {
		await shell.run('rm -rf node_modules');
		await shell.run('rm -f package-lock.json');
	});

	await check('Upgrade all dependencies', shell.stdout('npm update --save'));

	info('All dependencies are up to date');
}