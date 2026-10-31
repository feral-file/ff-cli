/**
 * Outbound HTTP User-Agent for ff-cli.
 *
 * Set on every fetch to third-party APIs (Raster, Objkt, fxhash, AB, Feral
 * File, Neort) so partners can distinguish CLI traffic from their own
 * frontend/backend traffic in logs. Without it, all Node-side fetches blend
 * into a generic default UA and partners can't attribute load or behavior
 * back to the CLI when something looks unusual.
 *
 * Format: `ff-cli/<version>` — version is read from package.json at compile
 * time via the bundler's JSON import support (`resolveJsonModule`).
 */

import pkg from '../../package.json';

export const USER_AGENT = `ff-cli/${pkg.version}`;
