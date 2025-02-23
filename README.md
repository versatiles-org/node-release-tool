[![Code Coverage](https://codecov.io/gh/versatiles-org/node-release-tool/branch/main/graph/badge.svg?token=IDHAI13M0K)](https://codecov.io/gh/versatiles-org/node-release-tool)
[![GitHub Workflow Status)](https://img.shields.io/github/actions/workflow/status/versatiles-org/node-release-tool/ci.yml)](https://github.com/versatiles-org/node-release-tool/actions/workflows/ci.yml)

# VersaTiles Release Tools

Tools used for:

* creating a graph of the source code as mermaid: [`vrt deps-graph`](#subcommand-vrt-deps-graph)
* upgrading all package dependencies: [`vrt deps-upgrade`](#subcommand-vrt-deps-upgrade)
* creating Markdown documentation of executables: [`vrt doc-command`](#subcommand-vrt-doc-command)
* inserting Markdown into documents: [`vrt doc-insert`](#subcommand-vrt-doc-insert)
* updating "Table of Content" in Markdown files: [`vrt doc-toc`](#subcommand-vrt-doc-toc)
* releasing the project as npm package: [`vrt release-npm`](#subcommand-vrt-release-npm)

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

# Command `vrt`

<!--- This chapter is generated automatically --->

```console
$ vrt
Usage: vrt [options] [command]

CLI tool for releasing packages and generating documentation for
Node.js/TypeScript projects.

Options:
  -h, --help                                display help for command

Commands:
  check-package                             Check package.json for required scripts and other metadata.
  deps-graph                                Analyze project files and output a dependency graph as Mermaid markup.
  deps-upgrade                              Upgrade all dependencies in the current project to their latest versions.
  doc-command <command>                     Generate Markdown documentation for a specified command and output the result.
  doc-insert <readme> [heading] [foldable]  Insert Markdown from stdin into a specified section of a Markdown file.
  doc-toc <readme> [heading]                Generate a Table of Contents (TOC) in a Markdown file.
  doc-typescript [options]                  Generate documentation for a TypeScript project.
  help [command]                            display help for command
  release-npm [path]                        Publish an npm package from the specified path to the npm registry.
```

## Subcommand: `vrt check-package`

```console
$ vrt check-package
Usage: vrt check-package [options]

Check package.json for required scripts and other metadata.

Options:
  -h, --help  display help for command
```

## Subcommand: `vrt deps-graph`

```console
$ vrt deps-graph
Usage: vrt deps-graph [options]

Analyze project files and output a dependency graph as Mermaid markup.

Options:
  -h, --help  display help for command
```

## Subcommand: `vrt deps-upgrade`

```console
$ vrt deps-upgrade
Usage: vrt deps-upgrade [options]

Upgrade all dependencies in the current project to their latest versions.

Options:
  -h, --help  display help for command
```

## Subcommand: `vrt doc-command`

```console
$ vrt doc-command
Usage: vrt doc-command [options] <command>

Generate Markdown documentation for a specified command and output the result.

Arguments:
  command     Command to document (e.g., "npm run build").

Options:
  -h, --help  display help for command
```

## Subcommand: `vrt doc-insert`

```console
$ vrt doc-insert
Usage: vrt doc-insert [options] <readme> [heading] [foldable]

Insert Markdown from stdin into a specified section of a Markdown file.

Arguments:
  readme      Path to the target Markdown file (e.g., README.md).
  heading     Heading in the Markdown file where content should be placed.
              Default is "# API". (default: "# API")
  foldable    Whether to wrap the inserted content in a foldable section.
              (default: false)

Options:
  -h, --help  display help for command
```

## Subcommand: `vrt doc-toc`

```console
$ vrt doc-toc
Usage: vrt doc-toc [options] <readme> [heading]

Generate a Table of Contents (TOC) in a Markdown file.

Arguments:
  readme      Path to the Markdown file (e.g., README.md).
  heading     Heading in the Markdown file where TOC should be inserted. Default
              is "# Table of Content". (default: "# Table of Content")

Options:
  -h, --help  display help for command
```

## Subcommand: `vrt doc-typescript`

```console
$ vrt doc-typescript
Usage: vrt doc-typescript [options]

Generate documentation for a TypeScript project.

Options:
  -h, --help       display help for command
  -i <entryPoint>  Entry point of the TypeScript project. Default is
                   "./src/index.ts".
  -o <outputPath>  Output path for the generated documentation. Default is
                   "./docs".
```

## Subcommand: `vrt release-npm`

```console
$ vrt release-npm
Usage: vrt release-npm [options] [path]

Publish an npm package from the specified path to the npm registry.

Arguments:
  path        Root path of the Node.js project. Defaults to the current
              directory.

Options:
  -h, --help  display help for command
```

# Development

## Dependency Graph

<!--- This chapter is generated automatically --->

```mermaid
flowchart TB

subgraph 0["src"]
subgraph 1["commands"]
2["check-package.ts"]
5["deps-graph.ts"]
6["deps-upgrade.ts"]
8["doc-command.ts"]
A["doc-typescript.ts"]
B["markdown.ts"]
C["release-npm.ts"]
end
subgraph 3["lib"]
4["log.ts"]
7["shell.ts"]
9["utils.ts"]
D["git.ts"]
end
E["index.ts"]
end
2-->4
5-->4
6-->4
6-->7
8-->9
A-->4
B-->9
C-->D
C-->4
C-->7
D-->7
E-->2
E-->5
E-->6
E-->8
E-->A
E-->B
E-->C
```
