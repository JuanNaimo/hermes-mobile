import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.hermes.mobile",
  appName: "Hermes",
  webDir: "dist",
  backgroundColor: "#041c1c",
  server: {
    // Serve the app from http://localhost so it may call a plain-http Hermes
    // gateway on the LAN (an https origin would block it as mixed content).
    androidScheme: "http",
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
};

export default config;
