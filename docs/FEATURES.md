# Code Diff Tool: product features

This file describes what the app does for the user. The pictures show made-up data. Run `npm run screenshots` to take them again.

## 1. What the app is

The app helps a reviewer read the code changes of one piece of work. A piece of work often has several merge requests or pull requests in several repos, and one or more issues. The app puts them in one review, shows the code of all of them together, and keeps your progress.

- Hosts: GitLab and GitHub, in any mix. The app calls their REST interfaces with your tokens. Jira gives the issues.
- Code: the app reads the diffs from your local clones with `git`. A change with no local clone is listed, but it has no diff.
- The app is a reviewer's tool. It never merges, and it never posts anything without your action.

## 2. Reviews

The home screen lists your reviews with their name, title, number of changes, number of issues, last opened time and the state of the Summarised page (Ready, Not written or Failed). A new review shows Not written until you open the Summarised tab. Every column sorts. A filter box narrows the list.

- **New review** asks for a name, the issue keys with an optional spec file, and the URLs of the merge or pull requests, in that order. The name is required, but when you leave it empty the app uses the first issue key, or else the first change as `<repo>-<number>`. The app makes the folder name of the review from the name, and adds `-2`, `-3` and so on when it is taken. The check step reads each change and shows what the review will hold. A change with no local clone is skipped, and the list says so. Create and open builds the review.
- A review is built when it opens. The build shows its stages: finding the clones, checking your login, reading the issues, reading the code changes, fetching the missing commits, diffing the files and preparing the review. A reload builds it again.
- **Add changes** at the bottom of the Code changes tab adds more merge or pull requests to the open review. **Add issues** at the bottom of the Issues tab adds issues. What the review holds stays, and nothing is added twice.
- **Start from outside.** A second start of the app, or a `codediff://new?...` link, hands a request to the open app. The request can hold `mr`, `issue`, `title` and `review`. It fills in the New review form and runs the check, and you press Create. When it names an existing review, a dialog lists what it brings and adds it when you agree. On the command line, use the form `--mr=<url>` and `--issue=<key>`, because the app receives the arguments of a second start in a different order. The link works only in the installed app.

## 3. The screen of a review

The header shows the title of the review, a short line about it, the AI button and the Reload button. The tabs are Code changes, Summarised, Diff, Issues and Acceptance criteria. Most tabs show a count. The keys `1` to `5` pick a tab, and Ctrl+Tab and Ctrl+Shift+Tab go through them.

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

- **View**: Linear or Stacked. Linear shows the files of each change by itself. Stacked shows the files of all the changes of one repo as one diff, when they merge cleanly. The Summarised page has its own tab, described in section 7. It has no file tree, and it shows only the Noise group.
- **Noise**: Code only, Keep mechanical, or Everything. Code only hides blank lines, white space, imports, comments and mechanical modifiers. A file with no change at that level is hidden, and the tree says how many.
- **Layout**: Inline, Side by side, or Full file.
- **Files**: New, Modified and Deleted, each with its count.
- **Types**: Code, Tests, Config, Docs, Images and Binary, each with its count. A file has one type. The app checks in this order and the first match wins: Images (by extension: png, jpg, jpeg, gif, webp, bmp, ico, svg, avif, tiff, heic and similar), then Binary (a file that git marks as binary, or a known binary extension such as zip, dll, exe, pdf, fonts, jar and wasm), then Docs, Tests, Config, and Code for the rest. An image is never Binary, and a picture in a `tests` folder is an Image. An SVG is an Image, and the diff still shows its text lines. The diff of another image, or of any binary file, shows the note "Binary file, no text diff." and no preview.
- The Types group shows only the options that have files. An option with no file is not shown, and the group is not shown when the review has no file at all. The counts come from the files that the View and Noise settings show, so the other filters do not change them. An option that is on stays visible when its count falls to 0, so you can turn it off.
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
- **Syntax colours.** The code has colours by its language in the Inline, Side by side and Full file layouts, and in the code blocks of the chat. The app picks the language from the name of the file, for example `.ts`, `.tsx`, `.cs`, `.py`, `.csproj`, `.tf`, `Dockerfile` and `Makefile`. A file in an unknown language stays plain.
  - A removed line takes its colours from the whole old file. An added or unchanged line takes them from the whole new file. A comment or a string over several lines then has the right colour on each line. A file with no whole text, such as a generated file, gets its colours one hunk at a time, so a comment that starts above a hunk can have a wrong colour. The text is always right.
  - The text shows at once and the colours follow a moment later, because a worker colours the file in the background. The marks inside a changed line stay visible over the colours.
  - A file with more than 8,000 lines, more than 600,000 characters or a line longer than 1,500 characters stays plain, and the file header says why.
  - The colours are always on. Each theme has its own colours for the code. They have a contrast of 4.5 or more on the plain, the added and the removed backgrounds and on the marks inside a changed line.
- **Full file** shows the whole new file with the added lines marked.
- **Commits.** The chips in the header list the commits of the change that touched the file. Choose one to see only what it changed, compared with its parent. A banner says which commit it is. Choose HEAD to go back. Comments and threads show at HEAD only, because the lines of a commit are not the lines of HEAD.
- **Viewed.** The Viewed button marks the file as viewed. With a commit chosen, it marks that commit. Each commit chip has its own box. Marking HEAD as viewed marks every commit before it. With a commit chosen, `v` and Shift+V mark and unmark that commit only.
- **Threads.** The threads of a line show under it. A thread shows its first comment, its replies and its state. You can reply, resolve and reopen. A thread on a line that the noise filter hides shows in a list at the top of the file. Threads on the whole file show above the diff.
- **Comments.** The `+` button opens a form. A comment on an open change goes to the host at once. A draft stays in the review, and you post it later or delete it. A merged change takes no new comment.
- **The review bar** at the bottom has Previous and Next for the files, the comment buttons that go to the next and the prior comment, and Submit review. Submit review sends your drafts, an optional summary and your decision (approve, request changes or comment) to each change.

## 7. Summarised

![The Summarised tab](docs/images/summarised.png)

The Summarised tab is a page of sections for a bug hunt. It shows the places where a bug can be spotted or a wrong decision can be found, in reading order, and leaves the noise out. A reviewer who reads and accepts every section, "Everything else" included, has seen the whole change.

**When the page is written.** An AI tool writes the page when you open the Summarised tab, and not when the review is built.

- The tool is Claude Code with the model `sonnet` at `medium` effort. The choice is for cost and speed, because you wait for the page when you open the view.
- While the tool writes, the view says so, and a banner shows on every tab. It takes a few minutes. If you leave the view, the run goes on and saves the page, and the page is there when you come back. The app never starts two runs for one review.
- The page is saved in the review. When you open the view again, a saved page that still fits is shown at once, and no run starts. A page is out of date when a change has new commits, when the issues changed, when a snippet no longer points at a change, or when the app has new rules for the page. Then the app holds the page back and writes it again when the view is open. After new commits arrive, press Refresh, and the open view writes the page again.
- If the tool fails, the view shows the reason and a **Try again** button. The app does not try again by itself. A try that gives no answer in 10 minutes is stopped.

**What the page holds.** The AI tool is told to pick code by one test: could a bug hide here, or could a wrong decision be spotted here? That means logic and branching, data flow, error handling, concurrency and ordering, security and permission rules, changes of a contract or of public behaviour, queries, configuration that changes behaviour, and a test only when it shows the intent or a missing case. It leaves out declarations that only mirror another change, wiring and plumbing, renames, formatting, imports, logging, comments, generated code, lock files, version bumps and test scaffolding.

- A page has at most 10 sections, "Everything else" included. The tool writes at most 9, usually 3 to 7, and fewer for a small change. If it writes more, the app asks it to merge or drop points, and after the last try it keeps the first 9 and says so in "Everything else".
- When no change needs thought, the page has only "Everything else", with a short sentence.

**A section.** It has:

- a title and one short paragraph for a bug hunt: what the code does now, what changed, and what to check.
- the code, as compact excerpts of the diff, with the syntax colours of the file panel. A snippet shows the changed lines of its range with at most one unchanged line around each change. Longer runs of unchanged lines fold into a row that opens on a click, and a long excerpt shows its first rows and a row "Show N more lines". The excerpts follow the Noise buttons. A section draws one block for each file, with the ranges in the order of the file.
- a footer with the files of the section. A click on a file opens it in the Linear view. A file shows a tick when it is viewed.
- an **Accept** button, and its own thread.

**Mirrors.** When several changes say the same thing, such as an interface and the class that implements it, the section shows the one place where the real change is, and lists the others in its footer as mirrors. A mirror has a dashed chip and no excerpt. Accept covers it like the other files.

**Everything else.** The last section is always "Everything else", and the app computes it from the real diffs. It holds every changed file that no section shows, and every changed line that no snippet picks. A change that a section already draws is never drawn again on the page. Changes that are only imports, comments or white space do not count, because the Code only level hides them. The AI tool does not list these files, and it may add one short sentence that names the categories that it left out.

- A file that is only partly left over shows only the lines that no section shows. Click a file to open its changes, and click "Open the file in the Linear view" for the whole file.
- If the sections show every change, the section does not appear.
- It has an Accept button and a thread, like any section.
- If a second section picks only lines that an earlier section draws, it says "These changes are shown in section N."

**The index.** The left column shows an index of the sections, in the place of the file tree. At the top is the progress, "N of M accepted". Each row has the number, the title, a mark (○ not accepted, ◐ accepted while a file waits for another section, ✓ accepted), how many of its files are viewed, and a mark for an open thread or a draft. "Everything else" is the last row.

- A click on a row goes to the section, opens it if it is collapsed, and moves the focus to it. The row of the section in view is highlighted while you scroll.
- The Up and Down keys walk the rows, Home and End go to the first and the last, and Enter goes to the section. The keys `n`, `p` and `v` do nothing in this view.
- The index has the width of the file tree, and the splitter resizes it. In a window narrower than 800 pixels it sits above the page, as the file tree does.

**Collapse and the sticky header.** Each section has a chevron that collapses it to its header and opens it again. A collapsed section still shows its number, title, "N of M files viewed", the Accept button, and marks for its open threads and drafts. "Collapse all" and "Expand all" sit near the progress line. The state is saved for each review, and a section with no saved state is open, unless it is accepted.

- The header of a section stays at the top of the page while you scroll through the section, and the next header pushes it away.
- Accept collapses the section and moves on: the next section that is not accepted goes to the top of the page. If none is left, the page goes to its end. Un-accept opens the section again and keeps its header where it is on the screen. A section that you open after the Accept stays open until you change it.
- A section that becomes accepted or not accepted in another way, such as a mark in the tree, collapses or opens in the same way, and the page does not scroll.

**Accept and Viewed.** Accept marks the files of the section as viewed, with the same rules as the Viewed box of the Linear view: the HEAD mark counts for the commits before it, the tree and its counter show the mark, and the marks stay in the review on this machine.

- A file that more than one section holds becomes viewed only when all of them are accepted. This includes a file that is partly in a section and partly in "Everything else". The first Accept leaves the file unviewed, and the tooltip of the file names the sections that it waits for. This way a file is never marked as read while one of its changes is not.
- The button turns into "Accepted". Press it again to take the accept back. The files of that section lose their viewed mark, because the section is no longer read. Another section that you accepted stays accepted.
- If you remove the viewed mark of a file in the tree, the sections that hold only that file stop being accepted. Accept sets the marks again.
- The top of the page shows how many sections are accepted and how many files are viewed. The line under it says how many files are in the sections and how many in "Everything else".

**The thread of a section.** The button "Comment on this section" opens a form. The comment goes to the host as a comment on the change, as the comments of the conversation do. It starts with the line `**Section: <title>**`, so people who read the change on the host see which section it is about. The app finds the threads by that line and shows them on the section, with their replies and their state. You can resolve and reopen a thread there, and you can also see it under the row in the Code changes tab.

- The comment goes to the open change that owns most files of the section. A merged or closed change takes no comment, and the section then shows its old threads only.
- **Save draft** keeps the comment in the review. The draft shows on the section, and you can edit it, delete it, or post it. Submit review posts it with the other drafts.
- If the AI writes the page again with a new title for a section, its old thread stays on the change but shows only in the Code changes tab.

**Checks.** The page is checked against the real diffs. Every snippet must point at a file of the review and hold a changed line, and its range must not be far wider than the changes in it. A mirror must be a changed file of the review. A section has a title, one paragraph and at least one snippet. The check never asks the tool to cover every file, because "Everything else" holds what the sections leave out. When the check fails, the tool must fix the page, and each message names the exact problem, for example the lines that did change. The app asks up to three times.

## 8. Acceptance criteria

![The Acceptance criteria tab](docs/images/criteria.png)

Each issue lists its criteria. **Validate ACs** asks the AI tool to check each criterion against the code of all the changes. It says met, partly met or not met, and gives the reason and links to the lines that show it. For a criterion that is not met, it can suggest a comment. A button adds the suggestion as a draft. The button is off when the change has new commits since the check or is no longer open.

## 9. The AI features

![The AI review box](docs/images/ai-review.png)

- **AI review.** The AI button opens a box. Choose a skill and a model, then start the review. A skill is a markdown file with review rules. One skill is built in. You can point the app at a folder of skill files whose front matter says they are for a code review. The run reads the review context, which is a folder of files that the app writes. It takes a few minutes, and it keeps going when you close the window. Each finding becomes a draft comment that starts with a robot mark, the lens and the severity. A finding with no line becomes a comment on the change.
- **Chat.** The button at the bottom right opens a chat about the whole review. A chat on one line is available from the gutter. The AI answers with the code of the repos at hand. A code block of an answer has syntax colours when its fence names a known language, as in three backticks and `ts`. It can propose comments, open a file or mark files as viewed, as cards that you apply or not.
- **Tools.** Claude Code is the default. Codex and a custom command also work. The Prerequisites screen shows the choice. A custom command can use the placeholders `{prompt}`, `{instructions}`, `{model}`, `{effort}`, `{dir}` and `{session}`.
- The AI tools run with read-only tools. They cannot change a file, and nothing they write reaches a host without your action.

## 10. Prerequisites

The first screen shows what the app needs. `git` and a workspace folder are required. At least one host needs a token. The screen explains how to make a token for GitLab, GitHub and Jira, and the access each one needs. The app checks a token before it saves it. The AI tool is optional, and the screen shows its state.

## 11. Themes

The Theme menu lists System, Tokyo Night, Dracula, Nord, Gruvbox Dark, Solarized Dark and Paper. A tick marks the current theme, and the app saves the choice. System follows the colour scheme of the computer. Every theme also sets the colours of the code tokens. See "Syntax colours" in the section about the file panel.

## 12. Keys

- `1` to `4`: pick a tab. Ctrl+Tab and Ctrl+Shift+Tab: the next and the prior tab.
- Arrow keys, `*`: walk the file tree.
- `n` and `p`: the next and the prior file. `v` and Shift+V: mark and unmark.
- `c`: the next comment.
- Enter sends a chat message, and Shift+Enter adds a line.
