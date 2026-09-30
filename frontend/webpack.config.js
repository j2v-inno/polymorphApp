const webpack = require('webpack');
const singleSpaDefaults = require('webpack-config-single-spa-react');
const { merge } = require('webpack-merge');

module.exports = (webpackConfigEnv, argv) => {
  const defaultConfig = singleSpaDefaults({
    orgName: 'innodata',
    projectName: 'transapp',
    webpackConfigEnv,
    argv,
  });

  // The defaults mark react, react-dom, react-dom/client and single-spa as
  // externals, expecting the host's import map to supply them. Orion has no
  // import map and does not share its React (its Next.js build bundles its own),
  // so a bare `import "react"` in this bundle fails to resolve when Orion
  // imports it. Bundle everything instead — one self-contained ES module that
  // any host can import() by URL. Assigned rather than merged: webpack-merge
  // would append to the defaults' array, not replace it.
  defaultConfig.externals = [];

  return merge(defaultConfig, {
    // webpack-config-single-spa-react hardcodes entry to src/<orgName>-<projectName>;
    // FLUID_APP_DEV_CONTEXT.md §9.1/§11 names the entry file single-spa-entry.tsx, so
    // override it here rather than renaming the file to match the tool's convention.
    entry: require('path').resolve(__dirname, 'src/single-spa-entry.tsx'),
    // Default config only resolves .mjs/.js/.jsx/.wasm/.json (see webpack-config-single-spa).
    resolve: { extensions: ['.ts', '.tsx'] },
    // §3.2 standalone mode reuses the same bundle (single-spa-entry.tsx's
    // domElementGetter falls back to a #app container) — see the generated dev/prod
    // HTML harness for the local testing entry point.
    plugins: [
      new webpack.DefinePlugin({
        'process.env.BACKEND_URL': JSON.stringify(process.env.BACKEND_URL || 'http://localhost:4100'),
      }),
    ],
  });
};
