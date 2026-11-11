import { createHash } from 'node:crypto';

import type { z } from 'zod';

import { CliError, CliUsageError } from '../errors.ts';

import {
	type DeploymentConfig,
	type NamedResourceKind,
	resourceNameProblem,
	type WorkerConfig,
	workerNameSchema
} from './config.ts';
import {
	type RateLimitNamespaceId,
	rateLimitNamespaceIdSchema,
	type ScriptName,
	scriptNameSchema
} from './identifiers.ts';
import { renameResources } from './overrides.ts';

/**
The longest deployment name. Cloudflare limits resource names to 63
characters, and the longest suffix in the release configuration,
`-maintenance-dlq`, has 16.
*/
export const deploymentNameMaxLength = 47;

/**
The name of a deployment on a Cloudflare account. It is the script name of
the deployment's control Worker, and the names of the deployment's other
account-level resources start with it.
*/
export const deploymentNameSchema = workerNameSchema
	.max(deploymentNameMaxLength)
	.brand('DeploymentName');
export type DeploymentName = z.infer<typeof deploymentNameSchema>;

/**
A resource name derived from the deployment name breaks one of Cloudflare's
naming rules, usually its length limit.
*/
export class DeploymentNameInvalidError extends CliUsageError {
	constructor(
		public readonly deploymentName: DeploymentName,
		public readonly resourceName: string,
		public readonly problem: string
	) {
		super(
			`The deployment name ${deploymentName} gives the resource name ${resourceName}, which is invalid: ${problem}. Choose a shorter deployment name.`
		);
		this.name = 'DeploymentNameInvalidError';
	}
}

/**
The deployment name ends with a resource suffix, or with the part of one
suffix that precedes another, so one of its resources could have the same
name as a resource of another deployment. For example, the control Worker of
a deployment called `staging-tenant` would be the tenant Worker of the
deployment called `staging`.
*/
export class DeploymentNameSuffixError extends CliUsageError {
	constructor(
		public readonly deploymentName: DeploymentName,
		public readonly suffix: string
	) {
		super(
			`The deployment name ${deploymentName} ends with ${suffix}, so one of its resources could have the same name as a resource of another deployment. Choose a deployment name that does not end with ${suffix}.`
		);
		this.name = 'DeploymentNameSuffixError';
	}
}

/**
The release configuration has a resource name that does not start with the
control Worker's name, so the deploy cannot derive a separate name for it.
*/
export class UnderivableResourceNameError extends CliError {
	override readonly humanMessage = this.message;
	constructor(
		public readonly resourceName: string,
		public readonly controlWorkerName: string
	) {
		super(
			`The release configuration has a resource called ${resourceName}, which does not start with the control Worker's name ${controlWorkerName}, so a named deployment would share it with the default deployment. This is a fault in the release; please report it.`
		);
		this.name = 'UnderivableResourceNameError';
	}
}

const rateLimitNamespaceIdRange = 2 ** 31 - 1;

/**
Every binding in the account with the same rate-limit namespace ID shares
its counters, so each named deployment uses its own ID: a hash of the
release's ID and the deployment name, between 1 and 2^31 - 1.
*/
function namespaceIdFor(
	namespaceId: RateLimitNamespaceId,
	name: DeploymentName
): RateLimitNamespaceId {
	const hash = createHash('sha256')
		.update(`${namespaceId}/${name}`)
		.digest()
		.readUInt32BE(0);

	return rateLimitNamespaceIdSchema.parse(
		String((hash % rateLimitNamespaceIdRange) + 1)
	);
}

/**
The endings that a deployment name must not have, longest first.

The deployments `x` and `y` share a resource name when `x + s1 = y + s2` for
two suffixes `s1` and `s2`, where the empty suffix belongs to the resources
named after the control Worker. Then `s1` ends with `s2` and `y` is `x`
followed by the rest of `s1`. Refusing every name that ends with such a rest
leaves no two accepted names with a shared resource name.
*/
function refusedEndings(config: DeploymentConfig, stem: string): string[] {
	const suffixes = resourceSuffixes(config, stem);
	const endings = new Set(
		suffixes.flatMap((longer) =>
			['', ...suffixes]
				.filter((shorter) => shorter !== longer && longer.endsWith(shorter))
				.map((shorter) => longer.slice(0, longer.length - shorter.length))
		)
	);

	return [...endings].toSorted((left, right) => right.length - left.length);
}

/**
The suffixes that follow the control Worker's name in the release's other
resource names.
*/
function resourceSuffixes(config: DeploymentConfig, stem: string): string[] {
	const names = [config.control, config.tenant].flatMap((worker) => [
		worker.name,
		...worker.services.map((service) => service.service),
		...worker.durableObjects.flatMap((binding) => binding.scriptName ?? []),
		...worker.r2Buckets.map((bucket) => bucket.bucketName),
		...worker.d1Databases.map((database) => database.databaseName),
		...worker.kvNamespaces.map((namespace) => namespace.title),
		...worker.queueProducers.map((producer) => producer.queue),
		...worker.queueConsumers.flatMap((consumer) => [
			consumer.queue,
			...(consumer.deadLetterQueue === undefined
				? []
				: [consumer.deadLetterQueue])
		])
	]);
	const suffixes = new Set(
		names
			.filter((resource) => resource.startsWith(`${stem}-`))
			.map((resource) => resource.slice(stem.length))
	);

	return [...suffixes];
}

/**
Returns the configuration of the deployment called `name`. The release
configuration gives every account-level resource a name that is either the
control Worker's name or starts with it and a hyphen. The named deployment
replaces that part with `name`: with the name `staging`, the Worker
`cupboard-tenant` becomes `staging-tenant` and the bucket `cupboard-blobs`
becomes `staging-blobs`. The rate-limit namespace IDs are replaced too.

Without a name, or with the release's own control Worker name, the release
configuration is returned unchanged, so existing deployments keep their
names.
*/
export function withDeploymentName(
	config: DeploymentConfig,
	name: DeploymentName | undefined
): DeploymentConfig {
	const stem: string = config.control.name;

	if (name === undefined || name === stem) {
		return config;
	}

	const suffix = refusedEndings(config, stem).find((ending) =>
		name.endsWith(ending)
	);

	if (suffix !== undefined) {
		throw new DeploymentNameSuffixError(name, suffix);
	}

	const derive = (kind: NamedResourceKind | 'kv', resource: string): string => {
		if (resource !== stem && !resource.startsWith(`${stem}-`)) {
			throw new UnderivableResourceNameError(resource, stem);
		}

		const derived = `${name}${resource.slice(stem.length)}`;
		const problem =
			kind === 'kv' ? undefined : resourceNameProblem(kind, derived);

		if (problem !== undefined) {
			throw new DeploymentNameInvalidError(name, derived, problem);
		}

		return derived;
	};
	const script = (scriptName: ScriptName): ScriptName =>
		scriptNameSchema.parse(derive('worker', scriptName));
	const renameWorker = (worker: WorkerConfig): WorkerConfig => ({
		...worker,
		name: script(worker.name),
		services: worker.services.map((service) => ({
			...service,
			service: script(service.service)
		})),
		durableObjects: worker.durableObjects.map((binding) => ({
			...binding,
			scriptName:
				binding.scriptName === undefined
					? undefined
					: script(binding.scriptName)
		})),
		kvNamespaces: worker.kvNamespaces.map((namespace) => ({
			...namespace,
			title: derive('kv', namespace.title)
		})),
		rateLimits: worker.rateLimits.map((rateLimit) => ({
			...rateLimit,
			namespaceId: namespaceIdFor(rateLimit.namespaceId, name)
		}))
	});
	const workers = [config.control, config.tenant];
	const renames = (
		kind: 'bucket' | 'database' | 'queue',
		names: readonly string[]
	): ReadonlyMap<string, string> =>
		new Map(names.map((resource) => [resource, derive(kind, resource)]));
	const renamed = renameResources(config, {
		bucket: renames(
			'bucket',
			workers.flatMap((worker) =>
				worker.r2Buckets.map((bucket) => bucket.bucketName)
			)
		),
		database: renames(
			'database',
			workers.flatMap((worker) =>
				worker.d1Databases.map((database) => database.databaseName)
			)
		),
		queue: renames(
			'queue',
			workers.flatMap((worker) => [
				...worker.queueProducers.map((producer) => producer.queue),
				...worker.queueConsumers.flatMap((consumer) => [
					consumer.queue,
					...(consumer.deadLetterQueue === undefined
						? []
						: [consumer.deadLetterQueue])
				])
			])
		)
	});

	return {
		control: renameWorker(renamed.control),
		tenant: renameWorker(renamed.tenant)
	};
}
