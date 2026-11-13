/** Alba's control-plane settings are never inherited by worker processes. */
const internal = (name) => /^ALBA_/i.test(name) || /(?:^|_)(?:CONSOLE|SERVICE|SERVER|CONTROL)(?:_|$).*TOKEN|(?:^|_)TOKEN.*(?:CONSOLE|SERVICE|SERVER|CONTROL)(?:_|$)/i.test(name);
const appOnly = (name) => /^ALBA_(?:PROJECT|WORKERS|MACHINES|LANG|URL|BROWSER|PRODUCER_.*|TEST_.*)$/i.test(name);

/**
 * Preserve ordinary inheritance (including model credentials), remove Alba settings and
 * control-plane tokens, then apply explicit adapter/launch values and finally env_unset.
 * Explicit ALBA_* protocol values are allowed; control-plane tokens are always blocked.
 */
export function workerEnvironment(parent, explicit, unset, platform = process.platform) {
  const sameName = (a, b) => platform === 'win32' ? a.toUpperCase() === b.toUpperCase() : a === b;
  const env = Object.fromEntries(Object.entries(parent).filter(([name]) => !internal(name)));
  for (const [name, value] of Object.entries(explicit)) {
    if (appOnly(name)) continue;
    if (!/^ALBA_/i.test(name) && internal(name)) continue;
    // Even an explicit launch must not forward an Alba console/service token.
    if (/^ALBA_.*(?:TOKEN|SECRET|PASSWORD|API_KEY)/i.test(name)) continue;
    for (const key of Object.keys(env)) if (sameName(key, name)) delete env[key];
    env[name] = value;
  }
  for (const name of unset) for (const key of Object.keys(env)) if (sameName(key, name)) delete env[key];
  return env;
}
