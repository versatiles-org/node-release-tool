import ELK, { ElkNode, LayoutOptions } from 'elkjs/lib/elk.bundled.js';

export async function graph2svg(data: unknown): Promise<string> {
	//console.log('graph2svg', data);
	if (typeof data !== 'object') throw new Error('expected object');
	if (data == null) throw new Error('expected not null');
	if (!('modules' in data)) throw new Error('expected modules');

	const modules = data.modules as ({ source: string, dependencies: { resolved: string }[] }[]);
	// @ts-expect-error: ELK has broken types
	const elk = new ELK();

	const container = new Graph();

	for (const module of modules) {
		const node = container.getNode(module.source);
		node.setSize(180, 40);
	}

	for (const module of modules) {
		for (const dep of module.dependencies) {
			container.addEdge(module.source, dep.resolved);
		}
	}

	const g = container.asGraph();
	//console.dir(g, { depth: 10 });
	await elk.layout(g);
	//console.dir(g, { depth: 6 });


	const gNodes: string[] = [];
	const gEdges: string[] = [];
	const gLabels: string[] = [];
	const gContainers: string[] = [];
	g.children!.forEach(drawNode);
	g.edges!.forEach(drawEdge);
	//console.log('g', g);


	return [
		`<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}" height="${g.height}">`,
		`<style><![CDATA[`,
		`   .node {fill:#fff8; stroke:#000;}`,
		`   .group {fill:#0003; stroke:#0005}`,
		`   text {font-family: sans-serif; font-size: 15px;}`,
		`]]></style>`,
		...gContainers,
		...gNodes,
		...gEdges,
		...gLabels,
		`</svg>`].join('\n');

	function drawNode(node: ElkNode) {
		const x = node.x ?? 0;
		const y = node.y ?? 0;
		const attr = `x="${x}" y="${y}" width="${node.width}" height="${node.height}"`;
		if (Array.isArray(node.children) && node.children.length > 0) {
			gContainers.push(`<rect ${attr} class="group" />`);
		} else {
			gNodes.push(`<rect ${attr} class="node" />`);
		}
		if (node.labels) {
			node.labels.forEach(label => {
				const x = label.x ?? 0;
				const y = (label.y ?? 0) + (label.height ?? 0) / 2;
				gLabels.push(`<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle">${label.text}</text>`);
			});
		}
		node.children!.forEach(drawNode);
	}

	function drawEdge(edge: any) {
		if (edge.sections.length !== 1) throw new Error('expected 1 section');
		const section = edge.sections[0];

		console.log(section.bendPoints.length);

		// draws a spline, starting from startPoint, ending at endPoint, with bendPoints in between

		const startPoint = section.startPoint;
		const bendPoints = section.bendPoints;
		const endPoint = section.endPoint;
		const d = [
			'M', startPoint.x, startPoint.y,
			...bendPoints.flatMap(p => ['L', p.x, p.y]),
			'L', endPoint.x, endPoint.y,
		].join(' ');

		gEdges.push(`<path d="${d}" fill="none" stroke="#000" />`);
	}
}


class Node {
	private id: string;
	private children: Node[] = [];
	private width?: number;
	private height?: number;

	constructor(id: string) {
		this.id = id;
	}
	setSize(width: number, height: number) {
		this.width = width;
		this.height = height;
	}
	addChild(node: Node) {
		this.children.push(node);
	}
	asGraph(): ElkNode {
		const node: ElkNode = {
			id: this.id,
			children: this.children.map(node => node.asGraph())
		}
		if (this.width) node.width = this.width;
		if (this.height) node.height = this.height;
		node.layoutOptions = new Proxy({}, {
			get(a: unknown, b: unknown, c: unknown) {
				console.log('get', a, b, c);
				return 'a';
			}
		}) as LayoutOptions;

		const isContainer = this.children.length > 0;

		node.layoutOptions = {
			'elk.contentAlignment': 'V_TOP',
			'elk.nodeLabels.placement': isContainer ? 'INSIDE V_TOP H_CENTER' : 'INSIDE V_CENTER H_CENTER',
			'elk.alignment': 'TOP',
			'elk.padding': '[left=10, top=10, right=10, bottom=10]',
			'elk.edgeRouting': 'SPLINES',
			//'elk.layered.edgeRouting.splines.mode': 'CONSERVATIVE',
		} as unknown as LayoutOptions;

		node.labels = [{
			id: this.id + '/label',
			text: this.id.split('/').pop() + (isContainer ? '/' : ''),
			height: 20,
			layoutOptions: {
			}
		}];

		return node;
	}
}

class Graph {
	private root = new Node('root');
	private nodes = new Map<string, Node>();
	private edges = new Map<string, { source: string, target: string }>();

	getNode(nodeId: string): Node {
		let node = this.nodes.get(nodeId);
		if (node) return node;

		node = new Node(nodeId);
		this.nodes.set(nodeId, node);

		let parent;
		if (nodeId.includes('/')) {
			const parentId = nodeId.split('/').slice(0, -1).join('/');
			parent = this.getNode(parentId);
		} else {
			parent = this.root;
		}
		parent.addChild(node);

		return node;
	}

	addEdge(nodeId0: string, nodeId1: string) {
		this.getNode(nodeId0);
		this.getNode(nodeId1);

		let key = nodeId0 + ' --> ' + nodeId1;
		if (this.edges.has(key)) return;
		this.edges.set(key, { source: nodeId0, target: nodeId1 });
	}

	asGraph(): ElkNode {
		let graph = this.root.asGraph();

		graph.edges = Array.from(this.edges.values()).map(({ source, target }) => ({
			id: source + ' --> ' + target,
			sources: [source],
			targets: [target],
			layoutOptions: {
				'elk.spacing.edgeEdge': 2,
				'elk.edgeRouting': 'SPLINES',
			} as unknown as LayoutOptions,
		}))

		graph.layoutOptions = {
			'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
			'elk.algorithm': 'layered',
			'elk.direction': 'RIGHT',
			'elk.layered.nodePlacement.strategy': 'NodePlacementStrategy.BRANDES_KOEPF',
			'elk.json.shapeCoords': 'ROOT',
			'elk.json.edgeCoords': 'ROOT',
			'elk.contentAlignment': 'V_TOP',
			'elk.alignment': 'TOP',
		} as unknown as LayoutOptions;

		return graph
	}
}
