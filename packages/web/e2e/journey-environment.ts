const defaultBrowserJourneyPort = 4173;

const configuredPort = process.env.SWIFTTUI_BROWSER_JOURNEY_PORT;
const parsedPort =
  configuredPort === undefined
    ? defaultBrowserJourneyPort
    : Number(configuredPort);

if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65_535) {
  throw new Error(
    `SWIFTTUI_BROWSER_JOURNEY_PORT must be an integer from 1 through 65535; received ${configuredPort}.`,
  );
}

export const browserJourneyPort = parsedPort;
export const browserJourneyOrigin = `http://127.0.0.1:${browserJourneyPort}`;

// Qualification policy: same-origin assets, WASM compilation and runtime styles.
export const browserFixtureCSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self'";
