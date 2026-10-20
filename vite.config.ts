import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import { readPublicConfig } from './src/public-config.js';
import { createProviderRelay } from './server/provider-relay.js';
import type { Connect } from 'vite';

function providerRelay() {
  const handler = createProviderRelay();
  const configure = (server: { middlewares: Connect.Server }) => {
    server.middlewares.use('/api/provider-relay', handler);
  };
  return { name: 'provider-relay', configureServer: configure, configurePreviewServer: configure };
}

const browserConfig = readPublicConfig({
  accountsEnabled: process.env.KAMKM_PUBLIC_ACCOUNTS_ENABLED === 'true',
  clerkPublishableKey: process.env.KAMKM_PUBLIC_CLERK_PUBLISHABLE_KEY ?? null,
  apiBaseUrl: process.env.KAMKM_PUBLIC_API_BASE_URL ?? null,
});
if (process.env.KAMKM_PUBLIC_ACCOUNTS_ENABLED === 'true' && !browserConfig.accountsEnabled) {
  throw new Error('Account builds require a valid Clerk publishable key and an HTTPS API origin, or HTTP localhost for development.');
}

export default defineConfig({
  plugins: [react(), tailwindcss(), providerRelay()],
  // Public configuration will be allowlisted when hosted accounts are implemented.
  envPrefix: [],
  // Each setting below is public by design. No other environment value enters
  // the browser bundle, including database, Clerk secret or provider credentials.
  define: {
    __KAMKM_PUBLIC_CONFIG__: JSON.stringify(browserConfig),
  },
  build: {
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    modulePreload: { polyfill: false },
  },
});
