import { existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { COMMIT_TYPES, groupCommitsByType, type ParsedCommit } from './git.js';

/**
 * Generates a changelog entry for a release from parsed commits.
 *
 * @param version - The version being released
 * @param commits - Array of parsed conventional commits
 * @param date - The release date (defaults to today)
 * @returns Formatted changelog entry string
 */
export function generateChangelogEntry(version: string, commits: ParsedCommit[], date: Date = new Date()): string {
	const dateStr = date.toISOString().split('T')[0];
	const reversed = [...commits].reverse();
	const grouped = groupCommitsByType(reversed);

	let entry = `## [${version}] - ${dateStr}\n\n`;

	// Order: breaking changes first, then features, fixes, and others
	const typeOrder: (keyof typeof COMMIT_TYPES | 'other')[] = [
		'feat',
		'fix',
		'perf',
		'refactor',
		'docs',
		'test',
		'build',
		'ci',
		'chore',
		'style',
		'revert',
		'other',
	];

	// Add breaking changes section if any
	const breakingCommits = reversed.filter((c) => c.breaking);
	if (breakingCommits.length > 0) {
		entry += '### Breaking Changes\n\n';
		for (const commit of breakingCommits) {
			entry += `- ${commit.description.replace(/\s+/g, ' ')}\n`;
		}
		entry += '\n';
	}

	// Add grouped commits
	for (const type of typeOrder) {
		const typeCommits = grouped.get(type);
		if (!typeCommits || typeCommits.length === 0) continue;

		// Skip commits already shown in breaking changes
		const nonBreaking = typeCommits.filter((c) => !c.breaking);
		if (nonBreaking.length === 0) continue;

		const label = type === 'other' ? 'Other Changes' : COMMIT_TYPES[type];
		entry += `### ${label}\n\n`;
		for (const commit of nonBreaking) {
			const scope = commit.scope ? `**${commit.scope}:** ` : '';
			entry += `- ${scope}${commit.description.replace(/\s+/g, ' ')}\n`;
		}
		entry += '\n';
	}

	return entry;
}

/**
 * Default changelog header for new CHANGELOG.md files
 */
const DEFAULT_CHANGELOG_HEADER = `# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

`;

/**
 * Updates or creates a CHANGELOG.md file with a new release entry.
 *
 * @param directory - The project directory containing CHANGELOG.md
 * @param version - The version being released
 * @param commits - Array of parsed conventional commits
 * @param date - The release date (defaults to today)
 * @returns Object indicating whether the file was created or updated
 */
export function updateChangelog(
	directory: string,
	version: string,
	commits: ParsedCommit[],
	date: Date = new Date(),
): { created: boolean; path: string } {
	const changelogPath = resolve(directory, 'CHANGELOG.md');
	const entry = generateChangelogEntry(version, commits, date);

	let content: string;
	let created = false;

	if (existsSync(changelogPath)) {
		const existing = readFileSync(changelogPath, 'utf8');
		// Insert new entry after the header (after the first double newline or at the start if no header)
		const headerEndIndex = findHeaderEnd(existing);
		content = existing.slice(0, headerEndIndex) + entry + existing.slice(headerEndIndex);
	} else {
		content = DEFAULT_CHANGELOG_HEADER + entry;
		created = true;
	}

	writeFileSync(changelogPath, content);

	return { created, path: changelogPath };
}

/**
 * Finds the end of the changelog header section.
 * Looks for patterns like "# Changelog" followed by description text,
 * ending before the first "## " section header.
 */
function findHeaderEnd(content: string): number {
	// Look for the first version section (## [x.y.z] or ## x.y.z)
	const versionSectionMatch = content.match(/^## \[?\d+\.\d+\.\d+\]?/m);
	if (versionSectionMatch?.index !== undefined) {
		return versionSectionMatch.index;
	}

	// If no version section found, look for any ## heading
	const anySectionMatch = content.match(/^## /m);
	if (anySectionMatch?.index !== undefined) {
		return anySectionMatch.index;
	}

	// No sections found, append at end (after ensuring trailing newline)
	return content.endsWith('\n') ? content.length : content.length;
}
