# Code Diff Tool

A desktop app (Electron) for reviewing merge requests and pull requests, from GitLab and GitHub, together with the issues they belong to.

- **Reviews:** a review holds one or more code changes (MRs or PRs) and one or more issues (Jira keys or spec files).
- **Diff:** per-change or combined view of a repo, noise filters, comments, threads and viewed marks.
- **Issues and acceptance criteria:** the criteria are extracted from the issues and checked against the changes.
- **AI help:** an AI review that leaves draft comments, a check of each acceptance criterion, a "Critical thinking" view (what to read in order, what to skip) and chats. It works with Claude Code, Codex or a custom command.
- **Themes:** System, Tokyo Night, Dracula, Nord, Gruvbox Dark, Solarized Dark and Paper (light), from the Theme menu.
- **Start from outside:** a second start of the app, or a `codediff://new?...` link, can open a new review or add to an existing one. See `src/shared/launch.ts`.

## Develop

```
npm install
npm run dev          # hot reload
npm run check        # typecheck, lint, format check and unit tests
npm run test:e2e     # builds, then runs the Playwright tests (fake forge and fake AI tools)
npm run pack:dir     # unpacked build in release/
npm run dist         # installer
```

GitLab, GitHub and Jira are used over REST. Tokens are saved per host, encrypted with the operating system's store, and are never sent to the page.
