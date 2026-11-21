# Code Diff Tool: product features

This file describes what the app does for the user. The pictures show made-up data. Run `npm run screenshots` to take them again.

## 1. What the app is

The app helps a reviewer read the code changes of one piece of work. A piece of work often has several merge requests or pull requests in several repos, and one or more issues. The app puts them in one review, shows the code of all of them together, and keeps your progress.

- Hosts: GitLab and GitHub, in any mix. The app calls their REST interfaces with your tokens. Jira gives the issues.
- Code: the app reads the diffs from your local clones with `git`. A change with no local clone is listed, but it has no diff.
- The app is a reviewer's tool. It never merges, and it never posts anything without your action.

## 2. Reviews

The home screen lists your reviews with their name, title, number of changes, number of issues, last opened time and the state of the Summarised page (Ready, Not written or Failed). A new review shows Not written until you open the Summarised view. Every column sorts. A filter box narrows the list.

- **New review** asks for the URLs of the merge or pull requests, the issue keys, an optional spec file, and a name. The check step reads each change and shows what the review will hold. A change with no local clone is skipped, and the list says so. Create and open builds the review.
- A review is built when it opens. The build shows its stages: finding the clones, checking your login, reading the issues, reading the code changes, fetching the missing commits, diffing the files and preparing the review. A reload builds it again.
- **Add changes** at the bottom of the Code changes tab adds more merge or pull requests to the open review. **Add issues** at the bottom of the Issues tab adds issues. What the review holds stays, and nothing is added twice.
- **Start from outside.** A second start of the app, or a `codediff://new?...` link, hands a request to the open app. The request can hold `mr`, `issue`, `title` and `review`. It fills in the New review form and runs the check, and you press Create. When it names an existing review, a dialog lists what it brings and adds it when you agree. On the command line, use the form `--mr=<url>` and `--issue=<key>`, because the app receives the arguments of a second start in a different order. The link works only in the installed app.

## 3. The screen of a review

The header shows the title of the review, a short line about it, the AI button and the Reload button. The tabs are Issues, Code changes, Diff and Acceptance criteria. Each tab shows a count. The keys `1` to `4` pick a tab, and Ctrl+Tab and Ctrl+Shift+Tab go through them.

- The Code changes tab shows the number of changes, and the open and total threads.
- The Diff tab shows how many files you viewed, and the number of your drafts.
- The Acceptance criteria tab shows one dot for each criterion, coloured by its state.
- A banner shows when new commits arrive on a change, when the Summarised page is out of date, or when the AI could not write it.

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

- **View**: Summarised, Linear, or Stacked. Summarised is a page of sections, described in section 7. Linear shows the files of each change by itself. Stacked shows the files of all the changes of one repo as one diff, when they merge cleanly. The Summarised view has no file tree, and it shows only the View and Noise groups.
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

## 7. Summarised

![The Summarised view](docs/images/summarised.png)

The Summarised view is a page of sections that shows what a reviewer must think about, in reading order, with the boilerplate left out. A reviewer who reads and accepts every section, "Everything else" included, has seen the whole change.

**When the page is written.** An AI tool writes the page when you open the Summarised view, and not when the review is built. Open it with the View button of the Diff tab. The Diff tab also opens it when Summarised is your saved choice.

- While the tool writes, the view says so, and a banner shows on every tab. It takes a few minutes. If you leave the view, the run goes on and saves the page, and the page is there when you come back. The app never starts two runs for one review.
- The page is saved in the review. When you open the view again, a saved page that still fits is shown at once, and no run starts. A page is out of date when a change has new commits, when the issues changed, or when a snippet no longer points at a change. Then the app holds the page back and writes it again when the view is open. After new commits arrive, press Refresh, and the open view writes the page again.
- If the tool fails, the view shows the reason and a **Try again** button. The app does not try again by itself. The banner says where to press it.

**The sections.** The page starts with a short paragraph about the whole change. A section has:

- a title and one short paragraph that says what this change does and what to check.
- the code, as small excerpts of the diff: new, removed or modified lines with a little code around them. The excerpts follow the Noise buttons of the toolbar. A click on the name of the file above an excerpt opens the file in the Linear view at that line.
- a footer with the files that the section involves. A click on a file opens it in the Linear view. A file shows a tick when it is viewed.
- an **Accept** button, and its own thread.

The AI tool is told to be selective: few sections, only the changes that need thought, such as behaviour, contracts, data, security, error handling and logic that is not obvious. It leaves out boilerplate, renames, moves, formatting, generated code, imports, lock files, version bumps and other mechanical changes.

**Everything else.** The last section is always "Everything else", and the app computes it from the real diffs. It holds every changed file that no snippet shows, and every change in a file that no snippet covers. A change counts as covered when a snippet has a line of it. Changes that are only imports, comments or white space do not count, because the Code only level already hides them. The AI tool does not list these files, and it may add one short sentence for the section.

- The section lists its files. A file opens to show its changes, and a file that is only partly left over shows only the changes that no section shows. A click on "Open the file in the Linear view" opens the whole file.
- If the sections show every change, the section does not appear. If no change needs a section, the page shows only "Everything else", with the short summary of the tool.
- It has an Accept button and a thread, like any section.

**Accept and Viewed.** Accept marks the files of the section as viewed, with the same rules as the Viewed box of the Linear view: the HEAD mark counts for the commits before it, the tree and its counter show the mark, and the marks stay in the review on this machine.

- A file that more than one section holds becomes viewed only when all of them are accepted. This includes a file that is partly in a section and partly in "Everything else". The first Accept leaves the file unviewed, and the tooltip of the file names the sections that it waits for. This way a file is never marked as read while one of its changes is not.
- The button turns into "Accepted". Press it again to take the accept back. The files of that section lose their viewed mark, because the section is no longer read. Another section that you accepted stays accepted.
- If you remove the viewed mark of a file in the tree, the sections that hold only that file stop being accepted. Accept sets the marks again.
- The top of the page shows how many sections are accepted and how many files are viewed. The line under it says how many files are in the sections and how many in "Everything else", and how many of those also have changes in a section.

**The thread of a section.** The button "Comment on this section" opens a form. The comment goes to the host as a comment on the change, as the comments of the conversation do. It starts with the line `**Section: <title>**`, so people who read the change on the host see which section it is about. The app finds the threads by that line and shows them on the section, with their replies and their state. You can resolve and reopen a thread there, and you can also see it under the row in the Code changes tab.

- The comment goes to the open change that owns most files of the section. A merged or closed change takes no comment, and the section then shows its old threads only.
- **Save draft** keeps the comment in the review. The draft shows on the section, and you can edit it, delete it, or post it. Submit review posts it with the other drafts.
- If the AI writes the page again with a new title for a section, its old thread stays on the change but shows only in the Code changes tab.

**Checks.** The page is checked against the real diffs. Every snippet must point at a file of the review and hold a changed line. A section has a title, one paragraph and at least one snippet, and the page has at most 12 sections. When the check fails, the tool must fix the page. The app asks up to three times. The check never asks the tool to cover every file, because "Everything else" holds what the sections leave out.

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
