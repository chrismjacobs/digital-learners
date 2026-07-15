/* Thin fetch wrapper. Every call throws an Error carrying the server's message. */
window.API = (function () {
  async function request(method, path, data) {
    const opts = { method, credentials: 'same-origin', headers: {} };
    if (data instanceof FormData) {
      opts.body = data;
    } else if (data !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(data);
    }
    const res = await fetch('/api' + path, opts);
    let payload = {};
    try { payload = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      const err = new Error(payload.error || 'Something went wrong.');
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  return {
    get: (p) => request('GET', p),
    post: (p, d) => request('POST', p, d),
    patch: (p, d) => request('PATCH', p, d),
    del: (p) => request('DELETE', p),
    upload: (p, formData) => request('POST', p, formData),
  };
})();

/* Stable IDs, minted once at creation and never reused (CLAUDE.md §3B). */
window.newId = function (prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
};
