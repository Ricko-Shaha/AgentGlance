const fs = require('node:fs/promises');
const path = require('node:path');
module.exports = async ({ appOutDir, packager }) => {
  // macOS stores resources inside the app bundle; Linux and Windows do not.
  const output = path.resolve(appOutDir);
  const sampleApp = path.resolve(packager.getResourcesDir(appOutDir), 'default_app.asar');
  const relative = path.relative(output, sampleApp);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Sample app removal escaped the package directory.');
  await fs.rm(sampleApp, { force: true });
};
