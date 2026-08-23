import type { RcFile } from 'syncpack';

export default {
	indent: '\t',
	semverGroups: [
		// Pin linters and formatters exactly so dependency resolution cannot change
		// lint or formatting results without an explicit update.
		{
			range: '',
			dependencyTypes: ['dev', 'prod'],
			dependencies: [
				'@eslint/js',
				'eslint',
				'eslint-config-prettier',
				'eslint-plugin-simple-import-sort',
				'eslint-plugin-unicorn',
				'prettier',
				'typescript-eslint'
			],
			packages: ['**']
		},
		{
			range: '^',
			dependencyTypes: ['dev', 'prod'],
			dependencies: ['**'],
			packages: ['**']
		}
	]
} satisfies RcFile;
