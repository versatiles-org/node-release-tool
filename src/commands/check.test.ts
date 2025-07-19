import { jest } from '@jest/globals';

// 1. Mock the modules used by check-package.ts
jest.unstable_mockModule('fs', () => ({
	readFileSync: jest.fn(),
	existsSync: jest.fn(() => true),
}));

jest.unstable_mockModule('../lib/log.js', () => ({
	panic: jest.fn((message: string) => {
		throw new Error(message);
	}),
	info: jest.fn(),
	warn: jest.fn(),
}));

// 2. Import the mocked modules and the function under test
const { readFileSync } = await import('fs');
const log = await import('../lib/log.js');
const { check } = await import('./check.js');

describe('check', () => {
	const goodPackage = {
		scripts: {
			build: 'run build script && npm run doc-graph',
			test: 'test',
			doc: 'npm run doc-graph',
			check: 'npm run build && npm run test',
			prepack: 'npm run build',
			release: 'vrt release-npm',
			upgrade: 'vrt deps-upgrade',
			'doc-graph': 'vrt deps-graph',
		},
	};

	beforeEach(() => {
		jest.clearAllMocks();
	});

	function testPackage(pkg: { scripts?: object | null }, result: { info?: string[], warn?: string[], panic?: string[] }) {
		if (!pkg) pkg = goodPackage;
		if (pkg.scripts !== null) {
			pkg.scripts = { ...goodPackage.scripts, ...pkg.scripts }
		}
		jest.mocked(readFileSync).mockReturnValue(JSON.stringify(pkg));

		try {
			check('/some/path')
		} catch (_) {
			// ignore
		}

		expect(calls(log.info)).toStrictEqual(result.info ?? []);
		expect(calls(log.warn)).toStrictEqual(result.warn ?? []);

		function calls(fn: (text: string) => void): string[] {
			return jest.mocked(fn).mock.calls.map((call) => call[0]);
		}
	}

	it('should pass if all required scripts exist and are correct', () => {
		testPackage({}, {});
	});

	it('should panic if "scripts" is missing entirely', () => {
		testPackage({ scripts: null }, { panic: ['scripts not found'] });
	});

	describe('scripts', () => {

		it('should info  if "test" is missing', () => {
			testPackage({ scripts: { test: null } }, { info: ['scripts.test is recommended'] });
		});

		it('should info  if "doc" is missing', () => {
			testPackage({ scripts: { doc: null } }, { info: ['scripts.doc is recommended'] });
		});

		it('should warn if "build" is missing', () => {
			testPackage({ scripts: { build: null } }, { warn: ['scripts.build is required'] });
		});

		it('should warn if "check" is missing', () => {
			testPackage({ scripts: { check: null } }, { warn: ['scripts.check is required'] });
		});
		it('should warn  if "check" does not include "npm run build"', () => {
			testPackage({ scripts: { check: 'something' } }, { warn: ['scripts.check should include "npm run build", but is "something"'] });
		});

		it('should warn if "prepack" is missing', () => {
			testPackage({ scripts: { prepack: null } }, { warn: ['scripts.prepack is required'] });
		});
		it('should warn  if "prepack" is not "npm run build"', () => {
			testPackage({ scripts: { prepack: 'something' } }, { warn: ['scripts.prepack should be "npm run build", but is "something"'] });
		});

		it('should warn if "release" is missing', () => {
			testPackage({ scripts: { release: null } }, { warn: ['scripts.release is required'] });
		});
		it('should warn  if "release" is not "vrt release-npm"', () => {
			testPackage({ scripts: { release: 'something' } }, { warn: ['scripts.release should be "vrt release-npm", but is "something"'] });
		});

		it('should panic if "upgrade" is missing', () => {
			testPackage({ scripts: { upgrade: null } }, { warn: ['scripts.upgrade is recommended'] });
		});
		it('should warn  if "upgrade" is not "vrt deps-upgrade"', () => {
			testPackage({ scripts: { upgrade: 'something' } }, { info: ['scripts.upgrade should be "vrt deps-upgrade", but is "something"'] });
		});
	})
});
