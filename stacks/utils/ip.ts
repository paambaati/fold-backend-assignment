import syncRequest from 'sync-request';

const publicIpLookupEndpoints = [
	'http://icanhazip.com',
	'http://ifconfig.io/ip',
	'http://ip.appspot.com/',
	'http://ident.me/',
	'http://whatismyip.akamai.com/',
	'http://tnx.nl/ip',
	'http://myip.dnsomatic.com/',
	'http://ipecho.net/plain',
	'http://diagnostic.opendns.com/myip',
	'http://api.ipify.org/',
	'http://trackip.net/ip',
	'http://myip.wtf/text',
] as const;

const getResponseBody = (url: string): string => {
	const response = syncRequest('GET', url, {
		timeout: 2000,
	});
	return response.getBody().toString().trim();
};

/**
 * Returns the public IPv4 address of the current host.
 *
 * **⚠️ WARNING!** This is not a general purpose utility, and should not be used
 * anywhere of CDK/SST projects! This method runs **synchronously**,
 * and so blocks the main thread!
 *
 * @returns Public IPv4 address.
 */
export const getPublicIp = (): string => {
	let ip: string | undefined = undefined;
	for (const endpoint of publicIpLookupEndpoints) {
		try {
			ip = getResponseBody(endpoint);
			if (!ip) continue;
			break;
		} catch {
			continue;
		}
	}

	if (!ip) {
		throw new Error(`Could not look up public IP address from all ${publicIpLookupEndpoints.length} providers!`);
	}
	return ip;
};
