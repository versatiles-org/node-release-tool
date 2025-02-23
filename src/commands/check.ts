import { JSONSchemaForNPMPackageJsonFiles2 as Package } from '@schemastore/package';
import { readFileSync } from "node:fs"
import { panic, info } from '../lib/log.js';
import { resolve } from 'node:path';


export function checkPackage(directory: string): void {

	const pack = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as Package;
	const { scripts } = pack;

	if (!scripts) panic('scripts not found');

	if (!scripts.build) info('scripts.build is recommended');
	if (!scripts.test) info('scripts.test is recommended');
	if (!scripts.doc) info('scripts.doc is recommended');

	if (!scripts.check) panic('scripts.check is required');

	if (!scripts.prepack) {
		panic('scripts.prepack is required');
	} else if (scripts.prepack !== 'npm run build') {
		info(`scripts.prepack should be "npm run build", but is "${scripts.prepack}"`);
	}

	if (!scripts.release) {
		panic('scripts.release is required');
	} else if (scripts.release !== 'vrt release-npm') {
		info(`scripts.release should be "vrt release-npm", but is "${scripts.release}"`);
	}

	if (!scripts.upgrade) {
		panic('scripts.upgrade is required');
	} else if (scripts.upgrade !== 'vrt deps-upgrade') {
		info(`scripts.upgrade should be "vrt deps-upgrade", but is "${scripts.upgrade}"`);
	}

	if (!scripts['doc-graph']) {
		info(`scripts.doc-graph could be: "vrt deps-graph | vrt doc-insert README.md '## Dependency Graph'"`);
	} else {
		if (!scripts.doc?.includes('npm run doc-graph')) {
			info('scripts.doc should include "npm run doc-graph"');
		}
	}

	if (pack.dependencies?.['npm-check-updates']) {
		info('dependencies npm-check-updates is probably not needed');
	}

	if (pack.devDependencies?.['npm-check-updates']) {
		info('devDependencies npm-check-updates is probably not needed');
	}
}


