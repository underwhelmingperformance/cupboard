import { type CacheName, type CacheScope } from '@cupboard/nix-store/scalars';

import { type CacheScopedClient } from './cache-scoped.ts';

export interface RecordedCall<Input> {
	readonly cache: CacheScope;
	readonly input: Input;
}

/**
 * A cache-scoped client pair that answers with `respond` and records the cache
 * each call addressed. Which of the two path variants a command used is part of
 * what the recording shows, so a test asserts the cache rather than a path.
 */
export function recordingCacheScopedClient<Input, Output>(
	respond: (input: Input) => Promise<Output>
): CacheScopedClient<Input, Output> & {
	readonly calls: RecordedCall<Input>[];
} {
	const calls: RecordedCall<Input>[] = [];

	return {
		calls,
		inDefaultCache(input) {
			calls.push({ cache: { kind: 'default' }, input });

			return respond(input);
		},
		inNamedCache(input: Input & { cacheName: CacheName }) {
			calls.push({
				cache: { kind: 'named', name: input.cacheName },
				input
			});

			return respond(input);
		}
	};
}
