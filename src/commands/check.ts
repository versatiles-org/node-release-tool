import { JSONSchemaForNPMPackageJsonFiles as Package } from '@schemastore/package';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { info, panic, warn } from '../lib/log.js';

/**
 * Runs all project checks including package.json and workflow validation.
 *
 * @param directory - The project directory to check
 */
export function check(directory: string): void {
	checkPackage(directory);
	checkWorkflow(directory);
}

/**
 * Validates package.json configuration for VersaTiles projects.
 *
 * Checks for:
 * - Required scripts (build, check, prepack, release)
 * - Recommended scripts (test, doc, upgrade, doc-graph)
 * - Script configurations following best practices
 * - Unnecessary dependencies
 *
 * @param directory - The project directory containing package.json
 * @throws {VrtError} If package.json is missing required scripts
 */
export function checkPackage(directory: string): void {
	const pack = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8')) as Package;
	const { scripts } = pack;

	const isPrivate = pack.private === true || String(pack.private).toLowerCase() === 'true';

	if (!scripts) panic('scripts not found');

	if (!scripts.test) info('scripts.test is recommended');
	if (!scripts.doc) info('scripts.doc is recommended');

	if (!scripts.build) warn('scripts.build is required');
	else if (!scripts.build.includes('npm run doc')) {
		warn(`scripts.build should include "npm run doc", but is "${scripts.build}"`);
	}

	if (!scripts.check) warn('scripts.check is required');
	else if (!scripts.check.includes('npm run build')) {
		warn(`scripts.check should include "npm run build", but is "${scripts.check}"`);
	}

	if (!isPrivate) {
		if (!scripts.prepack) warn('scripts.prepack is required');
		else if (scripts.prepack !== 'npm run build') {
			warn(`scripts.prepack should be "npm run build", but is "${scripts.prepack}"`);
		}

		if (!scripts.release) warn('scripts.release is required');
		else if (scripts.release !== 'vrt release-npm') {
			warn(`scripts.release should be "vrt release-npm", but is "${scripts.release}"`);
		}
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

/**
 * Validates GitHub Actions workflow configuration.
 *
 * Checks for the presence of expected workflow files.
 *
 * @param directory - The project directory to check
 */
export function checkWorkflow(directory: string): void {
	if (!existsSync(resolve(directory, '.github/workflows/pages.yml'))) {
		info('GitHub Pages workflow not found');
	}
}
