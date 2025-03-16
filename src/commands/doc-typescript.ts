import * as td from 'typedoc';
import { panic, warn } from '../lib/log.js';

export async function generateTypescriptDocs(options: { entryPoint?: string, outputPath?: string, format?: 'markdown' | 'wiki' | 'html', quiet?: boolean }) {
	const { entryPoint, outputPath, quiet } = options;
	const format = options.format ?? 'markdown';
	const isMarkdown = format !== 'html';

	const plugin = [
		isMarkdown && 'typedoc-plugin-markdown',
		format === 'wiki' && 'typedoc-github-wiki-theme',
		format === 'html' && 'typedoc-github-theme',
	].filter(Boolean) as string[];

	const app = await td.Application.bootstrapWithPlugins({
		entryPoints: [entryPoint ?? './src/index.ts'],
		out: outputPath ?? './docs',
		plugin,
		logLevel: quiet ? 'Warn' : 'Info',
		highlightLanguages: ['typescript', 'javascript', 'json', 'shell', 'bash', 'sh', 'css', 'html'],
	}, [
		new td.TypeDocReader(),
		new td.PackageJsonReader(),
		new td.TSConfigReader(),
	]);

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