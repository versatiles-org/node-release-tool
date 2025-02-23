import { JSONSchemaForNPMPackageJsonFiles2 as Package } from '@schemastore/package';
import { readFileSync } from "node:fs"
import { panic, info, warn } from '../lib/log.js';
import { resolve } from 'node:path';


export function checkPackage(directory: string): void {

	const pack = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as Package;
	const { scripts } = pack;

	if (!scripts) panic('scripts not found');

	if (!scripts.test) info('scripts.test is recommended');
	if (!scripts.doc) info('scripts.doc is recommended');

	if (!scripts.build) panic('scripts.build is required');

	if (!scripts.check) panic('scripts.check is required');
	if (!scripts.check.includes('npm run build')) {
		warn(`scripts.check should include "npm run build", but is "${scripts.check}"`);
	}

	if (!scripts.prepack) panic('scripts.prepack is required');
	if (scripts.prepack !== 'npm run build') {
		warn(`scripts.prepack should be "npm run build", but is "${scripts.prepack}"`);
	}

	if (!scripts.release) panic('scripts.release is required');
	if (scripts.release !== 'vrt release-npm') {
		warn(`scripts.release should be "vrt release-npm", but is "${scripts.release}"`);
	}

	if (!scripts.upgrade) {
		warn('scripts.upgrade is recommended');
	} else if (scripts.upgrade !== 'vrt deps-upgrade') {
		info(`scripts.upgrade should be "vrt deps-upgrade", but is "${scripts.upgrade}"`);
	}

	if (!scripts['doc-graph']) {
		info(`scripts.doc-graph could be: "vrt deps-graph | vrt doc-insert README.md '## Dependency Graph'"`);
	} else {
		if (scripts.doc && !scripts.doc.includes('npm run doc-graph')) {
			info('scripts.doc should include "npm run doc-graph"');
		}
	}

	['npm-check-updates'].forEach((dep) => {
		if (pack.dependencies?.[dep]) {
			info(`dependencies "${dep}" is probably not needed`);
		}
		if (pack.devDependencies?.[dep]) {
			info(`devDependencies "${dep}" is probably not needed`);
		}
	});
}
