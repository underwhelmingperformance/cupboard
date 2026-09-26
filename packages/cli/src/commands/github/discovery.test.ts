import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

import {
	GithubPermissionError,
	GithubRateLimitError
} from '../oidc-trust/github.ts';

import {
	discoverPublishingJobs,
	githubWorkflowSource,
	WorkflowBranchNotFoundError,
	WorkflowDiscoveryError,
	type WorkflowSource,
	type WorkflowTrigger
} from './discovery.ts';

const repository = 'iainlane/dotfiles';
const tenant = new URL('https://cupboard.supply/t/laney');

function triggers(...events: string[]): WorkflowTrigger[] {
	return events.map((event) => ({ event, filters: {}, hasPathFilter: false }));
}

function source(files: Readonly<Record<string, string>>): WorkflowSource {
	return {
		resolveBranch: () => Promise.resolve('a'.repeat(40)),
		list: () => Promise.resolve(Object.keys(files)),
		read: (_repository, path) => {
			const content = files[path];

			return content === undefined
				? Promise.reject(new Error(`Missing fixture ${path}`))
				: Promise.resolve(content);
		}
	};
}

function nestedJob(job: string, preset: string) {
	return {
		caller: '.github/workflows/ci.yml',
		job: `publish (inner.yml: ${job})`,
		kind: 'flake',
		workflowRef:
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
		inputs: { url: tenant.href, preset },
		triggers: triggers('push')
	};
}

function respond(
	responses: Readonly<Record<string, () => Response>>,
	requests: string[]
): typeof fetch {
	return (input) => {
		const url = input instanceof Request ? input.url : String(input);
		const response = responses[url];

		requests.push(url);

		return response === undefined
			? Promise.reject(new Error(`unexpected request: ${url}`))
			: Promise.resolve(response());
	};
}

// An error's own enumerable fields: its name and the fields that its
// constructor sets.
function errorFields(error: unknown): Record<string, unknown> {
	return typeof error === 'object' && error !== null
		? Object.fromEntries(Object.entries(error))
		: { value: error };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}

	return;
}

describe('discoverPublishingJobs', () => {
	it('finds a Cupboard call through a local reusable workflow', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/cupboard.yml': `
on: [push, pull_request]
jobs:
  publish:
    uses: iainlane/dotfiles/.github/workflows/cupboard-publish.yml@main
`,
				'.github/workflows/cupboard-publish.yml': `
on:
  workflow_call: {}
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      preset: pull-request-and-branch
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/cupboard.yml',
					job: 'publish (cupboard-publish.yml: publish)',
					kind: 'flake',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
					inputs: {
						url: 'https://cupboard.supply/t/laney',
						preset: 'pull-request-and-branch'
					},
					triggers: triggers('push', 'pull_request')
				}
			],
			unverified: []
		});
	});

	it('checks each call and reports an input that cannot identify the tenant', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/build.yml': `
on: push
jobs:
  first:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: packages
  second:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.36
    with:
      url: \${{ vars.CUPBOARD_URL }}
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/build.yml',
					job: 'first',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
					inputs: {
						url: 'https://cupboard.supply/t/laney',
						cache: 'packages'
					},
					triggers: triggers('push')
				}
			],
			unverified: [
				{
					caller: '.github/workflows/build.yml',
					job: 'second',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.36',
					detail:
						'with.url is missing or uses an expression, so the check cannot determine whether this job targets https://cupboard.supply/t/laney'
				}
			]
		});
	});

	it('reports external workflows and direct commands for manual review', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/build.yml': `
on: push
jobs:
  external:
    uses: another/repo/.github/workflows/publish.yml@v1
    with:
      url: https://cupboard.supply/t/laney
  direct:
    runs-on: ubuntu-latest
    steps:
      - run: cupboard push https://cupboard.supply/t/laney /nix/store/example
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: [
				{
					caller: '.github/workflows/build.yml',
					job: 'external',
					detail:
						'another/repo/.github/workflows/publish.yml@v1 is an external reusable workflow; the check cannot inspect its publication steps'
				},
				{
					caller: '.github/workflows/build.yml',
					job: 'direct',
					detail:
						'this job calls a Cupboard action or CLI command directly; inspect its tenant, grant and root inputs'
				}
			]
		});
	});

	it('matches a named cache URL and skips a flake workflow with publication disabled', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/build.yml': `
on: push
jobs:
  installable:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney/cache/packages
  no-push:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      push: false
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/build.yml',
					job: 'installable',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
					inputs: { url: 'https://cupboard.supply/t/laney/cache/packages' },
					triggers: triggers('push')
				}
			],
			unverified: []
		});
	});

	it('ignores direct Cupboard calls for another tenant', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/lint.yml': `
on: push
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: underwhelmingperformance/cupboard/actions/setup@v0.0.35
        with:
          cache-url: https://cupboard.supply/t/other
      - uses: underwhelmingperformance/cupboard/actions/setup@v0.0.35
      - uses: underwhelmingperformance/cupboard/actions/push@v0.0.35
        with:
          url: https://cupboard.supply/t/other
  publish:
    runs-on: ubuntu-latest
    steps:
      - run: cupboard push https://cupboard.supply/t/other /nix/store/example
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: []
		});
	});

	it('ignores Cupboard actions that do not publish', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/build.yml': `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: underwhelmingperformance/cupboard/actions/prepare@v0.0.35
      - uses: underwhelmingperformance/cupboard/actions/resolve-cupboard@v0.0.35
      - uses: underwhelmingperformance/cupboard/actions/build-paths@v0.0.35
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: []
		});
	});

	it('checks Cupboard publishing calls in the Cupboard repository', async () => {
		const result = await discoverPublishingJobs(
			'underwhelmingperformance/cupboard',
			'main',
			tenant,
			source({
				'.github/workflows/ci.yml': `
on: push
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`,
				'.github/workflows/cupboard-publish.yml':
					'on: workflow_call\njobs: {}\n'
			})
		);

		expect(result.jobs).toStrictEqual([
			{
				caller: '.github/workflows/ci.yml',
				job: 'publish',
				kind: 'installable',
				workflowRef:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
				inputs: { url: tenant.href },
				triggers: triggers('push')
			}
		]);
	});

	it("resolves a local call at the caller's ref", async () => {
		const files: Readonly<Record<string, string>> = {
			'.github/workflows/ci.yml@main': `
on: push
jobs:
  publish:
    uses: iainlane/dotfiles/.github/workflows/outer.yml@v9
`,
			'.github/workflows/outer.yml@v9': `
on: workflow_call
jobs:
  publish:
    uses: ./.github/workflows/inner.yml
`,
			'.github/workflows/inner.yml@v9': `
on: workflow_call
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`
		};
		const result = await discoverPublishingJobs(repository, 'main', tenant, {
			resolveBranch: () => Promise.resolve('a'.repeat(40)),
			list: () => Promise.resolve(['.github/workflows/ci.yml']),
			read: (_repository, path, reference) => {
				const key = `${path}@${reference === 'a'.repeat(40) ? 'main' : reference}`;
				const content = files[key];

				return content === undefined
					? Promise.reject(new Error(`Missing fixture ${key}`))
					: Promise.resolve(content);
			}
		});

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/ci.yml',
					job: 'publish (outer.yml: publish) (inner.yml: publish)',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
					inputs: { url: tenant.href },
					triggers: triggers('push')
				}
			],
			unverified: []
		});
	});

	it('continues after a workflow file cannot be parsed', async () => {
		const broken = 'on: [push\n';
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/broken.yml': broken,
				'.github/workflows/publish.yml': `
on: push
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/publish.yml',
					job: 'publish',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
					inputs: { url: tenant.href },
					triggers: triggers('push')
				}
			],
			unverified: [
				{
					caller: '.github/workflows/broken.yml',
					job: 'workflow',
					detail: `Cannot parse .github/workflows/broken.yml: ${parseDocument(broken, { uniqueKeys: true }).errors[0]?.message ?? ''}`
				}
			]
		});
	});

	it('keeps a branch-pinned Cupboard workflow for the pin check', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/publish.yml': `
on: push
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/heads/main
    with:
      url: https://cupboard.supply/t/laney
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/publish.yml',
					job: 'publish',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/heads/main',
					inputs: { url: tenant.href },
					triggers: triggers('push')
				}
			],
			unverified: []
		});
	});

	it("verifies the Cupboard pin whatever the caller's branch", async () => {
		const files = source({
			'.github/workflows/publish.yml': `
on: push
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main
    with:
      url: https://cupboard.supply/t/laney
`
		});
		const main = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			files
		);
		const develop = await discoverPublishingJobs(
			repository,
			'develop',
			tenant,
			files
		);

		expect(develop).toStrictEqual(main);
	});

	it('reports external workflows when any input identifies the tenant', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/build.yml': `
on: push
jobs:
  cache:
    uses: another/repo/.github/workflows/publish.yml@v1
    with:
      cache-url: https://cupboard.supply/t/laney/cache/packages
  tenant:
    uses: another/repo/.github/workflows/publish.yml@v1
    with:
      tenant: https://cupboard.supply/t/laney
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: ['cache', 'tenant'].map((job) => ({
				caller: '.github/workflows/build.yml',
				job,
				detail:
					'another/repo/.github/workflows/publish.yml@v1 is an external reusable workflow; the check cannot inspect its publication steps'
			}))
		});
	});

	it('ignores unrelated expressions in external reusable workflow inputs', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/build.yml': `
on: push
jobs:
  lint:
    uses: someorg/shared/.github/workflows/lint.yml@v1
    with:
      node-version: \${{ matrix.node }}
  dynamic-url:
    uses: another/repo/.github/workflows/publish.yml@v1
    with:
      cache-url: \${{ inputs.cache_url }}
  dynamic-secret:
    uses: another/repo/.github/workflows/publish.yml@v1
    with:
      tenant: \${{ secrets.CUPBOARD_URL }}
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: ['dynamic-url', 'dynamic-secret'].map((job) => ({
				caller: '.github/workflows/build.yml',
				job,
				detail:
					'another/repo/.github/workflows/publish.yml@v1 is an external reusable workflow; the check cannot inspect its publication steps'
			}))
		});
	});

	it.each([
		'push',
		'build-push',
		'attest attach',
		'plan cohort',
		'cache create',
		'cache remove',
		'root ensure',
		'confirm'
	])('reports direct %s calls for the tenant', async (command) => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/build.yml': `
on: push
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: cupboard ${command} https://cupboard.supply/t/laney example
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: [
				{
					caller: '.github/workflows/build.yml',
					job: 'build',
					detail:
						'this job calls a Cupboard action or CLI command directly; inspect its tenant, grant and root inputs'
				}
			]
		});
	});

	it('ignores direct GitHub setup calls', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/setup.yml': `
on: push
jobs:
  setup:
    runs-on: ubuntu-latest
    steps:
      - run: cupboard github setup https://cupboard.supply/t/laney --repo iainlane/dotfiles
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: []
		});
	});

	it('matches repository and Cupboard workflow names without case sensitivity', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/publish.yml': `
on: push
jobs:
  publish:
    uses: IainLane/DotFiles/.github/workflows/outer.yml@main
`,
				'.github/workflows/outer.yml': `
on: workflow_call
jobs:
  publish:
    uses: UnderwhelmingPerformance/Cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/publish.yml',
					job: 'publish (outer.yml: publish)',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
					inputs: { url: tenant.href },
					triggers: triggers('push')
				}
			],
			unverified: []
		});
	});

	it('reads each workflow revision once when callers share a reusable workflow', async () => {
		const files = source({
			'.github/workflows/first.yml': `
on: push
jobs:
  publish:
    uses: ./.github/workflows/shared.yml
`,
			'.github/workflows/second.yml': `
on: push
jobs:
  publish:
    uses: ./.github/workflows/shared.yml
`,
			'.github/workflows/shared.yml': `
on: workflow_call
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`
		});
		const reads: string[] = [];

		await discoverPublishingJobs(repository, 'main', tenant, {
			...files,
			read: (repo, path, reference) => {
				reads.push(`${path}@${reference}`);
				return files.read(repo, path, reference);
			}
		});

		expect(reads).toStrictEqual([
			`.github/workflows/first.yml@${'a'.repeat(40)}`,
			`.github/workflows/shared.yml@${'a'.repeat(40)}`,
			`.github/workflows/second.yml@${'a'.repeat(40)}`
		]);
	});

	it('reports a cycle in local reusable workflow calls', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/first.yml': `
on: push
jobs:
  publish:
    uses: ./.github/workflows/second.yml
`,
				'.github/workflows/second.yml': `
on: workflow_call
jobs:
  publish:
    uses: ./.github/workflows/first.yml
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: [
				{
					caller: '.github/workflows/first.yml',
					job: 'publish (second.yml: publish)',
					detail: `reusable workflow calls form a cycle at .github/workflows/first.yml@${'a'.repeat(40)}`
				}
			]
		});
	});
});

describe('discoverPublishingJobs event filters', () => {
	const publishJob = `
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`;

	it.each([
		{
			name: 'push tags',
			on: `
on:
  push:
    tags: ['v*']`,
			trigger: {
				event: 'push',
				filters: { tags: ['v*'] },
				hasPathFilter: false
			}
		},
		{
			name: 'push branches and paths',
			on: `
on:
  push:
    branches: [release/**]
    paths: [flake.lock]`,
			trigger: {
				event: 'push',
				filters: { branches: ['release/**'] },
				hasPathFilter: true
			}
		},
		{
			name: 'pull request branches',
			on: `
on:
  pull_request:
    branches-ignore: main`,
			trigger: {
				event: 'pull_request',
				filters: { 'branches-ignore': ['main'] },
				hasPathFilter: false
			}
		}
	])('keeps the $name filters', async ({ on, trigger }) => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({ '.github/workflows/publish.yml': `${on}${publishJob}` })
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/publish.yml',
					job: 'publish',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
					inputs: { url: tenant.href },
					triggers: [trigger]
				}
			],
			unverified: []
		});
	});
});

describe('discoverPublishingJobs reusable workflow inputs', () => {
	const inner = `
on:
  workflow_call:
    inputs:
      url:
        type: string
      preset:
        type: string
        default: pull-request-and-branch
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: \${{ inputs.url }}
      preset: \${{ inputs.preset }}
  systems:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: \${{ inputs.url }}
      preset: \${{ inputs.preset }}
`;

	it.each([
		{
			name: 'the caller',
			with: `
    with:
      url: https://cupboard.supply/t/laney
      preset: ''`,
			preset: ''
		},
		{
			name: 'a workflow_call default',
			with: `
    with:
      url: https://cupboard.supply/t/laney`,
			preset: 'pull-request-and-branch'
		}
	])(
		'resolves forwarded inputs from $name',
		async ({ with: inputs, preset }) => {
			const result = await discoverPublishingJobs(
				repository,
				'main',
				tenant,
				source({
					'.github/workflows/ci.yml': `
on: push
jobs:
  publish:
    uses: ./.github/workflows/inner.yml${inputs}
`,
					'.github/workflows/inner.yml': inner
				})
			);

			expect(result).toStrictEqual({
				revision: 'a'.repeat(40),
				jobs: [nestedJob('packages', preset), nestedJob('systems', preset)],
				unverified: []
			});
		}
	);
});

describe('githubWorkflowSource', () => {
	const revision = 'b'.repeat(40);
	const api = 'https://api.github.com/repos/iainlane/dotfiles';

	it('reads the branch, the workflow list and a workflow file', async () => {
		const requests: string[] = [];
		const workflows = githubWorkflowSource({
			fetch: respond(
				{
					[`${api}/branches/main`]: () =>
						Response.json({ commit: { sha: revision } }),
					[`${api}/contents/.github%2Fworkflows?ref=${revision}`]: () =>
						Response.json([
							{ type: 'file', path: '.github/workflows/publish.yml' }
						]),
					[`${api}/contents/.github%2Fworkflows%2Fpublish.yml?ref=${revision}`]:
						() =>
							Response.json({
								type: 'file',
								encoding: 'base64',
								content: Buffer.from('on: push\n').toString('base64')
							})
				},
				requests
			)
		});

		const result = {
			revision: await workflows.resolveBranch(repository, 'main'),
			files: await workflows.list(repository, revision),
			content: await workflows.read(
				repository,
				'.github/workflows/publish.yml',
				revision
			)
		};

		expect({ result, requests }).toStrictEqual({
			result: {
				revision,
				files: ['.github/workflows/publish.yml'],
				content: 'on: push\n'
			},
			requests: [
				`${api}/branches/main`,
				`${api}/contents/.github%2Fworkflows?ref=${revision}`,
				`${api}/contents/.github%2Fworkflows%2Fpublish.yml?ref=${revision}`
			]
		});
	});

	it('reports a branch that does not exist', async () => {
		const workflows = githubWorkflowSource({
			fetch: respond(
				{
					[`${api}/branches/trunk`]: () =>
						new Response(undefined, { status: 404 })
				},
				[]
			)
		});
		const error = await rejection(workflows.resolveBranch(repository, 'trunk'));

		expect({
			isBranchNotFound: error instanceof WorkflowBranchNotFoundError,
			fields: errorFields(error)
		}).toStrictEqual({
			isBranchNotFound: true,
			fields: {
				name: 'WorkflowBranchNotFoundError',
				repository,
				branch: 'trunk'
			}
		});
	});

	it('sends the branch lookup with Cache-Control: no-cache', async () => {
		const cacheControl: (string | null)[] = [];
		const workflows = githubWorkflowSource({
			fetch: (input, init) => {
				const headers = new Headers(
					input instanceof Request ? input.headers : init?.headers
				);

				cacheControl.push(headers.get('cache-control'));

				return Promise.resolve(Response.json({ commit: { sha: revision } }));
			}
		});

		expect({
			revision: await workflows.resolveBranch(repository, 'main'),
			cacheControl
		}).toStrictEqual({ revision, cacheControl: ['no-cache'] });
	});

	it('lists no workflows when the directory is missing', async () => {
		const workflows = githubWorkflowSource({
			fetch: respond(
				{
					[`${api}/contents/.github%2Fworkflows?ref=${revision}`]: () =>
						new Response(undefined, { status: 404 })
				},
				[]
			)
		});

		expect(await workflows.list(repository, revision)).toStrictEqual([]);
	});

	it.each([
		{
			name: 'a permission failure',
			response: () => new Response(undefined, { status: 401 }),
			type: GithubPermissionError,
			fields: {
				name: 'GithubPermissionError',
				resource: `${repository}/.github/workflows/publish.yml@${revision}`
			}
		},
		{
			name: 'an exhausted rate limit',
			response: () =>
				new Response(undefined, {
					status: 403,
					headers: { 'x-ratelimit-remaining': '0' }
				}),
			type: GithubRateLimitError,
			fields: { name: 'GithubRateLimitError' }
		},
		{
			name: 'a directory in place of a file',
			response: () => Response.json([]),
			type: WorkflowDiscoveryError,
			fields: { name: 'WorkflowDiscoveryError' }
		}
	])('maps $name to a typed error', async ({ response, type, fields }) => {
		const workflows = githubWorkflowSource({
			fetch: respond(
				{
					[`${api}/contents/.github%2Fworkflows%2Fpublish.yml?ref=${revision}`]:
						response
				},
				[]
			)
		});
		const error = await rejection(
			workflows.read(repository, '.github/workflows/publish.yml', revision)
		);

		expect({
			isExpectedType: error instanceof type,
			fields: errorFields(error)
		}).toStrictEqual({ isExpectedType: true, fields });
	});

	it('rejects a workflow directory path that is a file', async () => {
		const workflows = githubWorkflowSource({
			fetch: respond(
				{
					[`${api}/contents/.github%2Fworkflows?ref=${revision}`]: () =>
						Response.json({ type: 'file', encoding: 'base64', content: '' })
				},
				[]
			)
		});

		await expect(workflows.list(repository, revision)).rejects.toBeInstanceOf(
			WorkflowDiscoveryError
		);
	});

	it('rejects with the abort reason when the caller cancels', async () => {
		const controller = new AbortController();
		const reason = new Error('cancel workflow discovery');
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<true>();
		const workflows = githubWorkflowSource({
			signal: controller.signal,
			fetch: (_input, init) => {
				markStarted(true);

				return new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener(
						'abort',
						() => {
							const abortReason: unknown = init.signal?.reason;

							reject(
								abortReason instanceof Error
									? abortReason
									: new Error('request aborted')
							);
						},
						{ once: true }
					);
				});
			}
		});
		const pending = workflows.resolveBranch(repository, 'main');

		await started;
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});
});

describe('discoverPublishingJobs job conditions', () => {
	it('keeps only the triggers that each guarded job can run for', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/cache-publish.yml': `
on:
  pull_request:
  push:
    branches:
      - main
jobs:
  publish-pr:
    if: github.event_name == 'pull_request'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      cache: pull-requests
  publish-main:
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      root: github:iainlane/dotfiles/main
`
			})
		);
		const workflowReference =
			'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35';

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/cache-publish.yml',
					job: 'publish-pr',
					kind: 'installable',
					workflowRef: workflowReference,
					inputs: { url: tenant.href, cache: 'pull-requests' },
					triggers: triggers('pull_request')
				},
				{
					caller: '.github/workflows/cache-publish.yml',
					job: 'publish-main',
					kind: 'installable',
					workflowRef: workflowReference,
					inputs: { url: tenant.href, root: 'github:iainlane/dotfiles/main' },
					triggers: [
						{
							event: 'push',
							filters: { branches: ['main'] },
							hasPathFilter: false,
							undecidedConditions: [
								"github.event_name == 'push' && github.ref == 'refs/heads/main'"
							]
						}
					]
				}
			],
			unverified: []
		});
	});

	it.each([
		{
			condition:
				"github.event_name != 'pull_request' || github.event.pull_request.head.repo.id == github.repository_id",
			isSameRepositoryOnly: true
		},
		{
			condition:
				"github.event_name == 'pull_request' || github.event.pull_request.head.repo.id == github.repository_id",
			isSameRepositoryOnly: false
		}
	])(
		'marks a pull-request trigger as same-repository only when the condition excludes forks: $condition',
		async ({ condition, isSameRepositoryOnly }) => {
			const result = await discoverPublishingJobs(
				repository,
				'main',
				tenant,
				source({
					'.github/workflows/publish.yml': `
on: pull_request
jobs:
  publish:
    if: \${{ ${condition} }}
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`
				})
			);

			expect(result.jobs.map((job) => job.triggers)).toStrictEqual([
				[
					{
						event: 'pull_request',
						filters: {},
						hasPathFilter: false,
						...(isSameRepositoryOnly && { isSameRepositoryOnly })
					}
				]
			]);
		}
	);

	it('applies a calling job condition to the jobs of a reusable workflow', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/ci.yml': `
on: [push, pull_request]
jobs:
  publish:
    if: \${{ github.event_name != 'pull_request' }}
    uses: ./.github/workflows/publish.yml
`,
				'.github/workflows/publish.yml': `
on: workflow_call
jobs:
  packages:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`
			})
		);

		expect(result.jobs).toStrictEqual([
			{
				caller: '.github/workflows/ci.yml',
				job: 'publish (publish.yml: packages)',
				kind: 'installable',
				workflowRef:
					'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
				inputs: { url: tenant.href },
				triggers: triggers('push')
			}
		]);
	});
});

describe('discoverPublishingJobs reusable workflow reads', () => {
	it('reports a missing called workflow and checks the other jobs', async () => {
		const result = await discoverPublishingJobs(repository, 'main', tenant, {
			resolveBranch: () => Promise.resolve('a'.repeat(40)),
			list: () => Promise.resolve(['.github/workflows/ci.yml']),
			read: (_repository, path) =>
				path === '.github/workflows/ci.yml'
					? Promise.resolve(`
on: push
jobs:
  missing:
    uses: ./.github/workflows/missing.yml
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
`)
					: Promise.reject(
							new WorkflowDiscoveryError(`Cannot read ${path} from GitHub`)
						)
		});

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/ci.yml',
					job: 'publish',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
					inputs: { url: tenant.href },
					triggers: triggers('push')
				}
			],
			unverified: [
				{
					caller: '.github/workflows/ci.yml',
					job: 'missing',
					detail: 'Cannot read .github/workflows/missing.yml from GitHub'
				}
			]
		});
	});

	it('ignores workflow_call defaults when the workflow runs for another event', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/publish.yml': `
on:
  push:
  workflow_call:
    inputs:
      url:
        type: string
        default: https://cupboard.supply/t/laney
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: \${{ inputs.url }}
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: [
				{
					caller: '.github/workflows/publish.yml',
					job: 'publish',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
					detail:
						'with.url is missing or uses an expression, so the check cannot determine whether this job targets https://cupboard.supply/t/laney'
				}
			]
		});
	});
});

describe('discoverPublishingJobs local composite actions', () => {
	it('reads the steps of local composite actions', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/build.yml': `
on: push
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/publish
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: ./.github/actions/lint/
`,
				'.github/actions/publish/action.yml': `
runs:
  using: composite
  steps:
    - uses: ./.github/actions/push
`,
				'.github/actions/push/action.yml': `
runs:
  using: composite
  steps:
    - uses: underwhelmingperformance/cupboard/actions/push@v0.0.35
      with:
        url: \${{ inputs.url }}
`,
				'.github/actions/lint/action.yml': `
runs:
  using: composite
  steps:
    - run: npm run lint
      shell: bash
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: [
				{
					caller: '.github/workflows/build.yml',
					job: 'publish',
					detail:
						'this job calls a Cupboard action or CLI command through the local action ./.github/actions/publish; inspect its tenant, grant and root inputs'
				}
			]
		});
	});
});

describe('discoverPublishingJobs direct calls through a variable', () => {
	it('reports a step that runs the CLI with --github-oidc', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/cleanup.yml': `
on: pull_request
jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - run: '"\${CUPBOARD_PATH}" cache remove https://cupboard.supply/t/laney/cache/pr-1 --github-oidc'
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: [
				{
					caller: '.github/workflows/cleanup.yml',
					job: 'cleanup',
					detail:
						'this job calls a Cupboard action or CLI command directly; inspect its tenant, grant and root inputs'
				}
			]
		});
	});
});
