// Verification only: provider/network use is not authorized for PR #464.
const localFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const value = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
  const url = new URL(value);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error(`Live network disabled for PR #464 verification (${url.hostname}). Use an explicit test double.`);
  }
  return localFetch(input, init);
};
