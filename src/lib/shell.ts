import { spawn } from 'child_process';
import { debug, isVerbose } from './log.js';

export class Shell {
	private cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async run(
		command: string,
		errorOnCodeNonZero: boolean = true,
	): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
		debug(`$ ${command}`);
		return this.exec('bash', ['-c', command], errorOnCodeNonZero, true);
	}

	// Execute a command with arguments directly, avoiding shell escaping issues
	async exec(
		command: string,
		args: string[],
		errorOnCodeNonZero: boolean = true,
		skipLog: boolean = false,
	): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
		if (!skipLog) {
			debug(`$ ${command} ${args.join(' ')}`);
		}
		return await new Promise((resolve, reject) => {
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			const cp = spawn(command, args, { cwd: this.cwd })
				.on('error', (error) => reject(error))
				.on('close', (code, signal) => {
					const result = {
						code,
						signal,
						stdout: Buffer.concat(stdout).toString(),
						stderr: Buffer.concat(stderr).toString(),
					};
					if (isVerbose()) {
						if (result.stdout) result.stdout.split('\n').forEach((line) => debug(`  stdout: ${line}`));
						if (result.stderr) result.stderr.split('\n').forEach((line) => debug(`  stderr: ${line}`));
						debug(`  exit code: ${code}`);
					}
					if (errorOnCodeNonZero && code !== 0) {
						reject(result);
					} else {
						resolve(result);
					}
				});

			cp.stdout.on('data', (chunk) => stdout.push(chunk));
			cp.stderr.on('data', (chunk) => stderr.push(chunk));
		});
	}

	// Runs a command interactively, so the user can interact with stdin/stdout/stderr directly.
	async runInteractive(
		command: string,
		errorOnCodeNonZero: boolean = true,
	): Promise<{ code: number | null; signal: string | null }> {
		return await new Promise((resolve, reject) => {
			const cp = spawn('bash', ['-c', command], {
				cwd: this.cwd,
				stdio: 'inherit', // give full TTY passthrough
			});

			cp.on('error', reject);

			cp.on('close', (code, signal) => {
				const result = { code, signal };
				if (errorOnCodeNonZero && code !== 0) {
					reject(result);
				} else {
					resolve(result);
				}
			});
		});
	}

	async stderr(command: string, errorOnCodeZero?: boolean): Promise<string> {
		const result = await this.run(command, errorOnCodeZero);
		return result.stderr.trim();
	}

	async stdout(command: string, errorOnCodeZero?: boolean): Promise<string> {
		const result = await this.run(command, errorOnCodeZero);
		return result.stdout.trim();
	}

	async ok(command: string): Promise<boolean> {
		const result = await this.run(command, false);
		return result.code === 0;
	}
}
