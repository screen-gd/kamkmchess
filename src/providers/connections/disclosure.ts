import { getConnectionEndpoints } from './profile';
import { classifyConnectionRoute } from './route-scope';
import { usesProviderRelay } from '../transport';
import type { ConnectionProfile, DisclosureDecision, DisclosureDecisionRecord } from './types';

export interface DisclosureLink {
  readonly label: string;
  readonly href: string;
}

export interface FirstRequestDisclosure {
  readonly connectionId: string;
  readonly configRevision: string;
  readonly destinationUrl: string;
  readonly catalogUrl?: string;
  readonly title: string;
  readonly body: string;
  readonly links: readonly DisclosureLink[];
  readonly notices: readonly string[];
  readonly routeScope: ReturnType<typeof classifyConnectionRoute>;
}

export interface DisclosureChoice {
  readonly decision: DisclosureDecision;
  readonly recordedAtMs: number;
}

export function createFirstRequestDisclosure(profile: ConnectionProfile): FirstRequestDisclosure {
  const endpoints = getConnectionEndpoints(profile);
  const isProviderHost = profile.provider !== 'custom' && profile.provider !== 'cliproxy'
    && new URL(endpoints.generationUrl).origin === providerOrigin(profile.provider);
  const providerLabel = profile.provider === 'custom' ? 'the configured endpoint' : providerName(profile.provider);
  const target = isProviderHost
    ? `${providerLabel} at ${endpoints.generationUrl}`
    : `the configured endpoint at ${endpoints.generationUrl}`;
  const protocolText = profile.provider === 'custom'
    ? `${protocolName(profile.protocol)}`
    : `${providerLabel} ${protocolName(profile.protocol)}`;
  const operator = profile.provider === 'custom' || profile.provider === 'cliproxy'
    ? `This connection uses the configured ${protocolText} protocol. The endpoint operator controls account access, logging, retention, and billing for this destination. Review the endpoint operator's rules before playing. Requests use the account and billing configured for this connection and may consume quota or paid credits. Endpoint decisions may cause account restrictions, suspension, or loss of access. You are responsible for your configuration and for following the applicable terms. The client does not verify account eligibility, funding source, remaining quota, or endpoint operator approval.`
    : isProviderHost
      ? `Review the linked provider rules before playing. Providers may restrict how accounts or subscription access can be used in third-party software. Requests use the account and billing configured for this connection and may consume quota or paid credits. Provider decisions may cause account restrictions, suspension, or loss of access. You are responsible for your configuration and for following the provider's terms. The client does not verify account eligibility, funding source, remaining quota, or provider approval.`
      : `This connection uses the ${protocolText} protocol. The endpoint operator controls account access, logging, retention, and billing for this destination. The linked provider rules describe ${providerLabel} terms and credential use; they do not verify that this destination is operated or authorized by ${providerLabel}. Requests use the account and billing configured for this connection and may consume quota or paid credits. Endpoint decisions may cause account restrictions, suspension, or loss of access. You are responsible for your configuration and for following the applicable terms. The client does not verify account eligibility, funding source, remaining quota, or endpoint operator approval.`;
  const routeText = usesProviderRelay(endpoints.generationUrl)
    ? 'through this site\'s relay, which forwards your API key and request without storing them, to'
    : 'directly from your browser to';
  const body = `This open-source chess client sends model requests ${routeText} ${target}. ${operator}`;
  const links = providerLinks(profile.provider);
  const routeScope = classifyConnectionRoute(profile);
  const catalogNotice = endpoints.catalogUrl !== undefined
    && new URL(endpoints.catalogUrl).origin !== new URL(endpoints.generationUrl).origin
    ? `Catalog checks use the separately configured URL ${endpoints.catalogUrl}${usesProviderRelay(endpoints.catalogUrl) ? ' through this site\'s relay' : ''} and send this connection's configured authentication and header values. Check that operator before requesting the catalog.`
    : undefined;
  const notices = isProviderHost && profile.provider === 'anthropic' && profile.protocol === 'messages'
    ? ['Anthropic documents that organizations with Zero Data Retention cannot use this native direct-browser Messages route.', routeScope.statement]
    : profile.provider === 'custom' || profile.provider === 'cliproxy'
      ? ['The endpoint owner controls account access, logging, retention, and billing for this destination.', routeScope.statement]
      : [routeScope.statement];
  if (catalogNotice) notices.push(catalogNotice);
  return {
    connectionId: profile.id,
    configRevision: profile.configRevision,
    destinationUrl: endpoints.generationUrl,
    ...(endpoints.catalogUrl === undefined ? {} : { catalogUrl: endpoints.catalogUrl }),
    title: `Before the first request to ${profile.name}`,
    body,
    links,
    notices,
    routeScope,
  };
}

export function recordDisclosureChoice(profile: ConnectionProfile, choice: DisclosureChoice): DisclosureDecisionRecord {
  if (!Number.isFinite(choice.recordedAtMs) || choice.recordedAtMs < 0) {
    throw new TypeError('A disclosure choice needs a valid recorded time.');
  }
  const { generationUrl } = getConnectionEndpoints(profile);
  return {
    profileId: profile.id,
    configRevision: profile.configRevision,
    destinationUrl: generationUrl,
    decision: choice.decision,
    recordedAtMs: choice.recordedAtMs,
    ...(usesProviderRelay(generationUrl) || (profile.catalogUrl && usesProviderRelay(profile.catalogUrl)) ? { transport: 'site-relay' as const } : {}),
  };
}

export function hasCurrentDisclosureConsent(
  profile: ConnectionProfile,
  record: DisclosureDecisionRecord | undefined,
): boolean {
  if (!record || record.decision !== 'accepted') return false;
  const { generationUrl } = getConnectionEndpoints(profile);
  return record.profileId === profile.id
    && record.configRevision === profile.configRevision
    && record.destinationUrl === generationUrl
    && (!(usesProviderRelay(generationUrl) || (profile.catalogUrl && usesProviderRelay(profile.catalogUrl))) || record.transport === 'site-relay');
}

function providerName(provider: ConnectionProfile['provider']): string {
  switch (provider) {
    case 'openai': return 'OpenAI';
    case 'openrouter': return 'OpenRouter';
    case 'anthropic': return 'Anthropic';
    case 'cliproxy': return 'CLIProxyAPI';
    case 'custom': return 'the configured endpoint';
  }
}

function providerOrigin(provider: Exclude<ConnectionProfile['provider'], 'custom' | 'cliproxy'>): string {
  switch (provider) {
    case 'openai': return 'https://api.openai.com';
    case 'openrouter': return 'https://openrouter.ai';
    case 'anthropic': return 'https://api.anthropic.com';
  }
}

function protocolName(protocol: ConnectionProfile['protocol']): string {
  switch (protocol) {
    case 'chat-completions': return 'Chat Completions';
    case 'responses': return 'Responses';
    case 'messages': return 'Messages';
  }
}

function providerLinks(provider: ConnectionProfile['provider']): readonly DisclosureLink[] {
  switch (provider) {
    case 'openai':
      return [{ label: 'OpenAI Services Agreement', href: 'https://openai.com/policies/services-agreement/' }];
    case 'openrouter':
      return [{ label: 'OpenRouter Terms', href: 'https://openrouter.ai/terms' }];
    case 'anthropic':
      return [{
        label: 'Anthropic authentication and credential use',
        href: 'https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use',
      }, {
        label: 'Anthropic API data retention and Zero Data Retention browser restriction',
        href: 'https://platform.claude.com/docs/en/manage-claude/api-and-data-retention',
      }];
    case 'cliproxy':
      return [];
    case 'custom':
      return [];
  }
}
