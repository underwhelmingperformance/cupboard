import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import type { ScriptConfiguration } from './cloudflare-api.ts';
import { type DeploymentConfig, parseDeploymentConfig } from './config.ts';
import { collectResources } from './deploy-run.ts';
import {
	DeploymentNameInvalidError,
	deploymentNameMaxLength,
	deploymentNameSchema,
	DeploymentNameSuffixError,
	withDeploymentName
} from './deployment-name.ts';
import {
	type ExistingDeploymentApi,
	startingPlanLookup
} from './existing-deployment.ts';
import { cloudflareAccountIdSchema } from './identifiers.ts';

function serverSource(file: string): Promise<string> {
	return readFile(new URL(`../../../server/${file}`, import.meta.url), 'utf8');
}

const release = parseDeploymentConfig(
	await serverSource('wrangler.jsonc'),
	await serverSource('wrangler.tenant.jsonc')
);

/**
Every account-level name in a configuration, by the kind of resource.
*/
function accountNames(config: DeploymentConfig): Record<string, unknown> {
	const workers = [config.control, config.tenant];
	const resources = collectResources(config);

	return {
		'Worker scripts': workers.map((worker) => worker.name),
		'service binding targets': workers.flatMap((worker) =>
			worker.services.map((service) => service.service)
		),
		'Durable Object scripts': workers.flatMap((worker) =>
			worker.durableObjects.flatMap((binding) => binding.scriptName ?? [])
		),
		'R2 buckets': resources.r2Buckets,
		'D1 databases': resources.d1Databases,
		'KV namespaces': resources.kvTitles,
		'queue producers': workers.flatMap((worker) =>
			worker.queueProducers.map((producer) => producer.queue)
		),
		'queue consumers and dead-letter queues': config.control.queueConsumers.map(
			(consumer) => [consumer.queue, consumer.deadLetterQueue]
		),
		'rate-limit namespaces': workers.flatMap((worker) =>
			worker.rateLimits.map((rateLimit) => rateLimit.namespaceId)
		)
	};
}

const staging = deploymentNameSchema.parse('staging');

describe('withDeploymentName', () => {
	const named = accountNames(withDeploymentName(release, staging));

	it.each<[string, unknown]>([
		['Worker scripts', ['staging', 'staging-tenant']],
		['service binding targets', ['staging-tenant']],
		['Durable Object scripts', ['staging-tenant']],
		['R2 buckets', ['staging-blobs']],
		['D1 databases', ['staging', 'staging-control']],
		['KV namespaces', ['staging-cron-state', 'staging-tenant-cache']],
		['queue producers', ['staging-maintenance', 'staging-maintenance']],
		[
			'queue consumers and dead-letter queues',
			[['staging-maintenance', 'staging-maintenance-dlq']]
		],
		['rate-limit namespaces', ['1737665762']]
	])('names the %s from the deployment name', (kind, expected) => {
		expect(named[kind]).toStrictEqual(expected);
	});

	it.each([
		['without a deployment name', undefined],
		['with the default deployment name', deploymentNameSchema.parse('cupboard')]
	])('keeps the release names %s', (_name, name) => {
		const config = withDeploymentName(release, name);

		expect({ config, names: accountNames(config) }).toStrictEqual({
			config: release,
			names: {
				'Worker scripts': ['cupboard', 'cupboard-tenant'],
				'service binding targets': ['cupboard-tenant'],
				'Durable Object scripts': ['cupboard-tenant'],
				'R2 buckets': ['cupboard-blobs'],
				'D1 databases': ['cupboard', 'cupboard-control'],
				'KV namespaces': ['cupboard-cron-state', 'cupboard-tenant-cache'],
				'queue producers': ['cupboard-maintenance', 'cupboard-maintenance'],
				'queue consumers and dead-letter queues': [
					['cupboard-maintenance', 'cupboard-maintenance-dlq']
				],
				'rate-limit namespaces': ['28726273']
			}
		});
	});

	it.each<[number, boolean]>([
		[deploymentNameMaxLength, true],
		[deploymentNameMaxLength + 1, false]
	])('accepts a deployment name of %i characters: %s', (length, isAccepted) => {
		expect(deploymentNameSchema.safeParse('a'.repeat(length)).success).toBe(
			isAccepted
		);
	});

	it('fits the longest release name in a deployment name of the maximum length', () => {
		const name = deploymentNameSchema.parse(
			'a'.repeat(deploymentNameMaxLength)
		);
		const named = withDeploymentName(release, name);

		expect(
			Math.max(
				...[named.control, named.tenant].flatMap((worker) =>
					worker.queueConsumers.flatMap((consumer) => [
						consumer.queue.length,
						consumer.deadLetterQueue?.length ?? 0
					])
				)
			)
		).toBe(63);
	});

	it('rejects a deployment name that makes a resource name too long', () => {
		const name = deploymentNameSchema.parse(
			'a'.repeat(deploymentNameMaxLength)
		);
		const longer = parseDeploymentConfig(
			`{
				"name": "cupboard",
				"compatibility_date": "2026-05-15",
				"queues": {
					"producers": [{ "binding": "Q", "queue": "cupboard-maintenance-queue" }]
				}
			}`,
			`{ "name": "cupboard-tenant", "compatibility_date": "2026-05-15" }`
		);

		expect(thrownBy(() => withDeploymentName(longer, name))).toStrictEqual(
			new DeploymentNameInvalidError(
				name,
				`${name}-maintenance-queue`,
				'queue name must be at most 63 characters'
			)
		);
	});

	// A deployment called `staging-tenant` would have the control Worker of
	// the deployment `staging` as its tenant Worker.
	it.each([
		['staging-tenant', '-tenant'],
		['cupboard-control', '-control'],
		['staging-blobs', '-blobs'],
		['staging-maintenance', '-maintenance'],
		['staging-maintenance-dlq', '-maintenance-dlq'],
		['staging-tenant-cache', '-tenant-cache'],
		['staging-cron-state', '-cron-state']
	])(
		'rejects the deployment name %s, which ends with a resource suffix',
		(value, suffix) => {
			const name = deploymentNameSchema.parse(value);

			expect(thrownBy(() => withDeploymentName(release, name))).toStrictEqual(
				new DeploymentNameSuffixError(name, suffix)
			);
		}
	);

	// `cupboard-attest-blobs` ends with the suffix of `cupboard-blobs`, so
	// the bucket `x-attest-blobs` of the deployment `x` would be the bucket of
	// the deployment `x-attest`.
	const attest = parseDeploymentConfig(
		`{
			"name": "cupboard",
			"compatibility_date": "2026-05-15",
			"r2_buckets": [
				{ "binding": "BLOBS", "bucket_name": "cupboard-blobs" },
				{ "binding": "ATTESTATIONS", "bucket_name": "cupboard-attest-blobs" }
			]
		}`,
		`{ "name": "cupboard-tenant", "compatibility_date": "2026-05-15" }`
	);

	it('rejects a deployment name that ends with the difference of two suffixes', () => {
		const name = deploymentNameSchema.parse('x-attest');

		expect(thrownBy(() => withDeploymentName(attest, name))).toStrictEqual(
			new DeploymentNameSuffixError(name, '-attest')
		);
	});

	it.each([
		['the release configuration', release],
		['a configuration with nested suffixes', attest]
	])(
		'gives no two accepted deployment names a shared resource name in %s',
		(_name, config) => {
			const suffixes = accountNameList(config)
				.filter((resource) => resource.startsWith('cupboard-'))
				.map((resource) => resource.slice('cupboard'.length));
			const pieces = suffixes.flatMap((suffix) =>
				suffix
					.split('-')
					.map((_part, index, parts) => parts.slice(0, index + 1).join('-'))
					.filter((piece) => piece !== '')
			);
			const candidates = [
				...new Set([
					'x',
					...pieces.map((piece) => `x${piece}`),
					...suffixes.flatMap((suffix) =>
						pieces.map((piece) => `x${piece}${suffix}`)
					)
				])
			].filter((candidate) => candidate.length <= deploymentNameMaxLength);
			const accepted = candidates.flatMap((candidate) => {
				const name = deploymentNameSchema.parse(candidate);

				return thrownBy(() => withDeploymentName(config, name)) === undefined
					? [accountNameList(withDeploymentName(config, name))]
					: [];
			});
			const shared = accepted.flatMap((names, index) =>
				accepted
					.slice(index + 1)
					.flatMap((other) => names.filter((name) => other.includes(name)))
			);

			expect(shared).toStrictEqual([]);
		}
	);
});

/**
Every account-level resource name in a configuration, without the rate-limit
namespace IDs.
*/
function accountNameList(config: DeploymentConfig): string[] {
	return Object.entries(accountNames(config))
		.filter(([kind]) => kind !== 'rate-limit namespaces')
		.flatMap(([, names]) => z.array(z.unknown()).parse(names).flat())
		.filter((name): name is string => typeof name === 'string');
}

function thrownBy(action: () => unknown): unknown {
	try {
		action();
	} catch (error) {
		return error;
	}

	return undefined;
}

describe('startingPlanLookup for a named deployment', () => {
	it('reads the existing deployment from the named control Worker', async () => {
		const reads: string[] = [];
		const live: ScriptConfiguration = {
			bindings: [],
			cacheEnabled: false,
			crossVersionCache: false
		};
		const api: ExistingDeploymentApi = {
			getScriptConfiguration: (scriptName) => {
				reads.push(`script ${scriptName}`);
				return Promise.resolve(scriptName === 'staging' ? live : undefined);
			},
			listSchedules: (scriptName) => {
				reads.push(`schedules ${scriptName}`);
				return Promise.resolve([]);
			},
			findD1DatabaseName: () => Promise.resolve(undefined),
			findConsumerDeadLetterQueue: (queue, scriptName) => {
				reads.push(`dead-letter queue ${queue} ${scriptName}`);
				return Promise.resolve(undefined);
			},
			listCustomDomains: (scriptName) => {
				reads.push(`domains ${scriptName}`);
				return Promise.resolve(
					scriptName === 'staging' ? ['staging.example.com'] : []
				);
			}
		};
		const defaults = withDeploymentName(release, staging);
		const lookup = startingPlanLookup({
			apiFor: () => api,
			defaults,
			phase: (_label, read) => read()
		});

		const starting = await lookup(cloudflareAccountIdSchema.parse('acc-1'));

		expect({
			starting,
			reads: reads.toSorted((left, right) => left.localeCompare(right))
		}).toStrictEqual({
			starting: {
				config: defaults,
				routedDomains: ['staging.example.com'],
				isExisting: true
			},
			reads: [
				'dead-letter queue staging-maintenance staging',
				'domains staging',
				'schedules staging',
				'script staging'
			]
		});
	});
});
