import * as td from 'typedoc';
import * as tdMarkdown from 'typedoc-plugin-markdown';
import * as tdTheme from 'typedoc-github-wiki-theme';
import { panic, warn } from '../lib/log.js';

export async function generateTypescriptDocs(options: { entryPoint?: string, outputPath?: string }) {
	const app = await td.Application.bootstrap({
		entryPoints: [options.entryPoint ?? './src/index.ts'],
		gitRevision: 'main',
		outputs: [{ name: 'markdown', path: options.outputPath ?? './docs' }],
	}, [
		new td.ArgumentsReader(0),
		new td.TypeDocReader(),
		new td.PackageJsonReader(),
		new td.TSConfigReader(),
		new td.ArgumentsReader(300),
	]);


	tdMarkdown.load(app);
	tdTheme.load(app as tdMarkdown.MarkdownApplication);

	app.options.setValue('readme', 'none');
	app.options.setValue('hidePageHeader', true);

	app.options.setValue('classPropertiesFormat', 'table');
	app.options.setValue('enumMembersFormat', 'table');
	app.options.setValue('indexFormat', 'table');
	app.options.setValue('interfacePropertiesFormat', 'table');
	app.options.setValue('parametersFormat', 'table');
	app.options.setValue('propertiesFormat', 'table');
	app.options.setValue('propertyMembersFormat', 'table');
	app.options.setValue('typeDeclarationFormat', 'table');

	const project = await app.convert();
	if (!project) panic('Failed to convert project');

	app.validate(project);

	if (app.logger.hasWarnings()) warn('Warnings found during validation');
	if (app.logger.hasErrors()) panic('Errors found during validation');

	await app.generateOutputs(project);

	if (app.logger.hasWarnings()) warn('Warnings found during validation');
	if (app.logger.hasErrors()) panic('Errors found during validation');
}