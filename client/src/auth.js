// Optional dispatcher token (server env DISPATCH_TOKEN). Open the dashboard once as /?token=... and it is
// remembered for this browser tab. With no token configured on the server this is a no-op.
export function dispatcherToken() {
  try {
    const q = new URLSearchParams(window.location.search).get('token');
    if (q) sessionStorage.setItem('dispatchToken', q);
    return sessionStorage.getItem('dispatchToken') ?? '';
  } catch { return ''; }
}
