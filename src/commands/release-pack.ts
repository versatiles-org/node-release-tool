import { mkdirSync, readdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { releaseError } from '../lib/errors.js';
import { check, info } from '../lib/log.js';
import { publishOrder, readManifests } from '../lib/release-plan.js';
import { RELEASE_VERSION_ENV } from '../lib/release-link.js';
import { Shell } from '../lib/shell.js';

/** Name of the file that lists the packed tarballs, in the output directory. */
export const PACKAGES_FILE = 'packages.json';

/**
 * A package packed by {@link releasePack}.
 */
export interface PackedPackage {
	/** The package name. */
	name: string;
	/** The file name of the tarball in the output directory. */
	file: string;
}

/**
 * The content of {@link PACKAGES_FILE}.
 */
export interface PackedRelease {
	/** The version of all packages. */
	version: string;
	/** The packages, in the order they have to be published. */
	packages: PackedPackage[];
}

/**
 * Packs every package of the repository that is published to npm: the root package and the
 * workspaces, unless they are private. The tarballs and {@link PACKAGES_FILE}, which lists them
 * in the order to publish them, are written to `outDirectory`.
 *
 * While packing, the version is in the environment variable {@link RELEASE_VERSION_ENV}, so that
 * generated docs in the package, e.g. of `vrt deps-graph --svg`, link to files at the release tag.
 *
 * @param directory - The repository root.
 * @param outDirectory - Where to write the tarballs, relative to `directory`.
 * @returns What was packed.
 */
export async function releasePack(directory: string, outDirectory: string): Promise<PackedRelease> {
	const manifests = readManifests(directory);
	const version = manifests[0].version;
	const out = resolve(directory, outDirectory);
	mkdirSync(out, { recursive: true });

	const shell = new Shell(directory, { [RELEASE_VERSION_ENV]: version });
	const packages: PackedPackage[] = [];
	for (const manifest of publishOrder(manifests)) {
		const name = manifest.name as string;
		const before = new Set(tarballs(out));
		const args = ['pack', '--pack-destination', out];
		if (manifest.relative !== '') args.push('--workspace', manifest.relative);
		await check(`pack ${name}@${version}`, shell.exec('npm', args));

		// the file name is not parsed from npm's output, which the prepack script may write into
		const added = tarballs(out).filter((file) => !before.has(file));
		if (added.length !== 1)
			throw releaseError(`expected npm pack to write one tarball for ${name}, found ${added.length}`);
		packages.push({ name, file: added[0] });
	}

	const release: PackedRelease = { version, packages };
	writeFileSync(resolve(out, PACKAGES_FILE), JSON.stringify(release, null, 2) + '\n');
	if (packages.length === 0) info('every package is private, so nothing was packed');
	return release;
}

function tarballs(directory: string): string[] {
	return readdirSync(directory).filter((file) => file.endsWith('.tgz'));
}
