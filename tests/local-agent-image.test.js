const assert = require("node:assert/strict");
const path = require("node:path");
const {
  DEFAULT_LOCAL_AGENT_VERSIONS,
  LOCAL_AGENT_IMAGE_LABELS,
  LOCAL_AGENT_SOURCE_LABEL,
  LOCAL_AGENT_UPDATE_POLICY,
  LOCAL_AGENT_UPDATE_POLICY_LABEL,
  imageLabelsAreCertified,
  isExactPackageVersion,
  localAgentSourceFingerprint,
  versionsFromImageLabels
} = require("../scripts/local-agent-image");

const rootDir = path.resolve(__dirname, "..");
const sourceFingerprint = localAgentSourceFingerprint(rootDir);
assert.match(sourceFingerprint, /^[a-f0-9]{64}$/);
assert(Object.values(DEFAULT_LOCAL_AGENT_VERSIONS).every(isExactPackageVersion));

const labels = {
  [LOCAL_AGENT_UPDATE_POLICY_LABEL]: LOCAL_AGENT_UPDATE_POLICY,
  [LOCAL_AGENT_SOURCE_LABEL]: sourceFingerprint,
  ...Object.fromEntries(Object.entries(LOCAL_AGENT_IMAGE_LABELS).map(([provider, label]) => [
    label,
    DEFAULT_LOCAL_AGENT_VERSIONS[provider]
  ]))
};
assert.deepEqual(versionsFromImageLabels(labels), DEFAULT_LOCAL_AGENT_VERSIONS);
assert.equal(
  imageLabelsAreCertified(labels, rootDir, DEFAULT_LOCAL_AGENT_VERSIONS),
  true
);
assert.equal(
  imageLabelsAreCertified(
    { ...labels, [LOCAL_AGENT_SOURCE_LABEL]: "stale" },
    rootDir,
    DEFAULT_LOCAL_AGENT_VERSIONS
  ),
  false
);
assert.equal(
  imageLabelsAreCertified(
    { ...labels, [LOCAL_AGENT_IMAGE_LABELS.claude]: "2.1.0" },
    rootDir,
    DEFAULT_LOCAL_AGENT_VERSIONS
  ),
  false
);

console.log("local-agent image lifecycle tests passed");
