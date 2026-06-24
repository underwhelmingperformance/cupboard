import { z } from 'zod';

const slsaDependencySchema = z.object({
	uri: z.string().nullish(),
	digest: z.object({ gitCommit: z.string().nullish() }).nullish()
});

const slsaProvenanceSchema = z.object({
	buildDefinition: z
		.object({ resolvedDependencies: z.array(slsaDependencySchema).nullish() })
		.nullish()
});

function sourceCommitSchema(sourceRepository: string) {
	const sourceUri = `git+https://github.com/${sourceRepository}`;

	return slsaProvenanceSchema.transform((provenance) => {
		const sources = (
			provenance.buildDefinition?.resolvedDependencies ?? []
		).filter(
			(dependency) =>
				dependency.uri === sourceUri ||
				dependency.uri?.startsWith(`${sourceUri}@`)
		);

		return sources.length === 1
			? (sources[0]?.digest?.gitCommit ?? undefined)
			: undefined;
	});
}

/**
 * The git commit a SLSA provenance predicate was built from, taken from the
 * resolved dependency whose URI is the given source repository on GitHub.
 * Returns undefined when the predicate is not SLSA provenance, or does not
 * record exactly one such dependency carrying a commit.
 */
export function slsaSourceCommit(
	predicate: unknown,
	sourceRepository: string
): string | undefined {
	const parsed = sourceCommitSchema(sourceRepository).safeParse(predicate);

	return parsed.success ? parsed.data : undefined;
}
