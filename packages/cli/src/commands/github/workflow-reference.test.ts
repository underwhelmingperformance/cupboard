import { describe, expect, it } from 'vitest';

import {
	WorkflowReferenceMutableError,
	WorkflowReferenceNotFoundError
} from '../../errors.ts';
import {
	GithubPermissionError,
	GithubRateLimitError
} from '../oidc-trust/github.ts';

import { verifyPinnedWorkflowReference } from './workflow-reference.ts';

const workflowPath =
	'underwhelmingperformance/cupboard/.github/workflows/publish.yml';

function requestUrl(input: RequestInfo | URL): URL {
	if (typeof input === 'string') {
		return new URL(input);
	}

	if (input instanceof URL) {
		return input;
	}

	return new URL(input.url);
}

const mutableReleaseFetch: typeof globalThis.fetch = () =>
	Promise.resolve(Response.json({ immutable: false }));

const missingReferenceFetch: typeof globalThis.fetch = () =>
	Promise.resolve(new Response(undefined, { status: 404 }));

function forbiddenFetch(remaining: string): typeof globalThis.fetch {
	return () =>
		Promise.resolve(
			new Response(undefined, {
				status: 403,
				headers: { 'x-ratelimit-remaining': remaining }
			})
		);
}

describe('verifyPinnedWorkflowReference', () => {
	it('accepts a workflow file at a full commit id', async () => {
		const commit = 'a'.repeat(40);
		const requested: { pathname: string; ref: string | null }[] = [];
		const fetch: typeof globalThis.fetch = (input) => {
			const url = requestUrl(input);
			requested.push({
				pathname: url.pathname,
				ref: url.searchParams.get('ref')
			});

			return Promise.resolve(Response.json({ type: 'file' }));
		};

		await verifyPinnedWorkflowReference(`${workflowPath}@${commit}`, { fetch });

		expect(requested).toStrictEqual([
			{
				pathname:
					'/repos/underwhelmingperformance/cupboard/contents/.github%2Fworkflows%2Fpublish.yml',
				ref: commit
			}
		]);
	});

	it('accepts a tag backed by an immutable release and a workflow file', async () => {
		const requested: string[] = [];
		const fetch: typeof globalThis.fetch = (input) => {
			const url = requestUrl(input);
			requested.push(`${url.pathname}${url.search}`);

			if (url.pathname.endsWith('/releases/tags/v1.2.3')) {
				return Promise.resolve(Response.json({ immutable: true }));
			}

			return Promise.resolve(Response.json({ type: 'file' }));
		};

		await verifyPinnedWorkflowReference(`${workflowPath}@refs/tags/v1.2.3`, {
			fetch
		});

		expect(requested).toStrictEqual([
			'/repos/underwhelmingperformance/cupboard/releases/tags/v1.2.3',
			'/repos/underwhelmingperformance/cupboard/contents/.github%2Fworkflows%2Fpublish.yml?ref=refs%2Ftags%2Fv1.2.3'
		]);
	});

	it('refuses an ordinary mutable tag', async () => {
		await expect(
			verifyPinnedWorkflowReference(`${workflowPath}@refs/tags/v1.2.3`, {
				fetch: mutableReleaseFetch
			})
		).rejects.toBeInstanceOf(WorkflowReferenceMutableError);
	});

	it('refuses a reference whose workflow file does not exist', async () => {
		await expect(
			verifyPinnedWorkflowReference(`${workflowPath}@${'b'.repeat(40)}`, {
				fetch: missingReferenceFetch
			})
		).rejects.toBeInstanceOf(WorkflowReferenceNotFoundError);
	});

	it('maps an exhausted rate limit to a typed error', async () => {
		await expect(
			verifyPinnedWorkflowReference(`${workflowPath}@${'c'.repeat(40)}`, {
				fetch: forbiddenFetch('0')
			})
		).rejects.toBeInstanceOf(GithubRateLimitError);
	});

	it('maps a non-exhausted forbidden response to a permission error', async () => {
		const reference = `${workflowPath}@${'d'.repeat(40)}`;

		await expect(
			verifyPinnedWorkflowReference(reference, { fetch: forbiddenFetch('1') })
		).rejects.toStrictEqual(
			new GithubPermissionError(`workflow reference '${reference}'`)
		);
	});

	it('cancels a stalled workflow lookup with the caller signal', async () => {
		const controller = new AbortController();
		const reason = new Error('cancel workflow lookup');
		const { promise: started, resolve: markStarted } =
			Promise.withResolvers<true>();
		const fetch: typeof globalThis.fetch = (_input, init) => {
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
		};
		const pending = verifyPinnedWorkflowReference(
			`${workflowPath}@${'c'.repeat(40)}`,
			{ fetch, signal: controller.signal }
		);

		await started;
		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});
});
