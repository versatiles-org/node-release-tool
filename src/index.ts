#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { styleText } from 'util';
import { injectMarkdown, updateTOC } from './commands/markdown.js';
import { Command, InvalidArgumentError } from 'commander';
import { cwd } from 'process';
import { generateCommandDocumentation } from './commands/doc-command.js';
import { release } from './commands/release-npm.js';
import { startRelease } from './commands/release.js';
import { releaseCheck } from './commands/release-check.js';
import { releasePack } from './commands/release-pack.js';
import { releasePublish } from './commands/release-publish.js';
import { formatError } from './core/errors.js';
import { upgradeDependencies } from './commands/deps-upgrade.js';
import { generateDependencyGraph } from './commands/deps-graph.js';
import { check } from './commands/check.js';
import { generateTypescriptDocs } from './commands/doc-typescript.js';
import { generateTreemap } from './commands/treemap.js';
import { generateBundleTreemap } from './commands/bundle-treemap.js';
import { panic, setVerbose } from './core/log.js';

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
	.description('CLI tool for releasing packages and generating documentation for Node.js/TypeScript projects.')
	.option('-v, --verbose', 'Enable verbose output')
	.hook('preAction', (thisCommand) => {
		const opts = thisCommand.opts();
		if (opts.verbose) setVerbose(true);
	});

/**
 * Command: check-package
 * Checks that the project's package.json includes certain required scripts/fields.
 */
program
	.command('check')
	.description('Check repo for required scripts and other stuff.')
	.action(() => {
		void check(process.cwd());
	});

/**
 * Command: deps-graph
 * Analyzes the project’s files to produce a dependency graph (in Mermaid format).
 */
program
	.command('deps-graph')
	.description('Analyze project files and output a dependency graph as Mermaid markup.')
	.addHelpText(
		'after',
		[
			'',
			'All options can also be set in vrt.config.json, e.g.:',
			'  { "deps-graph": { "merge-outgoing": ["src/*"] } }',
			'CLI options are added to the values from vrt.config.json.',
		].join('\n'),
	)
	.option(
		'--include <glob>',
		'Analyze files in directories matching the glob instead of "src", e.g. "packages/*/src" in a workspace (repeatable).',
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option(
		'--collapse-dir <glob>',
		'Collapse all files matching the glob into a single node (repeatable).',
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option(
		'--exclude <glob>',
		'Drop files matching the glob from the graph entirely (repeatable).',
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option(
		'--subgraph-direction <glob=dir>',
		'Set the flow direction (TB, BT, LR, RL) of directory subgraphs matching the glob, e.g. "src/lib=LR" (repeatable).',
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option(
		'--merge-outgoing <glob>',
		'Merge edges from files in directories matching the glob that point to the same target into one edge from the directory (repeatable).',
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option(
		'--merge-incoming <glob>',
		'Merge edges from files outside of directories matching the glob that point into them into one edge per source directory (repeatable).',
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option(
		'--barrel <glob>',
		'Point imports of the index file (e.g. index.ts) in directories matching the glob to the directory itself (repeatable).',
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option(
		'--svg <file>',
		'Write the graph as SVG to the file and output a Markdown image link to it instead of Mermaid markup.',
	)
	.action(
		(opts: {
			barrel: string[];
			collapseDir: string[];
			exclude: string[];
			include: string[];
			mergeIncoming: string[];
			mergeOutgoing: string[];
			subgraphDirection: string[];
			svg?: string;
		}) => {
			void generateDependencyGraph(process.cwd(), {
				barrel: opts.barrel,
				collapseDir: opts.collapseDir,
				exclude: opts.exclude,
				include: opts.include,
				mergeIncoming: opts.mergeIncoming,
				mergeOutgoing: opts.mergeOutgoing,
				subgraphDirection: opts.subgraphDirection,
				svg: opts.svg,
			});
		},
	);

/**
 * Command: deps-upgrade
 * Upgrades project dependencies in package.json to their latest versions and reinstalls them.
 */
program
	.command('deps-upgrade')
	.description('Upgrade all dependencies in the current project to their latest versions.')
	.option(
		'--ignore <package[@range]>',
		'Do not upgrade this dependency, optionally only up to a semver range, e.g. "path-to-regexp@<7.0.0" (repeatable).',
		(value: string, prev: string[] = []) => prev.concat(value),
		[] as string[],
	)
	.option('--no-audit', 'Do not fix known vulnerabilities with "npm audit fix".')
	.option(
		'--no-peer',
		'Upgrade to the latest version even when a peer dependency of another package does not allow it.',
	)
	.action((opts: { ignore: string[]; peer: boolean; audit: boolean }) => {
		void upgradeDependencies(process.cwd(), { ignore: opts.ignore, peer: opts.peer, audit: opts.audit });
	});

/**
 * Command: doc-command
 * Generates Markdown documentation for a given CLI command.
 */
program
	.command('doc-command')
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
program
	.command('doc-insert')
	.description('Insert Markdown from stdin into a specified section of a Markdown file.')
	.argument('<readme>', 'Path to the target Markdown file (e.g., README.md).', checkFilename)
	.argument('[heading]', 'Heading in the Markdown file where content should be placed. Default is "# API".', '# API')
	.argument(
		'[foldable]',
		'Whether to wrap the inserted content in a foldable section.',
		(v: string) => v === 'true',
		false,
	)
	.action(async (mdFilename: string, heading: string, foldable: boolean) => {
		const buffers = [];
		for await (const data of process.stdin) {
			buffers.push(data);
		}
		const mdContent = '<!--- This chapter is generated automatically --->\n' + Buffer.concat(buffers).toString();

		let mdFile = readFileSync(mdFilename, 'utf8');
		mdFile = injectMarkdown(mdFile, mdContent, heading, foldable);
		writeFileSync(mdFilename, mdFile);
	});

/**
 * Command: treemap
 * Renders a treemap from JSON on stdin as SVG file and outputs a Markdown image link to it.
 */
program
	.command('treemap')
	.description('Render a treemap from JSON on stdin as SVG file and output a Markdown image link to it.')
	.requiredOption('--svg <file>', 'Path of the SVG file to write.')
	.option('--width <pixels>', 'Width of the treemap.', parsePositiveInteger, 880)
	.option('--height <pixels>', 'Height of the treemap.', parsePositiveInteger, 480)
	.addHelpText(
		'after',
		[
			'',
			'Input: { "title"?, "caption"?, "unit"?: "bytes", "children": [node, …] }',
			'where a node is { "name", "size" } or { "name", "children": [node, …] }.',
		].join('\n'),
	)
	.action(async (opts: { svg: string; width: number; height: number }) => {
		const buffers = [];
		for await (const data of process.stdin) {
			buffers.push(data);
		}
		await generateTreemap(process.cwd(), Buffer.concat(buffers).toString(), opts);
	});

/**
 * Command: bundle-treemap
 * Measures the composition of a bundle with its source map and renders it as treemap.
 */
program
	.command('bundle-treemap')
	.description("Measure a bundle's composition with its source map and render it as treemap.")
	.argument('<bundle>', 'Path of the bundle, or of its source map.')
	.option('--svg <file>', 'Path of the SVG file to write. Without it, the treemap is printed as JSON.')
	.option('--map <file>', 'Path of the source map. Default: the one the bundle points to, or <bundle>.map.')
	.option('--depth <levels>', 'How many directory levels become groups.', parsePositiveInteger, 1)
	.option(
		'--min-size <bytes>',
		'Fold files smaller than this into an "other" entry. Default: 0.5 % of the bundle.',
		parsePositiveInteger,
	)
	.option('--title <text>', 'Title of the image.', 'Bundle composition')
	.option('--width <pixels>', 'Width of the treemap.', parsePositiveInteger, 880)
	.option('--height <pixels>', 'Height of the treemap.', parsePositiveInteger, 480)
	.addHelpText(
		'after',
		[
			'',
			'Every byte of the bundle is attributed to the source file it came from, so',
			'the build only needs to emit a source map, e.g.:',
			"  vrt bundle-treemap dist/bundle.js --svg assets/bundle.svg | vrt doc-insert README.md '## Bundle'",
		].join('\n'),
	)
	.action(
		async (
			bundle: string,
			opts: {
				svg?: string;
				map?: string;
				depth: number;
				minSize?: number;
				title: string;
				width: number;
				height: number;
			},
		) => {
			await generateBundleTreemap(process.cwd(), bundle, opts);
		},
	);

/**
 * Command: doc-toc
 * Updates or generates a Table of Contents in a Markdown file under a specified heading.
 */
program
	.command('doc-toc')
	.description('Generate a Table of Contents (TOC) in a Markdown file.')
	.argument('<readme>', 'Path to the Markdown file (e.g., README.md).', checkFilename)
	.argument(
		'[heading]',
		'Heading in the Markdown file where TOC should be inserted. Default is "# Table of Content".',
		'# Table of Content',
	)
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
program
	.command('doc-typescript')
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
program
	.command('release-npm')
	.description(
		'Publish an npm package from the specified path to the npm registry, then wait until npm serves the new version.',
	)
	.option('-n, --dry-run', 'Show what would be done without making any changes')
	.option(
		'-b, --bump <version>',
		'Version to release: "major", "minor", "patch" or an explicit "x.y.z". Skips the prompt, e.g. for CI.',
	)
	.option(
		'--no-publish',
		'Do not publish to npm: only raise the version, update the changelog, tag, push and create the GitHub release, e.g. when a CI workflow publishes the pushed tag.',
	)
	.argument('[path]', 'Root path of the Node.js project. Defaults to the current directory.')
	.action((path: string | null, options: { dryRun?: boolean; bump?: string; publish: boolean }) => {
		// "release-npm minor" reads like a version, but the argument is the project path, so the
		// release would look for a directory named "minor" instead of raising the version.
		if (path !== null && /^(major|minor|patch|\d+\.\d+\.\d+)$/.test(path)) {
			panic(`"${path}" is a version, not a path. Did you mean "--bump ${path}"?`);
		}
		void release(resolve(process.cwd(), path ?? '.'), 'main', options.dryRun ?? false, options.bump, options.publish);
	});

/**
 * Command: release
 * Prepares a release locally and pushes its tag, which starts the release workflow.
 */
program
	.command('release')
	.description(
		'Prepare a release: check, raise the version, update CHANGELOG.md, commit, tag and push. The pushed tag starts the release workflow, which publishes; this command watches it.',
	)
	.argument(
		'[version]',
		'Version to release: "patch", "minor", "major" or an explicit version. Default: recommended from the commits, and asked for.',
	)
	.option('-n, --dry-run', 'Run the checks and show what would happen, but change nothing.')
	.option('-y, --yes', 'Ask nothing: take the recommended version and confirm everything.')
	.option('--skip-ci-check', 'Do not require passing CI runs on the released commit (emergencies only).')
	.option('--resume', 'Finish the unfinished release of the current version without asking.')
	.addHelpText(
		'after',
		[
			'',
			'The repository needs a workflow named "Release" that the tag starts, see',
			'https://github.com/versatiles-org/node-release-tool#release-workflow',
		].join('\n'),
	)
	.action(
		async (
			version: string | undefined,
			opts: { dryRun?: boolean; yes?: boolean; skipCiCheck?: boolean; resume?: boolean },
		) => {
			await reportErrors(
				startRelease(process.cwd(), {
					version,
					dryRun: opts.dryRun,
					yes: opts.yes,
					skipCiCheck: opts.skipCiCheck,
					resume: opts.resume,
				}),
			);
		},
	);

/**
 * Command: release-check
 * Verifies a pushed tag in the release workflow.
 */
program
	.command('release-check')
	.description(
		'Check that a tag can be released: it must match the version of every package.json, and CHANGELOG.md must have notes for it. Used by the release workflow.',
	)
	.argument('<tag>', 'The tag to release, e.g. "v1.2.3".')
	.option('--notes <file>', 'Write the release notes to this file.')
	.action(async (tag: string, opts: { notes?: string }) => {
		await reportErrors(async () => releaseCheck(process.cwd(), tag, { notesFile: opts.notes }));
	});

/**
 * Command: release-pack
 * Packs the packages of a release in the release workflow.
 */
program
	.command('release-pack')
	.description(
		'Pack every public package of the repository, including workspaces, into a directory, in the order to publish them. Used by the release workflow.',
	)
	.argument('<directory>', 'Directory to write the tarballs to, e.g. "release".')
	.action(async (directory: string) => {
		await reportErrors(releasePack(process.cwd(), directory));
	});

/**
 * Command: release-publish
 * Publishes a packed release in the release workflow.
 */
program
	.command('release-publish')
	.description(
		'Publish the packed packages to npm with trusted publishing, skipping versions npm has, and create the GitHub release. Used by the release workflow.',
	)
	.argument('<directory>', 'Directory with the tarballs and notes.md, e.g. "release".')
	.requiredOption('--tag <tag>', 'The tag to release, e.g. "v1.2.3".')
	.action(async (directory: string, opts: { tag: string }) => {
		await reportErrors(releasePublish(resolve(process.cwd(), directory), opts.tag));
	});

if (process.env.NODE_ENV !== 'test') {
	await program.parseAsync();
}

/**
 * Waits for a command and reports its error as a message instead of a stack trace.
 */
async function reportErrors(work: Promise<unknown> | (() => Promise<unknown>)): Promise<void> {
	try {
		await (typeof work === 'function' ? work() : work);
	} catch (error) {
		panic(formatError(error));
	}
}

function parsePositiveInteger(value: string): number {
	const number = Number(value);
	if (!Number.isInteger(number) || number <= 0) {
		throw new InvalidArgumentError(`Expected a positive integer, got "${value}".`);
	}
	return number;
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
