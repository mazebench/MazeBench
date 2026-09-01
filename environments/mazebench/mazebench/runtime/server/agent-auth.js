const fs = require("fs");
const path = require("path");

const CHAIR_CREDENTIAL_BROKER_KEYS = Object.freeze([
  "CHAIR_CLAUDE_TOKEN_HELPER",
  "CHAIR_CLAUDE_TOKEN_HELPER_HOME",
  "CHAIR_CLAUDE_NATIVE_HOME",
  "CHAIR_CLAUDE_NATIVE_USER"
]);

function chairNativeAccount(sourceEnvironment = process.env) {
  const home = String(sourceEnvironment.CHAIR_CLAUDE_NATIVE_HOME || "").trim();
  if (!home || !path.isAbsolute(home)) return null;

  try {
    if (!fs.statSync(home).isDirectory()) return null;
  } catch (_error) {
    return null;
  }

  const user = String(sourceEnvironment.CHAIR_CLAUDE_NATIVE_USER || "").trim();
  return { home, user };
}

// Chair project sites deliberately run with an isolated HOME. Provider CLIs
// must inspect the user's native account when the trusted MazeBench server
// checks login state or prepares the outer launcher. The evaluated agent still
// receives only its run-scoped container HOME and mounted credential file.
function trustedHostAccountEnvironment(environment, sourceEnvironment = process.env) {
  const result = { ...environment };
  const nativeAccount = chairNativeAccount(sourceEnvironment);
  if (!nativeAccount) return result;
  result.HOME = nativeAccount.home;
  if (nativeAccount.user) result.USER = nativeAccount.user;
  const nativeBins = [
    path.join(nativeAccount.home, ".local", "bin"),
    path.join(nativeAccount.home, ".claude", "local"),
    path.join(nativeAccount.home, ".kimi-code", "bin"),
    path.join(nativeAccount.home, ".local", "share", "prime-agent-node", "current", "bin")
  ].filter((directory) => {
    try {
      return fs.statSync(directory).isDirectory();
    } catch (_error) {
      return false;
    }
  });
  result.PATH = [...new Set([
    ...nativeBins,
    ...String(result.PATH || "").split(path.delimiter).filter(Boolean)
  ])].join(path.delimiter);
  return result;
}

function stripCredentialBrokerCapability(environment) {
  for (const key of CHAIR_CREDENTIAL_BROKER_KEYS) delete environment[key];
  return environment;
}

function localAgentImageReadiness(imageVersions, requiredVersions) {
  return Object.fromEntries(
    Object.entries(requiredVersions).map(([provider, version]) => [
      provider,
      Boolean(version) && String(imageVersions?.[provider] || "") === String(version)
    ])
  );
}

module.exports = {
  CHAIR_CREDENTIAL_BROKER_KEYS,
  chairNativeAccount,
  localAgentImageReadiness,
  stripCredentialBrokerCapability,
  trustedHostAccountEnvironment
};
