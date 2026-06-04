# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.8.1] - 2026-06-04

### Chores

- update dependencies and devDependencies in package.json ([5b48c91](https://github.com/versatiles-org/node-release-tool/commit/5b48c91499d9de4cc21b16a52384e04af23630e6))

## [2.8.0] - 2026-05-06

### Features

- add GitHub repository URL support in changelog and release notes ([01faef7](https://github.com/versatiles-org/node-release-tool/commit/01faef737defc19de9d0b56a91805cbd3483a482))
- enhance deps-graph command with collapse and exclude options for improved dependency visualization, close #46 ([9470a6e](https://github.com/versatiles-org/node-release-tool/commit/9470a6ef39a328305724c75fdd623c9577ef6b7c))

### Bug Fixes

- update ncu usage in upgradeDependencies function to reflect new API ([d68826d](https://github.com/versatiles-org/node-release-tool/commit/d68826d0dacf66df080ef354a25f5059f007bc27))

### Code Refactoring

- optimize extractTextFromMDAsHTML and convertToFoldable functions for better readability and performance ([f3d7742](https://github.com/versatiles-org/node-release-tool/commit/f3d7742f1c3319e39b2c21bab55f9f993ec13270))
- update script names in CI and package.json for consistency ([9976746](https://github.com/versatiles-org/node-release-tool/commit/9976746673a486b68d2dad64cddac7bd1306ee99))

### Tests

- enhance release function tests for dry-run mode and error handling ([b69d496](https://github.com/versatiles-org/node-release-tool/commit/b69d496beda4b8fc49c33a180d03a9fb326d5675))

### Chores

- update dependencies in package.json ([9e4716b](https://github.com/versatiles-org/node-release-tool/commit/9e4716b72888a41bbb6a856e98044323aafb6769))

## [2.7.5] - 2026-04-02

### Bug Fixes

- simplify extractTextFromMDAsHTML function by removing redundant handling for emphasis and list nodes
- restore rootDir in tsconfig.json for proper directory structure
- update esbuild packages to version 0.27.5 in package-lock.json

### Build System

- **deps:** bump codecov/codecov-action from 5 to 6 in the action group

### Chores

- update dependencies and fix import path

## [2.7.4] - 2026-03-01

### Bug Fixes

- remove deprecated mdast dependency in package.json and package-lock.json
- add typecheck script to check TypeScript types in the check command
- simplify readFileSync mock implementation in release-npm tests
- add @types/mdast to devDependencies in package.json and package-lock.json

## [2.7.3] - 2026-03-01

### Bug Fixes

- ensure test output is silent in vitest configuration

### Chores

- update dependencies in package.json
- add mdast and remark dependencies for improved markdown processing

## [2.7.2] - 2026-02-18

### Bug Fixes

- update README badges for NPM version, downloads, code coverage, CI status, and license
- update foldable argument to accept string input for better usability
- rename entryPoint and outputPath to input and output for consistency
- add "node" types to compilerOptions for improved type checking
- enhance error handling in generateCommandDocumentation for subcommands

### Chores

- update dependencies and devDependencies in package.json

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
