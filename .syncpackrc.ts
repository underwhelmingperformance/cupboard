import type { RcFile } from 'syncpack';

export default {
	indent: '\t',
	versionGroups: [
		{
			policy: 'catalog',
			dependencyTypes: ['dev', 'prod'],
			dependencies: [
				'@aws-sdk/client-s3',
				'@aws-sdk/lib-storage',
				'@cloudflare/workers-types',
				'@octokit/request-error',
				'@orpc/**',
				'@sigstore/bundle',
				'@sigstore/verify',
				'@types/node',
				'@types/ws',
				'aws4fetch',
				'cloudflare',
				'commander',
				'esbuild',
				'http-status-codes',
				'miniflare',
				'picocolors',
				'typescript',
				'vitest',
				'ws',
				'yaml',
				'zod'
			]
		}
	],
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
			dependencyTypes: ['dev', 'prod', 'pnpmCatalog'],
			dependencies: ['**'],
			packages: ['**']
		}
	]
} satisfies RcFile;
