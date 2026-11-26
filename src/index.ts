// foxpaw as a library (Bun). Programs in other languages run `foxpaw ensure --launch` and connect any WebDriver BiDi
// client to the URL it prints.
export { BidiClient, BidiError, BidiFeatureUnavailableError, BrowserUnavailableError, type BidiEvent, type BidiTransport, type JsonObject } from './bidi.ts';
export { BrokerBidiClient, ensureBroker } from './broker-client.ts';
export { createBroker, runBroker, type BrokerOptions } from './broker.ts';
export { ZenBrowser } from './browser.ts';
export { brokerSessionUrl, firefoxBidiBrokerUrl, firefoxBidiUrl } from './config.ts';
export { defaultProfileDir, findBrowser, installAutoconfig, launchBrowser, ProfileInUseError, type LaunchMode, type LaunchOptions, type LaunchResult } from './launch.ts';
