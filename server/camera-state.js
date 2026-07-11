const fs = require('fs');
const path = require('path');

// Admin "hide camera" flags live as one flag file per cam id in this gitignored
// dir — shared by the public camera list, the admin Cameras tab, and the infra
// alert paths so all of them agree on what "disabled in the admin panel" means.
const HIDDEN_CAMS_DIR = path.join(__dirname, '../.hidden-cams');

function isCameraHidden(camId) {
  return fs.existsSync(path.join(HIDDEN_CAMS_DIR, camId));
}

function setCameraHidden(camId, hidden) {
  if (!fs.existsSync(HIDDEN_CAMS_DIR)) {
    fs.mkdirSync(HIDDEN_CAMS_DIR, { recursive: true });
  }
  const flagPath = path.join(HIDDEN_CAMS_DIR, camId);
  if (hidden) {
    fs.writeFileSync(flagPath, Date.now().toString());
  } else if (fs.existsSync(flagPath)) {
    fs.unlinkSync(flagPath);
  }
}

// Snapshot of every configured camera's state: `enabled` (config.json — cam
// permanently on/off) and `hidden` (admin-panel toggle flag file — temporarily
// disabled). Pass the already-loaded config when you have it; otherwise it is
// lazy-required here so merely importing this module never needs config.json
// (keeps infra modules loadable in tests/worktrees without a live config).
function getCamStates(configArg) {
  let cfg = configArg;
  if (!cfg) {
    try {
      cfg = require('../config.json');
    } catch (err) {
      throw new Error('camera-state: failed to load config.json: ' + err.message);
    }
  }
  return (cfg.cameras || []).map(({ id, name, enabled }) => ({
    id,
    name,
    enabled: enabled !== false,
    hidden: isCameraHidden(id)
  }));
}

module.exports = { HIDDEN_CAMS_DIR, isCameraHidden, setCameraHidden, getCamStates };
