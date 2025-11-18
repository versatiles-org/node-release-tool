import { mkdtempSync, writeFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

const { generateTypescriptDocs } = await import('./doc-typescript.js');

describe('generateTypescriptDocs (integration)', () => {
	let testDir: string, indexTsPath: string;

	beforeEach(() => {
		// Create a temporary directory
		process.chdir(mkdtempSync(join(tmpdir(), 'doc-typescript-')));
		testDir = process.cwd();

		// Write a minimal TS file
		indexTsPath = join(testDir, 'index.ts');
		writeFileSync(indexTsPath, [
			'/**',
			'* Greets a person by name.',
			'*/',
			'export function greet(name: string): string {',
			'  return `Hello, ${name}!`;',
			'}'
		].join('\n'));

		// Write a minimal tsconfig.json
		writeFileSync(join(testDir, 'tsconfig.json'), JSON.stringify({
			compilerOptions: {
				target: 'ES2019',
				module: 'CommonJS',
				strict: true,
				declaration: true,
				outDir: 'dist'
			},
			include: ['./*.ts'],
		}));

		// Write a minimal package.json
		writeFileSync(join(testDir, 'package.json'), JSON.stringify({
			name: 'test-project',
		}));
	})

	async function generateFiles(format: 'markdown' | 'wiki' | 'html'): Promise<string[]> {
		// Invoke doc generator
		const docsDir = join(testDir, 'docs');
		await generateTypescriptDocs({
			entryPoint: indexTsPath,
			outputPath: docsDir,
			format,
			quiet: true,
		});

		// Get generated files
		return readdirSync(docsDir, { recursive: true }).sort() as string[];
	}

	it('should generate TypeDoc output as "markdown"', async () => {
		const files = await generateFiles('markdown');
		expect(files).toStrictEqual([
			'README.md',
			'functions',
			'functions/greet.md',
		]);
	});

	it('should generate TypeDoc output as "wiki"', async () => {
		const files = await generateFiles('wiki');
		expect(files).toStrictEqual([
			'Function.greet.md',
			'Home.md',
			'_Sidebar.md',
		]);
	});

	it('should generate TypeDoc output as "html"', async () => {
		const files = await generateFiles('html');
		expect(files).toStrictEqual([
			'.nojekyll',
			'assets',
			'assets/hierarchy.js',
			'assets/highlight.css',
			'assets/icons.js',
			'assets/icons.svg',
			'assets/main.js',
			'assets/navigation.js',
			'assets/search.js',
			'assets/style.css',
			'assets/typedoc-github-style.css',
			'functions',
			'functions/greet.html',
			'hierarchy.html',
			'index.html',
		]);
	});
});