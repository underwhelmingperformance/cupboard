import { once } from 'node:events';
import {
	createServer,
	type IncomingHttpHeaders,
	type IncomingMessage,
	type ServerResponse
} from 'node:http';
import { text } from 'node:stream/consumers';

/**
A request that the server has read in full.
*/
export interface ReceivedRequest {
	readonly method: string;
	readonly url: string;
	readonly headers: IncomingHttpHeaders;
	readonly body: string;
}

export interface LoopbackServer {
	/**
	The server's origin, such as `http://127.0.0.1:1234`.
	*/
	readonly origin: string;
	/**
	Every request that the server has read, in the order in which it
	finished reading them.
	*/
	readonly requests: readonly ReceivedRequest[];
	close(): Promise<void>;
}

async function receive(request: IncomingMessage): Promise<ReceivedRequest> {
	return {
		method: request.method ?? '',
		url: request.url ?? '',
		headers: request.headers,
		body: await text(request)
	};
}

/**
Starts an HTTP server on a free loopback port. It reads each request body
before it calls `respond`. Tests use it to make Node's fetch raise the real
errors for a connection that fails.
*/
export async function loopbackServer(
	respond: (request: ReceivedRequest, response: ServerResponse) => void
): Promise<LoopbackServer> {
	const requests: ReceivedRequest[] = [];
	const server = createServer((request, response) => {
		void receive(request)
			.then((received) => {
				requests.push(received);
				respond(received, response);
			})
			.catch(() => {
				response.destroy();
			});
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const address = server.address();
	if (address === null || typeof address === 'string') {
		throw new TypeError('Expected a TCP address');
	}

	return {
		origin: `http://127.0.0.1:${String(address.port)}`,
		requests,
		close: async () => {
			server.closeAllConnections();
			server.close();
			await once(server, 'close');
		}
	};
}

/**
Returns a handler that sends a response with `status` and part of its
declared body, then closes the connection. The client's fetch resolves, and
reading the body fails.
*/
export function destroyAfterHeaders(
	status = 200
): (response: ServerResponse) => void {
	return (response) => {
		response.writeHead(status, { 'content-length': '100' });
		response.write('partial', () => response.socket?.destroy());
	};
}
