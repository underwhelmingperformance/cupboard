import { fileURLToPath } from 'node:url';

import eslint from '@eslint/js';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url));

// `unicorn/prefer-uint8array-base64` rewrites `btoa`/`atob`/`Buffer` base64
// conversions to the TC39 Stage 3 `Uint8Array#toBase64`/`Uint8Array.fromBase64`
// API. workerd ships it, but our Node runtime (24 LTS) does not, so adopting it
// breaks the CLI and every Node-run test. We keep the `Buffer`/`btoa` fallbacks
// and disable the rule *only while the linting runtime lacks the API*. The day
// Node ships it, this flips back to `error` and the rule fires loudly on every
// fallback, forcing the migration.
const nodeHasUint8ArrayBase64 =
	'toBase64' in Uint8Array.prototype && 'fromBase64' in Uint8Array;

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
	includeIgnoreFile(gitignorePath),
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
	{
		rules: {
			'unicorn/prefer-uint8array-base64': nodeHasUint8ArrayBase64
				? 'error'
				: 'off'
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
						['^node:'],
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
			'packages/nix/src/**/*.{ts,js}',
			'packages/protocol/src/**/*.{ts,js}'
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
		files: ['packages/nix/src/zstd.ts'],
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
		// Tests deliberately exercise plain-http issuers and IdP endpoints (for
		// example asserting that HTTP issuers are rejected), so the HTTPS
		// preference does not apply to fixture URLs here.
		files: ['**/*.test.ts'],
		rules: {
			'unicorn/prefer-https': 'off'
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
			'**/worker-configuration*.d.ts'
		]
	}
);
