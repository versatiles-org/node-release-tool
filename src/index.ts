#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { styleText } from 'util';
import { injectMarkdown, updateTOC } from './commands/markdown.js';
import { Command, InvalidArgumentError } from 'commander';
import { cwd } from 'process';
import { generateCommandDocumentation } from './commands/doc-command.js';
import { release } from './commands/release-npm.js';
import { upgradeDependencies } from './commands/deps-upgrade.js';
import { generateDependencyGraph } from './commands/deps-graph.js';
import { check } from './commands/check.js';
import { generateTypescriptDocs } from './commands/doc-typescript.js';

/**
 * Main CLI program, configured with custom text styling for titles, commands, options, etc.
 */
export const program = new Command();

program.configureHelp({
	styleTitle: (str) => styleText('bold', str),
	styleCommandText: (str) => styleText('bold', str),
	styleOptionText: (str) => styleText('cyan', str),
	styleArgumentText: (str) => styleText('green', str),
	styleSubcommandText: (str) => styleText('yellow', str),
	sortOptions: true,
	sortSubcommands: true,
});

program
	.name('vrt')
	.description('CLI tool for releasing packages and generating documentation for Node.js/TypeScript projects.');

/**
 * Command: check-package
 * Checks that the project's package.json includes certain required scripts/fields.
 */
program.command('check')
	.description('Check repo for required scripts and other stuff.')
	.action(() => {
		void check(process.cwd());
	});

/**
 * Command: deps-graph
 * Analyzes the project’s files to produce a dependency graph (in Mermaid format).
 */
program.command('deps-graph')
	.description('Analyze project files and output a dependency graph as Mermaid markup.')
	.action(() => {
		void generateDependencyGraph(process.cwd());
	});

/**
 * Command: deps-upgrade
 * Upgrades project dependencies in package.json to their latest versions and reinstalls them.
 */
program.command('deps-upgrade')
	.description('Upgrade all dependencies in the current project to their latest versions.')
	.action(() => {
		void upgradeDependencies(process.cwd());
	});

/**
 * Command: doc-command
 * Generates Markdown documentation for a given CLI command.
 */
program.command('doc-command')
	.description('Generate Markdown documentation for a specified command and output the result.')
	.argument('<command>', 'Command to document (e.g., "npm run build").')
	.action(async (command: string) => {
		const mdDocumentation = await generateCommandDocumentation(command);
		process.stdout.write(mdDocumentation);
	});

/**
 * Command: doc-insert
 * Inserts Markdown content from stdin into a specified Markdown file under a given heading.
 * Optionally makes the inserted content foldable.
 */
program.command('doc-insert')
	.description('Insert Markdown from stdin into a specified section of a Markdown file.')
	.argument('<readme>', 'Path to the target Markdown file (e.g., README.md).', checkFilename)
	.argument('[heading]', 'Heading in the Markdown file where content should be placed. Default is "# API".', '# API')
	.argument('[foldable]', 'Whether to wrap the inserted content in a foldable section.', false)
	.action(async (mdFilename: string, heading: string, foldable: boolean) => {
		const buffers = [];
		for await (const data of process.stdin) {
			buffers.push(data);
		}
		const mdContent = '<!--- This chapter is generated automatically --->\n'
			+ Buffer.concat(buffers).toString();

		let mdFile = readFileSync(mdFilename, 'utf8');
		mdFile = injectMarkdown(mdFile, mdContent, heading, foldable);
		writeFileSync(mdFilename, mdFile);
	});

/**
 * Command: doc-toc
 * Updates or generates a Table of Contents in a Markdown file under a specified heading.
 */
program.command('doc-toc')
	.description('Generate a Table of Contents (TOC) in a Markdown file.')
	.argument('<readme>', 'Path to the Markdown file (e.g., README.md).', checkFilename)
	.argument('[heading]', 'Heading in the Markdown file where TOC should be inserted. Default is "# Table of Content".', '# Table of Content')
	.action((mdFilename: string, heading: string) => {
		let mdFile = readFileSync(mdFilename, 'utf8');
		mdFile = updateTOC(mdFile, heading);
		writeFileSync(mdFilename, mdFile);
	});

/**
 * Command: doc-typescript
 * Generates documentation for a TypeScript project.
 * Allows specifying entry point and output location.
 */
program.command('doc-typescript')
	.description('Generate documentation for a TypeScript project.')
	.option('-i, --input <entryPoint>', 'Entry point of the TypeScript project. Default is "./src/index.ts".')
	.option('-o, --output <outputPath>', 'Output path for the generated documentation. Default is "./docs".')
	.option('-f, --format <format>', 'Allowed are "markdown", "wiki" and "html". Default is "markdown".')
	.action(async (options) => {
		await generateTypescriptDocs(options);
	});

/**
 * Command: release-npm
 * Releases/publishes an npm package from a specified project path to the npm registry.
 */
program.command('release-npm')
	.description('Publish an npm package from the specified path to the npm registry.')
	.argument('[path]', 'Root path of the Node.js project. Defaults to the current directory.')
	.action((path: string | null) => {
		void release(resolve(path ?? '.', process.cwd()), 'main');
	});

if (process.env.NODE_ENV !== 'test') {
	await program.parseAsync();
}

/**
 * Validates that the given filename exists.
 * Throws an InvalidArgumentError if the file cannot be found.
 *
 * @param filename - The filename to check.
 * @returns The resolved full path if the file exists.
 */
function checkFilename(filename: string): string {
	const fullname = resolve(cwd(), filename);
	if (!existsSync(fullname)) {
		throw new InvalidArgumentError(`File not found: ${filename}`);
	}
	return fullname;
}
