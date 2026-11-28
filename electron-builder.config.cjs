module.exports = {
  appId: 'com.aavin.pos.desktop', productName: 'Aavin POS',
  directories: { app: '.desktop-package', output: 'releases' },
  files: ['main.js', 'preload.cjs', 'core/**/*.js', 'ui-build/**/*', 'public-config.json', 'package.json', '!node_modules/**/*'],
  asar: true, npmRebuild: false,
  electronFuses: { runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false, onlyLoadAppFromAsar: true, enableEmbeddedAsarIntegrityValidation: true },
  win: { target: [{ target: 'nsis', arch: ['x64'] }], signAndEditExecutable: false, artifactName: 'Aavin-POS-${version}-Windows-${arch}-Setup.${ext}', requestedExecutionLevel: 'asInvoker' },
  nsis: { oneClick: false, perMachine: false, allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false, createDesktopShortcut: true },
  mac: { target: ['dir'], identity: null },
  publish: null
};
