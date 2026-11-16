# Git, in plain words

You don’t need git to use, run or contribute to this project. The app and the hub work without it, and the issue forms take corrections and device reports from anyone. Git is how the data’s full history gets kept in public, and how people who like it can propose changes as files. This page is for when you want to set it up.

## What git is

Git keeps every version of a folder. Each saved version is a **commit**: a snapshot plus a note saying what changed. A **repository** (repo) is the folder plus its history. **GitHub** (or Codeberg, GitLab, or your own server) hosts a copy online so others can download it, and **push** and **pull** move commits between your copy and that one.

For this project, the useful parts are:

- every change to every record is kept, with who and why;
- anyone can copy the whole thing (a **clone** or **fork**) and keep it alive if the main hub disappears;
- people can propose changes as **pull requests**, which a maintainer reviews and merges.

## Getting a copy

1. Install git. On Debian, Ubuntu or Mint (asks for your password):
   ```bash
   sudo apt install git
   ```
   On a Mac, run `git --version` and accept the offer to install it; on Windows, use the installer from git-scm.com.
2. Tell git who you are (shows on your commits; GitHub can give you a private no-reply address under Settings → Emails):
   ```bash
   git config --global user.name "Your name or handle"
   ```
   ```bash
   git config --global user.email "you@example.com"
   ```
3. Download the project with its history:
   ```bash
   git clone https://github.com/CryMoarz/scrappers-guide.git
   ```

From then on, after changing things:

```bash
git add -A && git commit -m "Say what changed"
```

`git log --oneline` lists the history. `git diff` shows what changed since the last commit.

## Sending a change (a pull request)

1. On GitHub, press **Fork** on the project page. That makes your own copy you can push to.
2. Clone your fork instead of the main repo (replace YOUR-NAME), and start a branch for the change:
   ```bash
   git clone https://github.com/YOUR-NAME/scrappers-guide.git
   ```
   ```bash
   cd scrappers-guide && git switch -c fix-microwave-capacitor
   ```
3. Edit the files in `data/`, then run the checks:
   ```bash
   node tools/validate.js && node --test test/*.test.js
   ```
4. Commit, push the branch to your fork, and GitHub offers to open a pull request:
   ```bash
   git add -A && git commit -m "Microwave: the capacitor is behind the fan" && git push -u origin fix-microwave-capacitor
   ```

The GitHub CLI does steps 1 and 2 in one go: `gh repo fork CryMoarz/scrappers-guide --clone`.

## If it doesn’t work

- **git isn’t installed.** Step 1 of “Getting a copy” fixes it.
- **No name and email set.** Git refuses to commit until step 2 is done.
- **A folder name has a space in it.** Quote the path: `cd "my projects/scrappers-guide"`.
- **Pushing to GitHub needs a login.** GitHub no longer accepts your password for git. Install the GitHub CLI (`sudo apt install gh`), run `gh auth login`, and follow the prompts; after that, pushing works.

## Letting the hub commit for you

A hub can keep its data folder in git. Start it with commits on, and every accepted change becomes a commit with the contributor’s name and the reason:

```bash
SDG_GIT_COMMIT=1 SDG_GIT_PUSH=1 node server/hub.js
```

Push needs the login from above. If pushing fails, the hub keeps working and logs a warning.

## Taking pull requests

When someone sends a pull request on GitHub, its checks show whether `node tools/validate.js` and the tests pass. Read the changed files, merge if they’re good, then on the hub machine:

```bash
git pull && node tools/build.js
```
