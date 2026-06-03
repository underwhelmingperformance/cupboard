import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import ts from 'typescript-eslint';

const nodeBuiltInImports = [
	'assert',
	'async_hooks',
	'buffer',
	'child_process',
	'cluster',
	'console',
	'constants',
	'crypto',
	'dgram',
	'diagnostics_channel',
	'dns',
	'domain',
	'events',
	'fs',
	'http',
	'http2',
	'https',
	'module',
	'net',
	'os',
	'path',
	'perf_hooks',
	'process',
	'punycode',
	'querystring',
	'readline',
	'repl',
	'stream',
	'stream/consumers',
	'stream/promises',
	'stream/web',
	'string_decoder',
	'timers',
	'timers/promises',
	'tls',
	'tty',
	'url',
	'util',
	'v8',
	'vm',
	'wasi',
	'worker_threads',
	'zlib'
];

export default defineConfig(
	eslint.configs.recommended,
	...ts.configs.strictTypeChecked,
	...ts.configs.stylisticTypeChecked,
	unicorn.configs.recommended,
	{
		rules: {
			'unicorn/prevent-abbreviations': [
				'error',
				{
					replacements: {
						env: false,
						ctx: false
					}
				}
			]
		}
	},
	eslintConfigPrettier,
	{
		plugins: {
			'simple-import-sort': simpleImportSort
		},
		languageOptions: {
			globals: {
				...globals.node
			},
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname
			}
		},
		rules: {
			curly: ['error', 'all'],
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
			],
			'simple-import-sort/imports': [
				'error',
				{
					groups: [
						[String.raw`^\u0000`],
						[String.raw`^node:`],
						[String.raw`^@?\w`],
						[String.raw`^\.\.`],
						[String.raw`^\.`]
					]
				}
			],
			'simple-import-sort/exports': 'error'
		}
	},
	{
		files: [
			'packages/server/src/**/*.{ts,js}',
			'packages/shared/src/**/*.{ts,js}'
		],
		rules: {
			'no-restricted-globals': [
				'error',
				{
					name: 'Buffer',
					message:
						'Server and shared runtime code must use Cloudflare Worker APIs.'
				},
				{
					name: 'process',
					message:
						'Server and shared runtime code must use Cloudflare Worker APIs.'
				}
			],
			'no-restricted-imports': [
				'error',
				{
					paths: nodeBuiltInImports.map((name) => ({
						name,
						message:
							'Server and shared runtime code must use Cloudflare Worker APIs.'
					})),
					patterns: [
						{
							group: ['node:*'],
							message:
								'Server and shared runtime code must use Cloudflare Worker APIs.'
						}
					]
				}
			]
		}
	},
	{
		// `node:zlib` is the only zstd implementation available on workerd —
		// Compression Streams offer no zstd — so this one audited module is the
		// sanctioned Node boundary for the server-side NAR verifier. The ban on
		// `node:*` in server and shared code stays in force everywhere else.
		files: ['packages/shared/src/zstd.ts'],
		rules: {
			'no-restricted-imports': 'off'
		}
	},
	{
		files: ['**/*.d.ts'],
		rules: {
			'unicorn/require-module-specifiers': 'off',
			'@typescript-eslint/no-empty-object-type': 'off'
		}
	},
	{
		ignores: [
			'**/.tmp-*/',
			'**/.wrangler/',
			'**/dist/',
			'**/build/',
			'**/node_modules/',
			'**/drizzle/migrations.js',
			'**/worker-configuration.d.ts'
		]
	}
);
