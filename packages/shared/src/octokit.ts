import { retry } from '@octokit/plugin-retry';
import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';

// The single retry policy for the project: throttling backs off on the
// documented rate-limit responses and retry handles transient failures.
const OctokitClient = Octokit.plugin(throttling, retry);

type OctokitClientConstructorOptions = NonNullable<
	ConstructorParameters<typeof OctokitClient>[0]
>;

export interface OctokitClientOptions {
	readonly auth?: string;
	readonly request?: OctokitClientConstructorOptions['request'];
}

/**
 * Build an Octokit client with the project's shared resilience policy: the
 * throttling plugin fails fast rather than auto-retrying rate limits, and the
 * retry plugin handles transient failures. Pass `auth` to authenticate and
 * `request` to supply transport options such as a caching or stubbed `fetch`.
 */
export function createOctokitClient(
	options: OctokitClientOptions = {}
): InstanceType<typeof OctokitClient> {
	return new OctokitClient({
		...(options.auth !== undefined && { auth: options.auth }),
		...(options.request !== undefined && { request: options.request }),
		throttle: {
			onRateLimit: () => false,
			onSecondaryRateLimit: () => false
		}
	});
}
