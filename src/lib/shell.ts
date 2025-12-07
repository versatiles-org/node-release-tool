import { spawn } from 'child_process';

export class Shell {
	private cwd: string;

	constructor(cwd: string) {
		this.cwd = cwd;
	}

	async run(
		command: string,
		errorOnCodeNonZero: boolean = true
	): Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }> {
		try {
			return await new Promise((resolve, reject) => {
				const stdout: Buffer[] = [];
				const stderr: Buffer[] = [];
				const cp = spawn('bash', ['-c', command], { cwd: this.cwd })
					.on('error', error => reject(error))
					.on('close', (code, signal) => {
						const result = {
							code,
							signal,
							stdout: Buffer.concat(stdout).toString(),
							stderr: Buffer.concat(stderr).toString(),
						};
						if (errorOnCodeNonZero && code !== 0) {
							reject(result);
						} else {
							resolve(result);
						}
					});

				cp.stdout.on('data', chunk => stdout.push(chunk));
				cp.stderr.on('data', chunk => stderr.push(chunk));
			});
		} catch (error) {
			console.error(error);
			throw error;
		}
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