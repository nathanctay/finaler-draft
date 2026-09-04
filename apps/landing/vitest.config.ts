/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

// `getViteConfig` loads this app's astro.config.mjs and applies its plugins to the test
// environment, which is what lets tests import .astro components and `astro:content` directly
// (see the Astro Container API tests) rather than only the plain .ts modules.
export default getViteConfig({
  // The workspace pins apps/web to vite@7.1.3 directly, while astro 5's own dependency range
  // (^6.3.6) resolves a separate vite@6.4.3 for this app. pnpm installs both as distinct
  // packages, so vitest's `declare module 'vite' { interface UserConfig { test?: ... } }`
  // augmentation (triggered by the /// <reference> above) lands on vite@7.1.3's `UserConfig`,
  // not the vite@6.4.3 one `getViteConfig`'s own signature is typed against here -- two
  // structurally-identical but nominally distinct copies of the same interface. This is a type
  // identity artifact of the workspace's existing vite pin, not a real configuration error: the
  // object below is a plain, valid Vite test config at runtime either way.
  // @ts-expect-error -- see comment above; cross-package vite type identity mismatch, not a bug.
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
