import { z } from 'zod';

const githubUrlPrefix = 'https://github.com/';

const slsaProvenancePrefix = 'https://slsa.dev/provenance/';

/**
 * Returns whether the value begins with the SLSA provenance predicate prefix.
 * This classifies the predicate for display; it does not validate a version or
 * the predicate body.
 */
export function isSlsaProvenanceType(predicateType: string): boolean {
	return predicateType.startsWith(slsaProvenancePrefix);
}

const slsaDependencySchema = z.object({
	uri: z.string().nullish(),
	digest: z.object({ gitCommit: z.string().nullish() }).nullish()
});

type SlsaDependency = z.infer<typeof slsaDependencySchema>;

const workflowSchema = z.object({
	ref: z.string().nullish(),
	repository: z.string().nullish(),
	path: z.string().nullish()
});

const externalParametersSchema = z.object({
	workflow: workflowSchema.nullish()
});

const githubParametersSchema = z.object({
	event_name: z.string().nullish()
});

const internalParametersSchema = z.object({
	github: githubParametersSchema.nullish()
});

const buildDefinitionSchema = z.object({
	externalParameters: externalParametersSchema.nullish(),
	internalParameters: internalParametersSchema.nullish(),
	resolvedDependencies: z.array(slsaDependencySchema).nullish()
});

const builderSchema = z.object({ id: z.string().nullish() });

const metadataSchema = z.object({ invocationId: z.string().nullish() });

const runDetailsSchema = z.object({
	builder: builderSchema.nullish(),
	metadata: metadataSchema.nullish()
});

const slsaProvenanceSchema = z.object({
	buildDefinition: buildDefinitionSchema.nullish(),
	runDetails: runDetailsSchema.nullish()
});

/**
 * Returns the Git commit for `sourceRepository` from the resolved dependencies
 * in GitHub's workflow provenance shape. Exactly one dependency must refer to
 * that repository and include a commit.
 */
function resolvedSourceCommit(
	dependencies: readonly SlsaDependency[],
	sourceRepository: string
): string | undefined {
	const sourceUri = `git+${githubUrlPrefix}${sourceRepository}`;
	const sources = dependencies.filter(
		(dependency) =>
			dependency.uri === sourceUri ||
			dependency.uri?.startsWith(`${sourceUri}@`)
	);

	return sources.length === 1
		? (sources[0]?.digest?.gitCommit ?? undefined)
		: undefined;
}

/**
 * Returns the source commit from GitHub's workflow provenance fields. Returns
 * `undefined` when the predicate does not use that shape or does not contain
 * exactly one matching dependency with a Git commit.
 */
export function slsaSourceCommit(
	predicate: unknown,
	sourceRepository: string
): string | undefined {
	const parsed = slsaProvenanceSchema.safeParse(predicate);

	if (!parsed.success) {
		return undefined;
	}

	return resolvedSourceCommit(
		parsed.data.buildDefinition?.resolvedDependencies ?? [],
		sourceRepository
	);
}

/**
 * Build identity extracted from GitHub's workflow provenance fields for
 * display alongside a verified attestation. Every field is optional.
 */
export interface SlsaProvenanceSummary {
	readonly builder?: string;
	readonly sourceRepository?: string;
	readonly sourceRef?: string;
	readonly sourceRevision?: string;
	readonly workflow?: string;
	readonly buildTrigger?: string;
	readonly invocationId?: string;
}

/**
 * Extracts the source, workflow, builder, and invocation from GitHub's workflow
 * provenance fields. Returns `undefined` when none is present.
 */
export function slsaProvenanceSummary(
	predicate: unknown
): SlsaProvenanceSummary | undefined {
	const parsed = slsaProvenanceSchema.safeParse(predicate);

	if (!parsed.success) {
		return undefined;
	}

	const { buildDefinition, runDetails } = parsed.data;
	const workflow = buildDefinition?.externalParameters?.workflow;
	const sourceRepository = workflow?.repository ?? undefined;
	const repositoryPath = sourceRepository?.startsWith(githubUrlPrefix)
		? sourceRepository.slice(githubUrlPrefix.length)
		: undefined;
	const sourceRevision =
		repositoryPath === undefined
			? undefined
			: resolvedSourceCommit(
					buildDefinition?.resolvedDependencies ?? [],
					repositoryPath
				);

	const builder = runDetails?.builder?.id ?? undefined;
	const sourceReference = workflow?.ref ?? undefined;
	const workflowPath = workflow?.path ?? undefined;
	const buildTrigger =
		buildDefinition?.internalParameters?.github?.event_name ?? undefined;
	const invocationId = runDetails?.metadata?.invocationId ?? undefined;

	const summary: SlsaProvenanceSummary = {
		...(builder !== undefined && { builder }),
		...(sourceRepository !== undefined && { sourceRepository }),
		...(sourceReference !== undefined && { sourceRef: sourceReference }),
		...(sourceRevision !== undefined && { sourceRevision }),
		...(workflowPath !== undefined && { workflow: workflowPath }),
		...(buildTrigger !== undefined && { buildTrigger }),
		...(invocationId !== undefined && { invocationId })
	};

	return Object.keys(summary).length === 0 ? undefined : summary;
}
