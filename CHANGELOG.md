# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.7.1] - 2026-02-10

### Bug Fixes

- update git push command to use --atomic for safer releases
- remove unnecessary false flag from git commit command
- update upgradeDependencies to use shell.run for removing node_modules and lock file

### Chores

- update devDependencies and dependencies in package.json

## [2.7.0] - 2026-02-04

### Breaking Changes

- add tests for npm auth check and breaking changes in release function

### Features

- implement custom error handling with VrtError class and helper functions
- verify npm authentication before starting release
- add retry logic for transient network failures in release
- parse conventional commits for grouped release notes
- add changelog generation and update functionality
- add performance benchmarking for CLI operations

### Bug Fixes

- update flowchart structure in README for accurate command representation
- update exclude pattern in generateDependencyGraph to include mock files
- update dependency graph in README for accurate representation
- increase complexity threshold in ESLint configuration

### Code Refactoring

- improve extractTextFromMDAsHTML and getMDAnchor functions with exhaustive type checks and improved handling of Markdown nodes
- add strict type definitions for command options

### Documentation

- improve documentation with detailed comments and examples for Git and Shell interfaces
- enhance security warnings in Shell class methods to prevent command injection risks
- add SECURITY.md with vulnerability reporting policy

### Tests

- improve CLI tests with additional command coverage and verbose option handling
- add unit tests for changelog generation and updating functionality
- add some error scenario tests
- improve command documentation tests with subcommand handling
- increase duration threshold in async execution measurement
- adjust async execution duration thresholds in benchmark tests
- add interactive command execution tests in Shell
- add tests for nodeToHtml reference handling

### Build System

- **deps:** bump commander from 14.0.2 to 14.0.3 in the npm group

### CI/CD

- add build artifact validation step

### Chores

- update @types/node and commander dependencies to latest versions
- add .editorconfig for IDE consistency
- add husky and lint-staged for pre-commit hooks
- improve ESLint rules with complexity and promise checks
- update string-width dependency versions in package-lock.json

### Styles

- format YAML and TypeScript
- format YAML and TypeScript files for consistency
