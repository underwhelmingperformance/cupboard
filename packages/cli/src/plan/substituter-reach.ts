/**
 * Decides whether a consumer elsewhere could also reach a configured
 * substituter. {@link isReachableElsewhere} is the implementation a plan uses.
 */
export type SubstituterReach = (substituter: string) => boolean;

/**
 * Whether a consumer elsewhere could also reach a configured substituter. It
 * has to be a binary cache served over HTTP or HTTPS, on a host that refers to
 * the same machine wherever it is read.
 *
 * The host is judged from its syntax alone, with no name resolution, so the
 * answer is the same on every machine and at every moment. An address literal
 * is judged by the block it belongs to, `localhost` and the names under it are
 * the loopback interface by RFC 6761, and every other name is accepted,
 * because deciding otherwise would mean resolving it.
 */
export function isReachableElsewhere(substituter: string): boolean {
	const parsed = URL.parse(substituter);

	if (parsed === null) {
		return false;
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		return false;
	}

	return isReachableHost(parsed.hostname);
}

function isReachableHost(hostname: string): boolean {
	if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
		return false;
	}

	const octets = ipv4Octets(hostname);

	if (octets !== undefined) {
		return isReachableIpv4(octets);
	}

	const groups = ipv6Groups(hostname);

	return groups === undefined || isReachableIpv6(groups);
}

// The URL parser accepts an IPv4 address in several forms and serialises them
// all as four decimal octets, so a host of that shape is an address and one of
// any other shape is a name.
function ipv4Octets(hostname: string): readonly number[] | undefined {
	const parts = hostname.split('.');

	if (parts.length !== 4) {
		return undefined;
	}

	if (parts.some((part) => !/^\d{1,3}$/.test(part))) {
		return undefined;
	}

	const octets = parts.map(Number);

	return octets.every((octet) => octet <= 255) ? octets : undefined;
}

// The URL parser brackets an IPv6 host and serialises it canonically: every
// group in lowercase hexadecimal, including the low 32 bits of a mapped
// address, with one run of zero groups compressed at most.
function ipv6Groups(hostname: string): readonly number[] | undefined {
	if (!hostname.startsWith('[')) {
		return undefined;
	}

	const [leading = '', trailing = ''] = hostname.slice(1, -1).split('::', 2);
	const head = hexGroups(leading);
	const tail = hexGroups(trailing);
	const compressed = Array.from(
		{ length: 8 - head.length - tail.length },
		() => 0
	);

	return [...head, ...compressed, ...tail];
}

function hexGroups(part: string): readonly number[] {
	if (part === '') {
		return [];
	}

	return part.split(':').map((group) => Number.parseInt(group, 16));
}

// The blocks a first octet identifies on its own: 0.0.0.0/8 is this network,
// 10.0.0.0/8 is private use, and 127.0.0.0/8 is the loopback interface.
const confinedIpv4FirstOctets = new Set([0, 10, 127]);

function isReachableIpv4(octets: readonly number[]): boolean {
	const [first = 0, second = 0] = octets;

	if (confinedIpv4FirstOctets.has(first)) {
		return false;
	}

	// 169.254.0.0/16 is link-local.
	if (first === 169 && second === 254) {
		return false;
	}

	// 172.16.0.0/12 and 192.168.0.0/16 are the remaining private use blocks.
	if (first === 172 && second >= 16 && second <= 31) {
		return false;
	}

	if (first === 192 && second === 168) {
		return false;
	}

	return true;
}

function isReachableIpv6(groups: readonly number[]): boolean {
	const [first = 0] = groups;

	// fc00::/7 is unique local: routed within one site.
	if ((first & 0xfe_00) === 0xfc_00) {
		return false;
	}

	// fe80::/10 is link-local.
	if ((first & 0xff_c0) === 0xfe_80) {
		return false;
	}

	if (groups.slice(0, 5).some((group) => group !== 0)) {
		return true;
	}

	// ::ffff:0:0/96 carries an IPv4 address, which the IPv4 blocks cover. The
	// rest of ::/80 is the loopback address, the unspecified address, and the
	// deprecated IPv4-compatible range.
	const [mapped = 0, ...low] = groups.slice(5);

	return mapped === 0xff_ff && isReachableIpv4(octetsOf(low));
}

function octetsOf(groups: readonly number[]): readonly number[] {
	return groups.flatMap((group) => [group >>> 8, group & 0xff]);
}
