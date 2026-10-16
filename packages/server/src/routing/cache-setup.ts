import { NixConfig } from '@cupboard/nix-store/nix-config';
import { type Context } from 'hono';
import { html } from 'hono/html';

import { type WorkerHonoEnv } from './hono-env.ts';

/**
 * Renders configuration for the admitted cache with the tenant's current keys.
 */
export function answerCacheSetup(
	context: Context<WorkerHonoEnv>,
	publicKeys: string
): Response | Promise<Response> {
	const cacheUrl = new URL(context.req.url);
	const scope = context.get('readScope');
	const cache = scope.scope;
	cacheUrl.pathname = `/t/${context.get('tenant')}${cache.kind === 'named' ? `/cache/${cache.name}` : ''}`;
	cacheUrl.username = '';
	cacheUrl.password = '';
	cacheUrl.search = '';
	cacheUrl.hash = '';
	const configuration = new NixConfig(cacheUrl, publicKeys).render();

	return context.html(
		html`<!doctype html>
			<html lang="en">
				<head>
					<meta charset="utf-8" />
					<meta name="viewport" content="width=device-width, initial-scale=1" />
					<title>Use this cupboard cache</title>
				</head>
				<body>
					<main>
						<h1>Use this cupboard cache</h1>
						<p>Cache URL: <code>${cacheUrl.href}</code></p>
						<h2>Nix configuration</h2>
						<p>
							Copy these lines into your Nix configuration. They add this cache
							and its current signing keys.
						</p>
						<pre><code>${configuration}</code></pre>
						<p>
							Compare the signing keys with a copy from your tenant
							administrator before trusting them.
						</p>
						${scope.access === 'private' ? html`<p>This cache requires a read credential. Configure the credential in a netrc file and set <code>netrc-file</code> in Nix.</p>` : ''}
						<h2>Public signing keys</h2>
						<pre><code>${publicKeys}</code></pre>
					</main>
				</body>
			</html>`,
		200,
		{
			'cache-control': 'no-store',
			'content-security-policy':
				"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
			'referrer-policy': 'no-referrer',
			'x-content-type-options': 'nosniff'
		}
	);
}
