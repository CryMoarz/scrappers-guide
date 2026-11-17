// Optional: commits accepted changes to git so the data's history lives in an ordinary
// repository (and can be pushed to GitHub or any mirror). Does nothing if git isn't installed.
const { execFile } = require('child_process');

function run(cwd, args, env) {
  return new Promise((resolve, reject) => execFile('git', args, { cwd, timeout: 60e3, env: env && Object.assign({}, process.env, env) }, (err, stdout, stderr) => {
    if (err) reject(new Error((stderr || err.message).trim())); else resolve(stdout.trim());
  }));
}

// Names and reasons are contributors' own words, so they never reach git's command line or its
// headers. The author goes in through the environment, with no < > or control characters (in
// --author, git took the first <...> in a name as the email). In the message, the first paragraph
// is the subject, as git reads it, so it is joined into one line; in the rest, a line that looks
// like a trailer (Signed-off-by:, Co-authored-by: and the like) is quoted, so nobody's words can
// claim who wrote or approved a change.
const oneLine = s => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
function authorEnv(author) {
  const name = oneLine(author.name).replace(/[<>]/g, '').trim().slice(0, 60);
  return {
    GIT_AUTHOR_NAME: /[\p{L}\p{N}]/u.test(name) ? name : 'contributor',
    GIT_AUTHOR_EMAIL: `${String(author.fp || '').replace(/[^A-Za-z0-9._-]/g, '') || 'anonymous'}@scrappers-guide.invalid`,
  };
}
function cleanMessage(message) {
  const paras = String(message || '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').split(/\n[ \t]*\n/);
  const subject = oneLine(paras.shift()) || 'Update data';
  const body = paras.join('\n\n').split('\n').map(l => (/^\s*[A-Za-z0-9-]+\s*:/.test(l) ? '> ' + l.trim() : l.trimEnd())).join('\n').trim();
  return body ? `${subject}\n\n${body}` : subject;
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
      await run(cwd, ['commit', '-m', cleanMessage(message), '--', ...files], author && authorEnv(author)).catch(e => { if (!/nothing to commit/.test(e.message)) throw e; });
      if (opts.push) await run(cwd, ['push']).catch(e => console.warn('git push failed:', e.message));
      return true;
    }).catch(e => { console.warn('git commit failed:', e.message); return false; });
    return chain;
  }
  return { available, commit };
}

module.exports = { createGit, cleanMessage, authorEnv };
