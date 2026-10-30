import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const config: ExpoConfig = {
  name: "CCP-Bot",
  slug: "ccpbot",
  version: "0.0.1",
  scheme: "ccpbotmobile",
  ios: { bundleIdentifier: "ai.ccpbot.mobile", supportsTablet: true },
  android: { package: "ai.ccpbot.mobile" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { defaultChannel: "ccpbot" }],
  ],
  extra: { ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;
