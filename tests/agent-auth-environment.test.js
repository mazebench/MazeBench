const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  CHAIR_CREDENTIAL_BROKER_KEYS,
  chairNativeAccount,
  localAgentImageReadiness,
  stripCredentialBrokerCapability,
  trustedHostAccountEnvironment
} = require("../server/agent-auth");

const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mazebench-native-home-"));
try {
  const chairEnvironment = {
    CHAIR_CLAUDE_NATIVE_HOME: nativeHome,
    CHAIR_CLAUDE_NATIVE_USER: "native-user",
    CHAIR_CLAUDE_TOKEN_HELPER: "/private/helper",
    CHAIR_CLAUDE_TOKEN_HELPER_HOME: nativeHome
  };
  assert.deepEqual(chairNativeAccount(chairEnvironment), {
    home: nativeHome,
    user: "native-user"
  });
  assert.equal(chairNativeAccount({ CHAIR_CLAUDE_NATIVE_HOME: "relative/home" }), null);
  assert.equal(chairNativeAccount({ CHAIR_CLAUDE_NATIVE_HOME: path.join(nativeHome, "missing") }), null);

  const providerEnvironment = trustedHostAccountEnvironment(
    { HOME: "/isolated/project-site", PATH: "/usr/bin", ...chairEnvironment },
    chairEnvironment
  );
  assert.equal(providerEnvironment.HOME, nativeHome);
  assert.equal(providerEnvironment.USER, "native-user");
  assert.equal(providerEnvironment.PATH, "/usr/bin");

  stripCredentialBrokerCapability(providerEnvironment);
  assert.equal(providerEnvironment.HOME, nativeHome);
  for (const key of CHAIR_CREDENTIAL_BROKER_KEYS) {
    assert.equal(key in providerEnvironment, false, `${key} must not reach a provider process`);
  }

  assert.deepEqual(
    localAgentImageReadiness(
      { codex: "0.146.0", claude: "2.1.257", kimi: "0.38.0" },
      { codex: "0.146.0", claude: "2.1.257", kimi: "0.29.1" }
    ),
    { codex: true, claude: true, kimi: false },
    "one stale provider must not disable independently certified providers"
  );
} finally {
  fs.rmSync(nativeHome, { recursive: true, force: true });
}

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "server", "app.js"), "utf8");
const runSource = fs.readFileSync(path.join(root, "server", "agent-runs.js"), "utf8");
const agentSource = fs.readFileSync(path.join(root, "public", "agent.js"), "utf8");

assert.match(appSource, /probeCommand\("codex", \["login", "status"\]\)/);
assert.match(appSource, /probeCommand\("claude", \["auth", "status", "--json"\][\s\S]*claudeCredentials\.environment/);
assert.match(appSource, /probeCommand\("prime", \["whoami"\], 8000\)/);
assert.match(appSource, /providerHostEnvironment/);
assert.match(runSource, /stripCredentialBrokerCapability\([\s\S]*providerHostEnvironment/);
assert.match(runSource, /loadCodexModels\(providerEnvironment\.HOME\)/);
assert.match(runSource, /primeModelCatalog\(\)[\s\S]*env: trustedProviderEnvironment\(\)/);
assert.match(agentSource, /imageReadyByProvider\[provider\] \?\? env\.local_agent_image/);

console.log("agent-auth-environment: OK — native logins and per-provider image readiness stay isolated.");
