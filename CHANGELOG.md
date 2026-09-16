# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.12.0] - 2026-09-16

### Features

- add support for configuration via vrt.config.json for deps-graph options ([e2e4037](https://github.com/versatiles-org/node-release-tool/commit/e2e4037f3ee5a10a90083badcde9a2de3cfeae9f))

## [2.11.0] - 2026-09-16

### Features

- add subgraph direction option to deps-graph command and update related tests ([f879835](https://github.com/versatiles-org/node-release-tool/commit/f8798358aa8a077acfbf5d28e4d3df167ec3293d))
- add --merge-outgoing option to deps-graph command and update related tests ([86a6d89](https://github.com/versatiles-org/node-release-tool/commit/86a6d892155c3f8999f3a9c7f48682ab4c081bbe))

### Chores

- update dependencies to latest versions ([da0e904](https://github.com/versatiles-org/node-release-tool/commit/da0e9043fd3d205ecd16d2e2f21d8ceecbe29273))

## [2.10.0] - 2026-09-06

### Features

- add --no-peer option to upgradeDependencies for ignoring peer dependency ranges ([51591cf](https://github.com/versatiles-org/node-release-tool/commit/51591cfc0e16f90d2b28f009886edfb284ec5348))
- enhance upgradeDependencies to temporarily park modules during upgrades ([cc98f72](https://github.com/versatiles-org/node-release-tool/commit/cc98f725895aabf3f79c7b1790b5e95fbc8c105a))
- add environment variable support to Shell class ([7345226](https://github.com/versatiles-org/node-release-tool/commit/73452260a0be156481d21b64df7db7072042e278))
- refactor command execution to use Shell class for improved error handling and output management ([b336a92](https://github.com/versatiles-org/node-release-tool/commit/b336a9201c5b236de87460e889900fdfffa333e0))
- update Shell class to merge environment variables and remove undefined ones ([65c4762](https://github.com/versatiles-org/node-release-tool/commit/65c4762f8ccdf89b5318a9da5180170736516d29))
- add tests for declared dependencies and runtime imports in package.test.ts ([5bdcf9c](https://github.com/versatiles-org/node-release-tool/commit/5bdcf9c25aa5686f216a72f141fdca3e33e25dd8))
- add handling for missing working directory in Shell class ([76c38bd](https://github.com/versatiles-org/node-release-tool/commit/76c38bd2947c267b56e950483a4052dbb86718fd))
- add version bumping functionality and update release command options ([ce61039](https://github.com/versatiles-org/node-release-tool/commit/ce61039fe6fca1bc3705226e29f2fb8a15a6d2de))

### Bug Fixes

- update dependency graph in README for accurate representation ([f5a49cc](https://github.com/versatiles-org/node-release-tool/commit/f5a49cc0854b89c12259660d770b92e6fe80d53b))

### Chores

- remove unused TypeScript ESLint dependencies ([ebc9904](https://github.com/versatiles-org/node-release-tool/commit/ebc99047c3008977dbaddb236d3890af96ca273d))
- update dependencies and devDependencies in package.json ([cec2728](https://github.com/versatiles-org/node-release-tool/commit/cec2728ca41ca952eb62a970b3a712986a2fd4d6))
- move mdast-util-to-markdown dependency to devDependencies ([39f4a6f](https://github.com/versatiles-org/node-release-tool/commit/39f4a6f807e563c8ece575c9c81f97f718f86d8d))

## [2.9.1] - 2026-08-18

### Chores

- add security update groups for GitHub Actions and npm in dependabot configuration ([1a2fa69](https://github.com/versatiles-org/node-release-tool/commit/1a2fa69cfb890a1fd648dd557c4c7979a468d8c6))
- update devDependencies to latest versions ([aa048bd](https://github.com/versatiles-org/node-release-tool/commit/aa048bd7b4e0bb1fe90db14008c29647d503d3b5))

## [2.9.0] - 2026-08-09

### Features

- add ShellError class and integrate error handling in shell commands, fix #55 ([1001252](https://github.com/versatiles-org/node-release-tool/commit/100125211caeee15ad2b930a1484d3ea6d4bd352))
- let deps-upgrade skip or limit pinned dependencies, fix #53 ([fb45a2d](https://github.com/versatiles-org/node-release-tool/commit/fb45a2d8f098e41773adcbec1574cbf60a6bdee8))

### Bug Fixes

- roll back package.json and lockfile when deps-upgrade fails, fix #54 ([376bf0c](https://github.com/versatiles-org/node-release-tool/commit/376bf0ced3edce19db3fb442ba79116e605e3dbc))

### Chores

- update dependencies to latest versions ([92e28e0](https://github.com/versatiles-org/node-release-tool/commit/92e28e0f9eef84d6bc59e816cb7a6cf072a58e23))

## [2.8.2] - 2026-08-01

### Build System

- **deps:** bump the action group with 2 updates ([1efe0be](https://github.com/versatiles-org/node-release-tool/commit/1efe0be15f6127fb9a6254e10e2498babc1cbe31))
- **deps:** bump the npm group with 11 updates ([2819224](https://github.com/versatiles-org/node-release-tool/commit/28192245149bf6cf9d227f18aa81d335a0373eab))
- **deps:** bump actions/setup-node from 6 to 7 in the action group ([2ead831](https://github.com/versatiles-org/node-release-tool/commit/2ead83126d4465f8602a870409953f7128089e03))

### Chores

- update funding information in FUNDING.yml ([fb25f69](https://github.com/versatiles-org/node-release-tool/commit/fb25f69930c561e2220e00fd20c12079be5fc41a))
- update dependencies and devDependencies in package.json ([0673b4c](https://github.com/versatiles-org/node-release-tool/commit/0673b4c2bceffb245950e817b71f0d95566f42ea))

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
