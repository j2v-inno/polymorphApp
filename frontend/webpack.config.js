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
