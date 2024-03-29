#!/usr/bin/env -S node --enable-source-maps

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateTsMarkdownDoc } from './commands/typedoc.js';
import { injectMarkdown, updateTOC } from './commands/markdown.js';
import { Command, InvalidArgumentError } from 'commander';
import { cwd } from 'node:process';
import { generateCommandDocumentation } from './commands/command.js';
import { release } from './commands/release.js';


export const program = new Command();

program
	.name('vrt')
	.description('versatiles release and documentaion tool');

program.command('ts2md')
	.description('documents a TypeScript file and outputs it to stdout')
	.argument('<typescript>', 'Filename of the TypeScript file', checkFilename)
	.argument('<tsconfig>', 'Filename of tsconfig.json', checkFilename)
	.action(async (tsFilename: string, tsConfig: string) => {
		const mdDocumentation = await generateTsMarkdownDoc([tsFilename], tsConfig);
		process.stdout.write(mdDocumentation);
	});

program.command('cmd2md')
	.description('documents a runnable command and outputs it to stdout')
	.argument('<command>', 'command to run')
	.action(async (command: string) => {
		const mdDocumentation = await generateCommandDocumentation(command);
		process.stdout.write(mdDocumentation);
	});

program.command('insertmd')
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

program.command('inserttoc')
	.description('updates the TOC in a Markdown file')
	.argument('<readme>', 'Markdown file, like a readme.md', checkFilename)
	.argument('[heading]', 'Heading in the Markdown file', '# Table of Content')
	.action((mdFilename: string, heading: string) => {
		let mdFile = readFileSync(mdFilename, 'utf8');
		mdFile = updateTOC(mdFile, heading);
		writeFileSync(mdFilename, mdFile);
	});

program.command('release-npm')
	.description('release a npm package')
	.argument('[path]', 'root path of the Node.js project')
	.action((path: string | null) => {
		void release(resolve(path ?? ',', process.cwd()), 'main');
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

