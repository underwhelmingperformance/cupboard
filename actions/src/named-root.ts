import type { CacheScope, StorePathString } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import {
	type RootEnsureResponse,
	rootEnsureResponseSchema
} from '@cupboard/protocol/retention';
import type { ReporterResultEvent } from '@cupboard/reporter';

import {
	RootEnsureResultInvalidError,
	RootEnsureResultMissingError
} from './errors.ts';
import { cacheUrlFor } from './substituters.ts';

export interface NamedRootInputs {
	readonly url: URL;
	readonly cache: CacheScope;
	readonly audience: string;
	readonly ttl: string;
	readonly permanent: boolean;
}

/**
Named target roots replace their complete selection, unlike additive run roots.
*/
export function namedRootEnsureArguments(
	inputs: NamedRootInputs,
	root: string,
	paths: readonly StorePathString[]
): string[] {
	return [
		'root',
		'ensure',
		canonicalHref(cacheUrlFor(inputs.url, inputs.cache)),
		root,
		...paths,
		'--github-oidc',
		...(inputs.audience === '' ? [] : ['--audience', inputs.audience]),
		...(inputs.ttl === '' ? [] : ['--ttl', inputs.ttl]),
		...(inputs.permanent ? ['--permanent'] : [])
	];
}

export function namedRootEnsureResponse(
	root: string,
	events: readonly ReporterResultEvent[]
): RootEnsureResponse {
	const responses = events.filter((event) => event.kind === 'root-ensure');
	if (responses.length === 0) {
		throw new RootEnsureResultMissingError(root);
	}
	if (responses.length !== 1) {
		throw new RootEnsureResultInvalidError(root, {
			cause: new Error('Expected exactly one root-ensure report')
		});
	}
	const parsed = rootEnsureResponseSchema.safeParse(responses[0]?.data);
	if (!parsed.success) {
		throw new RootEnsureResultInvalidError(root, { cause: parsed.error });
	}
	return parsed.data;
}
