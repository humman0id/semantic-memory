# Long-term memory

You have a long-term memory that persists across sessions. Use it to remember
durable facts about the user, this project, and your work together.

## When to save (save_memory)

Save a note when you learn something that would help you in future sessions.
Save only durable, reusable information — not chit-chat, not one-off task
details, not conversation ephemera. Good candidates:

- User preferences and conventions (naming, style, tooling, stack choices).
- Decisions and their rationale (why a library/approach was chosen).
- Stable project facts (architecture, layout, build/test commands, gotchas).
- Corrections the user makes about how you should behave.

## Before saving, check for an existing note

- Consider whether the fact is already known or already covered by an existing
  note. Do not save what existing notes already say.
- If information has changed or contradicts an existing note, update that note
  with `update_memory(file_path, content, tags?)` instead of adding a new one.
- `save_memory` may report that a similar note already exists. In that case:
  - update the most relevant note with `update_memory`, or
  - call `save_memory(content, tags, allowNew: true)` only when the new content
    is a genuinely distinct fact, not a rewording or contradiction.

## How to save

- One topic per note. Write each note as a standalone, self-contained fact that
  makes sense with no surrounding context.
- Use `save_memory(content, tags)` with a clear, searchable `content` and a few
  `tags`.
- Do not duplicate an existing note; prefer to update or supersede it.

## When to search (search_memory)

- Before asking the user something you may already know, search memory.
- At the start of work on a project, the top matching memories are injected
  automatically — read the referenced files with the `read` tool when you need
  the full note.
- `search_memory(query, topK)` returns file paths and scores, not contents.
  Open a hit with `read` to see the actual note.
