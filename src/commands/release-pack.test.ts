import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/log.js', () => ({
	check: vi.fn(async (_message: string, promise: Promise<unknown>) => promise),
	info: vi.fn(),
}));

const exec = vi.fn();
vi.mock('../lib/shell.js', () => ({
	Shell: vi.fn(function () {
		return { exec };
	}),
}));

const { Shell } = await import('../lib/shell.js');
const { releasePack } = await import('./release-pack.js');

describe('releasePack', () => {
	let directory: string;
	beforeEach(() => {
		vi.clearAllMocks();
		directory = mkdtempSync(join(tmpdir(), 'vrt-release-pack-'));
		// npm pack writes "<name>-<version>.tgz" into --pack-destination
		exec.mockImplementation(async (_command: string, args: string[]) => {
			const out = args[args.indexOf('--pack-destination') + 1];
			const workspace = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : '.';
			const pkg = JSON.parse(readFileSync(join(directory, workspace, 'package.json'), 'utf8')) as {
				name: string;
				version: string;
			};
			writeFileSync(join(out, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`), '');
			return { code: 0, signal: null, stdout: '', stderr: '' };
		});
	});
	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	function writePackage(path: string, pkg: object): void {
		mkdirSync(join(directory, path), { recursive: true });
		writeFileSync(join(directory, path, 'package.json'), JSON.stringify(pkg));
	}

	it('packs a single package with the release version in the environment', async () => {
		writePackage('.', { name: '@x/single', version: '1.2.0' });
		const release = await releasePack(directory, 'release');

		expect(release).toStrictEqual({
			version: '1.2.0',
			packages: [{ name: '@x/single', file: 'x-single-1.2.0.tgz' }],
		});
		expect(JSON.parse(readFileSync(join(directory, 'release/packages.json'), 'utf8'))).toStrictEqual(release);
		expect(Shell).toHaveBeenCalledWith(directory, { VRT_RELEASE_VERSION: '1.2.0' });
		expect(exec).toHaveBeenCalledWith('npm', ['pack', '--pack-destination', join(directory, 'release')]);
	});

	it('packs the public workspaces in publish order', async () => {
		writePackage('.', { name: 'root', version: '2.0.0', private: true, workspaces: ['packages/*'] });
		writePackage('packages/a-cli', { name: 'cli', version: '2.0.0', dependencies: { core: '^2.0.0' } });
		writePackage('packages/b-core', { name: 'core', version: '2.0.0' });
		writePackage('packages/c-internal', { name: 'internal', version: '2.0.0', private: true });

		const release = await releasePack(directory, 'release');
		expect(release.packages).toStrictEqual([
			{ name: 'core', file: 'core-2.0.0.tgz' },
			{ name: 'cli', file: 'cli-2.0.0.tgz' },
		]);
		expect(exec.mock.calls.map((call) => (call[1] as string[]).at(-1))).toStrictEqual([
			'packages/b-core',
			'packages/a-cli',
		]);
	});

	it('packs nothing if every package is private', async () => {
		writePackage('.', { name: 'root', version: '1.0.0', private: true });
		expect(await releasePack(directory, 'release')).toStrictEqual({ version: '1.0.0', packages: [] });
		expect(exec).not.toHaveBeenCalled();
	});
});
