import { getShell } from './shell.js';
import { jest } from '@jest/globals';

describe('Run', () => {
	const cwd = new URL('../../', import.meta.url).pathname;
	const shell = getShell(cwd);

	it('runs ls', async () => {
		const ls = await shell.run('ls -1');
		expect(ls).toMatchObject({ code: 0, signal: null, stderr: '' });
		expect(ls.stdout).toContain('package.json\n');
	});

	it('returns stdout', async () => {
		expect(await shell.stdout('ls -1')).toContain('package.json\n');
	});

	it('returns stderr', async () => {
		expect(await shell.stderr('git status -h', false)).toContain('usage: git status');
	});

	it('returns ok', async () => {
		expect(await shell.ok('ls -1')).toBe(true);
	});

	it('returns not ok', async () => {
		expect(await shell.ok('exit 1')).toBe(false);
	});

	it('fails on exit 1', async () => {
		const mockError = jest.spyOn(console, 'error');
		mockError.mockImplementationOnce(() => { });
		await expect(shell.run('exit 1')).rejects.toEqual({ code: 1, signal: null, stderr: '', stdout: '' });
		mockError.mockRestore();
	});
})
