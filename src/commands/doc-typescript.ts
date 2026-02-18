import * as td from 'typedoc';
import { panic, warn } from '../lib/log.js';

/**
 * Output format for generated TypeScript documentation.
 */
export type DocFormat = 'markdown' | 'wiki' | 'html';

/**
 * Options for generating TypeScript documentation.
 */
export interface TypescriptDocOptions {
	/** Path to the entry point file (default: './src/index.ts') */
	input?: string;
	/** Output directory for generated docs (default: './docs') */
	output?: string;
	/** Documentation format: 'markdown', 'wiki', or 'html' (default: 'markdown') */
	format?: DocFormat;
	/** Suppress info-level logging (default: false) */
	quiet?: boolean;
}

/**
 * Generates TypeScript documentation using TypeDoc.
 *
 * Supports multiple output formats:
 * - `markdown`: Standard Markdown files using typedoc-plugin-markdown
 * - `wiki`: GitHub Wiki compatible Markdown using typedoc-github-wiki-theme
 * - `html`: HTML documentation using typedoc-github-theme
 *
 * @param options - Configuration options for documentation generation
 * @throws {VrtError} If project conversion fails or validation errors occur
 *
 * @example
 * ```ts
 * // Generate markdown docs from default entry point
 * await generateTypescriptDocs({ format: 'markdown' });
 *
 * // Generate HTML docs to custom directory
 * await generateTypescriptDocs({
 *   input: './src/main.ts',
 *   output: './api-docs',
 *   format: 'html'
 * });
 * ```
 */
export async function generateTypescriptDocs(options: TypescriptDocOptions): Promise<void> {
	const { input, output, quiet } = options;
	const format = options.format ?? 'markdown';
	const isMarkdown = format !== 'html';

	const plugin = [
		isMarkdown && 'typedoc-plugin-markdown',
		format === 'wiki' && 'typedoc-github-wiki-theme',
		format === 'html' && 'typedoc-github-theme',
	].filter(Boolean) as string[];

	const app = await td.Application.bootstrapWithPlugins(
		{
			entryPoints: [input ?? './src/index.ts'],
			out: output ?? './docs',
			plugin,
			logLevel: quiet ? 'Warn' : 'Info',
			highlightLanguages: ['typescript', 'javascript', 'json', 'shell', 'bash', 'sh', 'css', 'html'],
			groupOrder: ['Classes', 'Variables', 'Functions', '*'],
		},
		[new td.TypeDocReader(), new td.PackageJsonReader(), new td.TSConfigReader()],
	);

	app.options.setValue('readme', 'none');

	if (isMarkdown) {
		app.options.setValue('hidePageHeader', true);
		app.options.setValue('classPropertiesFormat', 'table');
		app.options.setValue('enumMembersFormat', 'table');
		app.options.setValue('indexFormat', 'table');
		app.options.setValue('interfacePropertiesFormat', 'table');
		app.options.setValue('parametersFormat', 'table');
		app.options.setValue('propertiesFormat', 'table');
		app.options.setValue('propertyMembersFormat', 'table');
		app.options.setValue('typeDeclarationFormat', 'table');
	}

	if (format === 'html') {
		app.options.setValue('githubPages', true);
	}

	const project = await app.convert();
	if (!project) panic('Failed to convert project');

	app.validate(project);

	if (app.logger.hasWarnings()) warn('Warnings found during validation');
	if (app.logger.hasErrors()) panic('Errors found during validation');

	await app.generateOutputs(project);

	if (app.logger.hasWarnings()) warn('Warnings found during validation');
	if (app.logger.hasErrors()) panic('Errors found during validation');
}
