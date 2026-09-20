// Turns a title into a URL slug.
function slugify(title) {
  return title.toLowerCase().trim().replace(/\s/g, '-').replace(/[^a-z0-9-]/g, '');
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

module.exports = { slugify, truncate };
