import { check, info } from '../lib/log.js';
import { getShell } from '../lib/shell.js';

export async function upgradeDependencies(directory: string): Promise<void> {
	const shell = getShell(directory);

	await check('Upgrade all packages', shell.stdout('npm update --save'));

	await check('Reinstall all dependencies', async () => {
		await shell.run('rm -rf node_modules');
		await shell.run('npm ci');
	});

	info('All dependencies are up to date');
}