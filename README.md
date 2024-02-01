[![Code Coverage](https://codecov.io/gh/versatiles-org/node-release-tool/branch/main/graph/badge.svg?token=IDHAI13M0K)](https://codecov.io/gh/versatiles-org/node-release-tool)
[![GitHub Workflow Status)](https://img.shields.io/github/actions/workflow/status/versatiles-org/node-release-tool/ci.yml)](https://github.com/versatiles-org/node-release-tool/actions/workflows/ci.yml)

# VersaTiles Release Tools

Tools used internally for:

* creating Markdown documentation of TypeScript libraries: [`vrt ts2md`](#subcommand-vrt-ts2md)
* creating Markdown documentation of executables: [`vrt cmd2md`](#subcommand-vrt-cmd2md)
* inserting Markdown into documents: [`vrt insertmd`](#subcommand-vrt-insertmd)
* updating "Table of Content" in Markdown files: [`vrt inserttoc`](#subcommand-vrt-inserttoc)
* releasing the current version as npm package: [`vrt release-npm`](#subcommand-vrt-release-npm)

# Installation

```bash
npm i -D @versatiles/release-tool
```

# configure scripts

You need to configure the scripts in the package.json:
```JSON
{
  "scripts": {
    "check": "npm run lint && npm run build && npm run test",
    "prepack": "npm run build && npm run doc",
    "release": "vrt release-npm",
    ...
  },
  ...
}
```
* `scripts.check` is **required** by the release command. Here you can lint, build and test your code.
* `scripts.prepack` is **recommended** to ensure that all files are up-to-date before releasing. Here you can build code and documentation.
* `scripts.release` is **recommended** to make it easy to release a new version.

Have a look at this [package.json](https://github.com/versatiles-org/node-release-tool/blob/main/package.json) as an example.

# Command `vrt`

<!--- This chapter is generated automatically --->

```console
$ vrt
Usage: vrt [options] [command]

versatiles release and documentaion tool

Options:
  -h, --help                              display help for command

Commands:
  ts2md <typescript> <tsconfig>           documents a TypeScript file and outputs it to stdout
  cmd2md <command>                        documents a runnable command and outputs it to stdout
  insertmd <readme> [heading] [foldable]  takes Markdown from stdin and insert it into a Markdown file
  inserttoc <readme> [heading]            updates the TOC in a Markdown file
  release-npm [path]                      release a npm package
  help [command]                          display help for command
```

## Subcommand: `vrt ts2md`

```console
$ vrt ts2md
Usage: vrt ts2md [options] <typescript> <tsconfig>

documents a TypeScript file and outputs it to stdout

Arguments:
  typescript  Filename of the TypeScript file
  tsconfig    Filename of tsconfig.json

Options:
  -h, --help  display help for command
```

## Subcommand: `vrt cmd2md`

```console
$ vrt cmd2md
Usage: vrt cmd2md [options] <command>

documents a runnable command and outputs it to stdout

Arguments:
  command     command to run

Options:
  -h, --help  display help for command
```

## Subcommand: `vrt insertmd`

```console
$ vrt insertmd
Usage: vrt insertmd [options] <readme> [heading] [foldable]

takes Markdown from stdin and insert it into a Markdown file

Arguments:
  readme      Markdown file, like a readme.md
  heading     Heading in the Markdown file (default: "# API")
  foldable    Make content foldable (default: false)

Options:
  -h, --help  display help for command
```

## Subcommand: `vrt inserttoc`

```console
$ vrt inserttoc
Usage: vrt inserttoc [options] <readme> [heading]

updates the TOC in a Markdown file

Arguments:
  readme      Markdown file, like a readme.md
  heading     Heading in the Markdown file (default: "# Table of Content")

Options:
  -h, --help  display help for command
```

## Subcommand: `vrt release-npm`

```console
$ vrt release-npm
Usage: vrt release-npm [options] [path]

release a npm package

Arguments:
  path        root path of the Node.js project

Options:
  -h, --help  display help for command
```
