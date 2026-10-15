import { type CacheName, type CacheScope } from '@cupboard/nix-store/scalars';

import { type CacheScopedClient } from './cache-scoped.ts';
import { type CallOptions } from './orpc.ts';

export interface RecordedCall<Input> {
	readonly cache: CacheScope;
	readonly input: Input;
}

/**
 * A cache-scoped client pair that answers with `respond` and records the cache
 * each call addressed. Which of the two path variants a command used is part of
 * what the recording shows, so a test asserts the cache rather than a path.
 */
export function recordingCacheScopedClient<Input extends object, Output>(
	respond: (input: Input, options?: CallOptions) => Promise<Output>
): CacheScopedClient<Input, Output> & {
	readonly calls: RecordedCall<Input>[];
} {
	const calls: RecordedCall<Input>[] = [];

	return {
		calls,
		inDefaultCache(input, options) {
			calls.push({ cache: { kind: 'default' }, input });

			return respond(input, options);
		},
		inNamedCache(
			input: Input & { cacheName: CacheName },
			options?: CallOptions
		) {
			calls.push({
				cache: { kind: 'named', name: input.cacheName },
				input
			});

			return respond(input, options);
		}
	};
}
