import { JSONSchemaForNPMPackageJsonFiles2 as Package } from '@schemastore/package';
import { readFileSync } from "node:fs"
import { info, panic, warn } from '../lib/log.js';
import { resolve } from 'node:path';


export function checkPackage(directory: string): void {
	let ok = true;

	const pack = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as Package;
	const { scripts } = pack;
	if (!scripts) panic('scripts not found');
	if (!scripts.check) panic('scripts.check is required');
	if (!scripts.build) warn('scripts.build is recommended');
	if (!scripts.prepack) panic('scripts.prepack is required');
	if (scripts.prepack !== 'npm run build') {
		warn(`scripts.prepack should be "npm run build", but is "${scripts.prepack}"`);
		ok = false;
	}

	if (!scripts.release) panic('scripts.release is required');
	if (scripts.release !== 'vrt release-npm') {
		warn(`scripts.release should be "vrt release-npm", but is "${scripts.release}"`);
		ok = false;
	}

	if (!scripts.upgrade) panic('scripts.upgrade is required');
	if (scripts.upgrade !== 'vrt deps-upgrade') {
		warn(`scripts.upgrade should be "vrt deps-upgrade", but is "${scripts.upgrade}"`);
		ok = false;
	}

	if (ok) {
		info('package.json is ok');
	} else {
		panic('errors found in package.json');
	}
}


