import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

import { StatusCodes } from 'http-status-codes';

/**
 * A loopback HTTP server for redirect tests. It responds to each path in
 * `redirects` with a 307 redirect to `/stolen`, to each path in `responses`
 * with the JSON body that the map gives for it, and to any other path with
 * 404. It records the path of every request.
 */
export class RedirectingOrigin {
	static async start(
		redirects: readonly string[],
		responses: Readonly<Record<string, unknown>> = {}
	): Promise<RedirectingOrigin> {
		const requests: string[] = [];
		const bodies = new Map(Object.entries(responses));
		const server = createServer((request, response) => {
			const path = request.url ?? '';
			requests.push(path);
			request.resume();

			if (redirects.includes(path)) {
				response.writeHead(StatusCodes.TEMPORARY_REDIRECT, {
					location: '/stolen'
				});
				response.end('Moved\n');
				return;
			}

			if (!bodies.has(path)) {
				response.writeHead(StatusCodes.NOT_FOUND);
				response.end();
				return;
			}

			response.writeHead(StatusCodes.OK, {
				'content-type': 'application/json'
			});
			response.end(JSON.stringify(bodies.get(path)));
		});

		server.listen(0, '127.0.0.1');
		await once(server, 'listening');
		const address = server.address();

		if (address === null || typeof address === 'string') {
			server.close();
			throw new Error('The redirecting origin has no TCP address');
		}

		return new RedirectingOrigin(
			server,
			`http://127.0.0.1:${String(address.port)}`,
			requests
		);
	}

	private constructor(
		private readonly server: Server,
		readonly origin: string,
		private readonly recorded: readonly string[]
	) {}

	url(path: string): string {
		return `${this.origin}${path}`;
	}

	get requests(): readonly string[] {
		return [...this.recorded];
	}

	async close(): Promise<void> {
		this.server.close();
		this.server.closeAllConnections();
		await once(this.server, 'close');
	}
}
