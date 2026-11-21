# CLAUDE.md

This file is the guide for any agent or person who starts new work on Code Diff Tool. It gives the working rules, the state of the repository and the known gaps. The product features and the tech stack have their own files, which this file imports. Keep all three files in step with the code.

## 1. Working rules

- The app is an Electron desktop app that reviews merge requests and pull requests, from GitLab and GitHub, with their issues. The owner runs it with `npm run dev`.
- Never run `pkill` or `taskkill` on `electron` or `electron-vite`. It ends every Electron app on the machine, not only this one.
- Never commit or push to `main`. Make a branch, commit there, push the branch and open a pull request. The title of the pull request must have the form `type: description`, because the squash merge makes it the commit message. The ruleset "Protect main" blocks a direct push. Bring `main` into the branch before the merge, so that the checks run on the result. `docs/TECH-STACK.md`, section 9, describes the rules.
- Commit, push and merge only when the owner asks. When the owner asks to merge, rebase onto `main`, run all the checks, and merge as soon as they pass. Commit messages use the form `type: description`, and the type chooses the next version (`feat` minor, `!` major, the rest patch, and each merge makes a release). `docs/TECH-STACK.md`, section 10, has the rules.
- When you pull, use fast-forward only. Leave a repo that has local changes alone.
- Never write the names of the owner's former employer or of its internal tools into the repository: not in code, comments, UI text, tests, fixtures, folder names, commit messages or pull request text. When a design file uses one of them, translate it. A workspace root folder, found by scanning the `origin` remotes of the repos in it, replaces a manifest. The data folder is `.code-diff/`. Before a push, search the tracked files for the banned names. A hit in a commit that is already shared goes to the owner, and history is not rewritten without the owner's approval.
- Say "issue", never "ticket". The tab for merge and pull requests is "Code changes". Prefer brand names (Claude Code, Codex, GitLab, GitHub, Jira) over generic labels.
- Use REST for every host. Never use the `glab`, the GitHub or the Jira command-line tools. Tokens are saved per host, encrypted with the operating system, checked before they are saved, and never sent to the page or written to a log.
- A test must never reach a real AI tool or a real remote. The tests point the app at fakes, and the hooks that allow it work only when `CODEDIFF_TEST=1`.
- Documentation and comments use plain English: short sentences, no contractions, no semicolons, no em-dashes, and the condition first.
- Write tests for new rules. Run `npm run check` before you finish, and `npm run test:e2e` when you change the interface. A screen that changes gets its tests updated in the same change. The end-to-end run takes many minutes, so start it in the background and do not switch branches in the same folder while it runs. Use a second git worktree for other work.
- After a change that you can see in the interface, run `npm run screenshots` and commit the new pictures in `docs/images`. The README and `docs/FEATURES.md` show them. They show made-up data only.
- Format with Prettier and lint with ESLint. A pre-commit hook checks the staged files. Do not skip it with `--no-verify`. Keep TypeScript below version 6.1 until `typescript-eslint` supports version 7.
- Line endings are LF. `.gitattributes` makes sure of it.

## 2. The specs

Two files hold the details.

- `docs/FEATURES.md` describes what the app does for the user.
- `docs/TECH-STACK.md` describes the stack, the processes, the files, the data formats, the security rules, the tests, the pipelines, the releases and the decisions.

@docs/FEATURES.md
@docs/TECH-STACK.md

## 3. Repository and workflow state

- GitHub: `calielc/code-diff-tool`. The branch `main` is protected, and it changes only through pull requests.
- The app was built from a design in `calielc/code-diff-spec`, with its own names. The screenshots of that design are the model for the look of the screens.
- The release workflow makes a release on each merge to `main`. The installers are built on demand.

## 4. Known gaps and ideas

- The Codex adapter was written from its documented `codex exec --json` behavior and tested only against a fake. It has never run against the real tool.
- GitLab was never tested against the real service. GitHub was tested read-only against a real public pull request.
- The app has one window. Two reviews cannot be open side by side.
- A commit of a file shows without comments or threads, because its lines are not the lines of HEAD. Mapping them is not done.
- The Diff tab has no per-commit view for the combined view.
- The pictures of the Code changes table do not have the columns Created, Merged and the filter chips of the design.
- Avatars show initials only.
- The installers are not signed, and the macOS app is not notarized. The app does not update itself.
- macOS has no automated test run in the CI. The installer workflow builds the macOS app and starts it once.
- Ideas: a window for each review, the history of a file by commit with blame, and a command palette.
