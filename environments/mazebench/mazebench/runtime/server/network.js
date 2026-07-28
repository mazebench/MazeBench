const net = require("node:net");

const LOOPBACK_PEERS = new net.BlockList();
LOOPBACK_PEERS.addSubnet("127.0.0.0", 8, "ipv4");
LOOPBACK_PEERS.addAddress("::1", "ipv6");
LOOPBACK_PEERS.addSubnet("::ffff:127.0.0.0", 104, "ipv6");

function browserHostForBind(value) {
  const host = String(value || "");
  if (host === "0.0.0.0" || host === "::" || host === "*") return "localhost";
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isLoopbackHost(value) {
  try {
    const url = new URL(`http://${String(value || "")}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return false;
    }
    if (url.hostname === "localhost") return true;
    const hostname =
      url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1)
        : url.hostname;
    return isLoopbackPeer(hostname);
  } catch {
    return false;
  }
}

function isLoopbackPeer(value) {
  const address = String(value || "").trim();
  const family = net.isIP(address);
  if (!family) return false;
  return LOOPBACK_PEERS.check(address, family === 4 ? "ipv4" : "ipv6");
}

module.exports = {
  browserHostForBind,
  isLoopbackHost,
  isLoopbackPeer
};
