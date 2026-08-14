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
