#!/usr/bin/env -S node --enable-source-maps

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { injectMarkdown, updateTOC } from './commands/markdown.js';
import { Command, InvalidArgumentError } from 'commander';
import { cwd } from 'node:process';
import { generateCommandDocumentation } from './commands/doc-command.js';
import { release } from './commands/release-npm.js';
import { upgradeDependencies } from './commands/deps-upgrade.js';
import { generateDependencyGraph } from './commands/deps-graph.js';
import { checkPackage } from './commands/check-package.js';
import { generateTypescriptDocs } from './commands/doc-typescript.js';


export const program = new Command();

program
	.name('vrt')
	.description('versatiles release and documentaion tool');

program.command('check-package')
	.description('checks the package.json for required scripts')
	.action(() => {
		void checkPackage(process.cwd());
	});

program.command('deps-graph')
	.description('draws a graph of all files in the project and outputs it as mermaid')
	.action(() => {
		void generateDependencyGraph(process.cwd());
	});

program.command('deps-upgrade')
	.description('upgrades all dependencies to the latest version')
	.action(() => {
		void upgradeDependencies(process.cwd());
	});

program.command('doc-command')
	.description('documents a runnable command and outputs it')
	.argument('<command>', 'command to run')
	.action(async (command: string) => {
		const mdDocumentation = await generateCommandDocumentation(command);
		process.stdout.write(mdDocumentation);
	});

program.command('doc-insert')
	.description('takes Markdown from stdin and insert it into a Markdown file')
	.argument('<readme>', 'Markdown file, like a readme.md', checkFilename)
	.argument('[heading]', 'Heading in the Markdown file', '# API')
	.argument('[foldable]', 'Make content foldable', false)
	.action(async (mdFilename: string, heading: string, foldable: boolean) => {
		const buffers = [];
		for await (const data of process.stdin) buffers.push(data);
		const mdContent = '<!--- This chapter is generated automatically --->\n' + Buffer.concat(buffers).toString();

		let mdFile = readFileSync(mdFilename, 'utf8');
		mdFile = injectMarkdown(mdFile, mdContent, heading, foldable);
		writeFileSync(mdFilename, mdFile);
	});

program.command('doc-toc')
	.description('updates the TOC in a Markdown file')
	.argument('<readme>', 'Markdown file, like a readme.md', checkFilename)
	.argument('[heading]', 'Heading in the Markdown file', '# Table of Content')
	.action((mdFilename: string, heading: string) => {
		let mdFile = readFileSync(mdFilename, 'utf8');
		mdFile = updateTOC(mdFile, heading);
		writeFileSync(mdFilename, mdFile);
	});

program.command('doc-typescript')
	.description('generates a documentation for a TypeScript project')
	.option('-i <entryPoint>', 'entry point of the TypeScript project, default is "./src/index.ts"')
	.option('-o <outputPath>', 'output path for the documentation, default is "./docs"')
	.action(async (options) => {
		await generateTypescriptDocs(options);
	});

program.command('release-npm')
	.description('releases a npm package')
	.argument('[path]', 'root path of the Node.js project')
	.action((path: string | null) => {
		void release(resolve(path ?? '.', process.cwd()), 'main');
	});

if (process.env.NODE_ENV !== 'test') {
	await program.parseAsync();
}

function checkFilename(filename: string): string {
	const fullname = resolve(cwd(), filename);
	if (!existsSync(fullname)) {
		throw new InvalidArgumentError('file not found');
	}
	return fullname;
}

