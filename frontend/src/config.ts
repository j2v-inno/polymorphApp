// webpack.DefinePlugin replaces `process.env.BACKEND_URL` with a literal string
// at build time (webpack.config.js) — there is no real `process` global in the
// browser bundle. Falls back to the local dev backend port when unset.
export const BACKEND_URL: string = process.env.BACKEND_URL || 'http://localhost:4100';
