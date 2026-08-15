import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { storeUriParameters } from './local-store-uri.ts';
import type { NixDaemonConnector } from './nix-daemon.ts';
import {
	createProcessNixDaemonConnector,
	type DaemonCommandRunner,
	spawnDaemonProcess
} from './nix-daemon-process.ts';
import { NixConfigSettingError } from './nix-store.ts';
import { listOf, nixIntegerOfWidth } from './setting-types.ts';
import { isEnabledSettingValue } from './store-config.ts';

const sshNgScheme = 'ssh-ng://';
const defaultRemoteProgram = ['nix-daemon'] as const;

/** The remote daemon an `ssh-ng` store URI names. */
export interface NixSshStoreSpec {
	/** The ssh destination: `host` or `user@host`. */
	readonly destination: string;
	/** Whether Nix normalises the URI authority to exactly `localhost`. */
	readonly isNativeLocalhost?: true;
	/** The host, without a user or port. */
	readonly host?: string;
	/** The SSH port stated by the authority. */
	readonly port?: number;
	/** The private key named by the store. */
	readonly sshKey?: string;
	/** The decoded public host key named by the store. */
	readonly sshPublicHostKey?: string;
	/** Whether SSH transport compression is enabled. */
	readonly compress?: boolean;
	/** The greatest number of concurrent daemon connections. */
	readonly maxConnections?: number;
	/** The maximum age in seconds at which an idle connection is reused. */
	readonly maxConnectionAge?: number;
	/** The daemon command started on the remote host. */
	readonly remoteProgram?: readonly string[];
	/** The store reference the remote daemon opens. */
	readonly remoteStore?: string;
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

	let parsed: URL;

	try {
		parsed = new URL(uri);
	} catch {
		return undefined;
	}

	const authority = sshAuthority(uri);
	const isNativeLocalhost = isNixNativeLocalhostAuthority(authority);

	if (
		parsed.hostname === '' ||
		parsed.pathname !== '' ||
		(authority.includes('@') && parsed.username === '')
	) {
		return undefined;
	}

	const user = decodeAuthorityPart(parsed.username);
	const decodedHost = decodeAuthorityPart(parsed.hostname);

	if (user === undefined || decodedHost === undefined) {
		return undefined;
	}

	const host = withoutIpv6Brackets(decodedHost);

	if (user.startsWith('-') || host.startsWith('-')) {
		return undefined;
	}

	const destination = user === '' ? host : `${user}@${host}`;

	const query = storeUriParameters(parsed.search.slice(1));
	const remoteProgramValue = query.get('remote-program');
	const remoteProgram =
		remoteProgramValue === undefined ? [] : listOf(remoteProgramValue);
	const remoteStore = query.get('remote-store');
	const maxConnectionsValue = query.get('max-connections');
	const maxConnections =
		maxConnectionsValue === undefined
			? undefined
			: parseMaxConnections(maxConnectionsValue);
	const maxConnectionAgeValue = query.get('max-connection-age');
	const maxConnectionAge =
		maxConnectionAgeValue === undefined
			? undefined
			: parseMaxConnectionAge(maxConnectionAgeValue);
	const sshKey = query.get('ssh-key');
	const encodedHostKey = query.get('base64-ssh-public-host-key');
	const sshPublicHostKey =
		encodedHostKey === undefined || encodedHostKey === ''
			? undefined
			: decodeHostKey(encodedHostKey);
	const compressValue = query.get('compress');
	const compress =
		compressValue === undefined
			? undefined
			: isEnabledSettingValue('compress', compressValue);
	const port = parsed.port === '' ? undefined : Number(parsed.port);

	if (port === 0) {
		return undefined;
	}

	if (
		sshPublicHostKey === undefined &&
		compress === undefined &&
		maxConnections === undefined &&
		maxConnectionAge === undefined &&
		port === undefined &&
		remoteProgramValue === undefined &&
		(remoteStore === undefined || remoteStore === '') &&
		(sshKey === undefined || sshKey === '')
	) {
		return {
			destination,
			host,
			...(isNativeLocalhost && { isNativeLocalhost: true as const })
		};
	}

	return {
		destination,
		host,
		...(isNativeLocalhost && { isNativeLocalhost: true as const }),
		...(port !== undefined && { port }),
		...(sshKey !== undefined && sshKey !== '' && { sshKey }),
		...(sshPublicHostKey !== undefined && { sshPublicHostKey }),
		...(compress !== undefined && { compress }),
		...(maxConnections !== undefined && { maxConnections }),
		...(maxConnectionAge !== undefined && { maxConnectionAge }),
		...(remoteProgramValue !== undefined && { remoteProgram }),
		...(remoteStore !== undefined && remoteStore !== '' && { remoteStore })
	};
}

function parseMaxConnectionAge(value: string): number {
	const parsed = nixIntegerOfWidth(value, 'uint32');

	if (parsed === undefined) {
		throw new NixConfigSettingError(
			'max-connection-age',
			value,
			'an unsigned 32-bit integer, optionally followed by K, M, G or T'
		);
	}

	return Number(parsed);
}

function parseMaxConnections(value: string): number {
	const parsed = nixIntegerOfWidth(value, 'int32');

	if (parsed === undefined) {
		throw new NixConfigSettingError(
			'max-connections',
			value,
			'a 32-bit integer, optionally followed by K, M, G or T'
		);
	}

	return Math.max(1, Number(parsed));
}

function sshAuthority(uri: string): string {
	const rest = uri.slice(sshNgScheme.length);
	const end = rest.search(/[/?#]/u);

	return end === -1 ? rest : rest.slice(0, end);
}

function decodeAuthorityPart(value: string): string | undefined {
	try {
		return decodeURIComponent(value);
	} catch {
		return undefined;
	}
}

function isNixNativeLocalhostAuthority(authority: string): boolean {
	if (authority.includes('@')) {
		return false;
	}

	const host = authority.endsWith(':') ? authority.slice(0, -1) : authority;

	if (host.includes(':')) {
		return false;
	}

	return decodeAuthorityPart(host) === 'localhost';
}

function withoutIpv6Brackets(host: string): string {
	return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

interface KnownHostsFile {
	readonly path: string;
	dispose(): void;
}

/**
 * The process environment and filesystem access used while opening SSH,
 * injected for tests.
 */
export interface NixSshConnectorDependencies {
	readonly env?: Readonly<Record<string, string | undefined>>;
	readonly knownHostsFile?: (host: string, publicKey: string) => KnownHostsFile;
}

/**
 * A connector that reaches the daemon an `ssh-ng` store names. Every daemon
 * connection owns one SSH child, so closing a completed operation cannot tear
 * down another operation's transport. A temporary known-hosts file has the same
 * lifetime as that child.
 */
export function createSshNixDaemonConnector(
	spec: NixSshStoreSpec,
	run: DaemonCommandRunner = spawnDaemonProcess,
	dependencies: NixSshConnectorDependencies = {}
): NixDaemonConnector {
	const remoteProgram = spec.remoteProgram ?? defaultRemoteProgram;
	const remoteStoreArguments =
		spec.remoteStore === undefined ? [] : ['--store', spec.remoteStore];
	const daemonArguments = [
		...remoteProgram,
		'--stdio',
		...remoteStoreArguments
	];
	const command = daemonArguments[0];

	if (command === undefined) {
		throw new Error('The SSH daemon command unexpectedly has no arguments');
	}

	if (shouldUseNativeLocalhost(spec)) {
		return createProcessNixDaemonConnector(
			command,
			daemonArguments.slice(1),
			run
		);
	}

	return (socketPath, signal) => {
		const inheritedSshOptions = shellSplit(
			(dependencies.env ?? process.env).NIX_SSHOPTS ?? ''
		);
		const sshOptions =
			spec.compress === undefined
				? inheritedSshOptions
				: withoutCompressionShortOptions(inheritedSshOptions);
		const knownHosts = createConnectionKnownHosts(spec, dependencies);
		const knownHostOptions =
			knownHosts === undefined
				? []
				: [
						`-oUserKnownHostsFile=${knownHosts.path}`,
						'-oStrictHostKeyChecking=yes',
						'-oGlobalKnownHostsFile=/dev/null'
					];
		const uriScalarOptions = [
			...knownHostOptions,
			...(spec.port === undefined ? [] : [`-p${String(spec.port)}`]),
			...(spec.compress === undefined
				? []
				: [`-oCompression=${spec.compress ? 'yes' : 'no'}`]),
			'-oRemoteCommand=none'
		];
		const commandArguments = [
			spec.destination,
			'-x',
			// OpenSSH uses the first value it obtains for these scalar options.
			// Put URI-provided values before inherited NIX_SSHOPTS so ambient
			// configuration cannot replace the store's explicit port, compression
			// policy, host-key policy or positional daemon command.
			...uriScalarOptions,
			...sshOptions,
			...(spec.sshKey === undefined ? [] : ['-i', spec.sshKey]),
			'--',
			...daemonArguments
		];

		try {
			return createProcessNixDaemonConnector(
				'ssh',
				commandArguments,
				run,
				() => {
					knownHosts?.dispose();
				}
			)(socketPath, signal);
		} catch (error) {
			knownHosts?.dispose();
			throw error;
		}
	};
}

function shouldUseNativeLocalhost(spec: NixSshStoreSpec): boolean {
	return (
		spec.isNativeLocalhost === true &&
		spec.destination === 'localhost' &&
		spec.host === 'localhost' &&
		spec.port === undefined
	);
}

function createConnectionKnownHosts(
	spec: NixSshStoreSpec,
	dependencies: NixSshConnectorDependencies
): KnownHostsFile | undefined {
	if (spec.sshPublicHostKey === undefined) {
		return;
	}

	return (dependencies.knownHostsFile ?? createKnownHostsFile)(
		knownHostsToken(spec),
		spec.sshPublicHostKey
	);
}

function knownHostsToken(spec: NixSshStoreSpec): string {
	const host = spec.host ?? hostOf(spec.destination);

	return spec.port === undefined || spec.port === 22
		? host
		: `[${host}]:${String(spec.port)}`;
}

function hostOf(destination: string): string {
	return destination.slice(destination.lastIndexOf('@') + 1);
}

function decodeHostKey(encoded: string): string {
	const decoded = Buffer.from(encoded, 'base64');
	const canonicalInput = encoded.replace(/=+$/u, '');
	const canonicalDecoded = decoded.toString('base64').replace(/=+$/u, '');

	if (canonicalInput !== canonicalDecoded || decoded.length === 0) {
		throw new Error('base64-ssh-public-host-key is not valid base64');
	}

	return decoded.toString('utf8');
}

function createKnownHostsFile(host: string, publicKey: string): KnownHostsFile {
	const directory = mkdtempSync(path.join(tmpdir(), 'cupboard-nix-ssh-'));
	const file = path.join(directory, 'host-key');
	writeFileSync(file, `${host} ${publicKey}\n`, { mode: 0o600 });

	return {
		path: file,
		dispose: () => {
			rmSync(directory, { recursive: true, force: true });
		}
	};
}

function shellSplit(source: string): readonly string[] {
	const words: string[] = [];
	let word = '';
	let quote: "'" | '"' | undefined;
	let isEscaping = false;
	let isStarted = false;

	for (const character of source) {
		if (isEscaping) {
			word +=
				quote === '"' && !['$', '`', '"', '\\'].includes(character)
					? `\\${character}`
					: character;
			isEscaping = false;
			isStarted = true;
			continue;
		}

		if (character === '\\' && quote !== "'") {
			isEscaping = true;
			isStarted = true;
			continue;
		}

		if (quote !== undefined) {
			if (character === quote) {
				quote = undefined;
				continue;
			}

			word += character;
			continue;
		}

		if (character === "'" || character === '"') {
			quote = character;
			isStarted = true;
			continue;
		}

		if (character === ' ' || character === '\t') {
			if (isStarted) {
				words.push(word);
				word = '';
				isStarted = false;
			}
			continue;
		}

		word += character;
		isStarted = true;
	}

	if (quote !== undefined) {
		throw new Error(`cannot split NIX_SSHOPTS: unfinished quote`);
	}

	if (isStarted) {
		words.push(word);
	}

	return words;
}

const sshShortOptionsWithArguments = new Set([
	'B',
	'b',
	'c',
	'D',
	'E',
	'e',
	'F',
	'I',
	'i',
	'J',
	'L',
	'l',
	'm',
	'O',
	'o',
	'P',
	'p',
	'Q',
	'R',
	'S',
	'W',
	'w'
]);

function withoutCompressionShortOptions(
	options: readonly string[]
): readonly string[] {
	const filtered: string[] = [];
	let requiresFollowingArgument = false;
	let hasEndedOptions = false;

	for (const token of options) {
		if (requiresFollowingArgument) {
			filtered.push(token);
			requiresFollowingArgument = false;
			continue;
		}

		if (hasEndedOptions || token === '-' || !token.startsWith('-')) {
			filtered.push(token);
			continue;
		}

		if (token === '--') {
			filtered.push(token);
			hasEndedOptions = true;
			continue;
		}

		if (token.startsWith('--')) {
			filtered.push(token);
			continue;
		}

		const shortOption = withoutCompressionShortOption(token);

		if (shortOption.token !== undefined) {
			filtered.push(shortOption.token);
		}

		requiresFollowingArgument = shortOption.requiresFollowingArgument;
	}

	return filtered;
}

interface FilteredSshShortOption {
	readonly token?: string;
	readonly requiresFollowingArgument: boolean;
}

function withoutCompressionShortOption(token: string): FilteredSshShortOption {
	let options = '';

	for (let index = 1; index < token.length; index += 1) {
		const option = token[index];

		if (option === undefined) {
			return { requiresFollowingArgument: false };
		}

		if (option === 'C') {
			continue;
		}

		options += option;

		if (!sshShortOptionsWithArguments.has(option)) {
			continue;
		}

		const attachedArgument = token.slice(index + 1);

		return {
			token: `-${options}${attachedArgument}`,
			requiresFollowingArgument: attachedArgument === ''
		};
	}

	return {
		...(options !== '' && { token: `-${options}` }),
		requiresFollowingArgument: false
	};
}
