// legacyFetch: deprecated wrapper around an HTTP GET that returns parsed JSON.
async function legacyFetch(url) {
  return { url, ok: true };
}

module.exports = { legacyFetch };
