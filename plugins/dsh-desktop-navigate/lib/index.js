/**
 * dsh-desktop-navigate — host-side entry.
 *
 * Pure UI/behavior plugin: the empty apply exists so the plugin appears in
 * the host Loader (dsh-client-modules scans loader entries for packages
 * declaring `dsh.client`); the browser half ships via exports["./client"],
 * discovered through the package.json dsh.client declaration, and is
 * composed into window.__DSH_BOOT__.
 */

/** Host plugin body — no host-side behavior for this client plugin. */
function apply() {}

export { apply }
