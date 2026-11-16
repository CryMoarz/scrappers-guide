// Optional: commits accepted changes to git so the data's history lives in an ordinary
// repository (and can be pushed to GitHub or any mirror). Does nothing if git isn't installed.
const { execFile } = require('child_process');

function run(cwd, args) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 60e3 }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message).trim())); else resolve(stdout.trim());
  }));
}

function createGit(cwd, opts) {
  let chain = Promise.resolve();
  let ok = null;
  const available = async () => {
    if (ok === null) ok = await run(cwd, ['rev-parse', '--is-inside-work-tree']).then(() => true, () => false);
    return ok;
  };
  // Commits run one at a time so git's index lock never collides.
  function commit(files, message, author) {
    if (!opts.commit) return Promise.resolve(false);
    chain = chain.then(async () => {
      if (!(await available())) return false;
      await run(cwd, ['add', '--all', '--', ...files]);
      const args = ['commit', '-m', message, '--', ...files];
      if (author) args.splice(1, 0, `--author=${author.name || 'contributor'} <${author.fp}@scrappers-guide.invalid>`);
      await run(cwd, args).catch(e => { if (!/nothing to commit/.test(e.message)) throw e; });
      if (opts.push) await run(cwd, ['push']).catch(e => console.warn('git push failed:', e.message));
      return true;
    }).catch(e => { console.warn('git commit failed:', e.message); return false; });
    return chain;
  }
  return { available, commit };
}

module.exports = { createGit };
