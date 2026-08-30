import { fileURLToPath } from 'node:url';

import eslint from '@eslint/js';
import { recommended as logtapeRecommended } from '@logtape/lint/eslint';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import eslintConfigPrettier from 'eslint-config-prettier/flat';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import unicorn from 'eslint-plugin-unicorn';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = fileURLToPath(new URL('.gitignore', import.meta.url));

// The rule rewrites base64 conversions to `Uint8Array#toBase64` and
// `Uint8Array.fromBase64`. Enable it only when the linting runtime implements
// both methods; otherwise its fixes would break Node-run code and tests.
const hasNativeUint8ArrayBase64 =
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
	// LogTape's own lint rules catch structured-logging mistakes: interpolated
	// messages, unawaited logs, missing lazy evaluation. See https://logtape.org/lint/.
	logtapeRecommended,
	{
		rules: {
			'unicorn/name-replacements': [
				'error',
				{
					// The defaults shorten `configuration` and `repository`, including
					// those words in public error names. Disable those replacements while
					// retaining the rule for other names.
					replacements: {
						env: false,
						ctx: false,
						configuration: false,
						repository: false
					}
				}
			]
		}
	},
	{
		rules: {
			'unicorn/prefer-uint8array-base64': hasNativeUint8ArrayBase64
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
			'packages/nix-store/src/**/*.{ts,js}',
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
					paths: [
						...nodeBuiltInImports.map((name) => ({
							name,
							message:
								'Server and shared runtime code must use Cloudflare Worker APIs.'
						})),
						{
							name: '@cupboard/protocol/oidc-trust-diagnostics',
							message: 'Authority-issuing code must use verified OIDC claims.'
						},
						{
							name: '@cupboard/protocol/oidc-trust-match',
							importNames: [
								'matchModelledOidcTrust',
								'preferredModelledOidcTrustRules'
							],
							message:
								'Authority-issuing code must not select policy from modelled OIDC claims.'
						}
					],
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
		// A fieldless `db.get(sql`...`)` consumes only the first row and leaves the
		// cursor undrained. The cost meter then under-counts the query. Require the
		// fielded query builder or an operation that drains the cursor. These selectors
		// catch the direct tagged-template and `sql.raw()` forms, but not aliased imports
		// or prepared statements, so they remain a backstop.
		files: ['packages/server/src/**/*.{ts,js}'],
		ignores: [
			'packages/server/src/**/*.test.{ts,js}',
			'packages/server/src/**/*test-support.ts'
		],
		rules: {
			'no-restricted-syntax': [
				'error',
				{
					selector:
						"CallExpression[callee.property.name='get'] > TaggedTemplateExpression[tag.name='sql']",
					message:
						'A raw db.get(sql`...`) leaves its cursor undrained, so the Durable Object cost meter under-counts its rows. Use the fielded query builder.'
				},
				{
					selector:
						"CallExpression[callee.property.name='get'] > CallExpression[callee.object.name='sql'][callee.property.name='raw']",
					message:
						'A raw db.get(sql.raw(...)) leaves its cursor undrained, so the Durable Object cost meter under-counts its rows. Use the fielded query builder.'
				}
			]
		}
	},
	{
		// `node:zlib` is the only zstd implementation available on workerd;
		// Compression Streams offer no zstd, so this one audited module is the
		// sanctioned Node boundary for the server-side NAR verifier. The ban on
		// `node:*` in server and shared code stays in force everywhere else.
		files: ['packages/nix-store/src/zstd.ts'],
		rules: {
			'no-restricted-imports': 'off'
		}
	},
	{
		// The database meter and deadline scope use `AsyncLocalStorage` to keep
		// interleaved requests from sharing accounting or deadlines. Workerd exposes
		// it through `nodejs_compat`; permit only `node:async_hooks` in these modules.
		files: [
			'packages/server/src/do/database-cost-meter.ts',
			'packages/server/src/do/deadline.ts'
		],
		rules: {
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
							group: ['node:*', '!node:async_hooks'],
							message:
								'Server and shared runtime code must use Cloudflare Worker APIs.'
						}
					]
				}
			]
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
