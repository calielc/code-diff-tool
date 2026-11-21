# Code Diff Tool: product features

This file describes what the app does for the user. The pictures show made-up data. Run `npm run screenshots` to take them again.

## 1. What the app is

The app helps a reviewer read the code changes of one piece of work. A piece of work often has several merge requests or pull requests in several repos, and one or more issues. The app puts them in one review, shows the code of all of them together, and keeps your progress.

- Hosts: GitLab and GitHub, in any mix. The app calls their REST interfaces with your tokens. Jira gives the issues.
- Code: the app reads the diffs from your local clones with `git`. A change with no local clone is listed, but it has no diff.
- The app is a reviewer's tool. It never merges, and it never posts anything without your action.

## 2. Reviews

The home screen lists your reviews with their name, title, number of changes, number of issues, last opened time and the state of Critical thinking. Every column sorts. A filter box narrows the list.

- **New review** asks for the URLs of the merge or pull requests, the issue keys, an optional spec file, and a name. The check step reads each change and shows what the review will hold. A change with no local clone is skipped, and the list says so. Create and open builds the review.
- A review is built when it opens. The build shows its stages: finding the clones, checking your login, reading the issues, reading the code changes, fetching the missing commits, diffing the files and preparing the review. A reload builds it again.
- **Add changes** at the bottom of the Code changes tab adds more merge or pull requests to the open review. **Add issues** at the bottom of the Issues tab adds issues. What the review holds stays, and nothing is added twice.
- **Start from outside.** A second start of the app, or a `codediff://new?...` link, hands a request to the open app. The request can hold `mr`, `issue`, `title` and `review`. It fills in the New review form and runs the check, and you press Create. When it names an existing review, a dialog lists what it brings and adds it when you agree. On the command line, use the form `--mr=<url>` and `--issue=<key>`, because the app receives the arguments of a second start in a different order. The link works only in the installed app.

## 3. The screen of a review

The header shows the title of the review, a short line about it, the AI button and the Reload button. The tabs are Issues, Code changes, Diff and Acceptance criteria. Each tab shows a count. The keys `1` to `4` pick a tab, and Ctrl+Tab and Ctrl+Shift+Tab go through them.

- The Code changes tab shows the number of changes, and the open and total threads.
- The Diff tab shows how many files you viewed, and the number of your drafts.
- The Acceptance criteria tab shows one dot for each criterion, coloured by its state.
- A banner shows when new commits arrive on a change, when Critical thinking is out of date, or when the AI could not write it.

## 4. Issues

![The Issues tab](docs/images/issues.png)

The table lists the issues with their type, title, status, assignee, number of criteria and description. A click on a row opens its detail: the summary, the criteria and a link to Jira. The AI tool writes the summary. Every column sorts. The row at the bottom adds Jira keys or URLs, and a button adds spec files.

- A spec file is a `.md`, `.txt`, `.html` or `.htm` file of at most 1 MB. The app copies it into the review, so the original can move. Its name is its key.
- An issue that Jira cannot give shows as a failed row with the reason. The review goes on without it.

## 5. Code changes

![The Code changes tab](docs/images/code-changes.png)

The table has one row for each change with its number, stack position, title and branches, repo, state, pipeline, author, approvals, your review status, comments and dates.

- Each branch pair shows a badge: "Up to date", or "N behind" when the change is behind its target branch.
- The state filters hide drafts, open, merged and closed changes. Every column sorts. The first click sorts ascending, the second descending, and the third goes back to the order of the review.
- The row shows what you can do: submit a review, approve, revoke your approval, mark a draft as ready, or mark a ready change as draft. Mark as ready has a circle with a check. Mark as draft has a pencil on a dashed circle.
- Merged and closed changes are read only. A closed change has no diff.
- The threads of the conversation, which are not on a line, show under the row.

## 6. The Diff tab

![The Diff tab](docs/images/diff.png)

### 6.1 The toolbar

- **View**: Critical thinking, By MR, or Combined per repo. Combined shows the files of all the changes of one repo as one diff, when they merge cleanly.
- **Noise**: Code only, Keep mechanical, or Everything. Code only hides blank lines, white space, imports, comments and mechanical modifiers. A file with no change at that level is hidden, and the tree says how many.
- **Layout**: Inline, Side by side, or Full file.
- **Files**: New, Modified and Deleted, each with its count.
- **Types**: Code, Tests, Config and Docs, each with its count.
- **Comments**: Open and Resolved, each with the number of threads. With Open on, the tree shows only the files with open threads, and the diff shows only the open threads, so resolved threads are hidden. Resolved works the same way.
- Filters with buttons (Files, Types and Comments) narrow the list only when a button is on. With no button on, every file shows.
- **Show**: a group at the right end of the toolbar with two checkboxes, Hide viewed and Only files with comments.

### 6.2 The file tree

The tree groups the files by repo, change and folder. A box on each row marks the file or the whole folder as viewed. The bar above the tree shows how many files you viewed. A row shows the status of the file (A, M, D or R), its counts of added and removed lines, and its open threads. A field filters the files by name.

- The arrow keys move through the rows. Up and Down open the file that the focus reaches. Left folds a folder or moves to the parent. Right unfolds a folder or moves to its first child. `*` unfolds everything below the row.
- `n` and `p` open the next and the prior file in the order of the tree. `v` marks the open file as viewed and goes to the next file. Shift+V takes the mark away.

### 6.3 The file panel

![The diff of one file, side by side](docs/images/side-by-side.png)

The header shows the path, the state of the change, the commits of the file and the Viewed button. The body shows the diff in the layout that you chose. A line has a gutter with a `+` button to comment, and a button to ask the AI about the line.

- **Marks inside a line.** When a line changed by a few characters, the changed characters are marked more strongly than the rest of the line. The app compares the two lines word by word, and compares the characters only inside a changed word. A line that changed almost completely gets no marks. Inline and side by side show the marks.
- **Full file** shows the whole new file with the added lines marked.
- **Commits.** The chips in the header list the commits of the change that touched the file. Choose one to see only what it changed, compared with its parent. A banner says which commit it is. Choose HEAD to go back. Comments and threads show at HEAD only, because the lines of a commit are not the lines of HEAD.
- **Viewed.** The Viewed button marks the file as viewed. With a commit chosen, it marks that commit. Each commit chip has its own box. Marking HEAD as viewed marks every commit before it. With a commit chosen, `v` and Shift+V mark and unmark that commit only.
- **Threads.** The threads of a line show under it. A thread shows its first comment, its replies and its state. You can reply, resolve and reopen. A thread on a line that the noise filter hides shows in a list at the top of the file. Threads on the whole file show above the diff.
- **Comments.** The `+` button opens a form. A comment on an open change goes to the host at once. A draft stays in the review, and you post it later or delete it. A merged change takes no new comment.
- **The review bar** at the bottom has Previous and Next for the files, the comment buttons that go to the next and the prior comment, and Submit review. Submit review sends your drafts, an optional summary and your decision (approve, request changes or comment) to each change.

## 7. Critical thinking

![Critical thinking](docs/images/critical-thinking.png)

An AI tool reads the whole review and writes a flow: a summary, boxes for the code that matters in one column for each repo, and arrows that show how one step calls the next. A new box is green. A changed box is plain. An existing box that no change touched has a dashed border. A box opens its file at its first line. Below the diagram are the files to read in order, with the reason for each, and the groups of files that you can skip.

- The flow is checked against the real diffs. A file that is neither in the reading order nor in a skip group makes the flow wrong, and the tool must fix it. The app asks up to three times.
- A flow that no longer matches the changes is hidden, and a banner says that the AI is writing it again.

## 8. Acceptance criteria

![The Acceptance criteria tab](docs/images/criteria.png)

Each issue lists its criteria. **Validate ACs** asks the AI tool to check each criterion against the code of all the changes. It says met, partly met or not met, and gives the reason and links to the lines that show it. For a criterion that is not met, it can suggest a comment. A button adds the suggestion as a draft. The button is off when the change has new commits since the check or is no longer open.

## 9. The AI features

![The AI review box](docs/images/ai-review.png)

- **AI review.** The AI button opens a box. Choose a skill and a model, then start the review. A skill is a markdown file with review rules. One skill is built in. You can point the app at a folder of skill files whose front matter says they are for a code review. The run reads the review context, which is a folder of files that the app writes. It takes a few minutes, and it keeps going when you close the window. Each finding becomes a draft comment that starts with a robot mark, the lens and the severity. A finding with no line becomes a comment on the change.
- **Chat.** The button at the bottom right opens a chat about the whole review. A chat on one line is available from the gutter. The AI answers with the code of the repos at hand. It can propose comments, open a file or mark files as viewed, as cards that you apply or not.
- **Tools.** Claude Code is the default. Codex and a custom command also work. The Prerequisites screen shows the choice. A custom command can use the placeholders `{prompt}`, `{instructions}`, `{model}`, `{effort}`, `{dir}` and `{session}`.
- The AI tools run with read-only tools. They cannot change a file, and nothing they write reaches a host without your action.

## 10. Prerequisites

The first screen shows what the app needs. `git` and a workspace folder are required. At least one host needs a token. The screen explains how to make a token for GitLab, GitHub and Jira, and the access each one needs. The app checks a token before it saves it. The AI tool is optional, and the screen shows its state.

## 11. Themes

The Theme menu lists System, Tokyo Night, Dracula, Nord, Gruvbox Dark, Solarized Dark and Paper. A tick marks the current theme, and the app saves the choice. System follows the colour scheme of the computer.

## 12. Keys

- `1` to `4`: pick a tab. Ctrl+Tab and Ctrl+Shift+Tab: the next and the prior tab.
- Arrow keys, `*`: walk the file tree.
- `n` and `p`: the next and the prior file. `v` and Shift+V: mark and unmark.
- `c`: the next comment.
- Enter sends a chat message, and Shift+Enter adds a line.
