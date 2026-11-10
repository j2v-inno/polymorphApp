// webpack.DefinePlugin replaces `process.env.BACKEND_URL` with a literal string
// at build time (webpack.config.js) — there is no real `process` global in the
// browser bundle. Falls back to the local dev backend port when unset.
export const BACKEND_URL: string = process.env.BACKEND_URL || 'http://localhost:4100';

// Where Orion publishes its External page (the `queue` screen loads it with
// import()). Baked in at build time like BACKEND_URL. Defaults to a local Orion
// frontend; set ORION_ENTRY_URL to the Orion this build should show.
export const ORION_ENTRY_URL: string =
  process.env.ORION_ENTRY_URL || 'http://localhost:3000/external-page/entry.js';
