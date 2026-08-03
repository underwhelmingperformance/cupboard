import type { NixDaemonConnector } from './nix-daemon.ts';
import {
	createProcessNixDaemonConnector,
	type DaemonCommandRunner,
	spawnDaemonProcess
} from './nix-daemon-process.ts';

const sshNgScheme = 'ssh-ng://';
const defaultRemoteProgram = 'nix-daemon';

/** The remote daemon an `ssh-ng` store URI names. */
export interface NixSshStoreSpec {
	/** The ssh destination: `host` or `user@host`. */
	readonly destination: string;
	/** The daemon command started on the remote host. */
	readonly remoteProgram?: string;
}

/**
 * The connection spec an `ssh-ng` store URI carries: the destination from
 * its authority and the daemon command from its `remote-program` query
 * parameter. `undefined` for any other URI, including an `ssh-ng` one with
 * no destination.
 */
export function parseSshNgStoreUri(uri: string): NixSshStoreSpec | undefined {
	if (!uri.startsWith(sshNgScheme)) {
		return undefined;
	}

	const rest = uri.slice(sshNgScheme.length);
	const queryStart = rest.indexOf('?');
	const destination = queryStart === -1 ? rest : rest.slice(0, queryStart);

	if (destination === '') {
		return undefined;
	}

	const query = queryStart === -1 ? '' : rest.slice(queryStart + 1);
	const remoteProgram = new URLSearchParams(query).get('remote-program');

	if (remoteProgram === null || remoteProgram === '') {
		return { destination };
	}

	return { destination, remoteProgram };
}

/**
 * A connector that reaches the daemon an `ssh-ng` store names: each
 * connection starts `ssh <destination> <remote-program> --stdio` and speaks
 * the worker protocol over the child's pipes.
 */
export function createSshNixDaemonConnector(
	spec: NixSshStoreSpec,
	run: DaemonCommandRunner = spawnDaemonProcess
): NixDaemonConnector {
	const remoteProgram = spec.remoteProgram ?? defaultRemoteProgram;

	return createProcessNixDaemonConnector(
		'ssh',
		[spec.destination, remoteProgram, '--stdio'],
		run
	);
}
