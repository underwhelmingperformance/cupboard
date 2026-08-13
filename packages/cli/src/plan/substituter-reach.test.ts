import { describe, expect, it } from 'vitest';

import { isReachableElsewhere } from './substituter-reach.ts';

describe('isReachableElsewhere', () => {
	it.each([
		{
			name: 'a public cache by name',
			substituter: 'https://cache.nixos.org/',
			reachable: true
		},
		{
			name: 'a public cache on a port, under a path',
			substituter: 'http://cache.example.com:8080/nix',
			reachable: true
		},
		{
			name: 'a public IPv4 address',
			substituter: 'https://1.1.1.1/',
			reachable: true
		},
		{
			name: 'a public IPv6 address',
			substituter: 'https://[2606:4700:4700::1111]/',
			reachable: true
		},
		{
			name: 'an address just below the private 172.16.0.0/12 block',
			substituter: 'https://172.15.0.1/',
			reachable: true
		},
		{
			name: 'an address just above the private 172.16.0.0/12 block',
			substituter: 'https://172.32.0.1/',
			reachable: true
		},
		{
			name: 'a public name that merely begins with `localhost`',
			substituter: 'https://localhost.example.com/',
			reachable: true
		},
		{
			name: 'a directory on this machine',
			substituter: 'file:///var/cache/nix',
			reachable: false
		},
		{
			name: 'a store URI that is not a URL',
			substituter: 'daemon',
			reachable: false
		},
		{
			name: 'a store URI whose scheme names no binary cache',
			substituter: 'ssh-ng://builder.example',
			reachable: false
		},
		{
			name: 'an S3 store URI, which is not opened as a substituter',
			substituter: 's3://cupboard-cache?region=eu-west-1',
			reachable: false
		},
		{
			name: 'the loopback name',
			substituter: 'http://localhost:5000/',
			reachable: false
		},
		{
			name: 'a name under the loopback name',
			substituter: 'http://cache.internal.localhost/',
			reachable: false
		},
		{
			name: 'the IPv4 loopback address',
			substituter: 'http://127.0.0.1:8080/',
			reachable: false
		},
		{
			name: 'another address in the IPv4 loopback block',
			substituter: 'http://127.10.20.30/',
			reachable: false
		},
		{
			name: 'the IPv4 loopback address written as one decimal number',
			substituter: 'http://2130706433/',
			reachable: false
		},
		{
			name: 'the IPv6 loopback address',
			substituter: 'http://[::1]:8080/',
			reachable: false
		},
		{
			name: 'the IPv4 loopback address mapped into IPv6',
			substituter: 'http://[::ffff:127.0.0.1]/',
			reachable: false
		},
		{
			name: 'the unspecified IPv6 address',
			substituter: 'http://[::]/',
			reachable: false
		},
		{
			name: 'the unspecified IPv4 address',
			substituter: 'http://0.0.0.0/',
			reachable: false
		},
		{
			name: 'a private 10.0.0.0/8 address',
			substituter: 'https://10.0.0.5/',
			reachable: false
		},
		{
			name: 'the first private 172.16.0.0/12 address',
			substituter: 'https://172.16.0.1/',
			reachable: false
		},
		{
			name: 'the last private 172.16.0.0/12 address',
			substituter: 'https://172.31.255.254/',
			reachable: false
		},
		{
			name: 'a private 192.168.0.0/16 address',
			substituter: 'http://192.168.1.10/',
			reachable: false
		},
		{
			name: 'a link-local IPv4 address',
			substituter: 'http://169.254.169.254/',
			reachable: false
		},
		{
			name: 'a unique local IPv6 address in fc00::/8',
			substituter: 'http://[fc00::1]/',
			reachable: false
		},
		{
			name: 'a unique local IPv6 address in fd00::/8',
			substituter: 'http://[fd12:3456:789a::1]/',
			reachable: false
		},
		{
			name: 'a link-local IPv6 address',
			substituter: 'http://[fe80::1]/',
			reachable: false
		}
	])('reports $name as $reachable', ({ substituter, reachable }) => {
		expect({
			substituter,
			reachable: isReachableElsewhere(substituter)
		}).toStrictEqual({ substituter, reachable });
	});
});
