import config from "./playwright.config";
const localConfig = { ...config, use: { ...config.use, channel: "chromium" } };
export default localConfig;
