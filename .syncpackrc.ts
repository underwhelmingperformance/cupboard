import type { RcFile } from 'syncpack';

export default {
	indent: '\t',
	semverGroups: [
		{
			range: '^',
			dependencyTypes: ['dev', 'prod'],
			dependencies: ['**'],
			packages: ['**']
		}
	]
} satisfies RcFile;
