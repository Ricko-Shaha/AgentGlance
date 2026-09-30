'use strict';

// Source smoke-test entry point. Install backend doubles before requiring the
// real app; production contains no fixture flag or alternative auth behavior.
const Module = require('node:module');
const path = require('node:path');
const now = new Date().toISOString();
const snapshot = { checkedAt: now, scanDurationMs: 1, platform: process.platform, providers: ['codex', 'claude'].map((id, index) => ({
  id, name: index ? 'Claude' : 'Codex', description: 'Test assistant', status: 'running', authSource: 'Test fixture', processCount: 1, lastActivityAt: now, detail: 'Fixture process',
  activity: { state: index ? 'free' : 'occupied', detail: 'Fixture activity', source: 'Test fixture', updatedAt: now },
  tasks: [{ id: `${id}-fixture`, label: 'Cross-platform desktop checks', state: 'occupied', updatedAt: now, context: { usedTokens: 25000, maxTokens: 100000, usedPercent: 25 } }],
  usage: { context: null, state: 'available', source: 'Test fixture', updatedAt: now, stale: false, message: null, limits: [{ id: 'five_hour', label: '5-hour', usedPercent: 24, resetsAt: new Date(Date.now() + 3600000).toISOString() }, { id: 'seven_day', label: 'Weekly', usedPercent: 40, resetsAt: new Date(Date.now() + 86400000).toISOString() }] },
})) };
const originalLoad = Module._load;
Module._load = function (request, parent, ...args) {
  if (typeof parent?.filename === 'string' && path.basename(parent.filename) === 'main.cjs' && path.basename(path.dirname(parent.filename)) === 'electron') {
    if (request === './providers.cjs') return { getSnapshot: async () => snapshot };
    if (request === './claude-integration.cjs') return {
      getIntegrationStatus: async () => ({ signedIn: true, installed: true, usageConnected: true, activityConnected: true, legacy: false, canConnect: false, canDisconnect: false, reason: null }),
      connectIntegration: async () => { throw new Error('Fixture must not edit credentials'); },
      disconnectIntegration: async () => { throw new Error('Fixture must not edit credentials'); },
    };
  }
  return originalLoad.call(this, request, parent, ...args);
};

module.exports = { snapshot };
if (process.versions.electron) {
  const root = path.resolve(__dirname, '..');
  require('electron').app.setAppPath(root);
  require(path.join(root, 'electron', 'main.cjs'));
}
