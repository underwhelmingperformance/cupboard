import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

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
	WorkflowReferenceMissingError,
	type WorkflowSource,
	type WorkflowTrigger
} from './discovery.ts';
import { ForkPullRequestFinding, modelPublishingJob } from './publication.ts';

const repository = 'iainlane/dotfiles';
const tenant = new URL('https://cupboard.supply/t/laney');
const legacyPublishingWorkflow =
	'on: workflow_call\njobs:\n  publish:\n    steps:\n      - uses: $/actions/push\n';

function triggers(...events: string[]): WorkflowTrigger[] {
	return events.map((event) => ({ event, filters: {}, hasPathFilter: false }));
}

function source(files: Readonly<Record<string, string>>): WorkflowSource {
	return {
		resolveBranch: () => Promise.resolve('a'.repeat(40)),
		list: () => Promise.resolve(Object.keys(files)),
		read: (selectedRepository, path) => {
			const content =
				selectedRepository === 'underwhelmingperformance/cupboard' &&
				path === '.github/workflows/cupboard-publish.yml'
					? legacyPublishingWorkflow
					: files[path];

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
					workflow: 'cupboard',
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
					workflow: 'external',
					detail:
						'another/repo/.github/workflows/publish.yml@v1 is an external reusable workflow; the check cannot inspect its publication steps'
				},
				{
					caller: '.github/workflows/build.yml',
					job: 'direct',
					workflow: 'repository',
					detail:
						'this job calls a Cupboard action or CLI command directly; inspect its tenant, grant and root inputs'
				}
			]
		});
	});

	it('matches a named cache URL and discovers read-only workflows', async () => {
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
  no-flake-publication:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      publish: none
  no-installable-publication:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      publish: none
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
				},
				{
					caller: '.github/workflows/build.yml',
					job: 'no-push',
					kind: 'flake',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
					inputs: {
						url: 'https://cupboard.supply/t/laney',
						push: false
					},
					triggers: triggers('push')
				},
				{
					caller: '.github/workflows/build.yml',
					job: 'no-flake-publication',
					kind: 'flake',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
					inputs: {
						url: 'https://cupboard.supply/t/laney',
						publish: 'none'
					},
					triggers: triggers('push')
				},
				{
					caller: '.github/workflows/build.yml',
					job: 'no-installable-publication',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
					inputs: {
						url: 'https://cupboard.supply/t/laney',
						publish: 'none'
					},
					triggers: triggers('push')
				}
			],
			unverified: []
		});
	});

	it('reports a dynamic publication mode for either reusable workflow', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/build.yml': `
on: push
jobs:
  flake:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      publish: \${{ inputs.publish }}
  installable:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
      publish: \${{ inputs.publish }}
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: ['flake', 'installable'].map((job) => ({
				caller: '.github/workflows/build.yml',
				job,
				workflow: 'cupboard',
				workflowRef: `underwhelmingperformance/cupboard/.github/workflows/cupboard-${job === 'flake' ? 'flake-publish' : 'publish'}.yml@refs/tags/v0.0.35`,
				detail:
					'the publish input is dynamic or invalid, so the check cannot determine whether this job publishes'
			}))
		});
	});

	it('records declared read-secret wiring without reading secret values', async () => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/build.yml': `
on: push
jobs:
  static-cache:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
    secrets:
      destination_read_user: \${{ secrets.CACHE_USER }}
      destination_read_password: \${{ secrets.CACHE_PASSWORD }}
  inherited:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@v0.0.35
    with:
      url: https://cupboard.supply/t/laney
    secrets: inherit
`
			})
		);

		expect(
			result.jobs.map(({ job, readCredentialWiring }) => ({
				job,
				readCredentialWiring
			}))
		).toStrictEqual([
			{
				job: 'static-cache',
				readCredentialWiring: { cache: 'configured', view: 'none' }
			},
			{
				job: 'inherited',
				readCredentialWiring: { cache: 'unknown', view: 'unknown' }
			}
		]);
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

	it('ignores read-only Cupboard setup for this tenant', async () => {
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
      - uses: underwhelmingperformance/cupboard/actions/setup@v0.0.35
        with:
          cache-url: https://cupboard.supply/t/laney/cache/default
      - uses: underwhelmingperformance/cupboard/actions/setup@v0.0.35
        with:
          cache-url: https://cupboard.supply/t/laney
          provision-cache: '  '
`
			})
		);

		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [],
			unverified: []
		});
	});

	it('reports Cupboard setup that can provision a cache', async () => {
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
      - uses: underwhelmingperformance/cupboard/actions/setup@v0.0.35
        with:
          cache-url: https://cupboard.supply/t/laney
          provision-cache: packages
          provision-cache-access: public
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
					workflow: 'repository',
					detail:
						'this job calls a Cupboard action or CLI command directly; inspect its tenant, grant and root inputs'
				}
			]
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
			read: (selectedRepository, path, reference) => {
				if (selectedRepository === 'underwhelmingperformance/cupboard') {
					return Promise.resolve(legacyPublishingWorkflow);
				}

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
					workflow: 'unknown',
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
				workflow: 'external',
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
				workflow: 'external',
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
					workflow: 'repository',
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
			'.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35',
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
					workflow: 'unknown',
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
	it.each([
		{ reference: 'refs/heads/main', expectedCacheControl: 'no-cache' },
		{ reference: 'refs/tags/v0.0.35', expectedCacheControl: undefined },
		{ reference: 'b'.repeat(40), expectedCacheControl: undefined }
	])(
		'reads workflow contents at $reference',
		async ({ reference, expectedCacheControl }) => {
			const cacheControl: (string | undefined)[] = [];
			const workflows = githubWorkflowSource({
				fetch: (input, init) => {
					const headers = new Headers(
						init?.headers ??
							(input instanceof Request ? input.headers : undefined)
					);
					cacheControl.push(headers.get('cache-control') ?? undefined);
					return Promise.resolve(
						Response.json({
							type: 'file',
							encoding: 'base64',
							content: Buffer.from('on: push\n').toString('base64')
						})
					);
				}
			});
			expect({
				content: await workflows.read(
					repository,
					'.github/workflows/ci.yml',
					reference
				),
				cacheControl
			}).toStrictEqual({
				content: 'on: push\n',
				cacheControl: [expectedCacheControl]
			});
		}
	);
	it.each([
		{ tagStatus: 200, branchStatus: 200, expected: 'refs/tags/main' },
		{ tagStatus: 404, branchStatus: 200, expected: 'refs/heads/main' },
		{ tagStatus: 404, branchStatus: 404, expected: undefined }
	])(
		'resolves a bare workflow ref with tag precedence: $tagStatus/$branchStatus',
		async ({ tagStatus, branchStatus, expected }) => {
			const requests: string[] = [];
			const workflows = githubWorkflowSource({
				fetch: (input) => {
					const url = input instanceof Request ? input.url : String(input);
					requests.push(url);
					const status = url.endsWith('/git/ref/tags%2Fmain')
						? tagStatus
						: branchStatus;
					return Promise.resolve(
						status === 200
							? Response.json({
									ref: url.endsWith('/git/ref/tags%2Fmain')
										? 'refs/tags/main'
										: 'refs/heads/main'
								})
							: new Response(undefined, { status })
					);
				}
			});
			let result: string | undefined;
			let isRefused = false;
			try {
				result = await workflows.resolveWorkflowReference?.(repository, 'main');
			} catch (error) {
				isRefused = error instanceof WorkflowReferenceMissingError;
			}
			expect({ result, refused: isRefused, requests }).toStrictEqual({
				result: expected,
				refused: expected === undefined,
				requests: [
					`https://api.github.com/repos/${repository}/git/ref/tags%2Fmain`,
					...(tagStatus === 404
						? [
								`https://api.github.com/repos/${repository}/git/ref/heads%2Fmain`
							]
						: [])
				]
			});
		}
	);

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
				humanMessage:
					'GitHub repository iainlane/dotfiles has no branch trunk.',
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
				humanMessage: undefined,
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
			fields: { name: 'GithubRateLimitError', humanMessage: undefined }
		},
		{
			name: 'a directory in place of a file',
			response: () => Response.json([]),
			type: WorkflowDiscoveryError,
			fields: {
				name: 'WorkflowDiscoveryError',
				humanMessage:
					'The GitHub workflow could not be inspected. Check the repository reference, workflow file and GitHub access. Use --debug for diagnostic information.'
			}
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
	it.each(['refs/heads/.bad', 'refs/heads/main?'])(
		'keeps inspecting other jobs when a workflow ref is invalid: %s',
		async (pin) => {
			const caller = '.github/workflows/ci.yml';
			const uses = `underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@${pin}`;
			const result = await discoverPublishingJobs(
				repository,
				'main',
				tenant,
				source({
					[caller]: `on: push\njobs:\n  invalid:\n    uses: ${uses}\n    with:\n      url: ${tenant.href}\n  present:\n    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35\n    with:\n      url: ${tenant.href}\n`
				})
			);
			expect({
				jobs: result.jobs.map((job) => job.job),
				unverified: result.unverified
			}).toStrictEqual({
				jobs: ['present'],
				unverified: [
					{
						caller,
						job: 'invalid',
						workflow: 'cupboard',
						detail: `${uses} does not use an exact release tag, branch ref or full commit ID`
					}
				]
			});
		}
	);
	it('does not resolve a bare workflow ref for another tenant', async () => {
		let resolutions = 0;
		const fixtures = source({
			'.github/workflows/ci.yml':
				'on: push\njobs:\n  publish:\n    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main\n    with:\n      url: https://other.example/t/other\n'
		});
		const result = await discoverPublishingJobs(repository, 'main', tenant, {
			...fixtures,
			resolveWorkflowReference: () => {
				resolutions += 1;
				return Promise.reject(new GithubPermissionError('unrelated reference'));
			}
		});
		expect({ result, resolutions }).toStrictEqual({
			result: { revision: 'a'.repeat(40), jobs: [], unverified: [] },
			resolutions: 0
		});
	});
	it('keeps inspecting other jobs when a bare workflow ref has disappeared', async () => {
		const caller = '.github/workflows/ci.yml';
		const failure = new WorkflowReferenceMissingError(
			'underwhelmingperformance/cupboard',
			'missing'
		);
		const fixtures = source({
			[caller]: `on: push\njobs:\n  missing:\n    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@missing\n    with:\n      url: ${tenant.href}\n  present:\n    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/tags/v0.0.35\n    with:\n      url: ${tenant.href}\n`
		});
		const result = await discoverPublishingJobs(repository, 'main', tenant, {
			...fixtures,
			resolveWorkflowReference: () => Promise.reject(failure)
		});
		expect({
			jobs: result.jobs.map((job) => job.job),
			unverified: result.unverified
		}).toStrictEqual({
			jobs: ['present'],
			unverified: [
				{
					caller,
					job: 'missing',
					workflow: 'cupboard',
					detail: failure.message
				}
			]
		});
	});

	it('propagates a bare workflow ref permission failure', async () => {
		const failure = new GithubPermissionError('workflow reference');
		const fixtures = source({
			'.github/workflows/ci.yml': `on: push\njobs:\n  publish:\n    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main\n    with:\n      url: ${tenant.href}\n`
		});
		await expect(
			discoverPublishingJobs(repository, 'main', tenant, {
				...fixtures,
				resolveWorkflowReference: () => Promise.reject(failure)
			})
		).rejects.toBe(failure);
	});
	it.each([
		{
			filter: 'branches: [main]',
			condition: "github.ref == 'refs/heads/main'",
			outcome: 'decided'
		},
		{
			filter: 'branches: [release]',
			condition: "github.ref == 'refs/heads/main'",
			outcome: 'excluded'
		},
		{
			filter: 'branches: [main, release]',
			condition: "github.ref == 'refs/heads/main'",
			outcome: 'unknown'
		},
		{
			filter: 'branches: [release/**]',
			condition: "github.ref == 'refs/heads/main'",
			outcome: 'unknown'
		},
		{
			filter: '{}',
			condition: "github.ref == 'refs/heads/main'",
			outcome: 'unknown'
		},
		{
			filter: 'branches: [main]',
			condition: "inputs.publish == 'true'",
			outcome: 'unknown'
		}
	])(
		'proves push conditions only for an exact branch: $filter/$condition',
		async ({ filter, condition, outcome }) => {
			const caller = '.github/workflows/ci.yml';
			const result = await discoverPublishingJobs(
				repository,
				'main',
				tenant,
				source({
					[caller]: `on:\n  push:\n    ${filter}\njobs:\n  publish:\n    if: ${condition}\n    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@v0.0.35\n    with:\n      url: ${tenant.href}\n      root: github:iainlane/dotfiles/main\n`
				})
			);
			expect({
				jobs: result.jobs.map((job) => ({
					job: job.job,
					conditions: job.triggers.map((trigger) => trigger.undecidedConditions)
				})),
				unverified: result.unverified
			}).toStrictEqual({
				jobs:
					outcome === 'excluded'
						? []
						: [
								{
									job: 'publish',
									conditions: [outcome === 'unknown' ? [condition] : undefined]
								}
							],
				unverified: []
			});
		}
	);

	it('models both jobs in the repository cache publishing workflow', async () => {
		const repository = 'underwhelmingperformance/cupboard';
		const tenant = new URL('https://cupboard.supply/t/cupboard');
		const caller = await readFile(
			new URL(
				'../../../../../.github/workflows/cache-publish.yml',
				import.meta.url
			),
			'utf8'
		);
		const reusable = await readFile(
			new URL(
				'../../../../../.github/workflows/cupboard-publish.yml',
				import.meta.url
			),
			'utf8'
		);
		const discovered = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			{
				resolveBranch: () => Promise.resolve('a'.repeat(40)),
				resolveWorkflowReference: () => Promise.resolve('refs/heads/main'),
				list: () => Promise.resolve(['.github/workflows/cache-publish.yml']),
				read: (_repository, path) =>
					Promise.resolve(
						path === '.github/workflows/cache-publish.yml' ? caller : reusable
					)
			}
		);
		const identity = {
			repositoryId: 1234,
			repositoryOwnerId: 5678,
			fullName: repository,
			defaultBranch: 'main'
		};

		expect({
			unverified: discovered.unverified,
			jobs: discovered.jobs.map((job) => {
				const model = modelPublishingJob(job, identity, tenant, 'main');

				return {
					job: job.job,
					kind: job.kind,
					workflowRef: job.workflowRef,
					workflowRefInput: job.workflowRefInput,
					installableRunRoot: job.installableRunRoot,
					rootAttach: model.cases.some((publication) =>
						publication.requests.some((request) =>
							request.some(
								(detail) =>
									detail.type === 'cupboard_cache' &&
									detail.actions.includes('root:attach')
							)
						)
					),
					cache: job.inputs.cache,
					root: job.inputs.root,
					findings: model.findings,
					cases: model.cases.map((publication) => ({
						trigger: publication.trigger,
						cache: publication.cache,
						pullRequestTemplates: publication.pullRequestTemplates
					}))
				};
			})
		}).toStrictEqual({
			unverified: [],
			jobs: [
				{
					job: 'publish-pr',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/heads/main',
					workflowRefInput:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main',
					installableRunRoot: true,
					rootAttach: true,
					cache: 'pr-${{ github.event.pull_request.number }}',
					root: 'github:${{ github.repository }}/pr-${{ github.event.pull_request.number }}',
					findings: [
						{
							trigger: 'pull_request',
							finding: new ForkPullRequestFinding()
						}
					],
					cases: [
						{
							trigger: 'pull_request',
							cache: {
								kind: 'named',
								name: 'pr-1'
							},
							pullRequestTemplates: {
								cache: 'pr-{pr}',
								root: 'github:underwhelmingperformance/cupboard/pr-{pr}/'
							}
						}
					]
				},
				{
					job: 'publish-main',
					kind: 'installable',
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@refs/heads/main',
					workflowRefInput:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@main',
					installableRunRoot: true,
					rootAttach: true,
					cache: undefined,
					root: 'github:${{ github.repository }}/main',
					findings: [],
					cases: [
						{
							trigger: 'push',
							cache: undefined,
							pullRequestTemplates: undefined
						}
					]
				}
			]
		});
	});

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
							hasPathFilter: false
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
			read: (selectedRepository, path) =>
				selectedRepository === 'underwhelmingperformance/cupboard'
					? Promise.resolve(legacyPublishingWorkflow)
					: path === '.github/workflows/ci.yml'
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
					workflow: 'unknown',
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
					workflow: 'cupboard',
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
					workflow: 'repository',
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
					workflow: 'repository',
					detail:
						'this job calls a Cupboard action or CLI command directly; inspect its tenant, grant and root inputs'
				}
			]
		});
	});
});

describe('installable run-root capability', () => {
	it.each([
		{ reference: 'v0.0.35', runRoot: undefined, enabled: false },
		{ reference: 'b'.repeat(40), runRoot: '', enabled: false },
		{
			reference: 'b'.repeat(40),
			runRoot:
				"${{ format('{0}/_cupboard-run/{1}', steps.root.outputs.root, github.run_id) }}",
			enabled: true
		}
	])(
		'reads actual push wiring at $reference with run-root=$runRoot',
		async ({ reference, runRoot, enabled }) => {
			const caller = `on: push
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@${reference}
    with:
      url: ${tenant.href}
`;
			const files = source({ '.github/workflows/publish.yml': caller });
			const reads: string[] = [];
			const result = await discoverPublishingJobs(repository, 'main', tenant, {
				...files,
				read: (selectedRepository, selectedPath, selectedReference) => {
					if (selectedRepository !== 'underwhelmingperformance/cupboard') {
						return files.read(
							selectedRepository,
							selectedPath,
							selectedReference
						);
					}
					reads.push(
						`${selectedRepository}/${selectedPath}@${selectedReference}`
					);
					return Promise.resolve(
						`${legacyPublishingWorkflow}${runRoot === undefined ? '' : `        with:\n          run-root: ${JSON.stringify(runRoot)}\n`}`
					);
				}
			});
			expect({
				reads,
				jobs: result.jobs.map((job) => ({
					kind: job.kind,
					runRoot: job.installableRunRoot === true
				})),
				unverified: result.unverified
			}).toStrictEqual({
				reads: [
					`underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@${reference.startsWith('v') ? `refs/tags/${reference}` : reference}`
				],
				jobs: [{ kind: 'installable', runRoot: enabled }],
				unverified: []
			});
		}
	);

	it.each(['unreadable', 'unrecognised'] as const)(
		'reports an %s referenced workflow as unverified',
		async (reason) => {
			const reference = 'b'.repeat(40);
			const caller = `on: push
jobs:
  publish:
    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@${reference}
    with:
      url: ${tenant.href}
`;
			const files = source({ '.github/workflows/publish.yml': caller });
			const result = await discoverPublishingJobs(repository, 'main', tenant, {
				...files,
				read: (selectedRepository, selectedPath, selectedReference) =>
					selectedRepository === 'underwhelmingperformance/cupboard'
						? reason === 'unreadable'
							? Promise.reject(new WorkflowDiscoveryError('Unavailable source'))
							: Promise.resolve('on: workflow_call\njobs: {}\n')
						: files.read(selectedRepository, selectedPath, selectedReference)
			});
			expect(result).toStrictEqual({
				revision: 'a'.repeat(40),
				jobs: [],
				unverified: [
					{
						caller: '.github/workflows/publish.yml',
						job: 'publish',
						workflow: 'cupboard',
						workflowRef: `underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@${reference}`,
						detail: `the check cannot ${reason === 'unreadable' ? 'inspect' : 'determine'} run-root publication in underwhelmingperformance/cupboard/.github/workflows/cupboard-publish.yml@${reference}: ${reason === 'unreadable' ? 'Unavailable source' : 'no recognised push step'}`
					}
				]
			});
		}
	);
});

it.each([
	{ permissions: 'permissions: read-all', permission: 'granted' },
	{ permissions: 'permissions:\n  pull-requests: read', permission: 'granted' },
	{ permissions: 'permissions:\n  contents: read', permission: 'missing' },
	{ permissions: '', permission: 'unknown' }
])(
	'discovers trusted reuse and the caller permission: $permission',
	async ({ permissions, permission }) => {
		const result = await discoverPublishingJobs(
			repository,
			'main',
			tenant,
			source({
				'.github/workflows/ci.yml': `on: push\n${permissions}\njobs:\n  publish:\n    uses: underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish-trusted.yml@v0.0.35\n    with:\n      url: ${tenant.href}\n      preset: pull-request-and-branch\n`
			})
		);
		expect(result).toStrictEqual({
			revision: 'a'.repeat(40),
			jobs: [
				{
					caller: '.github/workflows/ci.yml',
					job: 'publish',
					kind: 'flake',
					trustedContributorReuse: true,
					pullRequestsReadPermission: permission,
					workflowRef:
						'underwhelmingperformance/cupboard/.github/workflows/cupboard-flake-publish.yml@refs/tags/v0.0.35',
					inputs: { url: tenant.href, preset: 'pull-request-and-branch' },
					triggers: triggers('push')
				}
			],
			unverified: []
		});
	}
);
