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

// `unicorn/prefer-uint8array-base64` rewrites `btoa`/`atob`/`Buffer` base64
// conversions to the TC39 Stage 3 `Uint8Array#toBase64`/`Uint8Array.fromBase64`
// API. workerd ships it, but our Node runtime (24 LTS) does not, so adopting it
// breaks the CLI and every Node-run test. We keep the `Buffer`/`btoa` fallbacks
// and disable the rule *only while the linting runtime lacks the API*. The day
// Node ships it, this flips back to `error` and the rule fires loudly on every
// fallback, forcing the migration.
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
					// `name-replacements` (renamed from `prevent-abbreviations` in
					// unicorn v68) gained default replacements in v68/v69 that would
					// have us *abbreviate* `configuration`→`config` and
					// `repository`→`repo`, the opposite of this rule's purpose and at
					// odds with our deliberately verbose vocabulary (including exported
					// error classes such as `OwnerConfigurationInvalidError`). Opt those
					// two words out alongside the abbreviations we already allow; the
					// rule stays on for everything else.
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
		// A raw fieldless `db.get(sql`...`)` pulls a single row with `.next()` and
		// leaves the rest of the cursor undrained, so the Durable Object cost meter
		// settles it before the scan's rows are counted and under-reports. The fielded
		// query builder (and `values`/`all`, which drain via `toArray`) keeps the
		// meter honest, so the raw `get(sql...)` forms in runtime code are banned;
		// relying on the convention being remembered is not enough. The tagged-template and
		// `sql.raw()` forms are caught; an aliased `sql` import or a fieldless `get()`
		// on a prepared statement would slip past, which no static selector can see, so
		// this is a backstop, not a proof.
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
		// `AsyncLocalStorage` (`node:async_hooks`) scopes ambient per-request state
		// so a request that interleaves with another on the same Durable Object
		// never folds its state into the other's: the database cost meter uses it
		// for row attribution, and the deadline scope uses it to bound every
		// subrequest a critical section makes. workerd exposes it under
		// `nodejs_compat`; it is the sanctioned Node boundary for this scoping. Only
		// that one module is allowed: every other `node:*` import stays banned here
		// as everywhere else.
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
