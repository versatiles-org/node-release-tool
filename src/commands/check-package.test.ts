import { jest } from '@jest/globals';

// 1. Mock the modules used by check-package.ts
jest.unstable_mockModule('node:fs', () => ({
	readFileSync: jest.fn(),
}));

jest.unstable_mockModule('../lib/log.js', () => ({
	panic: jest.fn((message: string) => {
		throw new Error(message);
	}),
	info: jest.fn(),
}));

// 2. Import the mocked modules and the function under test
const { readFileSync } = await import('node:fs');
const { panic, info } = await import('../lib/log.js');
const { checkPackage } = await import('./check-package.js');

describe('checkPackage', () => {
	// A convenient helper that mocks readFileSync with a given package.json object
	function mockPackageJson(pkg: object) {
		jest.mocked(readFileSync).mockReturnValue(JSON.stringify(pkg));
	}

	beforeEach(() => {
		jest.clearAllMocks();
	});

	it('should pass (no panic) if all required scripts exist and are correct', () => {
		mockPackageJson({
			scripts: {
				build: 'npm run somebuild',
				test: 'npm run test',
				doc: 'npm run doc-graph',
				check: 'npm run check',
				prepack: 'npm run build',
				release: 'vrt release-npm',
				upgrade: 'vrt deps-upgrade',
				'doc-graph': 'echo "dep-graph script"',
			},
		});

		expect(() => checkPackage('/some/path')).not.toThrow();
		// We expect some info calls about recommended scripts if they diverge,
		// but here they are all correct, so no warnings expected except possibly doc checks
		expect(info).toHaveBeenCalledTimes(0);
		expect(panic).toHaveBeenCalledTimes(0);
	});

	it('should panic if "scripts" is missing entirely', () => {
		mockPackageJson({});
		expect(() => checkPackage('/no/scripts')).toThrow('scripts not found');
		expect(panic).toHaveBeenCalledWith('scripts not found');
	});

	it('should panic if "scripts.check" is missing', () => {
		mockPackageJson({
			scripts: {
				build: 'npm run build',
			},
		});
		expect(() => checkPackage('/missing/check')).toThrow('scripts.check is required');
		expect(panic).toHaveBeenCalledWith('scripts.check is required');
	});

	it('should panic if "scripts.prepack" is missing', () => {
		mockPackageJson({
			scripts: {
				check: 'npm run check',
			},
		});
		expect(() => checkPackage('/missing/prepack')).toThrow('scripts.prepack is required');
		expect(panic).toHaveBeenCalledWith('scripts.prepack is required');
	});

	it('should provide an info message if prepack is not "npm run build"', () => {
		mockPackageJson({
			scripts: {
				check: 'npm run check',
				prepack: 'something else',
			},
		});
		// No panic for just the mismatch of prepack, but we do expect an info warning
		expect(() => checkPackage('/incorrect/prepack')).toThrow('scripts.release is required');
		// The function will panic later for missing scripts.release, but first let's check the info message:
		expect(info).toHaveBeenCalledWith('scripts.prepack should be "npm run build", but is "something else"');
	});

	it('should panic if "scripts.release" is missing', () => {
		mockPackageJson({
			scripts: {
				check: 'npm run check',
				prepack: 'npm run build',
			},
		});
		expect(() => checkPackage('/missing/release')).toThrow('scripts.release is required');
		expect(panic).toHaveBeenCalledWith('scripts.release is required');
	});

	it('should provide an info message if release is not "vrt release-npm"', () => {
		mockPackageJson({
			scripts: {
				check: 'npm run check',
				prepack: 'npm run build',
				release: 'some-other-tool release',
			},
		});
		// We'll see it eventually panics for "scripts.upgrade" not found, but let's check the info message:
		expect(() => checkPackage('/incorrect/release')).toThrow('scripts.upgrade is required');
		expect(info).toHaveBeenCalledWith('scripts.release should be "vrt release-npm", but is "some-other-tool release"');
	});

	it('should panic if "scripts.upgrade" is missing', () => {
		mockPackageJson({
			scripts: {
				check: 'npm run check',
				prepack: 'npm run build',
				release: 'vrt release-npm',
			},
		});
		expect(() => checkPackage('/missing/upgrade')).toThrow('scripts.upgrade is required');
		expect(panic).toHaveBeenCalledWith('scripts.upgrade is required');
	});

	it('should provide an info message if upgrade is not "vrt deps-upgrade"', () => {
		mockPackageJson({
			scripts: {
				check: 'npm run check',
				prepack: 'npm run build',
				release: 'vrt release-npm',
				upgrade: 'some-other-tool upgrade',
			},
		});
		// Will panic for missing doc-graph or something else, let's see:
		expect(() => checkPackage('/incorrect/upgrade')).not.toThrow();
		// Actually, in this scenario, it won't panic because everything "required" is there.
		// But we do expect an info about mismatch:
		expect(info).toHaveBeenCalledWith('scripts.upgrade should be "vrt deps-upgrade", but is "some-other-tool upgrade"');
	});

	it('should advise on doc-graph usage if scripts.doc-graph is missing', () => {
		mockPackageJson({
			scripts: {
				check: 'npm run check',
				prepack: 'npm run build',
				release: 'vrt release-npm',
				upgrade: 'vrt deps-upgrade',
				doc: 'npm run doc',
			},
		});
		checkPackage('/missing/doc-graph');
		expect(info).toHaveBeenCalledWith(
			'scripts.doc-graph could be: "vrt deps-graph | vrt doc-insert README.md \'## Dependency Graph\'"'
		);
	});

	it('should advise if scripts.doc exists but doesn’t include "npm run doc-graph"', () => {
		mockPackageJson({
			scripts: {
				check: 'npm run check',
				prepack: 'npm run build',
				release: 'vrt release-npm',
				upgrade: 'vrt deps-upgrade',
				doc: 'npm run something-else',
				'doc-graph': 'echo "dep-graph script"',
			},
		});
		checkPackage('/doc-missing-doc-graph-call');
		expect(info).toHaveBeenCalledWith('scripts.doc should include "npm run doc-graph"');
	});

	it('should show info messages if "npm-check-updates" is present in dependencies', () => {
		mockPackageJson({
			scripts: {
				check: 'npm run check',
				prepack: 'npm run build',
				release: 'vrt release-npm',
				upgrade: 'vrt deps-upgrade',
			},
			dependencies: {
				'npm-check-updates': '^12.0.2',
			},
		});
		// No panic for the mismatch because doc is not strictly required.
		checkPackage('/unwanted/npm-check-updates');
		expect(info).toHaveBeenCalledWith('dependencies "npm-check-updates" is probably not needed');
	});

	it('should show info messages if "npm-check-updates" is present in devDependencies', () => {
		mockPackageJson({
			scripts: {
				check: 'npm run check',
				prepack: 'npm run build',
				release: 'vrt release-npm',
				upgrade: 'vrt deps-upgrade',
			},
			devDependencies: {
				'npm-check-updates': '^12.0.2',
			},
		});
		checkPackage('/unwanted/npm-check-updates-in-dev');
		expect(info).toHaveBeenCalledWith('devDependencies "npm-check-updates" is probably not needed');
	});
});