# Code Diff Tool: tech stack and architecture

This file describes how the app is built. The product features are in `docs/FEATURES.md`.

## 1. Stack

- Electron 45, with a main process, a preload script and one renderer window.
- React 19 and TypeScript in strict mode. The compiler is TypeScript 6.0. Do not move to version 7 until `typescript-eslint` supports it, because that tool needs the JavaScript API of the compiler.
- `electron-vite` builds the three parts. `vite` serves the renderer in development.
- `zod` checks every message that crosses the IPC boundary and every file that the app reads.
- `yaml` reads the front matter of AI skill files.
- `lowlight` and `highlight.js` colour code (syntax colours). Section 11 gives the choice and the rules.
- IBM Plex Sans and Mono, bundled with `@fontsource`, so the app needs no network for its type.
- `vitest` runs the unit tests. Playwright (`_electron`) runs the end-to-end tests.
- ESLint (flat config, `typescript-eslint`, the hooks rules of React) and Prettier. Husky and `lint-staged` check the staged files before a commit.
- `electron-builder` makes the installers.
- npm is the package manager.

## 2. Processes

- **Main** (`src/main`) owns everything that touches the outside: the file system, `git`, the REST calls, the AI processes, the credentials and the menu. It keeps one session for each open review in memory.
- **Preload** (`src/preload/index.ts`) exposes a typed object, `window.codeDiff`, with one method for each IPC channel. It is the only bridge.
- **Renderer** (`src/renderer`) draws the screens. It has no access to Node, to files or to tokens.
- The app allows one instance. A second start hands its arguments to the first one (`src/main/ipc/launch.ts`).

## 3. Files

- `src/shared`: code and types that both sides use, with no dependency on Electron or the DOM. The diff model, the thread rules, the comparison of two lines, the file kinds, the themes, the prompts of the AI tools, the checks of their answers, the launch request, the version helpers of the review and the types of the IPC.
- `src/main/clients`: one module for each outside system. `rest-api.ts` and `forge-api.ts` make the calls, `gitlab.ts` and `github.ts` map them to the neutral model, `jira.ts` reads issues, `git.ts` runs `git`, and `writes.ts` posts comments, approvals and state changes.
- `src/main/diff`: the diff engine. It is pure TypeScript with no `git` dependency except the reading of blobs. `myers.ts` makes the line diff, `noise.ts` finds the three noise levels, `file-diff.ts` builds a file with its hunks, `mr-files.ts` builds the files of a change, and `combined.ts` builds the combined view of a repo.
- `src/main/services`: the build of a review, the session, the issues and their summaries, the review context folder, the exports of commits, the watcher, the AI runs, the flow, the commits of a file, the credentials and the state of the app.
- `src/main/processes`: the AI tools. `llm.ts` is the facade. `claude.ts`, `codex.ts` and `custom.ts` are the adapters. `run.ts` starts a process, limits its output and time, and kills its whole tree when a build or a run is cancelled.
- `src/main/ipc`: one file for each area. Each handler checks the sender, checks its arguments with `zod` and calls a service.
- `src/renderer/features`: the screens. `review-context.tsx` holds the data of the open review and shares it with the tabs.
- `src/renderer/highlight`: the syntax colours. `engine.ts` colours a whole text with one grammar and cuts the answer into lines. `loaders.ts` holds one lazy import for each grammar, and `hcl.ts` is the grammar of Terraform files that the app defines itself. `highlight.worker.ts` runs the engine off the page thread, and `client.ts` talks to the worker, keeps the cache and stops a worker that is too slow. `useFileHighlight.ts` is the hook of the file panel, `Code.tsx` draws a line, a code block and the switch, and `settings.ts` keeps the switch. `src/renderer/highlight.css` holds the colours of the System look.
- `src/shared/syntax-language.ts` picks a grammar from a file name or a code fence. `syntax-tokens.ts` has the token kinds, the cutting of a tree into lines, the join of tokens with the marks of changed characters, and the size limits. `syntax-plan.ts` says which texts of a file to colour and where the colours of each line come from. `themes.ts` also holds the token colours of each theme.
- `tests`: the unit tests (`*.test.ts`), the end-to-end tests (`e2e/*.spec.ts`) and the fakes (`fakes/`).
- `scripts`: the version rules, the release scripts, the icon and the screenshot scripts.

## 4. Data sources and formats

The app keeps its files in two places.

**The data folder of the app** (`userData`): `app-state.json` (the workspace root, the AI tool choice, the theme, the recent reviews, the sort of the home list and the folder of skill files) and `credentials.json` (the tokens per host, each encrypted with `safeStorage`). A bad or unknown file reads as empty. An unknown key stays.

**The workspace** has a folder `.code-diff` with:

- `reviews/<name>/review.json`: the title, the list of changes (provider, host, project, number), the skipped changes with the reason, and the issue keys. It is written as one line.
- `reviews/<name>/comments.json`: your draft comments, by id.
- `reviews/<name>/specs/`: the copies of spec files.
- `reviews/<name>/issue-briefs.json`: the AI summaries of the issues, keyed by the Jira `updated` time.
- `reviews/<name>/context/<time>/`: the review context for the AI tools. `index.md` lists everything, and each change has a folder with its description, diff, threads, history and files. The repos are exported read-only with `git archive`.
- `reviews/<name>/flow.json` and `flow-issues.json`: the Critical thinking flow and the issues it was written for. `flow-error.txt` holds the reason when three tries failed.
- `reviews/<name>/review-run.json` and `ac-run.json`: the record of the last AI review and of the last acceptance check. A record that says `running` when the app starts is rewritten as stopped.
- `settings.json`: the choice of skill and model, shared by all reviews.

The neutral model is in `src/shared/provider.ts`: `ChangeRef` (provider, host, project, number), `ChangeInfo`, `Thread`, `Approvals`. GitLab and GitHub map to it, so the rest of the code does not care which host it talks to. GitHub threads and check runs use GraphQL and REST.

## 5. IPC

Channel names are in `src/shared/channels.ts`, the types of the bridge in `src/shared/types.ts`, and the handlers in `src/main/ipc`. A channel is a request with a reply (`invoke`), or a push from the main process to the renderer (the build progress, the watcher events, the chat stream, the flow state, the AI run state, the theme and the launch request). Every request returns a result object with `ok`, so an error never throws through the bridge.

## 6. Security

- The window uses `contextIsolation`, `sandbox` and no Node integration. A content security policy is injected at build time. It allows scripts, styles, images and fonts from the app only.
- `src/main/ipc/guard.ts` checks the sender frame of every message against the app origin and checks the arguments.
- A token is validated before it is saved, stored encrypted per host, and never sent to the renderer or written to a log. A request sends the token only to its own host. A test hook can change the base URL, and it works only when `CODEDIFF_TEST=1`.
- The page never holds a file path. A spec file is chosen in a main-process dialog, and the page gets a one-time token and the file names.
- The export of a commit reads the tar stream itself and refuses a path that leaves the folder and any link.
- The code of a repository is drawn as React elements and as text, never as HTML. The grammar library gives a tree, the app turns it into plain tokens, and React escapes the text. The grammars and the worker are files of the app, so the colours need no network. The worker loads under the same content security policy, because `script-src 'self'` covers it.
- The AI tools get a read-only tool list. The text of issues, changes, threads and diffs is data for them, and the instructions say so.
- A request from outside the app only fills in a form. It never creates a review or posts anything.
- Tests never reach a real AI tool or a real remote. The test environment points at fakes, and the hooks that allow it work only under the test flag.

## 7. Build and run

- `npm run dev` starts `electron-vite dev`. The renderer reloads on a change. A change in the main process restarts the app.
- `npm run build` writes `out/main`, `out/preload` and `out/renderer`. The renderer build makes a module worker for the syntax colours (`worker.format` is `es` in `electron.vite.config.ts`) and one small file for each grammar, which the worker loads when a file needs it.
- `npm run pack:dir` makes an unpacked app in `release/`. `npm run dist` makes the installer with a draft version. `npm run dist:release` makes the installer with the version in `package.json`.
- The icon is `build/icon.svg`. `npm run icon` draws `build/icon.png` and `build/icon.ico` with an offscreen Electron window.

### 7.1 Strict checks and style

- `tsconfig.json` has `strict`. The scripts in `scripts/` run directly with Node 22.18 or later and import each other with the `.ts` extension, so the config allows that.
- `npm run lint` runs ESLint with the recommended rules of `typescript-eslint` and the two classic rules of the hooks plugin. `npm run format` runs Prettier (no semicolons, single quotes, 160 columns).
- Line endings are LF everywhere (`.gitattributes` and `.editorconfig`). Without it, a Windows checkout turns files into CRLF and the format check fails.
- A pre-commit hook runs `lint-staged`. It checks and never changes a file. Do not skip it with `--no-verify`.

## 8. Tests

- **Unit tests** (`tests/*.test.ts`) cover the pure code: the diff engine, the thread and comment rules, the comparison of two lines, the file kinds, the themes, the checks of AI answers, the flow checker, the launch request, the version rules, the REST clients against a fake HTTP server, and the services against temporary folders and repos.
- **End-to-end tests** (`tests/e2e`) start the real app with Playwright. Each test makes a temporary workspace with real git repos, starts a fake forge server (`tests/fakes/fake-forge.ts`) and fake AI tools (`fake-claude.mjs`, `fake-codex.mjs`, `fake-custom.mjs`), and drives the window. `forgeEnv` sets the environment that points the app at them.
- The fake forge answers a table of `METHOD endpoint` keys. An array gives one answer for each call in order. An entry can wait or fail.
- Test hooks (`CODEDIFF_FAKE_<TOOL>`, `CODEDIFF_TEST_PICK_FILES`, `CODEDIFF_TEST_FLOW` and more) work only when `CODEDIFF_TEST=1`.
- The windows of the tests stay hidden unless `CODEDIFF_SHOW_WINDOW=1`.
- The syntax colours have unit tests for the language of a name (`syntax-language`), the cutting into lines, the join with the marks and the size limit (`syntax-tokens`), the plan of a file (`syntax-plan`), every grammar and the multi-line cases (`syntax-highlight`), and the contrast of every theme (`syntax-themes`). The contrast test reads `highlight.css` and checks it against `themes.ts` and `styles.css`. `tests/e2e/highlight.spec.ts` shares one app and checks the colour classes and the real colours in the three layouts, the mark over a token, an unknown file and the switch.
- `tests/e2e/screenshots.spec.ts` takes the pictures of the documentation. It runs only when `SHOTS` names a folder. `npm run screenshots` sets it.
- `tests/e2e/phase10.spec.ts` starts a packaged app. It runs only when the app exists. The installer workflow uses it as a smoke test.
- Lessons: a test that asserts the side effect, and not only the reply, finds more. Wait for a state on the page, not for a time.

## 9. Pipelines and repository settings

- `.github/workflows/ci.yml` runs on each push to `main` and on each pull request. The job "Typecheck, test and build" runs `npm ci`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test` and `npm run build` on Ubuntu and on Windows. The install skips the Electron binary. The job "End-to-end tests" runs `npm run test:e2e` on both systems, with the Electron binary and, on Linux, with `xvfb-run`.
- `.github/workflows/audit.yml` runs `npm audit`. It runs when the package files change and every Monday at 05:00 UTC. A finding of high severity or more in the packages that ship in the app fails the run. A finding in the build tools only gives a warning.
- `renovate.json` configures Renovate. It opens update pull requests on Monday before 06:00 (Amsterdam time), waits 3 days after a release and groups the minor and patch updates of the dev packages and of the GitHub Actions. Those updates, and the patch updates of the app packages, merge on their own after the CI jobs pass. A major update of `electron` or `electron-builder` gets its own pull request with the label `needs-manual-test`, and those two never merge on their own. TypeScript stays below 6.1. Renovate needs the Renovate GitHub App on the repository.
- The ruleset "Protect main" protects the default branch. A change reaches `main` only through a pull request. The four CI jobs must pass, the branch must contain the current `main`, and the owner must approve it (`.github/CODEOWNERS` names the owner). A new commit removes the approval. No one can force-push to `main` or delete it. The repository admin and the Renovate app can bypass the ruleset in the mode "pull request" only. That mode lets them merge a pull request without the approval. It does not let them push to `main`.
- `.github/workflows/pr-title.yml` checks the title of each pull request. The title must have the form `type: description` with a known type. This check is not in the required checks of the ruleset yet.
- The repository settings: squash merge, merge commit and rebase are all allowed, the head branch is deleted after a merge, the squash commit takes the title of the pull request, and the wiki is off.
- The steps of a change: make a branch, commit there (the pre-commit hook runs), push it, open a pull request with a title in the form `type: description`, wait for the checks, bring `main` into the branch and squash merge.

## 10. Releases

The workflow `.github/workflows/release.yml` gives each merge to `main` a version, a tag and a release on GitHub. The release has notes and no installers, except a major release. The workflow `.github/workflows/installers.yml` builds the installers and adds them to a release. It starts by itself for a major release, and by hand for any other.

### 10.1 Versions

- The version follows Semantic Versioning. The commit types decide it, as in Conventional Commits. A `feat` commit gives a minor version. A `fix` or `perf` commit gives a patch version. A `!` before the colon, as in `feat!: ...`, or a line that starts with `BREAKING CHANGE:` in the message, gives a major version.
- Every other type (`docs`, `test`, `chore`, `ci`, `build`, `style`, `refactor`) gives a patch version, because each merge makes a release.
- The job "Choose the version" runs `scripts/release-version.ts`, which reads git through `scripts/git-version.ts`. It finds the highest tag `vX.Y.Z`, reads all commit messages since that tag and takes the biggest change. Before the first tag, the base is the version in `package.json`. The rules are in `scripts/next-version.ts`, and `tests/next-version.test.ts` tests them.
- The tag is the version. The file `package.json` keeps its old number in the repository, and nothing is committed to `main`. Inside the installer build, `npm version` sets the new number, so the installers and the app report the version of the release.
- Squash merge the pull requests, because the commit message is the title of the pull request. The workflow `pr-title.yml` fails if the title is not `type: description`.

### 10.2 The release

- The `release` job runs on each push to `main`. It creates the release "Code Diff Tool <version>" with the tag `v<version>` on the commit of the push, and marks it as the latest release. The notes list the commits since the last tag, without the `chore`, `ci`, `docs`, `test`, `build` and `style` commits.

### 10.3 The installers

- The build is costly, so it runs by itself only for a major release. For any other release, choose the workflow "Installers" in the Actions tab, and give the tag of a release, or leave it empty for the latest one. The workflow checks out the code of that tag.
- The Windows runner makes an NSIS installer and a zip (`Code-Diff-Tool-<version>-win-x64.exe`). The macOS runner makes a `.dmg` and a `.zip` for Apple Silicon and for Intel.
- After the build, each runner starts the unpacked app and runs `tests/e2e/phase10.spec.ts` with `CODEDIFF_E2E_PACKAGED` and `CODEDIFF_EXPECT_VERSION`. The test proves that the app starts and reports the version of the release.
- The `upload` job adds the files to the release. `--clobber` replaces the files of an earlier build. The files also stay as workflow artifacts for 7 days.
- A local `npm run dist` builds with the next version and the mark `-draft.<n>`, where n is the number of commits since the last release. It passes the version to `electron-builder` with `-c.extraMetadata.version`, so `package.json` does not change.
- The installers are not signed with a trusted certificate. Windows SmartScreen warns about an unknown publisher. On macOS, the hook `scripts/ad-hoc-sign.cjs` gives the app an ad hoc signature, because Apple Silicon reports an unsigned app as damaged. The app is not notarized, so the user opens it once with a right click and "Open". To sign the installers later, add the certificate as repository secrets and set `CSC_LINK` and `CSC_KEY_PASSWORD` in the build step.
- The app does not update itself and does not check for a newer release.

## 11. Decisions and why

- A review is a folder of files, not a database. It is easy to read, to back up and to share, and a bad file affects one review.
- The code comes from local clones, read with `git`. It is fast, works offline for the diff, and gives the same result as the command line. A change with no clone is listed without a diff.
- REST for every host, never the command-line tools. The app then needs no install of `glab`, the GitHub tool or the Jira tool, and it knows exactly what it sends.
- One neutral model for GitLab and GitHub. The rest of the code, and the tests, do not depend on the host.
- AI tools run as child processes behind one facade. The app does not link any vendor library. A new tool is one more adapter, and a custom command needs none.
- The AI tools only read. The app turns their answers into drafts that the reviewer reads first. A wrong answer then costs a deleted draft, not a wrong comment on a real change.
- The answers of the AI tools are checked against the real data, and a wrong answer goes back to the tool up to three times. A flow or a finding that points at a line that does not exist never reaches the screen.
- The marks inside a line compare words first and characters only inside a changed word. A pure character comparison scatters marks inside a word that changed fully.
- Viewed marks and the choice of tab stay in the browser storage of the window, per review. They belong to the reader and not to the review.
- ESLint and Prettier, with TypeScript pinned below 7. `typescript-eslint` needs the JavaScript API of the compiler, which version 7 does not have.
- The MIT license. It is short, common and permissive.
- Changes go through pull requests and are squash merged. The title of the pull request is the commit message, and its type chooses the version. This gives one commit for each change and a version rule that needs no extra file.
- Each merge makes a release, and the installers are built only for a major release or on demand, because the build costs a Windows and a macOS runner.
- The version lives in the tag and not in `package.json`. A bot must not commit to a protected `main`, so the build sets the number for itself.

### 11.1 Syntax colours

- **The library is `lowlight` on top of `highlight.js`.** The four candidates were compared. Shiki gives the most exact colours, because it uses the grammars of VS Code, but it needs a regular expression engine of its own (WebAssembly or a JavaScript port) and bigger grammars, and its tokens carry theme colours that the app would have to override for seven themes. Prism is small and permissive, but it registers each grammar as a global side effect and its tree is meant to become HTML. `highlight.js` alone covers every requested language with one small file for each, so the app loads only the grammars it needs. It needs no network, and its licence is BSD-3-Clause. But it returns HTML strings, which the app must not inject. `lowlight` (MIT) runs the same grammars and returns a tree of nodes. The app turns the tree into tokens and draws them as React elements. It does not parse HTML and it never injects any. The cost is that the grammars are rule based and not exact like those of VS Code. The colours are right for most code and can be wrong for rare syntax.
- **The language comes from the name of the file.** The extension decides, and a few whole names decide too (`Dockerfile`, `Makefile`, `Gemfile`, `.env`, `.gitignore`). A file that matches nothing stays plain, because guessing the language wastes time and often guesses wrong. A code fence in the chat names its language, and a fence with no known name stays plain. Project files such as `.csproj` and `.props` use the XML grammar, `.sln` and TOML use the INI grammar, and `.gradle` has its own. `highlight.js` has no HCL grammar, so `hcl.ts` defines a small one for `.tf` files.
- **The whole file is coloured, then cut into lines.** A removed line reads the old file, and an added or unchanged line reads the new file, both by line number. Colouring each diff line alone breaks every multi-line comment and string. When a file has no whole text (a generated file, or an old side where nothing was removed), each hunk is coloured by itself with its own lines. This can give a wrong colour for a token that starts above the hunk, and it never changes the text. When the tokens of a line do not join to the text of that line, the line shows as plain text.
- **A worker does the work.** The page never waits for the colours. The first render shows plain text, and the page draws again when the worker answers. A worker that has not answered after 8 seconds is stopped and the file stays plain. The cache keeps the answers by language, line count and a hash of the text, so a file that comes back is coloured at once. It holds the 48 last texts. A measure on 7,500 lines in the Full file layout, with 21,000 coloured elements, gave the colours 60 ms after the table was drawn, and a switch off or on cost about 150 ms.
- **The size limit is 8,000 lines, 600,000 characters or a line of more than 1,500 characters.** Above it, the file stays plain and the file header says why. A long line is minified or generated code, where a grammar is slow and the colours help little. The limits are in `syntax-tokens.ts`.
- **The marks and the colours work together.** A changed character has the class `chg` and its token has the class `tk-<kind>`, on the same element. The mark sets the background and the token sets the text colour, so both show. The mark is stronger than the line, so a token inside a mark has its own colour (`--tok-<kind>-chg`), moved further for the contrast.
- **Each theme has a colour for twelve kinds of token.** A theme lists the wanted colours. `tokensOf` moves each one toward white (dark themes) or black (light themes) in small steps until it has a contrast of 4.5 (WCAG AA) on the page, the panel, the added line and the removed line, and a second colour for the marks. A test checks all seven looks (the six themes and the light and dark looks of System). System keeps its values in `highlight.css`, and a test checks that they match `themes.ts` and `styles.css`.
- **The switch is a box in the file header, kept in the browser storage like the other choices of the Diff tab.** It is not in the toolbar, to stay away from the toolbar work, and not in the native Theme menu, because that needs a new message between the processes for a small gain.
- **Not coloured.** Text of comments and threads, the Critical thinking boxes and the other screens have no code. The code of the `DevReader` screen is raw data for developers.
