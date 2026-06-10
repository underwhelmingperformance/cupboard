import type { RcFile } from 'syncpack';

export default {
	indent: '\t',
	semverGroups: [
		// Linters and formatters are pinned to exact versions so a patch bump
		// cannot silently change lint or format results; Renovate pins them too.
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
