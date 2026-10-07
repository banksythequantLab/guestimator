import type { CapacitorConfig } from '@capacitor/cli';

// The Android app is a native shell around the live PWA: same origin as the API, so the session cookie,
// camera capture and eBay connect work unchanged. appId stays ai.banksy.bottletree: the Play listing, RevenueCat products and the Google sign-in client are all bound to it. Native adds Google Play billing through RevenueCat.
const config: CapacitorConfig = {
  appId: 'ai.banksy.bottletree',
  appName: 'Guestimator',
  webDir: 'www',
  server: {
    url: 'https://app.theguestimator.com',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#ffffff',
  },
  plugins: {
    // Only Google is bundled; the others would drag in SDKs we don't use.
    SocialLogin: {
      providers: { google: true, facebook: false, apple: false, twitter: false },
      logLevel: 1,
    },
  },
};

export default config;
