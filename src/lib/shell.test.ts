import { describe, expect, it, vi } from 'vitest';
import { Shell } from './shell.js';

describe('Shell', () => {
	const cwd = new URL('../../', import.meta.url).pathname;
	const shell = new Shell(cwd);

	describe('run', () => {
		it('runs ls successfully', async () => {
			const ls = await shell.run('ls -1');
			expect(ls).toMatchObject({ code: 0, signal: null, stderr: '' });
			expect(ls.stdout).toContain('package.json\n');
		});

		it('fails on exit 1', async () => {
			const mockError = vi.spyOn(console, 'error');
			mockError.mockImplementationOnce(() => {});
			await expect(shell.run('exit 1')).rejects.toEqual({ code: 1, signal: null, stderr: '', stdout: '' });
			mockError.mockRestore();
		});

		it('does not throw when errorOnCodeNonZero is false', async () => {
			const result = await shell.run('exit 1', false);
			expect(result.code).toBe(1);
		});

		it('captures stderr on failed command', async () => {
			const mockError = vi.spyOn(console, 'error');
			mockError.mockImplementationOnce(() => {});
			try {
				await shell.run('>&2 echo "error message" && exit 1');
			} catch (e) {
				expect(e).toMatchObject({ code: 1, stderr: 'error message\n' });
			}
			mockError.mockRestore();
		});
	});

	describe('stdout', () => {
		it('returns stdout', async () => {
			expect(await shell.stdout('echo "message to stdout"')).toBe('message to stdout');
		});

		it('throws on non-zero exit code by default', async () => {
			const mockError = vi.spyOn(console, 'error');
			mockError.mockImplementationOnce(() => {});
			await expect(shell.stdout('exit 1')).rejects.toBeDefined();
			mockError.mockRestore();
		});

		it('handles multiline output', async () => {
			const result = await shell.stdout('echo "line1" && echo "line2"');
			expect(result).toBe('line1\nline2');
		});

		it('handles empty output', async () => {
			const result = await shell.stdout('true');
			expect(result).toBe('');
		});
	});

	describe('stderr', () => {
		it('returns stderr', async () => {
			expect(await shell.stderr('>&2 echo "message to stderr"')).toBe('message to stderr');
		});

		it('handles empty stderr', async () => {
			const result = await shell.stderr('echo "stdout only"');
			expect(result).toBe('');
		});
	});

	describe('ok', () => {
		it('returns true for successful command', async () => {
			expect(await shell.ok('ls -1')).toBe(true);
		});

		it('returns false for failed command', async () => {
			expect(await shell.ok('exit 1')).toBe(false);
		});

		it('returns false for non-existent command', async () => {
			expect(await shell.ok('nonexistent_command_xyz_123')).toBe(false);
		});
	});

	describe('exec', () => {
		it('executes command with arguments', async () => {
			const result = await shell.exec('echo', ['hello', 'world']);
			expect(result.code).toBe(0);
			expect(result.stdout).toBe('hello world\n');
		});

		it('handles arguments with spaces', async () => {
			const result = await shell.exec('echo', ['hello world']);
			expect(result.stdout).toBe('hello world\n');
		});

		it('throws on non-zero exit code', async () => {
			const mockError = vi.spyOn(console, 'error');
			mockError.mockImplementationOnce(() => {});
			await expect(shell.exec('sh', ['-c', 'exit 1'])).rejects.toMatchObject({ code: 1 });
			mockError.mockRestore();
		});
	});
});
