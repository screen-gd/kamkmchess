import { getConnectionEndpoints } from './profile';
import type { ConnectionProfile } from './types';

export type ConnectionRouteKind = 'public-https' | 'loopback-http' | 'private-network' | 'unverified-http';
export type ConnectionRouteEvidence = 'normal-remote-route' | 'conditional-research-only' | 'unverified';

export interface ConnectionRouteScope {
  readonly kind: ConnectionRouteKind;
  readonly evidence: ConnectionRouteEvidence;
  readonly destinationHost: string;
  readonly statement: string;
}

export function classifyConnectionRoute(profile: ConnectionProfile): ConnectionRouteScope {
  const { generationUrl } = getConnectionEndpoints(profile);
  return classifyEndpointRoute(generationUrl);
}

export function classifyEndpointRoute(url: string): ConnectionRouteScope {
  const destination = new URL(url);
  const host = destination.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  if (destination.protocol === 'http:' && isLoopback) {
    return {
      kind: 'loopback-http',
      evidence: 'conditional-research-only',
      destinationHost: destination.hostname,
      statement: 'Loopback HTTP is a conditional Windows Chrome and Edge route. Native permission UI, a full installed proxy, and the other required browser targets remain unverified.',
    };
  }
  if (isPrivateHost(host)) {
    return {
      kind: 'private-network',
      evidence: 'unverified',
      destinationHost: destination.hostname,
      statement: 'This private-network destination has no general support claim. LAN, private HTTPS, IPv6, container, firewall, and mobile reachability require route-specific evidence.',
    };
  }
  if (destination.protocol === 'https:') {
    return {
      kind: 'public-https',
      evidence: 'normal-remote-route',
      destinationHost: destination.hostname,
      statement: 'Public HTTPS is the normal remote route. This label does not establish CORS, authentication, model, or account eligibility for this endpoint.',
    };
  }
  return {
    kind: 'unverified-http',
    evidence: 'unverified',
    destinationHost: destination.hostname,
    statement: 'This HTTP destination is unverified. The client has no general support claim for it.',
  };
}

function isPrivateHost(host: string): boolean {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host.includes(':')) {
    const normalized = host.toLowerCase();
    return normalized === '::1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe8')
      || normalized.startsWith('fe9')
      || normalized.startsWith('fea')
      || normalized.startsWith('feb')
      || (normalized.startsWith('::ffff:') && isPrivateHost(normalized.slice(7)));
  }
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10
    || octets[0] === 127
    || (octets[0] === 192 && octets[1] === 168)
    || (octets[0] === 172 && octets[1] !== undefined && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 169 && octets[1] === 254);
}
