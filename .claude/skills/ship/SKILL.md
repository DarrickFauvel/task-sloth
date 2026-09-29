---
name: ship
description: Ship the current work - branch, commit, push, open a PR, wait for checks, squash-merge into main, and sync local main. Pass "--no-merge" to stop at an open PR, or a short description to steer the branch name and commit message.
argument-hint: "[--no-merge] [what this change is]"
disable-model-invocation: true
allowed-tools: Bash(git *), Bash(gh *), Bash(pnpm test*), Bash(node --check *)
---

Ship the current working tree to `main` through a GitHub PR. Arguments: `$ARGUMENTS`

Invoking `/ship` is the user's authorization for every step below (commit, push, PR, merge), so don't stop to ask for confirmation between them. Stop and report only when a step fails or a check below says to.

## 1. Preflight

Run these checks together, then act on what they show:

- `git status --short`, `git branch --show-current`, `git log --oneline origin/main..HEAD 2>/dev/null`, `git remote -v`
- If there are no uncommitted changes and no unpushed commits, say "nothing to ship" and stop.
- **Secrets:** make sure none of these are about to be committed: `.env` files, `*.db` files, `data/`, or anything that looks like a key or token. Check `git status` together with `.gitignore`, and grep the diff for `SECRET|TOKEN|PRIVATE KEY|sk-`. If you find anything, stop and name the file.
- **Leftovers:** grep the diff (`git diff HEAD` plus the contents of untracked files) for `console.log(`, `debugger`, `.only(`, and conflict markers. Stop on conflict markers. For the others, list them in the final report, but don't block on them.
- **Tests:** run `pnpm test`. If it fails, stop and show the failures.
- **Syntax:** run `node --check` on each changed `.js` file.

## 2. Branch

- If the current branch is `main`, create a branch named `feature/<short-kebab-slug>`, taking the slug from `$ARGUMENTS` or from the diff: `git switch -c feature/<slug>`.
- Otherwise stay on the current branch.

## 3. Commit

- Read the full diff (`git diff HEAD`, plus untracked files) before writing the message. Don't write the message from file names alone.
- Stage with `git add -A`, after making sure step 1 found nothing that shouldn't be committed.
- Use a subject line of at most 72 characters, in the imperative mood ("Add task list with quick-add"), a blank line, then a short body explaining *why*. If the changes are unrelated to each other, make one commit per concern.
- End every commit message with the attribution trailer the session tells you to use, if there is one.

## 4. Push

`git push -u origin HEAD`. If the remote branch has moved on, `git pull --rebase` and push again. Never force-push `main`. Force-push the feature branch only with `--force-with-lease`, and only when a rebase made it necessary.

## 5. Pull request

- If the branch already has an open PR (`gh pr view --json url,state`), update it by pushing, and don't open a second one.
- Otherwise run `gh pr create --base main --title "<subject>" --body "<body>"`. Write the body with these sections:
  - **Summary:** 2–5 bullets on what changed and why.
  - **Testing:** what was actually run (tests, manual checks), and what wasn't.
  - **Notes:** follow-ups, leftovers found in step 1, and any migrations.
  - End with the PR attribution line the session tells you to use, if there is one.
- If `$ARGUMENTS` contains `--no-merge`, open the PR as a draft (`--draft`), report its URL, and stop here.

## 6. Merge

- Run `gh pr checks --watch --fail-fast`. If the repo has no checks, treat that as passing. If any check fails, report which one and stop without merging.
- Run `gh pr merge --squash --delete-branch`. If the repo requires review, or merging is blocked, report it and leave the PR open. Don't pass `--admin`.
- Sync local: `git switch main && git pull --ff-only`.

## 7. Report

Keep the report short:
- the PR URL and the merge commit
- the branch that was deleted
- anything skipped or flagged: leftovers, missing tests, checks that didn't run
- one suggested next step, if something is obvious (for example, a migration that needs running in production)
